import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { inspectBudget } from "../src/runtime/budget.js";
import { ServiceClient } from "../src/service/client.js";
import { LoomService, serviceSocketPath } from "../src/service/daemon.js";
import type { FeatureSpec } from "../src/workflow/feature-store.js";
import { createFeatureFixture, implementedSource } from "./feature-fixture.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

async function launch(args: string[], timeoutMs = 60_000) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

/** Bounded retry over the transient window where the service's teardown after a
 * failed run() (finish → runner.close → lease release) has not released the
 * database lease yet; DATABASE_IN_USE there is a timing artifact, not a verdict. */
async function launchPatient(args: string[], timeoutMs = 60_000) {
  let result = await launch(args, timeoutMs);
  for (
    let attempt = 0;
    attempt < 20 && result.stderr.includes("DATABASE_IN_USE");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await launch(args, timeoutMs);
  }
  return result;
}

const firstJson = (stdout: string) => {
  const newline = stdout.indexOf("\n");
  return JSON.parse(newline < 0 ? stdout : stdout.slice(0, newline));
};

/** Completions SSE fixture speaking the feature worker protocol (same shape as
 * tests/cli-recovery.test.ts): first requests fail with 500 until serve() is
 * called; afterwards each step prompt gets a read/write tool call first and a
 * JSON report once tool results are in context. With holdFirst the very first
 * request additionally stalls inside the fixture until release() — a
 * deterministic "model call in flight" window in which the service holds the
 * run's database lease. */
function featureWorkerServer(options: { holdFirst?: boolean } = {}) {
  let requests = 0;
  let failing = true;
  let held = options.holdFirst === true;
  let releaseHeld: (() => void) | undefined;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests += 1;
    if (held)
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    if (failing) {
      request.resume();
      response.writeHead(500);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{
        role: string;
        content: unknown;
      }>;
    };
    const user = [...body.messages].reverse().find((m) => m.role === "user");
    const content = user?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part) =>
                  part &&
                  typeof part === "object" &&
                  "text" in part &&
                  typeof (part as { text: unknown }).text === "string",
              )
              .map((part) => (part as { text: string }).text)
              .join("")
          : "";
    const prompt = JSON.parse(text) as { step: string };
    const afterTool = body.messages.some((m) => m.role === "tool");
    let delta: Record<string, unknown>;
    let finishReason: string;
    if ((prompt.step === "implement" || prompt.step === "fix") && !afterTool) {
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "write-one",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({
                path: "sum.js",
                content: implementedSource,
              }),
            },
          },
        ],
      };
      finishReason = "tool_calls";
    } else if (
      (prompt.step === "review" || prompt.step === "scout") &&
      !afterTool
    ) {
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "read-one",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "sum.js" }),
            },
          },
        ],
      };
      finishReason = "tool_calls";
    } else {
      const report =
        prompt.step === "review"
          ? { approved: true, findings: [] }
          : { step: prompt.step, report: "Fixture worker report." };
      delta = { role: "assistant", content: JSON.stringify(report) };
      finishReason = "stop";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: `c${requests}`,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  return {
    server,
    requests: () => requests,
    serve: () => {
      failing = false;
    },
    release: () => {
      held = false;
      releaseHeld?.();
    },
  };
}

