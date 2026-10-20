import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseOptions } from "../src/cli/options.js";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function launch(args: string[]) {
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
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
