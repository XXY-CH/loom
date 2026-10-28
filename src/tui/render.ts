import type { DashboardState, GitFile } from "./types.js";

type Tone = "text" | "muted" | "accent" | "good" | "warn" | "bad" | "selected";
type Line = { text: string; tone?: Tone };
const colors: Record<Tone, string> = {
  text: "\x1b[38;5;252m",
  muted: "\x1b[38;5;244m",
  accent: "\x1b[38;5;80m",
  good: "\x1b[38;5;114m",
  warn: "\x1b[38;5;221m",
  bad: "\x1b[38;5;210m",
  selected: "\x1b[48;5;24m\x1b[38;5;159m",
};
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Untrusted Git text must never become terminal commands, links or extra rows. */
function clean(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly remove terminal escape sequences.
      .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly remove terminal escape sequences.
      .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly remove terminal escape sequences.
      .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly remove terminal escape sequences.
      .replace(/\x1b[ -/]*[@-~]/g, "")
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
        character === "\u200d" ? character : " ",
      )
  );
}

function cellWidth(grapheme: string): number {
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme))
    return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

export function fitCells(value: string, width: number): string {
  if (width <= 0) return "";
  const parts = [...segments.segment(clean(value))].map(
    ({ segment }) => segment,
  );
  const total = parts.reduce((sum, part) => sum + cellWidth(part), 0);
  let used = 0;
  let result = "";
  const limit = total > width ? width - 1 : width;
  for (const part of parts) {
    const size = cellWidth(part);
    if (used + size > limit) break;
    result += part;
    used += size;
  }
  if (total > width) {
    result += "…";
    used++;
  }
  return result + " ".repeat(Math.max(0, width - used));
}

function paint(line: Line, width: number, color: boolean): string {
  const text = fitCells(line.text, width);
  return color ? `${colors[line.tone ?? "text"]}${text}\x1b[0m` : text;
}

/** Keep the insertion point visible without splitting terminal graphemes. */
function inputLine(state: DashboardState, width: number): string {
  const prefix = state.inputAdmitting ? "  … " : "  › ";
  const suffix = state.inputAdmitting ? "▏ [admitting]" : "▏";
  const budget = Math.max(0, width - prefix.length - suffix.length);
  const parts = [...segments.segment(clean(state.input ?? ""))].map(
    ({ segment }) => segment,
  );
  let used = 0;
  let start = parts.length;
  while (start > 0) {
    const size = cellWidth(parts[start - 1] ?? "");
    if (used + size > budget) break;
    used += size;
    start--;
  }
  return `${prefix}${parts.slice(start).join("")}${suffix}`;
}

function panel(
  title: string,
  lines: Line[],
  width: number,
  height: number,
  active: boolean,
): Line[] {
  if (width < 4)
    return Array.from(
      { length: height },
      (_, index) => lines[index] ?? { text: "" },
    );
  const inner = width - 2;
  return Array.from({ length: height }, (_, index): Line => {
    if (index === 0)
      return {
        text: `╭${fitCells(` ${active ? "● " : ""}${title} `, inner)
          .trimEnd()
          .padEnd(inner, "─")}╮`,
        tone: active ? "accent" : "muted",
      };
    if (index === height - 1)
      return { text: `╰${"─".repeat(inner)}╯`, tone: "muted" };
    const line = lines[index - 1] ?? { text: "" };
    return {
      text: `│${fitCells(line.text, inner)}│`,
      ...(line.tone ? { tone: line.tone } : {}),
    };
  });
}

function conflict(file: GitFile): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
    file.index + file.working,
  );
}
function basename(path: string): string {
  return path.replace(/\/$/, "").split("/").at(-1) || path;
}
function windowStart(
  selected: number,
  count: number,
  capacity: number,
): number {
  return Math.max(
    0,
    Math.min(selected - Math.max(0, capacity - 1), count - capacity),
  );
}

