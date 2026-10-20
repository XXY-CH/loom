import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitFile, GitSnapshot, WorktreeSnapshot } from "../tui/types.js";
import { cleanGitEnvironment } from "./git-env.js";

const execute = promisify(execFile);
const PREVIEW_BYTES = 64 * 1024;
const GIT_BYTES = 8 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execute(
      "git",
      [
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd,
        timeout: 8_000,
        maxBuffer: GIT_BYTES,
        encoding: "utf8",
        env: {
          ...cleanGitEnvironment(),
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return result.stdout;
  } catch {
    // Git errors may contain remote URLs or user configuration. Keep them out of the UI.
    throw new Error(
      "Git observation failed; repository unavailable, busy, or output limit exceeded.",
    );
  }
}

function fields(record: string, count: number): [string[], string] {
  const values: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(" ", offset);
    if (end < 0) throw new Error("Invalid Git status record.");
    values.push(record.slice(offset, end));
    offset = end + 1;
  }
  return [values, record.slice(offset)];
}

function parseStatus(status: string, snapshot: GitSnapshot): void {
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) snapshot.head = record.slice(13);
    else if (record.startsWith("# branch.head "))
      snapshot.branch = record.slice(14);
    else if (record.startsWith("# branch.upstream "))
      snapshot.upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const [, ahead, behind] =
        record.match(/^# branch.ab \+(\d+) -(\d+)$/) ?? [];
      snapshot.ahead = Number(ahead ?? 0);
      snapshot.behind = Number(behind ?? 0);
    } else if (/^[12u?] /.test(record)) {
      const kind = record[0];
      const [metadata, path] = fields(
        record,
        kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 1,
      );
      const xy = kind === "?" ? "??" : (metadata[1] ?? "..");
      const file: GitFile = {
        path,
        index: xy[0] ?? ".",
        working: xy[1] ?? ".",
        additions: 0,
        deletions: 0,
        binary: false,
      };
      if (kind === "2") file.originalPath = records[++i] ?? "";
      snapshot.files.push(file);
    }
  }
}

function parseWorktrees(output: string): WorktreeSnapshot[] {
  const worktrees: WorktreeSnapshot[] = [];
  let current: WorktreeSnapshot | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = {
        path: field.slice(9),
        head: "",
        branch: "",
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      worktrees.push(current);
    } else if (current) {
      if (field.startsWith("HEAD ")) current.head = field.slice(5);
      else if (field.startsWith("branch "))
        current.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "bare") current.bare = true;
      else if (field === "detached") current.detached = true;
      else if (field === "locked" || field.startsWith("locked "))
        current.locked = true;
      else if (field === "prunable" || field.startsWith("prunable "))
        current.prunable = true;
    }
  }
  return worktrees;
}

function applyNumstat(output: string, files: Map<string, GitFile>): void {
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(record);
    if (!match) continue;
    let path = match[3] ?? "";
    if (!path) {
      i++; // Original name in -z rename records.
      path = records[++i] ?? "";
    }
    const file = files.get(path);
    if (!file) continue;
    file.binary ||= match[1] === "-" || match[2] === "-";
    file.additions += Number.parseInt(match[1] ?? "0", 10) || 0;
    file.deletions += Number.parseInt(match[2] ?? "0", 10) || 0;
  }
}

async function preview(
  root: string,
  path: string,
): Promise<{ text: string; binary: boolean; truncated: boolean }> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("Invalid Git file path.");
  // Resolve parent directories, then refuse final-component symlinks as well.
  const canonical = await realpath(target);
  const canonicalRel = relative(root, canonical);
  if (
    isAbsolute(canonicalRel) ||
    canonicalRel === ".." ||
    canonicalRel.startsWith("../")
  )
    throw new Error("Git preview is outside repository.");
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Git preview is not a regular file.");
    const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, PREVIEW_BYTES));
    return {
      text: bytes.toString("utf8"),
      binary: bytes.includes(0),
      truncated: bytesRead > PREVIEW_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/** Numstat totals combine staged and working changes; they are activity totals, not a HEAD diff. */
export async function readGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const root = await realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""),
  );
  const [status, worktrees, staged, working] = await Promise.all([
    git(root, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]),
    git(root, ["worktree", "list", "--porcelain", "-z"]),
    git(root, [
      "diff",
      "--cached",
      "--numstat",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
    ]),
    git(root, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]),
  ]);
  const snapshot: GitSnapshot = {
    root,
    branch: "",
    head: "",
    ahead: 0,
    behind: 0,
    files: [],
    worktrees: parseWorktrees(worktrees),
    observedAt: 0,
  };
  parseStatus(status, snapshot);
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  applyNumstat(staged, files);
  applyNumstat(working, files);
  // Limit untracked reads and concurrency. Unreadable/symlink files remain visible with unknown (zero) counts.
  for (const file of snapshot.files) {
    if (file.index !== "?") continue;
    try {
      const content = await preview(root, file.path);
      file.binary = content.binary;
      if (!content.binary && !content.truncated)
        file.additions = content.text
          ? content.text.split("\n").length -
            (content.text.endsWith("\n") ? 1 : 0)
          : 0;
    } catch {
      /* A file may disappear during observation. */
    }
  }
  // Bounded per-worktree observation: visible absence is never labelled clean.
  const observable = snapshot.worktrees
    .filter((tree) => !tree.bare && !tree.prunable)
    .slice(0, 20);
  for (let offset = 0; offset < observable.length; offset += 4) {
    await Promise.all(
      observable.slice(offset, offset + 4).map(async (tree) => {
        try {
          const view: GitSnapshot = { ...snapshot, files: [] };
          parseStatus(
            tree.path === root
              ? status
              : await git(tree.path, [
                  "status",
                  "--porcelain=v2",
                  "-z",
                  "--untracked-files=all",
                ]),
            view,
          );
          const conflicts = view.files.filter((file) =>
            ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
              file.index + file.working,
            ),
          );
          tree.changes = {
            staged: view.files.filter(
              (file) =>
                ![".", "?", " "].includes(file.index) &&
                !conflicts.includes(file),
            ).length,
            working: view.files.filter(
              (file) =>
                ![".", "?", " "].includes(file.working) &&
                !conflicts.includes(file),
            ).length,
            untracked: view.files.filter((file) => file.index === "?").length,
            conflicts: conflicts.length,
          };
        } catch {
          tree.statusUnavailable = true;
        }
      }),
    );
  }
  snapshot.observedAt = Date.now();
  return snapshot;
}

export async function readGitDiff(
  cwd: string,
  file: GitFile,
  mode: "working" | "staged" = "working",
): Promise<string> {
  const root = await realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""),
  );
  for (const path of [
    file.path,
    ...(file.originalPath ? [file.originalPath] : []),
  ]) {
    const rel = relative(root, resolve(root, path));
    if (isAbsolute(path) || rel === ".." || rel.startsWith("../")) {
      throw new Error("Invalid Git file path.");
    }
  }
  if (file.index === "?" && mode === "working") {
    try {
      const content = await preview(root, file.path);
      if (content.binary) return "Binary file (untracked)";
      return `Untracked file: ${file.path}\n${content.text}${content.truncated ? "\n… preview truncated (64 KiB)" : ""}`;
    } catch {
      return "Preview unavailable (file removed, unreadable, or symbolic link).";
    }
  }
  const output = await git(root, [
    "diff",
    ...(mode === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--",
    ...(file.originalPath ? [file.originalPath] : []),
    file.path,
  ]);
  return output.length > PREVIEW_BYTES
    ? `${output.slice(0, PREVIEW_BYTES)}\n… preview truncated (64 KiB)`
    : output;
}
