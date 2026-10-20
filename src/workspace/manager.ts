import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { cleanGitEnvironment } from "./git-env.js";

const execute = promisify(execFile);
const TIMEOUT = 30_000;

export interface CreateWorkspaceOptions {
  repositoryPath: string;
  runId: string;
  /** Full commit object ID: mutable refs are deliberately not accepted. */
  baseCommit: string;
  worktreePath: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  runId: string;
  repositoryRoot: string;
  repositoryCommonDir: string;
  path: string;
  branch: string;
  baseCommit: string;
  head: string;
  gitDir: string;
  device: number;
  inode: number;
}

type Intent = {
  version: 1;
  options: CreateWorkspaceOptions;
  repositoryRoot: string;
  repositoryCommonDir: string;
  state: "creating" | "ready" | "removed";
  record?: WorkspaceRecord;
};

export class WorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], {
    timeout: TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
    env: cleanGitEnvironment(),
  });
  return result.stdout.trimEnd();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  if (await exists(absolute)) return realpath(absolute);
  return join(
    await realpath(dirname(absolute)),
    absolute.slice(dirname(absolute).length + 1),
  );
}

async function repository(path: string) {
  const root = await realpath(
    await git(path, ["rev-parse", "--show-toplevel"]),
  );
  const common = await realpath(
    await git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  return { root, common };
}

function fail(code: string, message: string): never {
  throw new WorkspaceError(code, message);
}

/** Git lifecycle only; callers must stop writers before remove. This is not a runtime lease. */
export class WorkspaceManager {
  private async locked<T>(
    common: string,
    action: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = join(common, "loom-workspaces");
    await mkdir(directory, { recursive: true });
    const lock = join(directory, "mutation.lock");
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        fail(
          "WORKSPACE_BUSY",
          "Workspace mutation is in progress or needs manual lock reconciliation",
        );
      }
      throw error;
    }
    try {
      return await action(directory);
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  private async save(path: string, intent: Intent) {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  async create(input: CreateWorkspaceOptions): Promise<WorkspaceRecord> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.runId)) {
      fail(
        "INVALID_RUN_ID",
        "runId must contain 1-80 ASCII letters, digits, underscores or hyphens",
      );
    }
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.baseCommit)) {
      fail("INVALID_BASE", "baseCommit must be a full commit object ID");
    }
    if (!isAbsolute(input.worktreePath) || input.worktreePath.includes("\0")) {
      fail("INVALID_PATH", "worktreePath must be an absolute filesystem path");
    }
    const { root, common } = await repository(input.repositoryPath);
    const path = await canonicalDestination(input.worktreePath);
    const commit = await git(root, [
      "rev-parse",
      "--verify",
      `${input.baseCommit}^{commit}`,
    ]);
    if (commit !== input.baseCommit.toLowerCase())
      fail("INVALID_BASE", "baseCommit must identify a commit directly");
    const options = {
      ...input,
      repositoryPath: root,
      worktreePath: path,
      baseCommit: commit,
    };
    const branch = `loom/run-${input.runId}`;
    return this.locked(common, async (directory) => {
      const recordPath = join(directory, `${input.runId}.json`);
      let intent: Intent;
      if (await exists(recordPath)) {
        intent = JSON.parse(await readFile(recordPath, "utf8")) as Intent;
        if (
          intent.version !== 1 ||
          intent.repositoryCommonDir !== common ||
          intent.options.worktreePath !== path ||
          intent.options.baseCommit !== commit
        ) {
          fail(
            "WORKSPACE_CONFLICT",
            "Recorded workspace identity or baseline differs",
          );
        }
        if (intent.state === "removed")
          fail("WORKSPACE_REMOVED", "This run workspace was already removed");
        if (intent.record) return this.inspect(intent.record);
      } else {
        if (await exists(path))
          fail(
            "PATH_EXISTS",
            "Destination already exists; it is not owned by this run",
          );
        const refs = await git(root, [
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${branch}`,
        ]);
        if (refs)
          fail(
            "BRANCH_EXISTS",
            "Run branch already exists; it is not owned by this run",
          );
        intent = {
          version: 1,
          options,
          repositoryRoot: root,
          repositoryCommonDir: common,
          state: "creating",
        };
        await this.save(recordPath, intent);
      }
      // An incomplete create is discovered by Git, never repaired by resetting or deleting files.
      const listed = await git(root, ["worktree", "list", "--porcelain", "-z"]);
      const entries = listed.split("\0\0").map((entry) => entry.split("\0"));
      const discovered = entries.find((entry) =>
        entry.includes(`worktree ${path}`),
      );
      if (!discovered) {
        if (await exists(path))
          fail(
            "WORKSPACE_CONFLICT",
            "Incomplete creation left an unregistered destination; reconcile manually",
          );
        await git(root, ["worktree", "add", "-b", branch, "--", path, commit]);
      } else if (
        !discovered.includes(`branch refs/heads/${branch}`) ||
        !discovered.includes(`HEAD ${commit}`)
      ) {
        fail(
          "WORKSPACE_CONFLICT",
          "Incomplete workspace no longer matches the recorded branch and commit",
        );
      }
      const info = await stat(path);
      const record: WorkspaceRecord = {
        workspaceId: `run-${input.runId}`,
        runId: input.runId,
        repositoryRoot: root,
        repositoryCommonDir: common,
        path,
        branch,
        baseCommit: commit,
        head: await git(path, ["rev-parse", "HEAD"]),
        gitDir: await realpath(
          await git(path, ["rev-parse", "--absolute-git-dir"]),
        ),
        device: info.dev,
        inode: info.ino,
      };
      intent.record = record;
      intent.state = "ready";
      await this.save(recordPath, intent);
      return record;
    });
  }

  async inspect(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    const actual = await repository(record.path);
    const info = await stat(record.path);
    const gitDir = await realpath(
      await git(record.path, ["rev-parse", "--absolute-git-dir"]),
    );
    const branch = await git(record.path, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (
      actual.common !== record.repositoryCommonDir ||
      actual.root !== record.path ||
      (await realpath(record.path)) !== record.path ||
      info.dev !== record.device ||
      info.ino !== record.inode ||
      gitDir !== record.gitDir ||
      branch !== record.branch
    ) {
      fail(
        "WORKSPACE_IDENTITY_CHANGED",
        "Workspace path, directory, repository or branch identity changed",
      );
    }
    return { ...record, head: await git(record.path, ["rev-parse", "HEAD"]) };
  }

  async remove(record: WorkspaceRecord): Promise<void> {
    await this.locked(record.repositoryCommonDir, async (directory) => {
      const recordPath = join(directory, `${record.runId}.json`);
      const intent = JSON.parse(await readFile(recordPath, "utf8")) as Intent;
      if (
        !intent.record ||
        JSON.stringify(intent.record) !== JSON.stringify(record)
      ) {
        fail(
          "WORKSPACE_CONFLICT",
          "Cleanup requires the original persisted workspace record",
        );
      }
      if (intent.state === "removed") {
        if (await exists(record.path))
          fail("WORKSPACE_CONFLICT", "Removed workspace path was reused");
        return;
      }
      await this.inspect(record);
      const status = await git(record.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      if (status)
        fail(
          "WORKSPACE_DIRTY",
          "Workspace has tracked, untracked or ignored files; preserve and reconcile them first",
        );
      await git(record.repositoryRoot, [
        "worktree",
        "remove",
        "--",
        record.path,
      ]);
      intent.state = "removed";
      await this.save(recordPath, intent);
    });
  }
}