// The documented service-hosted flow, driven end to end against a real
// LoomService with its default provider runtime factory and a keyless loopback
// completions fixture (zero credentials): start → blocked with one unsettled
// call → while the service lives, the CLI opens the Run under the unified
// connection identity, clears the workflow operation and reconciles the ledger
// (the lease, not process membership, is the only ownership judge) → a
// service-side resume fails again → stop the service → the CLI reconciles the
// second round offline → serve + restart + explicit resume → completed.
test("service-hosted budget reconciliation walks stop → CLI reconcile → restart → resume end to end", async () => {
  const fixture = await createFeatureFixture();
  const spec: FeatureSpec = {
    ...fixture.spec,
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
  };
  const { server, requests, serve } = featureWorkerServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP fixture");
  const runId = spec.runId;
  const dataRoot = join(fixture.root, "service");
  const dbPath = join(dataRoot, "runs", runId, "agent.sqlite");
  const profile = {
    id: "service-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture-worker",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  } as const;
  // The CLI side must select the identical profile id: the Pi provider session
  // label `loom:<id>` is part of the reopen check, so raw flags can never
  // reopen a service-started Run. Registering this profile through the real
  // `connections add` (which creates the owner-only catalog directory itself)
  // keeps every CLI step on the documented path.
  const catalogDir = join(fixture.root, "catalog");
  const profilePath = join(fixture.root, "service-fixture.json");
  const requestSpecPath = join(fixture.root, "request-spec.json");

  let service: LoomService | undefined;
  try {
    await writeFile(profilePath, JSON.stringify(profile));
    const added = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "connections",
        "add",
        "--profile",
        profilePath,
        "--catalog",
        catalogDir,
      ],
      { timeout: 30_000 },
    );
    expect(firstJson(added.stdout)).toEqual({
      id: "service-fixture",
      status: "added",
    });

    service = await LoomService.open({ dataRoot });
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    await client.request({ method: "start", spec, profile });

    // Stage 1 — the first model request fails; the run lands blocked with one
    // unsettled ledger row, the fixture saw exactly one request, and the
    // service is no longer dispatching (no lease held).
    await vi.waitFor(
      async () => {
        const status = await client.request({ method: "status", runId });
        expect(status.blockedReason).toBeTruthy();
        expect(status.operationId).toBeTruthy();
        expect(status.active).toBe(false);
      },
      { timeout: 60_000 },
    );
    await vi.waitFor(
      async () => {
        expect(inspectBudget(dbPath)).toMatchObject({
          calls: 1,
          pending: 1,
          reconciled: 0,
        });
        expect(requests()).toBe(1);
      },
      { timeout: 30_000 },
    );

    // Service-alive segment — the CLI opens the service-hosted Run (proof the
    // service holds no lease) under the unified connection identity, clears
    // the workflow operation, then reconciles the ledger.
    const request = JSON.parse(
      await readFile(join(dataRoot, "runs", runId, "request.json"), "utf8"),
    ) as { spec: FeatureSpec };
    // The persisted spec is normalized (fixed key order, resolved paths,
    // injected budget); reusing its exact shape is what satisfies the strict
    // stringify comparison when the CLI runner reopens the Run.
    await writeFile(requestSpecPath, JSON.stringify(request.spec));
    const common = [
      "feature",
      "--db",
      dbPath,
      "--spec",
      requestSpecPath,
      "--catalog",
      catalogDir,
      "--profile-id",
      "service-fixture",
    ];
    const reconcileWorkflow = async () => {
      const inspected = await launchPatient([...common, "--inspect"]);
      expect(inspected.code, inspected.stderr).toBe(0);
      const state = JSON.parse(inspected.stdout);
      expect(state.operation).toBeTruthy();
      const reconciled = await launchPatient([
        ...common,
        "--reconcile",
        "--operation-id",
        state.operation.id,
        "--expected-workspace",
        JSON.stringify(state.currentWorkspace),
        "--confirm-effects-reviewed",
      ]);
      expect(reconciled.code, reconciled.stderr).toBe(0);
      return JSON.parse(reconciled.stdout);
    };
    await reconcileWorkflow();
    const firstUnlock = await launchPatient([
      "feature",
      "--db",
      dbPath,
      "--reconcile-budget",
    ]);
    expect(firstUnlock.code, firstUnlock.stderr).toBe(0);
    const firstDecision = firstJson(firstUnlock.stdout);
    expect(firstDecision.before).toMatchObject({ pending: 1, reconciled: 0 });
    expect(firstDecision.after).toMatchObject({ pending: 0, reconciled: 1 });

    // Stage 2 — an explicit service-side resume fails again; wait until the
    // second unsettled call is durably in the ledger and the run is blocked.
    await client.request({ method: "resume", runId });
    await vi.waitFor(
      async () => {
        const status = await client.request({ method: "status", runId });
        expect(status.blockedReason).toBeTruthy();
        expect(status.operationId).toBeTruthy();
        expect(status.active).toBe(false);
        expect(inspectBudget(dbPath)).toMatchObject({
          calls: 2,
          pending: 1,
          reconciled: 1,
        });
        expect(requests()).toBe(2);
      },
      { timeout: 60_000 },
    );

    // Stage 3 — stop the service; the CLI performs the second round offline:
    // clear the new workflow operation (each failed retry leaves one), then
    // reconcile the second unsettled call.
    await service.close();
    service = undefined;
    await reconcileWorkflow();
    const secondUnlock = await launchPatient([
      "feature",
      "--db",
      dbPath,
      "--reconcile-budget",
    ]);
    expect(secondUnlock.code, secondUnlock.stderr).toBe(0);
    const secondDecision = firstJson(secondUnlock.stdout);
    expect(secondDecision.before).toMatchObject({ pending: 1, reconciled: 1 });
    expect(secondDecision.after).toMatchObject({ pending: 0, reconciled: 2 });

    // Stage 4 — serve the fixture, restart the service on the same dataRoot
    // and explicitly resume; the run completes and the ledger settles.
    serve();
    service = await LoomService.open({ dataRoot });
    await client.request({ method: "resume", runId });
    await vi.waitFor(
      async () => {
        expect((await client.request({ method: "status", runId })).status).toBe(
          "completed",
        );
      },
      { timeout: 120_000 },
    );

    expect(await readFile(join(spec.worktreePath, "sum.js"), "utf8")).toBe(
      implementedSource,
    );
    expect(inspectBudget(dbPath)).toMatchObject({
      pending: 0,
      reconciled: 2,
    });
    const ledger = inspectBudget(dbPath);
    expect(ledger?.calls).toBeGreaterThan(1);
    expect(ledger?.tokens).toBeGreaterThan(0);
    expect(requests()).toBeGreaterThan(1);
  } finally {
    await service?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 300_000);

