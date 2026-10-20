import { isUtf8 } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceIdentity } from "../workflow/index.js";
import { cleanGitEnvironment } from "./git-env.js";
import { WorkspaceManager, type WorkspaceRecord } from "./manager.js";

const execute = promisify(execFile);
const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 1024 * 1024;

async function snapshot(record: WorkspaceRecord): Promise<WorkspaceIdentity> {
  const inspected = await new WorkspaceManager().inspect(record);
  // Read raw worktree bytes, never diff drivers, external diff, or textconv.
  const { stdout } = await execute(
    "git",
    [
      "-C",
      record.path,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      env: cleanGitEnvironment(),
      encoding: "buffer",
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * OUTPUT_LIMIT,
    },
  );
  if (!isUtf8(stdout))
    throw new Error("Workspace contains unsupported non-UTF-8 paths");
  const paths = [
    ...new Set(stdout.toString("utf8").split("\0").filter(Boolean)),
  ].sort();
  const hash = createHash("sha256");
  const field = (value: string) =>
    hash.update(`${Buffer.byteLength(value)}:${value}`);
  field(inspected.head);
  for (const path of paths) {
    if (path.split("/").some((part) => part === ".git" || part === "..")) {
      throw new Error("Workspace contains an unsupported Git metadata path");
    }
    field(path);
    const absolute = join(record.path, path);
    // Refuse symlink ancestors instead of reading files outside this worktree.
    const parent = await realpath(dirname(absolute)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (parent !== undefined && parent !== dirname(absolute))
      throw new Error("Workspace file has a symlink ancestor");
    const before = await lstat(absolute).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!before) {
      field("deleted");
      continue;
    }
    field(String(before.mode));
    if (before.isSymbolicLink()) {
      field("symlink");
      field((await readlink(absolute, { encoding: "buffer" })).toString("hex"));
    } else if (before.isFile()) {
      field("file");
      field(String(before.size));
      // O_NOFOLLOW prevents replacing a regular file with a symlink between checks.
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await file.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new Error("Workspace file changed before reading its content");
        for await (const chunk of file.createReadStream({ autoClose: false }))
          hash.update(chunk);
      } finally {
        await file.close();
      }
    } else {
      throw new Error(`Unsupported workspace file type: ${path}`);
    }
    const after = await lstat(absolute);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Workspace changed while collecting its fingerprint");
    }
  }
  const after = await new WorkspaceManager().inspect(record);
  if (after.head !== inspected.head)
    throw new Error("Workspace HEAD changed while collecting its fingerprint");
  return {
    workspaceId: record.workspaceId,
    head: inspected.head,
    fingerprint: hash.digest("hex"),
  };
}

/** Covers tracked and nonignored untracked paths. Ignored files are outside acceptance evidence. */
export async function fingerprintWorkspace(
  record: WorkspaceRecord,
): Promise<WorkspaceIdentity> {
  const first = await snapshot(record);
  const second = await snapshot(record);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Workspace changed while collecting its fingerprint");
  }
  return second;
}

/** Caller must persist command intent before invoking this potentially mutating operation. */
export async function collectCommand(input: {
  workspace: WorkspaceRecord;
  command: readonly string[];
  signal: AbortSignal;
}): Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  before: WorkspaceIdentity;
  after: WorkspaceIdentity;
}> {
  input.signal.throwIfAborted();
  const executable = input.command[0];
  if (!executable || input.command.some((value) => value.includes("\0")))
    throw new Error("Command must contain valid argv");
  if (process.platform === "win32")
    throw new Error("Command evidence requires POSIX process groups");
  const before = await fingerprintWorkspace(input.workspace);
  input.signal.throwIfAborted();
  const result = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(executable, input.command.slice(1), {
      cwd: input.workspace.path,
      env: cleanGitEnvironment(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure ??= error as Error;
        }
      }
    };
    const stop = (error: Error) => {
      failure ??= error;
      kill();
    };
    const abort = () => stop(new Error("Command cancelled"));
    const timer = setTimeout(
      () => stop(new Error("Command exceeded 30000ms timeout")),
      TIMEOUT_MS,
    );
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT)
        stop(new Error("Command exceeded 1MiB output limit"));
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => stop(error));
    child.once("exit", kill);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      kill();
      if (failure) reject(failure);
      else if (signal || code === null)
        reject(
          new Error(
            `Command terminated without an exit code (${signal ?? "unknown"})`,
          ),
        );
      else
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
  input.signal.throwIfAborted();
  const after = await fingerprintWorkspace(input.workspace);
  return { command: JSON.stringify(input.command), ...result, before, after };
}
