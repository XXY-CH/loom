import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { ConnectionCatalog } from "../src/providers/catalog.js";
import { inspectBudget } from "../src/runtime/budget.js";
import { ServiceClient } from "../src/service/client.js";
import {
  LoomService,
  type ServiceRequest,
  type ServiceResult,
  serviceSocketPath,
} from "../src/service/daemon.js";
import { ServiceWorkbench } from "../src/tui/service-controller.js";
import { renderServiceWorkbench } from "../src/tui/service-render.js";
import type { FeatureSpec } from "../src/workflow/feature-store.js";
import {
  createFeatureFixture,
  featureModel,
  implementedSource,
} from "./feature-fixture.js";

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
 * tests/service-budget-reconcile.test.ts): requests fail with 500 until
 * serve() is called. Requests whose 1-based index is in `hold` stall inside
 * the fixture until release() — a deterministic "model call in flight" window
 * in which the service holds the run's database lease. */
function featureWorkerServer(options: { hold?: number[] } = {}) {
  let requests = 0;
  let failing = true;
  const held = new Set(options.hold ?? []);
  const heldResolvers = new Map<number, () => void>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests += 1;
    if (held.has(requests))
      await new Promise<void>((resolve) => {
        heldResolvers.set(requests, resolve);
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
      held.clear();
      for (const resolve of heldResolvers.values()) resolve();
      heldResolvers.clear();
    },
  };
}

