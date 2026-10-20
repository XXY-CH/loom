import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
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
  return (await execute("git", ["-C", cwd, ...args])).stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loom-worktree-"));
  directories.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-qm", "baseline");
  const baseCommit = await git(root, "rev-parse", "HEAD");
  const manager = new WorkspaceManager();
  const options = {
    repositoryPath: root,
    runId: "one",
    baseCommit,
    worktreePath: join(root, "..", `${root.split("/").pop()}-run`),
  };
  directories.push(options.worktreePath);
  return { root, manager, options };
}

test("creates a commit workspace without copying or changing dirty main files, and discovers retries", async () => {
  const { root, manager, options } = await fixture();
  await writeFile(join(root, "tracked.txt"), "user change");
  await writeFile(join(root, "user.txt"), "untracked user");
  const record = await manager.create(options);
  expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe(
    "baseline\n",
  );
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user change");
  expect(await readFile(join(root, "user.txt"), "utf8")).toBe("untracked user");
  expect(await new WorkspaceManager().create(options)).toEqual(record);
  expect(await git(record.path, "branch", "--show-current")).toBe(
    "loom/run-one",
  );
  await manager.remove(record);
  await manager.remove(record);
  expect(await git(root, "rev-parse", "refs/heads/loom/run-one")).toBe(
    options.baseCommit,
  );
});

test("refuses dirty and ignored files during cleanup", async () => {
  const { manager, options } = await fixture();
  const record = await manager.create(options);
  await writeFile(join(record.path, "untracked.txt"), "keep");
  await expect(manager.remove(record)).rejects.toMatchObject({
    code: "WORKSPACE_DIRTY",
  });
  expect(await readFile(join(record.path, "untracked.txt"), "utf8")).toBe(
    "keep",
  );
  await rm(join(record.path, "untracked.txt"));
  await writeFile(
    join(record.gitDir, "..", "..", "info", "exclude"),
    "ignored.txt\n",
  );
  await writeFile(join(record.path, "ignored.txt"), "keep ignored");
  await expect(manager.remove(record)).rejects.toMatchObject({
    code: "WORKSPACE_DIRTY",
  });
});

test("rejects branch collisions and destination aliases", async () => {
  const { root, manager, options } = await fixture();
  await git(root, "branch", "loom/run-one");
  await expect(manager.create(options)).rejects.toMatchObject({
    code: "BRANCH_EXISTS",
  });
  const alias = join(root, "alias");
  await symlink(root, alias, "dir");
  await expect(
    manager.create({ ...options, runId: "alias", worktreePath: alias }),
  ).rejects.toMatchObject({ code: "PATH_EXISTS" });
});

test("rejects changed run baseline, branch identity and mutable refs", async () => {
  const { manager, options } = await fixture();
  await expect(
    manager.create({ ...options, baseCommit: "HEAD" }),
  ).rejects.toMatchObject({ code: "INVALID_BASE" });
  const record = await manager.create(options);
  await git(record.path, "checkout", "-qb", "foreign");
  await expect(manager.remove(record)).rejects.toMatchObject({
    code: "WORKSPACE_IDENTITY_CHANGED",
  });
  await expect(manager.create(options)).rejects.toMatchObject({
    code: "WORKSPACE_IDENTITY_CHANGED",
  });
});

test("concurrent mutations have one owner and a retry discovers the same workspace", async () => {
  const { manager, options } = await fixture();
  const attempts = await Promise.allSettled([
    manager.create(options),
    new WorkspaceManager().create(options),
  ]);
  const success = attempts.filter((attempt) => attempt.status === "fulfilled");
  expect(success.length).toBeGreaterThanOrEqual(1);
  for (const attempt of attempts) {
    if (attempt.status === "rejected")
      expect(attempt.reason.code).toBe("WORKSPACE_BUSY");
  }
  const record = await manager.create(options);
  expect(await git(record.path, "rev-parse", "HEAD")).toBe(options.baseCommit);
});

test("separate processes cannot allocate duplicate worktrees for the same run", async () => {
  const { manager, options } = await fixture();
  const moduleUrl = new URL("../src/workspace/manager.ts", import.meta.url)
    .href;
  const source = `import { WorkspaceManager } from ${JSON.stringify(moduleUrl)};
try { console.log(JSON.stringify(await new WorkspaceManager().create(JSON.parse(process.argv[1])))); }
catch (error) { if (error.code === 'WORKSPACE_BUSY') { console.log('busy'); } else { throw error; } }`;
  const invoke = () =>
    execute(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      source,
      JSON.stringify(options),
    ]);
  const results = await Promise.all([invoke(), invoke()]);
  const record = await manager.create(options);
  const records = results
    .filter((result) => result.stdout.trim() !== "busy")
    .map((result) => JSON.parse(result.stdout));
  expect(records.length).toBeGreaterThanOrEqual(1);
  for (const discovered of records) expect(discovered).toEqual(record);
  expect(
    (
      await git(options.repositoryPath, "worktree", "list", "--porcelain")
    ).split(`branch refs/heads/${record.branch}`),
  ).toHaveLength(2);
});
