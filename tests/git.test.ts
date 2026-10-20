import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGitDiff, readGitSnapshot } from "../src/workspace/git.js";

const execute = promisify(execFile);
const directories: string[] = [];
async function command(cwd: string, ...args: string[]) {
  return execute("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}
async function repository() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "loom-git-")));
  directories.push(base);
  const cwd = join(base, "repo");
  await mkdir(cwd);
  await command(cwd, "init", "-b", "main");
  await command(cwd, "config", "user.email", "test@example.invalid");
  await command(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "tracked.txt"), "first\n");
  await command(cwd, "add", ".");
  await command(cwd, "commit", "-m", "initial");
  return { base, cwd };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("read-only live Git projection", () => {
  it("ignores inherited repository selectors when observing another repository", async () => {
    const target = await repository();
    const foreign = await repository();
    await command(foreign.cwd, "checkout", "-b", "foreign");
    await writeFile(join(target.cwd, "tracked.txt"), "target-only\n");
    await writeFile(join(foreign.cwd, "tracked.txt"), "foreign-only\n");
    vi.stubEnv("GIT_DIR", join(foreign.cwd, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign.cwd);
    vi.stubEnv("GIT_INDEX_FILE", join(foreign.cwd, ".git/index"));
    vi.stubEnv("GIT_COMMON_DIR", join(foreign.cwd, ".git"));
    const snapshot = await readGitSnapshot(target.cwd);
    expect(snapshot.root).toBe(target.cwd);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.worktrees.map((tree) => tree.path)).toEqual([target.cwd]);
    const changed = snapshot.files.find((file) => file.path === "tracked.txt");
    if (!changed) throw new Error("Missing target change");
    const diff = await readGitDiff(target.cwd, changed);
    expect(diff).toContain("+target-only");
    expect(diff).not.toContain("foreign-only");
  });

  it("observes actual staged/working changes, unusual paths and bounded untracked previews", async () => {
    const { cwd } = await repository();
    const weird = "--新 name\nline.txt";
    await rename(join(cwd, "tracked.txt"), join(cwd, weird));
    await command(cwd, "add", "-A");
    await writeFile(join(cwd, weird), "first\nworking\n");
    await writeFile(join(cwd, "new.txt"), "new\nfile\n");
    await writeFile(join(cwd, "binary"), Buffer.from([1, 0, 2]));
    await writeFile(join(cwd, "large"), "x".repeat(100_000));
    const indexBefore = await readFile(join(cwd, ".git/index"));
    const snapshot = await readGitSnapshot(cwd);
    expect(snapshot.branch).toBe("main");
    expect(
      snapshot.worktrees.find((tree) => tree.path === cwd)?.changes,
    ).toMatchObject({ staged: 1, working: 1, untracked: 3, conflicts: 0 });
    expect(snapshot.observedAt).toBeGreaterThan(Date.now() - 10_000);
    const changed = snapshot.files.find((file) => file.path === weird);
    expect(changed).toMatchObject({
      originalPath: "tracked.txt",
      index: "R",
      working: "M",
      additions: 1,
      deletions: 0,
    });
    if (!changed) throw new Error("Missing rename");
    expect(await readGitDiff(cwd, changed, "staged")).toContain(
      "rename from tracked.txt",
    );
    expect(await readGitDiff(cwd, changed)).toContain("+working");
    await mkdir(join(cwd, "nested"));
    expect(await readGitDiff(join(cwd, "nested"), changed)).toContain(
      "+working",
    );
    expect(
      snapshot.files.find((file) => file.path === "new.txt"),
    ).toMatchObject({ index: "?", working: "?", additions: 2 });
    const binary = snapshot.files.find((file) => file.path === "binary");
    const large = snapshot.files.find((file) => file.path === "large");
    expect(binary?.binary).toBe(true);
    if (!binary || !large) throw new Error("Missing untracked files");
    expect(await readGitDiff(cwd, binary)).toContain("Binary file");
    expect(await readGitDiff(cwd, large)).toContain("truncated");
    expect(await readFile(join(cwd, ".git/index"))).toEqual(indexBefore);
    await writeFile(join(cwd, "new.txt"), "updated\n");
    expect(
      (await readGitSnapshot(cwd)).files.find((file) => file.path === "new.txt")
        ?.additions,
    ).toBe(1);
  });

  it("projects detached, locked and prunable worktrees without changing their state", async () => {
    const { base, cwd } = await repository();
    const detached = join(base, "detached 空\n间");
    const stale = join(base, "stale");
    await command(cwd, "worktree", "add", "--detach", detached);
    await command(
      cwd,
      "worktree",
      "lock",
      "--reason",
      "user owns it",
      detached,
    );
    await command(cwd, "worktree", "add", "-b", "stale", stale);
    await rm(stale, { recursive: true });
    const snapshot = await readGitSnapshot(cwd);
    expect(
      snapshot.worktrees.find((tree) => tree.path === detached),
    ).toMatchObject({ detached: true, locked: true });
    expect(
      snapshot.worktrees.find((tree) => tree.path === stale),
    ).toMatchObject({ prunable: true, branch: "stale" });
    expect((await readGitSnapshot(detached)).branch).toBe("(detached)");
  });

  it("reports conflicts and locally known divergence without fetching", async () => {
    const { cwd } = await repository();
    await command(cwd, "branch", "topic");
    await writeFile(join(cwd, "tracked.txt"), "main\n");
    await command(cwd, "commit", "-am", "main change");
    await command(cwd, "checkout", "topic");
    await writeFile(join(cwd, "tracked.txt"), "topic\n");
    await command(cwd, "commit", "-am", "topic change");
    await command(cwd, "config", "branch.topic.remote", ".");
    await command(cwd, "config", "branch.topic.merge", "refs/heads/main");
    await expect(command(cwd, "merge", "main")).rejects.toThrow();
    const snapshot = await readGitSnapshot(cwd);
    expect(snapshot).toMatchObject({ upstream: "main", ahead: 1, behind: 1 });
    expect(
      snapshot.files.find((file) => file.path === "tracked.txt"),
    ).toMatchObject({ index: "U", working: "U" });
  });

  it("does not invoke external diff drivers or preview symlinks outside the repository", async () => {
    const { base, cwd } = await repository();
    const marker = join(base, "should-not-exist");
    const script = join(base, "driver.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await command(cwd, "config", "diff.external", script);
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const outside = join(base, "private");
    await writeFile(outside, "do-not-preview");
    await symlink(outside, join(cwd, "link"));
    const snapshot = await readGitSnapshot(cwd);
    const changed = snapshot.files.find((file) => file.path === "tracked.txt");
    const link = snapshot.files.find((file) => file.path === "link");
    if (!changed || !link) throw new Error("Missing files");
    expect(await readGitDiff(cwd, changed)).toContain("+changed");
    expect(await readGitDiff(cwd, link)).not.toContain("do-not-preview");
    await expect(readFile(marker)).rejects.toThrow();
    await expect(readGitSnapshot(base)).rejects.toThrow(
      "Git observation failed",
    );
  });
});