// Local Pi provider fixture; no HTTP requests or real credentials.
test("service TUI reads real run, budget and Git projections through a separate process", async () => {
  const fixture = await createFeatureFixture();
  const model = featureModel();
  const dataRoot = join(fixture.root, "service");
  const service = await LoomService.open({
    dataRoot,
    runtimeFactory: () => model.runtime,
  });
  try {
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    await client.request({
      method: "start",
      spec: fixture.spec,
      profile: {
        id: "fixture",
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "feature-fixture",
        baseUrl: "http://invalid.test",
      },
    });
    await vi.waitFor(
      async () => {
        expect(
          (
            await client.request({
              method: "status",
              runId: fixture.spec.runId,
            })
          ).status,
        ).toBe("completed");
      },
      { timeout: 20000 },
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "src/cli/service-tui.ts",
      "--data-root",
      dataRoot,
      "--once",
    ]);
    expect(stdout).toContain(fixture.spec.runId);
    expect(stdout).toContain("completed");
    expect(stdout).toContain("Budget:");
    expect(stdout).toContain("sum.js");
    expect(stdout).not.toContain("\x1b");
    expect(
      (await client.request({ method: "status", runId: fixture.spec.runId }))
        .usage?.calls,
    ).toBeGreaterThan(0);
  } finally {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 30000);

// `--once` renders a keyless single frame, so the toggled evidence pane is
// asserted in-process here: a real ServiceWorkbench over the same socket the
// TUI uses, against the same real service/fixture run, plus a rendered frame
// through the same renderer the dashboard draws with.
test("service TUI evidence panel lists the fixture run's real evidence over the socket", async () => {
  const fixture = await createFeatureFixture();
  const model = featureModel();
  const dataRoot = join(fixture.root, "service");
  const service = await LoomService.open({
    dataRoot,
    runtimeFactory: () => model.runtime,
  });
  try {
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    await client.request({
      method: "start",
      spec: fixture.spec,
      profile: {
        id: "fixture",
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "feature-fixture",
        baseUrl: "http://invalid.test",
      },
    });
    await vi.waitFor(
      async () => {
        expect(
          (
            await client.request({
              method: "status",
              runId: fixture.spec.runId,
            })
          ).status,
        ).toBe("completed");
      },
      { timeout: 20000 },
    );
    const ui = new ServiceWorkbench(client);
    try {
      await ui.refresh();
      expect(ui.state.evidence).toBeUndefined();
      await ui.key("e");
      // Same socket evidence projection the HTTP workbench consumes.
      const projected = await client.request({
        method: "evidence",
        runId: fixture.spec.runId,
      });
      expect(ui.state.evidenceRunId).toBe(fixture.spec.runId);
      expect(ui.state.evidence).toEqual(projected);
      expect(projected.length).toBeGreaterThan(0);
      // Real host-collected evidence: command exits from the executed
      // targeted/regression argv plus review and artifact records.
      expect(new Set(projected.map((item) => item.kind))).toEqual(
        new Set(["artifact", "command", "review"]),
      );
      const command = projected.find((item) => item.kind === "command");
      expect(command).toBeTruthy();
      // Host-collected command evidence from the executed targeted/regression argv.
      expect(command?.kind === "command" && command.exitCode).toBe(0);
      const frame = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(frame).toContain("EVIDENCE (");
      // Entry prefixes (id, stepId) survive the 120-column fit; the long JSON
      // command body may truncate, so exit codes are asserted on the state.
      expect(frame).toContain(command?.id ?? "");
      expect(frame).toContain(command?.stepId ?? "");
      expect(frame).not.toContain("\x1b");
    } finally {
      ui.stop();
    }
  } finally {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 30000);

// Worker artifact bodies are refused above 64 KiB at write time, and the
// spec.regression override can only amplify command bodies — the entry kind
// the TUI deliberately leaves without a body view. The only artifact-kind
// body that can legally exceed the read-side cap is the deliver manifest,
// which embeds the full git diff, so the fixture's implement write amplifies
// sum.js with a >64 KiB comment line (sum.js stays require-able, keeping
// targeted/regression green) to make `truncated:true` reachable end to end.
test("service TUI opens a real artifact body with the truncation badge over the socket", async () => {
  const fixture = await createFeatureFixture();
  const model = featureModel({
    implementationSources: [`// ${"l".repeat(70_000)}\n${implementedSource}`],
  });
  const dataRoot = join(fixture.root, "service");
  const service = await LoomService.open({
    dataRoot,
    runtimeFactory: () => model.runtime,
  });
  try {
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    await client.request({
      method: "start",
      spec: fixture.spec,
      profile: {
        id: "fixture",
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "feature-fixture",
        baseUrl: "http://invalid.test",
      },
    });
    await vi.waitFor(
      async () => {
        expect(
          (
            await client.request({
              method: "status",
              runId: fixture.spec.runId,
            })
          ).status,
        ).toBe("completed");
      },
      { timeout: 20000 },
    );
    const ui = new ServiceWorkbench(client);
    try {
      await ui.refresh();
      await ui.key("e");
      const entries = ui.state.evidence ?? [];
      expect(entries.length).toBeGreaterThan(0);
      const deliver = entries.find(
        (item) => item.kind === "artifact" && item.stepId === "deliver",
      );
      expect(deliver).toBeTruthy();
      // Move the selection onto the deliver entry through the real key path.
      const index = entries.indexOf(deliver as (typeof entries)[number]);
      for (let step = 0; step < index; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(index);
      await ui.key("return");
      expect(ui.state.artifactViewId).toBe(deliver?.id);
      // The viewed body is deep-equal to the same socket projection the HTTP
      // workbench consumes, and the read-side cap genuinely truncated it.
      const projected = await client.request({
        method: "artifact",
        runId: fixture.spec.runId,
        evidenceId: deliver?.id ?? "",
      });
      expect(ui.state.artifactBodies.get(deliver?.id ?? "")).toEqual(projected);
      expect(projected.truncated).toBe(true);
      expect(projected.byteLength).toBeGreaterThan(64 * 1024);
      const frame = renderServiceWorkbench(ui.state, 120, 40, false);
      expect(frame).toContain("truncated at 64 KiB");
      expect(frame).toContain(`${projected.byteLength} bytes`);
      // The marker the projection embeds in the truncated text stays visible.
      expect(frame).toContain("… preview truncated (64 KiB)");
      // The manifest's first body line (JSON envelope) renders, sanitized.
      expect(frame).toContain('{"runId"');
      expect(frame).not.toContain("\x1b");
    } finally {
      ui.stop();
    }
  } finally {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 30000);

// The TUI leg of the budget reconciliation series, driven end to end against
// a real LoomService with its default provider runtime factory and a keyless
// loopback completions fixture (zero credentials). The order is forced by two
// gates of the slice itself: `b` only arms on a run with unsettled calls that
// is NOT dispatching (an armed run is never the service's own dispatch — the
// budget gate blocks new calls while a call is unsettled), so the real
// DATABASE_IN_USE window is an EXTERNAL CLI feature process holding the run's
// database lease, exactly the ownership case the lease arbitrates:
// start → blocked (pending 1) → arm (zero requests) → confirm reconciles the
// first round (before/after cross-checked against inspectBudget) → CLI clears
// the workflow operation → an external CLI process reopens the run and its
// held model call re-creates an unsettled row → the armed key fails closed
// with the verbatim DATABASE_IN_USE message → the external process fails and
// exits → the retry reconciles the second round → the settled ledger refuses
// a further reconcile → resume still requires the CLI workflow operation.
test("service TUI reconciles the budget ledger through the real key path, failing closed while dispatching", async () => {
  const fixture = await createFeatureFixture();
  const spec: FeatureSpec = {
    ...fixture.spec,
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
  };
  const { server, requests, release } = featureWorkerServer({ hold: [2] });
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
  // `connections add` keeps the workflow reconciliation on the documented path.
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
    // unsettled ledger row and the runner closed (lease released).
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
      },
      { timeout: 30_000 },
    );

    // The TUI observes the blocked run through the same socket; arming the
    // reconciliation sends nothing. The wrapper records every request (and
    // structured error) that flows through the real client behind the keys.
    const wire: { method: string; error?: string }[] = [];
    // The client's typed overloads narrow per-method results; the wrapper
    // forwards the request union and widens back — the runtime implementation
    // is one JSON request, which this bound-method cast only re-expresses.
    const forward = client.request.bind(client) as unknown as (
      request: ServiceRequest,
    ) => Promise<ServiceResult>;
    const transport = {
      request: async (request: ServiceRequest): Promise<ServiceResult> => {
        try {
          const result = await forward(request);
          wire.push({ method: request.method });
          return result;
        } catch (error) {
          wire.push({ method: request.method, error: String(error) });
          throw error;
        }
      },
    };
    const reconciles = () =>
      wire.filter((entry) => entry.method === "reconcile-budget");
    const ui = new ServiceWorkbench(transport);
    let external: ReturnType<typeof spawn> | undefined;
    try {
      await ui.refresh();
      expect(ui.state.detail?.active).toBe(false);
      expect(ui.state.detail?.usage?.pending).toBe(1);
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(reconciles()).toEqual([]);

      // Stage 2 — the confirmed reconciliation settles the first round over
      // the real socket; the summary matches the persisted ledger.
      await ui.key("return");
      expect(reconciles()).toHaveLength(1);
      expect(reconciles()[0]?.error).toBeUndefined();
      const first = ui.state.reconcileResult;
      expect(first?.database).toBe(await realpath(dbPath));
      expect(first?.before).toMatchObject({ pending: 1, reconciled: 0 });
      expect(first?.after).toMatchObject({ pending: 0, reconciled: 1 });
      expect(inspectBudget(dbPath)).toMatchObject({
        calls: 1,
        pending: 0,
        reconciled: 1,
      });
      expect(ui.state.reconcileConfirm).toBeUndefined();
      const settled = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(settled).toContain("Reconciled: pending 1 → 0 · reconciled 0 → 1");
      expect(settled).toContain("not adopted as succeeded");
      expect(settled).toContain("no token fabrication");
      expect(settled).not.toContain("\x1b");

      // Stage 3 — clear the workflow operation via the CLI (the resume gate's
      // precondition; workflow reconciliation deliberately stays CLI-only),
      // then reopen the run from an external CLI process whose model call the
      // fixture holds: the process holds the run's database lease and its
      // in-flight reservation re-creates an unsettled ledger row.
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
      external = spawn(process.execPath, ["--import", "tsx", cli, ...common], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      external.stderr?.on("data", () => {});
      const externalExit = new Promise<number | null>((resolve) => {
        external?.once("close", (code) => resolve(code));
        const killer = setTimeout(() => external?.kill("SIGKILL"), 240_000);
        external?.once("close", () => clearTimeout(killer));
      });
      await vi.waitFor(
        async () => {
          expect(requests()).toBe(2);
          expect(inspectBudget(dbPath)).toMatchObject({
            calls: 2,
            pending: 1,
            reconciled: 1,
          });
        },
        { timeout: 60_000 },
      );

      // Stage 4 — from the service the run is settled-but-not-dispatching
      // (the external process is invisible to the service's active overlay),
      // so the key arms again; confirming into the externally held lease
      // fails closed with the structured DATABASE_IN_USE message verbatim,
      // keeps the connection up and the confirmation armed for a retry.
      await ui.refresh();
      expect(ui.state.detail?.active).toBe(false);
      expect(ui.state.detail?.usage?.pending).toBe(1);
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      await ui.key("return");
      expect(reconciles()).toHaveLength(2);
      // String(error) carries the "Error: " prefix; the state holds the
      // service message itself, asserted with its exact prefix below.
      expect(reconciles()[1]?.error).toMatch(
        /DATABASE_IN_USE: Database is already owned by another Loom runtime: /,
      );
      expect(ui.state.reconcileNotice).toMatch(
        /^DATABASE_IN_USE: Database is already owned by another Loom runtime: /,
      );
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(ui.state.connected).toBe(true);
      expect(ui.state.reconcileResult).toEqual(first);
      const busy = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(busy).toContain(
        "Reconcile failed · DATABASE_IN_USE: Database is already owned",
      );
      expect(busy).toContain("reconcile budget addition? · return confirm");
      expect(busy).not.toContain("\x1b");

      // Stage 5 — release the held request; the fixture answers 500, the
      // external process blocks the run with a new operation and exits, and
      // the explicit retry through the same key path settles the second round.
      release();
      expect(await externalExit).toBe(1);
      await vi.waitFor(
        async () => {
          const status = await client.request({ method: "status", runId });
          expect(status.active).toBe(false);
          expect(status.blockedReason).toBeTruthy();
        },
        { timeout: 60_000 },
      );
      await ui.refresh();
      expect(ui.state.detail?.usage?.pending).toBe(1);
      await ui.key("return");
      expect(reconciles()).toHaveLength(3);
      expect(reconciles()[2]?.error).toBeUndefined();
      const second = ui.state.reconcileResult;
      expect(second?.before).toMatchObject({ pending: 1, reconciled: 1 });
      expect(second?.after).toMatchObject({ pending: 0, reconciled: 2 });
      expect(inspectBudget(dbPath)).toMatchObject({
        calls: 2,
        pending: 0,
        reconciled: 2,
      });
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "Reconciled: pending 1 → 0 · reconciled 1 → 2",
      );

      // Stage 6 — the settled ledger closes the entry itself: the key no-op
      // arms nothing and sends nothing. The daemon-level refusal of a further
      // reconcile on a settled ledger is asserted over the bare socket (the
      // key gate hides the entry before any request could carry it).
      expect(ui.state.detail?.usage?.pending).toBe(0);
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(reconciles()).toHaveLength(3);
      await expect(
        client.request({ method: "reconcile-budget", runId }),
      ).rejects.toThrow("Model budget has no unsettled call to reconcile");

      // Stage 7 — the key path never touches the workflow gate: the external
      // process's failure left a new blocked operation, and the TUI's own
      // resume key receives the same structured refusal until the CLI clears
      // it. (Driving the full clear → serve → resume → completed round is the
      // neighboring socket test's job; this one pins the gate.)
      await ui.key("p");
      const resumed = wire.filter((entry) => entry.method === "resume").at(-1);
      expect(resumed?.error).toContain(
        "Unknown or blocked operation requires reconciliation before resume",
      );
      // The refused resume leaves the run exactly as it was: still carrying
      // the blocked operation that only the CLI reconciliation can clear.
      const final = await client.request({ method: "status", runId });
      expect(final.active).toBe(false);
      expect(final.operationId).toBeTruthy();
      expect(final.blockedReason).toBeTruthy();
    } finally {
      external?.kill("SIGKILL");
      ui.stop();
    }
  } finally {
    await service?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 300_000);

// The TUI leg of the connection management series, driven end to end against
// a real LoomService opened with connectionCatalogDirectory (the same
// catalogDir scaffolding as the reconcile test above): the panel lists
// CLI-preset entries over the real socket, `a` adds from a disk profile file
// through the real draft path, `d`+return removes through the real armed
// confirmation, and every step is cross-checked against a direct
// connections.json read and ConnectionCatalog.list(). The structured
// UNKNOWN_CONNECTION path is real too: an external catalog writer removes the
// armed id between arming and confirming. Zero credentials, zero model
// calls — the runtime factory throwing pins that no connection key ever
// opens a Runtime (no runs exist in this dataRoot).
test("service TUI manages connection catalog entries through the real key path", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-tui-conns-"));
  const catalogDir = join(root, "catalog");
  const dataRoot = join(root, "service");
  const cliProfilePath = join(root, "cli-fixture.json");
  const tuiProfilePath = join(root, "tui-fixture.json");
  const cliProfile = {
    id: "cli-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture-worker",
    baseUrl: "http://127.0.0.1:1/v1",
  } as const;
  const tuiProfile = {
    id: "tui-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture-worker",
    baseUrl: "http://127.0.0.1:1/v1",
    keyEnv: "LOOM_TUI_PROBE_KEY",
  } as const;

  let service: LoomService | undefined;
  try {
    // CLI preseed — the subcommand creates the owner-only catalog directory
    // on demand, exactly as in the reconcile test above.
    await writeFile(cliProfilePath, JSON.stringify(cliProfile));
    const added = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "connections",
        "add",
        "--profile",
        cliProfilePath,
        "--catalog",
        catalogDir,
      ],
      { timeout: 30_000 },
    );
    expect(firstJson(added.stdout)).toEqual({
      id: "cli-fixture",
      status: "added",
    });

    service = await LoomService.open({
      dataRoot,
      connectionCatalogDirectory: catalogDir,
      runtimeFactory() {
        throw new Error("connection keys must not open Runtime");
      },
    });
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    // The wire records every request (and structured error) that flows
    // through the real client behind the keys.
    const wire: { method: string; error?: string }[] = [];
    const forward = client.request.bind(client) as unknown as (
      request: ServiceRequest,
    ) => Promise<ServiceResult>;
    const transport = {
      request: async (request: ServiceRequest): Promise<ServiceResult> => {
        try {
          const result = await forward(request);
          wire.push({ method: request.method });
          return result;
        } catch (error) {
          wire.push({ method: request.method, error: String(error) });
          throw error;
        }
      },
    };
    const ui = new ServiceWorkbench(transport);
    try {
      // The panel lists the CLI-preset entry over the real socket.
      await ui.refresh();
      await ui.key("c");
      expect(ui.state.connectionsEnabled).toBe(true);
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "cli-fixture",
      ]);
      const listed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(listed).toContain("CONNECTIONS (1)");
      expect(listed).toContain("cli-fixture");
      expect(listed).toContain("fixture-worker");
      expect(listed).not.toContain("\x1b");

      // `a` opens the add draft; the typed disk path loads the non-sensitive
      // profile and sends exactly one connections-add over the real socket.
      await writeFile(tuiProfilePath, JSON.stringify(tuiProfile));
      await ui.key("a");
      expect(ui.state.draft).toBe("add ");
      ui.state.draft = `add "${tuiProfilePath}"`;
      await ui.submitDraft();
      const adds = wire.filter((entry) => entry.method === "connections-add");
      expect(adds).toEqual([{ method: "connections-add" }]);
      expect(ui.state.draft).toBeUndefined();
      // TUI state, direct connections.json read and ConnectionCatalog.list()
      // agree on the same persisted document.
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "cli-fixture",
        "tui-fixture",
      ]);
      const document = JSON.parse(
        await readFile(join(catalogDir, "connections.json"), "utf8"),
      ) as { version: number; connections: Record<string, unknown> };
      expect(document.version).toBe(1);
      expect(document.connections["tui-fixture"]).toEqual(tuiProfile);
      expect(
        (await new ConnectionCatalog(catalogDir).list()).map(
          (entry) => entry.id,
        ),
      ).toEqual(["cli-fixture", "tui-fixture"]);

      // `d` arms the remove on the cursor entry; the armed step itself and
      // the abandon path send nothing (asserted on the real wire).
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("cli-fixture");
      expect(
        wire.filter((entry) => entry.method === "connections-remove"),
      ).toEqual([]);
      const armed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(armed).toContain("remove connection cli-fixture?");
      expect(armed).toContain("return confirm");

      // Structured error path over the real socket: an external catalog
      // writer removes the armed id first; the confirmation fails closed
      // with the verbatim code-prefixed message and stays armed.
      await new ConnectionCatalog(catalogDir).remove("cli-fixture");
      await ui.key("return");
      const removes = wire.filter(
        (entry) => entry.method === "connections-remove",
      );
      expect(removes).toHaveLength(1);
      expect(removes[0]?.error).toContain(
        "UNKNOWN_CONNECTION: Unknown connection id: cli-fixture",
      );
      expect(ui.state.connectionRemoveId).toBe("cli-fixture");
      expect(ui.state.connected).toBe(true);
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain(
        "Connections · UNKNOWN_CONNECTION: Unknown connection id: cli-fixture.",
      );
      expect(failed).toContain("remove connection cli-fixture?");
      await ui.key("escape");
      expect(ui.state.connectionRemoveId).toBeUndefined();

      // The refreshed list shows what actually persisted; the remaining
      // entry is removed through the real armed key path and the empty
      // catalog lands on disk in the same shape the CLI leaves it.
      await ui.refresh();
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "tui-fixture",
      ]);
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("tui-fixture");
      await ui.key("return");
      expect(
        wire.filter((entry) => entry.method === "connections-remove"),
      ).toHaveLength(2);
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(ui.state.connections).toEqual([]);
      const emptied = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(emptied).toContain("Connections (0)");
      expect(emptied).not.toContain("\x1b");
      expect(
        JSON.parse(
          await readFile(join(catalogDir, "connections.json"), "utf8"),
        ),
      ).toEqual({ version: 1, connections: {} });
      expect(await new ConnectionCatalog(catalogDir).list()).toEqual([]);
    } finally {
      ui.stop();
    }
  } finally {
    await service?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// The TUI leg of the connection edit series, driven end to end against a
// real LoomService opened with connectionCatalogDirectory (the same
// scaffolding as the management test above): `u` opens the edit draft,
// submitting it arms the cursor entry, and only `return` loads the disk
// profile and sends exactly one connections-update over the real socket.
// The catalog's update semantics are asserted through the key path: an
// external writer that changed the entry first is overwritten — update is
// an explicit same-id replacement, so the confirm still succeeds with
// `updated` (last writer wins, no conflict detection) — an idempotent
// re-edit of identical settings returns the real `unchanged`, and only an
// external delete of the armed id yields the verbatim UNKNOWN_CONNECTION
// prefix. Zero credentials, zero model calls — the runtime factory
// throwing pins that the edit key never opens a Runtime.
test("service TUI edits connection catalog entries through the real key path", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-tui-edit-"));
  const catalogDir = join(root, "catalog");
  const dataRoot = join(root, "service");
  const cliProfilePath = join(root, "cli-fixture.json");
  const editProfilePath = join(root, "edit-fixture.json");
  const first = {
    id: "cli-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "model-one",
    baseUrl: "http://127.0.0.1:1/v1",
  } as const;
  // The edit target: same id, changed fields — the explicit update shape.
  const edited = {
    ...first,
    modelId: "model-two",
    keyEnv: "LOOM_TUI_EDIT_KEY",
  };
  // An external writer's competing change between arming and confirming.
  const external = { ...first, modelId: "model-three" };

  let service: LoomService | undefined;
  try {
    // CLI preseed — the subcommand creates the owner-only catalog directory
    // on demand, exactly as in the management test above.
    await writeFile(cliProfilePath, JSON.stringify(first));
    const added = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "connections",
        "add",
        "--profile",
        cliProfilePath,
        "--catalog",
        catalogDir,
      ],
      { timeout: 30_000 },
    );
    expect(firstJson(added.stdout)).toEqual({
      id: "cli-fixture",
      status: "added",
    });

    service = await LoomService.open({
      dataRoot,
      connectionCatalogDirectory: catalogDir,
      runtimeFactory() {
        throw new Error("edit key must not open Runtime");
      },
    });
    const client = new ServiceClient(serviceSocketPath(dataRoot));
    // The wire records every request, structured error and connection write
    // status that flows through the real client behind the keys.
    const wire: { method: string; error?: string; status?: string }[] = [];
    const forward = client.request.bind(client) as unknown as (
      request: ServiceRequest,
    ) => Promise<ServiceResult>;
    const transport = {
      request: async (request: ServiceRequest): Promise<ServiceResult> => {
        try {
          const result = await forward(request);
          wire.push({
            method: request.method,
            ...(typeof result === "object" &&
            result !== null &&
            "status" in result
              ? { status: String(result.status) }
              : {}),
          });
          return result;
        } catch (error) {
          wire.push({ method: request.method, error: String(error) });
          throw error;
        }
      },
    };
    const updates = () =>
      wire.filter((entry) => entry.method === "connections-update");
    const ui = new ServiceWorkbench(transport);
    try {
      // The panel lists the CLI-preset entry over the real socket.
      await ui.refresh();
      await ui.key("c");
      expect(ui.state.connectionsEnabled).toBe(true);
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "cli-fixture",
      ]);

      // `u` opens the edit draft; submitting it arms the cursor entry and
      // sends nothing (asserted on the real wire).
      await writeFile(editProfilePath, JSON.stringify(edited));
      await ui.key("u");
      expect(ui.state.draft).toBe("edit ");
      ui.state.draft = `edit "${editProfilePath}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "cli-fixture",
        profilePath: editProfilePath,
      });
      expect(updates()).toEqual([]);
      const armed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(armed).toContain("update connection cli-fixture?");
      expect(armed).toContain("return confirm");

      // An external catalog writer changed the entry between arming and
      // confirming: update is an explicit same-id replacement, so the
      // confirm overwrites it — `updated`, never a conflict.
      await new ConnectionCatalog(catalogDir).update(external);
      await ui.key("return");
      expect(updates()).toEqual([
        { method: "connections-update", status: "updated" },
      ]);
      expect(ui.state.connectionEdit).toBeUndefined();
      // TUI state, direct connections.json read and ConnectionCatalog.list()
      // agree on the same persisted document.
      const listed = ui.state.connections?.find(
        (entry) => entry.id === "cli-fixture",
      );
      expect(listed).toEqual(edited);
      const document = JSON.parse(
        await readFile(join(catalogDir, "connections.json"), "utf8"),
      ) as { version: number; connections: Record<string, unknown> };
      expect(document.version).toBe(1);
      expect(document.connections["cli-fixture"]).toEqual(edited);
      expect(
        await new ConnectionCatalog(catalogDir).resolve("cli-fixture"),
      ).toEqual(edited);

      // The idempotent re-edit of identical settings returns the real
      // `unchanged` through the key path and is presented as success.
      await ui.key("u");
      ui.state.draft = `edit "${editProfilePath}"`;
      await ui.submitDraft();
      await ui.key("return");
      expect(updates()).toEqual([
        { method: "connections-update", status: "updated" },
        { method: "connections-update", status: "unchanged" },
      ]);
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.connectionsNotice).toBeUndefined();

      // The structured error path over the real socket: an external catalog
      // writer deletes the armed id first; the confirmation fails closed
      // with the verbatim code-prefixed message and stays armed.
      await ui.key("u");
      ui.state.draft = `edit "${editProfilePath}"`;
      await ui.submitDraft();
      await new ConnectionCatalog(catalogDir).remove("cli-fixture");
      await ui.key("return");
      expect(updates()).toHaveLength(3);
      expect(updates()[2]?.error).toContain(
        "UNKNOWN_CONNECTION: Unknown connection id: cli-fixture",
      );
      expect(ui.state.connectionEdit?.id).toBe("cli-fixture");
      expect(ui.state.connected).toBe(true);
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain(
        "Connections · UNKNOWN_CONNECTION: Unknown connection id: cli-fixture.",
      );
      expect(failed).toContain("update connection cli-fixture?");
      await ui.key("escape");
      expect(ui.state.connectionEdit).toBeUndefined();

      // The refreshed list shows the externally emptied catalog; the
      // persisted document and list() agree with it.
      await ui.refresh();
      expect(ui.state.connections).toEqual([]);
      expect(
        JSON.parse(
          await readFile(join(catalogDir, "connections.json"), "utf8"),
        ),
      ).toEqual({ version: 1, connections: {} });
      expect(await new ConnectionCatalog(catalogDir).list()).toEqual([]);
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "\x1b",
      );
    } finally {
      ui.stop();
    }
  } finally {
    await service?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
