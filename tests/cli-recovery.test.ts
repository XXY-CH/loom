import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { help, parseOptions } from "../src/cli/options.js";
import { inspectBudget } from "../src/runtime/budget.js";
import { acquireDatabaseLease } from "../src/service/database-lease.js";
import { createFeatureFixture, implementedSource } from "./feature-fixture.js";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function launch(args: string[], timeoutMs = 10_000) {
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
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, result };
}

test("ack-recovery requires explicit IDs and manual effects review", () => {
  const common = ["--db", "db", "--cwd", ".", "--model", "fixture"];
  expect(() => parseOptions(["ack-recovery", ...common])).toThrow(
    "--operation-id",
  );
  expect(() =>
    parseOptions(["ack-recovery", ...common, "--operation-id", "id"]),
  ).toThrow("--confirm-effects-reviewed");
  expect(() =>
    parseOptions([
      "ack-recovery",
      ...common,
      "--operation-id",
      "id,",
      "--confirm-effects-reviewed",
    ]),
  ).toThrow("--operation-id");
  expect(
    parseOptions([
      "ack-recovery",
      ...common,
      "--operation-id",
      "one,two",
      "--confirm-effects-reviewed",
    ])?.operationIds,
  ).toEqual(["one", "two"]);
});

test("budget reconciliation flag is a feature-only offline entry needing only --db", () => {
  expect(
    parseOptions(["feature", "--db", "feature.sqlite", "--reconcile-budget"]),
  ).toMatchObject({ command: "feature", "reconcile-budget": true });
  expect(
    parseOptions(["debug", "--db", "feature.sqlite", "--reconcile-budget"]),
  ).toMatchObject({ command: "debug", "reconcile-budget": true });
  expect(() => parseOptions(["feature", "--reconcile-budget"])).toThrow(
    "--reconcile-budget requires --db",
  );
  expect(() =>
    parseOptions([
      "feature",
      "--db",
      "feature.sqlite",
      "--reconcile-budget",
      "--spec",
      "run.json",
    ]),
  ).toThrow("takes no --spec");
  for (const flag of ["--inspect", "--tui", "--reconcile"]) {
    expect(() =>
      parseOptions([
        "feature",
        "--db",
        "feature.sqlite",
        "--reconcile-budget",
        flag,
      ]),
    ).toThrow("cannot be combined");
  }
  for (const command of ["run", "status", "resume", "ack-recovery", "tui"]) {
    const common = [command, "--db", "db", "--cwd", ".", "--model", "fixture"];
    expect(() => parseOptions([...common, "--reconcile-budget"])).toThrow(
      "--reconcile-budget requires feature",
    );
  }
  // The offline entry resolves no connection; every connection flag shape
  // (single flags plus the --catalog+--profile-id pairing) is rejected up front.
  for (const flags of [
    ["--model", "fixture"],
    ["--profile", "local.json"],
    ["--profile-id", "local"],
    ["--provider", "anthropic"],
    ["--endpoint", "http://127.0.0.1:9/v1/"],
    ["--protocol", "completions"],
    ["--key-env", "LOOM_FIXTURE_KEY"],
    ["--catalog", "DIR", "--profile-id", "local"],
  ]) {
    expect(() =>
      parseOptions([
        "feature",
        "--db",
        "feature.sqlite",
        "--reconcile-budget",
        ...flags,
      ]),
    ).toThrow("is a connection flag; --reconcile-budget");
  }
  expect(() =>
    parseOptions(["connections", "list", "--reconcile-budget"]),
  ).toThrow("is a runtime flag; connections manages the catalog");
  expect(() =>
    parseOptions([
      "feature",
      "--db",
      "feature.sqlite",
      "--reconcile-budget",
      "--operation-id",
      "id",
      "--confirm-effects-reviewed",
    ]),
  ).toThrow("require ack-recovery");
  expect(help).toContain("feature --db PATH --reconcile-budget");
});

