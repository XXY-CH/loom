import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  collectCommand,
  fingerprintWorkspace,
} from "../src/workspace/evidence.js";
import { cleanGitEnvironment } from "../src/workspace/git-env.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function git(cwd: string, ...args: string[]) {
  return (
    await execute("git", ["-C", cwd, ...args], { env: cleanGitEnvironment() })
  ).stdout.trim();
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "loom-evidence-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await execute("git", ["init", "-q", root], { env: cleanGitEnvironment() });
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  return new WorkspaceManager().create({
    repositoryPath: root,
    runId: "evidence",
    baseCommit: await git(root, "rev-parse", "HEAD"),
    worktreePath: join(directory, "run"),
  });
}

test("fingerprint includes full clean tracked bytes, mode, deletion, untracked paths, and symlink targets", async () => {
  const record = await fixture();
  const original = await fingerprintWorkspace(record);
  expect(await fingerprintWorkspace(record)).toEqual(original);
  await writeFile(join(record.path, "tracked.txt"), "different\n");
  const changed = await fingerprintWorkspace(record);
  expect(changed.fingerprint).not.toBe(original.fingerprint);
  // Same porcelain status but different bytes must produce different evidence.
  await writeFile(join(record.path, "tracked.txt"), "different again\n");
  expect((await fingerprintWorkspace(record)).fingerprint).not.toBe(
    changed.fingerprint,
  );
  await writeFile(join(record.path, "tracked.txt"), "baseline\n");
  await chmod(join(record.path, "tracked.txt"), 0o755);
  expect((await fingerprintWorkspace(record)).fingerprint).not.toBe(
    original.fingerprint,
  );
  await chmod(join(record.path, "tracked.txt"), 0o644);
  expect(await fingerprintWorkspace(record)).toEqual(original);
  await rm(join(record.path, "tracked.txt"));
  expect((await fingerprintWorkspace(record)).fingerprint).not.toBe(
    original.fingerprint,
  );
  await writeFile(join(record.path, "tracked.txt"), "baseline\n");
  await writeFile(join(record.path, "untracked.txt"), "new");
  const untracked = await fingerprintWorkspace(record);
  expect(untracked.fingerprint).not.toBe(original.fingerprint);
  await rm(join(record.path, "untracked.txt"));
  await symlink("tracked.txt", join(record.path, "link"));
  const link = await fingerprintWorkspace(record);
  await rm(join(record.path, "link"));
  await symlink("missing.txt", join(record.path, "link"));
  expect((await fingerprintWorkspace(record)).fingerprint).not.toBe(
    link.fingerprint,
  );
});

test("ignored files and Git metadata are explicitly outside fingerprint coverage", async () => {
  const record = await fixture();
  const original = await fingerprintWorkspace(record);
  await writeFile(join(record.path, "ignored.txt"), "ignored data");
  await writeFile(
    join(record.gitDir, "unrelated-metadata"),
    "not worktree evidence",
  );
  expect(await fingerprintWorkspace(record)).toEqual(original);
});

test("hashes every tracked file even when Git marks it assume-unchanged", async () => {
  const record = await fixture();
  const original = await fingerprintWorkspace(record);
  await git(record.path, "update-index", "--assume-unchanged", "tracked.txt");
  await writeFile(join(record.path, "tracked.txt"), "hidden modification\n");
  expect(await git(record.path, "status", "--porcelain")).toBe("");
  expect((await fingerprintWorkspace(record)).fingerprint).not.toBe(
    original.fingerprint,
  );
});

test("ignores inherited Git routing/config and never invokes diff drivers", async () => {
  const record = await fixture();
  const original = await fingerprintWorkspace(record);
  const poison = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: "/missing",
    GIT_CONFIG_PARAMETERS: "invalid config",
    GIT_NAMESPACE: "bad",
    GIT_DIR: "/missing",
    GIT_INDEX_FILE: "/missing",
  };
  const previous = new Map(
    Object.keys(poison).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, poison);
    expect(await fingerprintWorkspace(record)).toEqual(original);
    const result = await collectCommand({
      workspace: record,
      command: ["git", "rev-parse", "HEAD"],
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(record.head);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await git(record.path, "config", "diff.external", "/missing-diff-driver");
  expect(await fingerprintWorkspace(record)).toEqual(original);
});

test("collects real argv, nonzero exit, stdout/stderr, and before/after mutation evidence", async () => {
  const record = await fixture();
  const command = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('tracked.txt', process.argv[1]);process.stdout.write('out');process.stderr.write('err');process.exit(7)",
    "literal $HOME ; value",
  ];
  const result = await collectCommand({
    workspace: record,
    command,
    signal: new AbortController().signal,
  });
  expect(result.command).toBe(JSON.stringify(command));
  expect(result.exitCode).toBe(7);
  expect(result.stdout).toBe("out");
  expect(result.stderr).toBe("err");
  expect(result.before.fingerprint).not.toBe(result.after.fingerprint);
  expect(result.after).toEqual(await fingerprintWorkspace(record));
  expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe(
    "literal $HOME ; value",
  );
});

test("unchanged commands preserve evidence and signal termination cannot pass", async () => {
  const record = await fixture();
  const input = { workspace: record, signal: new AbortController().signal };
  const result = await collectCommand({
    ...input,
    command: [process.execPath, "-e", "process.stdout.write('ok')"],
  });
  expect(result.before).toEqual(result.after);
  await expect(
    collectCommand({
      ...input,
      command: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
    }),
  ).rejects.toThrow("terminated without an exit code");
});

test("output overflow and missing executables fail closed", async () => {
  const record = await fixture();
  const input = { workspace: record, signal: new AbortController().signal };
  await expect(
    collectCommand({
      ...input,
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.alloc(1024 * 1024 + 1))",
      ],
    }),
  ).rejects.toThrow("output limit");
  await expect(
    collectCommand({ ...input, command: ["/missing-loom-executable"] }),
  ).rejects.toThrow();
});

test("cancellation terminates the command process group, including descendants", async () => {
  const record = await fixture();
  const controller = new AbortController();
  const marker = join(record.path, "started.txt");
  const late = join(record.path, "late.txt");
  const command = [
    process.execPath,
    "-e",
    "const cp=require('node:child_process');cp.spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync('late.txt','leaked'),700);setInterval(()=>{},1000)`],{stdio:'ignore'});require('node:fs').writeFileSync('started.txt','yes');setInterval(()=>{},1000)",
  ];
  const pending = collectCommand({
    workspace: record,
    command,
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow("cancelled");
  for (let i = 0; i < 100; i++) {
    if (await readFile(marker, "utf8").catch(() => "")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await readFile(marker, "utf8")).toBe("yes");
  controller.abort();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 900));
  await expect(readFile(late)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a hung command fails at its real 30-second deadline", async () => {
  const record = await fixture();
  await expect(
    collectCommand({
      workspace: record,
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("30000ms timeout");
}, 35_000);

test("an already cancelled command cannot mutate the workspace", async () => {
  const record = await fixture();
  const signal = AbortSignal.abort();
  await expect(
    collectCommand({
      workspace: record,
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('forbidden.txt','bad')",
      ],
      signal,
    }),
  ).rejects.toThrow();
  await expect(
    readFile(join(record.path, "forbidden.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