// The service-side endpoint round: the ledger reconciliation itself moves to
// the socket protocol while the service lives (no stop/restart for the budget
// step, no CLI budget command), the dispatching window fails closed through
// the lease, and a settled ledger errors explicitly. Workflow operation
// reconciliation deliberately stays CLI-only, so clearing it before resume is
// still a CLI `feature --reconcile` step in this flow. Zero credentials: the
// fixture is a keyless loopback completions endpoint.
test("the socket reconcile-budget method unlocks the ledger during the service lifetime, failing closed while dispatching", async () => {
  const fixture = await createFeatureFixture();
  const spec: FeatureSpec = {
    ...fixture.spec,
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
  };
  const { server, requests, serve, release } = featureWorkerServer({
    holdFirst: true,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP fixture");
  const runId = spec.runId;
  const dataRoot = join(fixture.root, "service");
  const dbPath = join(dataRoot, "runs", runId, "agent.sqlite");
  const profile = {
    id: "service-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture-worker",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  } as const;
  const catalogDir = join(fixture.root, "catalog");
  const profilePath = join(fixture.root, "service-fixture.json");
  const requestSpecPath = join(fixture.root, "request-spec.json");

  let service: LoomService | undefined;
  try {
    await writeFile(profilePath, JSON.stringify(profile));
    const added = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "connections",
        "add",
        "--profile",
        profilePath,
        "--catalog",
        catalogDir,
      ],
      { timeout: 30_000 },
    );
    expect(firstJson(added.stdout)).toEqual({
      id: "service-fixture",
      status: "added",
    });

    service = await LoomService.open({ dataRoot });
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    await client.request({ method: "start", spec, profile });

    // Stage 1 — the fixture holds the first model request, so the service is
    // dispatching with one unsettled reservation durably in the ledger and the
    // run's lease held by the service's own runner. The endpoint fails closed
    // with the structured ownership error (code carried in the message).
    await vi.waitFor(
      async () => {
        const status = await client.request({ method: "status", runId });
        expect(status.active).toBe(true);
        expect(inspectBudget(dbPath)).toMatchObject({
          calls: 1,
          pending: 1,
          reconciled: 0,
        });
      },
      { timeout: 60_000 },
    );
    const canonical = await realpath(dbPath);
    await expect(
      client.request({ method: "reconcile-budget", runId }),
    ).rejects.toThrow(
      `DATABASE_IN_USE: Database is already owned by another Loom runtime: ${canonical}`,
    );

    // Stage 2 — release the held request; the fixture answers 500 and the run
    // lands blocked with the runner closed and the lease released.
    release();
    await vi.waitFor(
      async () => {
        const status = await client.request({ method: "status", runId });
        expect(status.blockedReason).toBeTruthy();
        expect(status.operationId).toBeTruthy();
        expect(status.active).toBe(false);
      },
      { timeout: 60_000 },
    );

    // Stage 3 — the service-alive endpoint round: reconciliation succeeds over
    // the socket with the before/after summary and no service restart, no CLI
    // budget command, and no credential anywhere in the loop.
    const decision = await client.request({
      method: "reconcile-budget",
      runId,
    });
    expect(decision.database).toBe(canonical);
    expect(decision.before).toMatchObject({ pending: 1, reconciled: 0 });
    expect(decision.after).toMatchObject({ pending: 0, reconciled: 1 });
    expect(inspectBudget(dbPath)).toMatchObject({ pending: 0, reconciled: 1 });

    // A settled ledger is an explicit error, never a silent success.
    await expect(
      client.request({ method: "reconcile-budget", runId }),
    ).rejects.toThrow("Model budget has no unsettled call to reconcile");

    // Stage 4 — the workflow gate is untouched by the ledger reconciliation:
    // resume still refuses until the blocked operation is cleared, and that
    // human reconciliation stays a CLI `feature --reconcile` step.
    await expect(client.request({ method: "resume", runId })).rejects.toThrow(
      "Unknown or blocked operation requires reconciliation before resume",
    );
    const request = JSON.parse(
      await readFile(join(dataRoot, "runs", runId, "request.json"), "utf8"),
    ) as { spec: FeatureSpec };
    await writeFile(requestSpecPath, JSON.stringify(request.spec));
    const common = [
      "feature",
      "--db",
      dbPath,
      "--spec",
      requestSpecPath,
      "--catalog",
      catalogDir,
      "--profile-id",
      "service-fixture",
    ];
    const inspected = await launchPatient([...common, "--inspect"]);
    expect(inspected.code, inspected.stderr).toBe(0);
    const state = JSON.parse(inspected.stdout);
    expect(state.operation).toBeTruthy();
    const reconciledWorkflow = await launchPatient([
      ...common,
      "--reconcile",
      "--operation-id",
      state.operation.id,
      "--expected-workspace",
      JSON.stringify(state.currentWorkspace),
      "--confirm-effects-reviewed",
    ]);
    expect(reconciledWorkflow.code, reconciledWorkflow.stderr).toBe(0);

    // Stage 5 — serve the fixture and resume through the same living service;
    // the run completes and the ledger settles.
    serve();
    await client.request({ method: "resume", runId });
    await vi.waitFor(
      async () => {
        expect((await client.request({ method: "status", runId })).status).toBe(
          "completed",
        );
      },
      { timeout: 120_000 },
    );
    expect(await readFile(join(spec.worktreePath, "sum.js"), "utf8")).toBe(
      implementedSource,
    );
    expect(inspectBudget(dbPath)).toMatchObject({
      pending: 0,
      reconciled: 1,
    });
    expect(inspectBudget(dbPath)?.tokens).toBeGreaterThan(0);
    expect(requests()).toBeGreaterThan(1);
  } finally {
    await service?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 300_000);
