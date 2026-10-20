import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

function launch(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, result };
}

test("resume exits nonzero when a recovered request fails, without echoing server errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-cli-resume-"));
  const responseSecret = "fixture-server-echo-must-not-be-printed";
  let rejectRequests = false;
  let markRequest: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    markRequest = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    markRequest?.();
    if (rejectRequests) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: responseSecret, type: "authentication_error" },
        }),
      );
    }
    // First request deliberately remains in flight so the persisted generation is interrupted.
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
  const timeout = setTimeout(() => initial.child.kill("SIGKILL"), 5000);
  try {
    await Promise.race([
      requestStarted,
      initial.result.then(() => {
        throw new Error("Fixture CLI exited before its request");
      }),
    ]);
    initial.child.kill("SIGKILL");
    await initial.result;
    rejectRequests = true;
    const resumed = launch(["resume", ...common]);
    const resumeTimeout = setTimeout(() => resumed.child.kill("SIGKILL"), 5000);
    let result: Awaited<typeof resumed.result>;
    try {
      result = await resumed.result;
    } finally {
      clearTimeout(resumeTimeout);
    }
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).submissions).toEqual({
      queued: 0,
      placed: 0,
      done: 0,
      unanswered: 1,
    });
    expect(result.stdout + result.stderr).not.toContain(responseSecret);
    expect(result.stderr).toContain("unanswered or unfinished");

    // A fresh status process must read the settled failure from the database.
    const status = await launch(["status", ...common]).result;
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).submissions.unanswered).toBe(1);
    const repeated = await launch(["resume", ...common]).result;
    expect(repeated.code, repeated.stderr).toBe(1);
  } finally {
    clearTimeout(timeout);
    initial.child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 15000);