function worktreeLines(state: DashboardState, capacity: number): Line[] {
  const trees = state.git?.worktrees ?? [];
  if (!trees.length)
    return [{ text: "  No worktrees observed", tone: "muted" }];
  const visible = Math.max(1, Math.floor((capacity - 1) / 4));
  const start = windowStart(state.selectedWorktree, trees.length, visible);
  const lines: Line[] = [
    { text: `  ${trees.length} worktrees · read-only`, tone: "muted" },
  ];
  for (
    let index = start;
    index < Math.min(trees.length, start + visible);
    index++
  ) {
    const tree = trees[index];
    if (!tree) continue;
    const selected = index === state.selectedWorktree;
    lines.push({
      text: ` ${selected ? "›" : " "} ${basename(tree.path)}${tree.path === state.git?.root ? " · viewing" : ""}${tree.path === state.runtimeCwd ? " · runtime executes" : ""}`,
      tone: selected ? "selected" : "text",
    });
    lines.push({
      text: `   ${tree.detached ? `detached ${tree.head.slice(0, 7)}` : tree.branch || "(no branch)"}`,
      tone: tree.detached ? "warn" : "accent",
    });
    lines.push({
      text: tree.changes
        ? `   S${tree.changes.staged} W${tree.changes.working} ?${tree.changes.untracked} !${tree.changes.conflicts}`
        : "   status not observed",
      tone: tree.changes?.conflicts
        ? "bad"
        : tree.changes && Object.values(tree.changes).some(Boolean)
          ? "warn"
          : "muted",
    });
    const flags = [
      tree.bare && "bare",
      tree.locked && "locked",
      tree.prunable && "prunable",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push({
      text: `   ${flags || tree.path}`,
      tone: flags ? "warn" : "muted",
    });
  }
  if (start > 0 || start + visible < trees.length)
    lines.push({
      text: `  ${start + 1}–${Math.min(start + visible, trees.length)} / ${trees.length}`,
      tone: "muted",
    });
  return lines;
}

function wrapText(value: string, width: number): string[] {
  const result: string[] = [];
  for (const raw of value.split("\n")) {
    let line = "";
    let used = 0;
    for (const { segment } of segments.segment(clean(raw))) {
      const size = cellWidth(segment);
      if (used + size > Math.max(1, width)) {
        result.push(line);
        line = "";
        used = 0;
      }
      line += segment;
      used += size;
    }
    result.push(line);
  }
  return result;
}
function activityLines(
  state: DashboardState,
  capacity: number,
  width: number,
): Line[] {
  const header: Line[] = [
    { text: `  Runtime · ${state.runtimeStatus}`, tone: "accent" },
    ...(state.runtimeUsage
      ? [
          {
            text: `  Tokens in ${formatCount(state.runtimeUsage.total.input)} · out ${formatCount(state.runtimeUsage.total.output)}`,
            tone: "muted",
          } as Line,
          {
            text: `  Cache R ${formatCount(state.runtimeUsage.total.cacheRead)} · W ${formatCount(state.runtimeUsage.total.cacheWrite)}`,
            tone: "muted",
          } as Line,
          {
            text: `  Prompt cache ${state.runtimeUsage.total.cacheReadPromptRatio === null ? "unknown" : `${Math.round(state.runtimeUsage.total.cacheReadPromptRatio * 100)}%`}`,
            tone: "muted",
          } as Line,
        ]
      : state.runtimeUsageError
        ? [
            {
              text: `  Usage unavailable · ${state.runtimeUsageError}`,
              tone: "warn" as Tone,
            },
          ]
        : []),
    ...(state.workflow
      ? [
          {
            text: `  Workflow ${state.workflow.id} · ${state.workflow.status} · ${state.workflow.completed}/${state.workflow.total}${state.workflow.currentStep ? ` · ${state.workflow.currentStep}` : ""}`,
            tone:
              state.workflow.status === "completed"
                ? "good"
                : state.workflow.status === "blocked"
                  ? "bad"
                  : "accent",
          } as Line,
        ]
      : []),
    {
      text: `  ${state.pendingInputs ?? 0} pending inputs · PgUp history`,
      tone: "muted",
    },
    { text: "" },
  ];
  if (!state.activity.length)
    return [
      ...header,
      { text: "  No agent events yet", tone: "muted" },
      {
        text: state.readOnly
          ? "  Feature observer · read only"
          : "  Attach --db + --model · i to ask",
        tone: "muted",
      },
    ];
  const lines: Line[] = [];
  for (const item of state.activity) {
    const tone: Tone =
      item.state === "error"
        ? "bad"
        : item.state === "running"
          ? "warn"
          : item.state === "done"
            ? "good"
            : "accent";
    const icon =
      item.state === "running"
        ? "◉"
        : item.state === "done"
          ? "✓"
          : item.state === "error"
            ? "!"
            : "·";
    lines.push({ text: `  ${icon} ${item.label}`, tone });
    for (const text of wrapText(item.detail, Math.max(1, width - 6)).slice(-5))
      lines.push({ text: `    ${text}`, tone: "muted" });
    if (item.output)
      for (const text of wrapText(item.output, Math.max(1, width - 6)).slice(
        -4,
      ))
        lines.push({ text: `    ${text}`, tone: "text" });
    lines.push({ text: "" });
  }
  const available = Math.max(1, capacity - header.length);
  const offset =
    state.focus === "activity"
      ? Math.max(0, Math.min(state.scroll, lines.length - available))
      : 0;
  const end = Math.max(0, lines.length - offset);
  return [...header, ...lines.slice(Math.max(0, end - available), end)];
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  if (value < 1000) return String(Math.max(0, Math.round(value)));
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function changeLines(state: DashboardState, capacity: number): Line[] {
  const files = state.git?.files ?? [];
  const lines: Line[] = [];
  if (state.gitError)
    lines.push({ text: `  Git error · ${state.gitError}`, tone: "bad" });
  if (!state.git)
    return [...lines, { text: "  Waiting for Git snapshot…", tone: "muted" }];
  if (!files.length)
    return [...lines, { text: "  ✓ Working tree clean", tone: "good" }];
  const fileCapacity = Math.min(
    files.length,
    Math.max(1, Math.floor((capacity - 4) / 3)),
  );
  const start = windowStart(state.selectedFile, files.length, fileCapacity);
  for (
    let index = start;
    index < Math.min(files.length, start + fileCapacity);
    index++
  ) {
    const file = files[index];
    if (!file) continue;
    const selected = index === state.selectedFile;
    lines.push({
      text: ` ${selected ? "›" : " "} ${file.index}${file.working} ${file.originalPath ? `${file.originalPath} → ` : ""}${file.path}  ${file.binary ? "binary" : `+${file.additions} −${file.deletions}`}`,
      tone: selected ? "selected" : conflict(file) ? "bad" : "text",
    });
  }
  const selected = files[state.selectedFile];
  const diff = state.diff.split(/\r?\n/);
  if (diff.at(-1) === "") diff.pop();
  const available = Math.max(0, capacity - lines.length - 2);
  const offset = Math.max(
    0,
    Math.min(
      Math.floor(state.scroll) || 0,
      Math.max(0, diff.length - available),
    ),
  );
  lines.push(
    { text: `  ── ${selected?.path ?? "Diff"} ──`, tone: "accent" },
    {
      text: `  ${state.diffMode === "staged" ? "STAGED" : "WORKING"} DIFF  ${diff.length ? `${offset + 1}–${Math.min(diff.length, offset + available)} / ${diff.length}` : "waiting"}  · PgUp/PgDn`,
      tone: "muted",
    },
  );
  for (const text of diff.slice(offset, offset + available)) {
    lines.push({
      text: ` ${text}`,
      tone: text.startsWith("+")
        ? "good"
        : text.startsWith("-")
          ? "bad"
          : text.startsWith("@@")
            ? "accent"
            : "muted",
    });
  }
  if (!diff.length && available)
    lines.push({ text: "  No diff content for selection", tone: "muted" });
  return lines;
}

/** A complete frame, without cursor movement; the host owns redraw and scheduling. */
export function renderDashboard(
  state: DashboardState,
  columns: number,
  rows: number,
  options: { color?: boolean } = {},
): string {
  const width = Number.isFinite(columns)
    ? Math.max(0, Math.floor(columns))
    : 80;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 24;
  if (!width || !height) return "";
  const color = options.color ?? true;
  const git = state.git;
  const files = git?.files ?? [];
  const staged = files.filter(
    (file) =>
      file.index !== " " &&
      file.index !== "." &&
      file.index !== "?" &&
      !conflict(file),
  ).length;
  const unstaged = files.filter(
    (file) =>
      file.working !== " " &&
      file.working !== "." &&
      file.working !== "?" &&
      !conflict(file),
  ).length;
  const untracked = files.filter((file) => file.index === "?").length;
  const conflicts = files.filter(conflict).length;
  const age = git
    ? Math.max(0, Math.floor((Date.now() - git.observedAt) / 1000))
    : 0;
  const freshness = state.gitError
    ? "ERROR · last snapshot retained"
    : state.refreshing
      ? "refreshing…"
      : git
        ? `${age > 10 ? "STALE · " : "live · "}${age}s ago`
        : "connecting…";
  const branch = git
    ? `${git.branch || `detached ${git.head.slice(0, 7)}`}  ↑${git.ahead} ↓${git.behind}`
    : "Git pending";
  const header: Line[] = [
    { text: `  LOOM  /  ${basename(state.cwd)}    ${branch}`, tone: "accent" },
    ...(state.runtimeCwd && state.runtimeCwd !== state.cwd
      ? [
          {
            text: `  Git viewing: ${state.cwd} · Runtime executes: ${state.runtimeCwd}`,
            tone: "muted" as Tone,
          },
        ]
      : []),
    {
      text: `  ${staged} staged · ${unstaged} unstaged · ${untracked} untracked · ${conflicts} conflicts    ${freshness}`,
      tone: conflicts || state.gitError ? "bad" : age > 10 ? "warn" : "muted",
    },
    {
      text: `  ${state.focus === "worktrees" ? "[Worktrees]" : " Worktrees "}   ${state.focus === "activity" ? "[Agent Activity]" : " Agent Activity "}   ${state.focus === "files" ? "[Changes & Diff]" : " Changes & Diff "}`,
      tone: "muted",
    },
  ];
  if (height < 7 || width < 24)
    return [
      ...header.slice(0, Math.max(1, height - 1)),
      { text: "  Resize · q quit", tone: "muted" as const },
    ]
      .slice(0, height)
      .map((line) => paint(line, width, color))
      .join("\n");
  const contentHeight = Math.max(0, height - header.length - 2);
  const capacity = Math.max(0, contentHeight - 2);
  const frames: { width: number; lines: Line[] }[] = [];
  if (width >= 120) {
    const left = Math.floor((width - 2) * 0.25);
    const middle = Math.floor((width - 2) * 0.29);
    const right = width - left - middle - 2;
    frames.push(
      {
        width: left,
        lines: panel(
          "WORKTREES",
          worktreeLines(state, capacity),
          left,
          contentHeight,
          state.focus === "worktrees",
        ),
      },
      {
        width: middle,
        lines: panel(
          "AGENT ACTIVITY",
          activityLines(state, capacity, middle),
          middle,
          contentHeight,
          state.focus === "activity",
        ),
      },
      {
        width: right,
        lines: panel(
          "CHANGES & DIFF",
          changeLines(state, capacity),
          right,
          contentHeight,
          state.focus === "files",
        ),
      },
    );
  } else {
    const title =
      state.focus === "worktrees"
        ? "WORKTREES"
        : state.focus === "activity"
          ? "AGENT ACTIVITY"
          : "CHANGES & DIFF";
    const lines =
      state.focus === "worktrees"
        ? worktreeLines(state, capacity)
        : state.focus === "activity"
          ? activityLines(state, capacity, width)
          : changeLines(state, capacity);
    frames.push({
      width,
      lines: panel(title, lines, width, contentHeight, true),
    });
  }
  const output = header.map((line) => paint(line, width, color));
  for (let index = 0; index < contentHeight; index++)
    output.push(
      frames
        .map((frame) =>
          paint(frame.lines[index] ?? { text: "" }, frame.width, color),
        )
        .join(" "),
    );
  output.push(
    paint(
      {
        text:
          state.input !== undefined
            ? `  ${state.inputNotice ?? (state.inputAdmitting ? "Admitting input · draft locked until persisted" : "enter send · esc discard · /help commands · // literal slash")}`
            : `  Runtime: ${state.runtimeStatus} · ${state.pendingInputs ?? 0} pending inputs${state.lastRuntimeUpdate ? ` · updated ${new Date(state.lastRuntimeUpdate).toLocaleTimeString("en-GB", { hour12: false })}` : ""}${state.gitError ? ` · ${state.gitError}` : ""}`,
        tone: state.gitError ? "bad" : "muted",
      },
      width,
      color,
    ),
  );
  output.push(
    paint(
      {
        text:
          state.input !== undefined
            ? inputLine(state, width)
            : state.readOnly
              ? "  read-only observer  tab focus  j/k select  enter open  s staged  PgUp/PgDn scroll  r refresh  q quit"
              : "  i ask (/help)  tab focus  j/k select  enter open  s staged  PgUp/PgDn scroll  p resume  x cancel  r refresh  q quit",
        tone: "muted",
      },
      width,
      color,
    ),
  );
  return output.join("\n");
}