test("CLI gates unknown shell effects across processes until explicit acknowledgement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-cli-recovery-"));
  let calls = 0;
  const server = createServer(async (request, response) => {
    request.resume();
    calls += 1;
    const shell = calls === 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: `c${calls}`, choices: [{ index: 0, delta: shell ? { role: "assistant", tool_calls: [{ index: 0, id: "shell-one", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf x >> executions; printf ready > started; sleep 1; printf done > shell-ended" }) } }] } : { role: "assistant", content: "recovered" }, finish_reason: shell ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP fixture");
  const common = [
    "--db",
    join(cwd, "agent.sqlite"),
    "--cwd",
    cwd,
    "--model",
    "fixture",
    "--protocol",
    "completions",
    "--endpoint",
    `http://127.0.0.1:${address.port}/v1`,
  ];
  const initial = launch([
    "run",
    ...common,
    "--prompt",
    "fixture",
    "--request-id",
    "one",
  ]);
  try {
    await expect
      .poll(
        async () => readFile(join(cwd, "started"), "utf8").catch(() => ""),
        { timeout: 5000 },
      )
      .toBe("ready");
    initial.child.kill("SIGKILL");
    await initial.result;
    const status = await launch(["status", ...common]).result;
    expect(status.code, status.stderr).toBe(0);
    const ids: string[] = JSON.parse(status.stdout).recovery
      .pendingOperationIds;
    expect(ids).toHaveLength(1);
    expect(calls).toBe(1);
    const resume = await launch(["resume", ...common]).result;
    expect(resume.code).toBe(1);
    expect(resume.stderr).toContain("RECOVERY_REQUIRED");
    expect(resume.stderr).toContain(ids[0]);
    const run = await launch([
      "run",
      ...common,
      "--prompt",
      "fixture",
      "--request-id",
      "two",
    ]).result;
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("RECOVERY_REQUIRED");
    const unconfirmed = await launch([
      "ack-recovery",
      ...common,
      "--operation-id",
      ids.join(","),
    ]).result;
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--confirm-effects-reviewed");
    const unknown = await launch([
      "ack-recovery",
      ...common,
      "--operation-id",
      "unknown",
      "--confirm-effects-reviewed",
    ]).result;
    expect(unknown.code).toBe(1);
    expect(calls).toBe(1);
    // The fixture's marker establishes the old shell finished before we acknowledge its effects.
    await expect
      .poll(
        async () => readFile(join(cwd, "shell-ended"), "utf8").catch(() => ""),
        { timeout: 5000 },
      )
      .toBe("done");
    expect(await readFile(join(cwd, "executions"), "utf8")).toBe("x");
    const acknowledged = await launch([
      "ack-recovery",
      ...common,
      "--operation-id",
      ids.join(","),
      "--confirm-effects-reviewed",
    ]).result;
    expect(acknowledged.code, acknowledged.stderr).toBe(0);
    expect(acknowledged.stdout).toContain("does not cancel");
    const afterAck = await launch(["status", ...common]).result;
    expect(JSON.parse(afterAck.stdout).recovery.pendingOperationIds).toEqual(
      [],
    );
    const recovered = await launch(["resume", ...common]).result;
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(await readFile(join(cwd, "executions"), "utf8")).toBe("x");
    expect(calls).toBe(2);
  } finally {
    initial.child.kill("SIGKILL");
    await initial.result;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 25_000);

/** Completions SSE fixture speaking the feature worker protocol: parse the
 * step from the last user message, answer with a read/write tool call first
 * and a JSON report (approved review) once tool results are in context. */
function featureWorkerServer() {
  let requests = 0;
  let failing = true;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests += 1;
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
  };
}

test("explicit budget reconciliation unblocks an unsettled model call across CLI processes", async () => {
  const fixture = await createFeatureFixture();
  const spec = {
    ...fixture.spec,
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
  };
  const { server, requests, serve } = featureWorkerServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP fixture");
  const specPath = join(fixture.root, "spec.json");
  const common = [
    "--db",
    fixture.dbPath,
    "--spec",
    specPath,
    "--model",
    "fixture",
    "--protocol",
    "completions",
    "--endpoint",
    `http://127.0.0.1:${address.port}/v1`,
  ];
  try {
    await writeFile(specPath, JSON.stringify(spec));
    const reconcileWorkflow = async () => {
      const inspected = await launch(["feature", ...common, "--inspect"])
        .result;
      expect(inspected.code, inspected.stderr).toBe(0);
      const state = JSON.parse(inspected.stdout);
      const reconciled = await launch(
        [
          "feature",
          ...common,
          "--reconcile",
          "--operation-id",
          state.operation.id,
          "--expected-workspace",
          JSON.stringify(state.currentWorkspace),
          "--confirm-effects-reviewed",
        ],
        60_000,
      ).result;
      expect(reconciled.code, reconciled.stderr).toBe(0);
    };
    // One failed model request persists an unsettled reservation and blocks.
    const failed = await launch(["feature", ...common], 60_000).result;
    expect(failed.code, failed.stderr).toBe(1);
    expect(JSON.parse(failed.stdout).status).toBe("blocked");
    expect(inspectBudget(fixture.dbPath)).toMatchObject({
      calls: 1,
      tokens: 0,
      pending: 1,
      reconciled: 0,
    });
    // Reconciling the workflow intent alone cannot bypass the budget block:
    // the retry attempt never reaches the endpoint and leaves the run blocked.
    await reconcileWorkflow();
    const stillBlocked = await launch(["feature", ...common], 60_000).result;
    expect(stillBlocked.code, stillBlocked.stderr).toBe(1);
    expect(JSON.parse(stillBlocked.stdout).status).toBe("blocked");
    expect(requests()).toBe(1);
    expect(inspectBudget(fixture.dbPath)).toMatchObject({
      calls: 1,
      pending: 1,
      reconciled: 0,
    });
    // The failed retry left a new workflow operation; clear it, then the
    // offline ledger reconciliation is the only remaining unlock.
    await reconcileWorkflow();
    const unlocked = await launch(
      ["feature", "--db", fixture.dbPath, "--reconcile-budget"],
      30_000,
    ).result;
    expect(unlocked.code, unlocked.stderr).toBe(0);
    const newline = unlocked.stdout.indexOf("\n");
    const decision = JSON.parse(
      newline < 0 ? unlocked.stdout : unlocked.stdout.slice(0, newline),
    );
    expect(decision.before).toMatchObject({ pending: 1, reconciled: 0 });
    expect(decision.after).toMatchObject({ pending: 0, reconciled: 1 });
    expect(unlocked.stdout).toContain("does not count tokens");
    // With the fixture serving, the same command resumes and completes.
    serve();
    const completed = await launch(["feature", ...common], 120_000).result;
    expect(completed.code, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout).status).toBe("completed");
    expect(await readFile(join(spec.worktreePath, "sum.js"), "utf8")).toBe(
      implementedSource,
    );
    expect(requests()).toBeGreaterThan(1);
    expect(inspectBudget(fixture.dbPath)).toMatchObject({
      pending: 0,
      reconciled: 1,
    });
    const calls = inspectBudget(fixture.dbPath)?.calls ?? 0;
    const tokens = inspectBudget(fixture.dbPath)?.tokens ?? 0;
    expect(calls).toBeGreaterThan(1);
    expect(tokens).toBeGreaterThan(0);
    // A held database lease refuses the offline reconciliation outright.
    const lease = await acquireDatabaseLease(fixture.dbPath);
    try {
      const refused = await launch(
        ["feature", "--db", fixture.dbPath, "--reconcile-budget"],
        30_000,
      ).result;
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("DATABASE_IN_USE");
      expect(refused.stdout).not.toContain("Budget reconciliation unblocks");
    } finally {
      lease.release();
    }
    // Without unsettled calls the reconciliation fails explicitly, never silently.
    const settled = await launch(
      ["feature", "--db", fixture.dbPath, "--reconcile-budget"],
      30_000,
    ).result;
    expect(settled.code).toBe(1);
    expect(settled.stdout).not.toContain("Budget reconciliation unblocks");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 300_000);
