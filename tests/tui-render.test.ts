import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { renderDashboard } from "../src/tui/render.js";
import type { DashboardState } from "../src/tui/types.js";

function fixture(): DashboardState {
  return {
    cwd: "/project/loom",
    runtimeCwd: "/project/loom",
    refreshing: false,
    selectedWorktree: 1,
    selectedFile: 0,
    focus: "files",
    scroll: 0,
    diff: "@@ -1 +1 @@\n-old content\n+new content\n",
    runtimeStatus: "connected",
    runtimeUsage: {
      models: {},
      total: {
        input: 1200,
        output: 300,
        cacheRead: 600,
        cacheWrite: 200,
        cacheReadPromptRatio: 600 / 2000,
      },
    },
    activity: [
      {
        id: "1",
        label: "Editing renderer",
        detail: "src/tui/render.ts",
        state: "running",
      },
    ],
    git: {
      root: "/project/loom",
      branch: "feature/dashboard",
      head: "1234567890",
      ahead: 2,
      behind: 1,
      observedAt: Date.now(),
      files: [
        {
          path: "src/render.ts",
          index: "M",
          working: "M",
          additions: 8,
          deletions: 3,
          binary: false,
        },
        {
          path: "new.ts",
          index: "?",
          working: "?",
          additions: 0,
          deletions: 0,
          binary: false,
        },
        {
          path: "conflict.ts",
          index: "U",
          working: "U",
          additions: 0,
          deletions: 0,
          binary: false,
        },
      ],
      worktrees: [
        {
          path: "/project/loom",
          branch: "main",
          head: "1234567",
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: "/project/agent",
          branch: "",
          head: "abcdef123",
          bare: false,
          detached: true,
          locked: true,
          prunable: true,
        },
      ],
    },
  };
}

// An independent width oracle for test fixture characters, including CJK and emoji.
function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(value)) {
    if (/^\p{Mark}+$/u.test(segment)) continue;
    width +=
      /[\u2e80-\ua4cf\uac00-\ud7a3\uff01-\uff60]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(
        segment,
      )
        ? 2
        : 1;
  }
  return width;
}
function assertFits(frame: string, columns: number, rows: number) {
  const plain = stripVTControlCharacters(frame);
  const lines = plain.split("\n");
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines)
    expect(displayWidth(line)).toBeLessThanOrEqual(columns);
}

describe("terminal dashboard renderer", () => {
  it("shows three live observation panels, selection and Git evidence", () => {
    const frame = renderDashboard(fixture(), 140, 40, { color: false });
    assertFits(frame, 140, 40);
    expect(frame.split("\n")).toHaveLength(40);
    for (const label of [
      "LOOM",
      "WORKTREES",
      "AGENT ACTIVITY",
      "CHANGES & DIFF",
      "1 staged",
      "1 unstaged",
      "1 untracked",
      "1 conflicts",
      "↑2 ↓1",
      "detached abcdef1",
      "locked · prunable",
      "› agent",
      "Editing renderer",
      "+new content",
      "-old content",
      "live · 0s ago",
      "Runtime: connected",
      "Tokens in 1.2k",
      "Prompt cache 30%",
    ])
      expect(frame).toContain(label);
    expect(frame).not.toContain("\x1b");
    expect(renderDashboard(fixture(), 120, 32, { color: false })).toContain(
      "Prompt cache 30%",
    );
  });

  it("uses selected focus on narrow terminals and keeps diff scrolling visible", () => {
    const state = fixture();
    state.diff = Array.from(
      { length: 100 },
      (_, index) => `+line ${index}`,
    ).join("\n");
    state.scroll = 25;
    const frame = renderDashboard(state, 80, 24, { color: false });
    assertFits(frame, 80, 24);
    expect(frame).toContain("[Changes & Diff]");
    expect(frame).toContain("+line 25");
    expect(frame).not.toContain("+line 0");
    expect(frame).toContain("/ 100");
    state.focus = "worktrees";
    expect(renderDashboard(state, 80, 24, { color: false })).toContain(
      "detached abcdef1",
    );
    state.focus = "activity";
    expect(renderDashboard(state, 80, 24, { color: false })).toContain(
      "Editing renderer",
    );
  });

  it("keeps distant selections visible and colors added and removed diff lines", () => {
    const state = fixture();
    if (!state.git) throw new Error("fixture missing git");
    const original = state.git.files[0];
    if (!original) throw new Error("fixture missing file");
    state.git.files = Array.from({ length: 30 }, (_, index) => ({
      ...original,
      path: `file-${index}.ts`,
    }));
    state.selectedFile = 29;
    const frame = renderDashboard(state, 80, 24);
    expect(stripVTControlCharacters(frame)).toContain("› MM file-29.ts");
    expect(stripVTControlCharacters(frame)).not.toContain("file-0.ts");
    expect(
      frame.split("\n").find((line) => line.includes("+new content")),
    ).toContain("\x1b[38;5;114m");
    expect(
      frame.split("\n").find((line) => line.includes("-old content")),
    ).toContain("\x1b[38;5;210m");
  });

  it("bounds every terminal size including tiny and empty screens", () => {
    for (const columns of [1, 2, 8, 23, 24, 39, 80, 119, 120, 140]) {
      for (const rows of [1, 2, 3, 6, 7, 8, 24, 40])
        assertFits(renderDashboard(fixture(), columns, rows), columns, rows);
    }
    expect(renderDashboard(fixture(), 0, 10)).toBe("");
    expect(renderDashboard(fixture(), 10, 0)).toBe("");
  });

  it("keeps CJK, combining marks and emoji graphemes within cell boundaries", () => {
    const state = fixture();
    state.cwd = "/开发/工作台👩‍💻";
    if (!state.git) throw new Error("fixture missing git");
    state.git.branch = "功能/实时更新🇨🇳é";
    const tree = state.git.worktrees[0];
    if (tree) tree.path = "/开发/工作台👩‍💻";
    state.diff = "+中文👩‍💻é".repeat(100);
    for (const columns of [24, 25, 80, 121, 140])
      assertFits(renderDashboard(state, columns, 24), columns, 24);
    expect(renderDashboard(state, 140, 40, { color: false })).toContain(
      "工作台👩‍💻",
    );
  });

  it("never executes untrusted ANSI, OSC, carriage returns, bidi or control sequences", () => {
    const state = fixture();
    const attack =
      "safe\x1b[2J\x1b]52;c;stolen\x07\x1b]8;;https://evil\x1b\\link\x1b]8;;\x1b\\\r\t\b\u009b2J\u202eevil";
    state.cwd = attack;
    state.runtimeStatus = attack;
    state.gitError = attack;
    state.diff = `+${attack}\n-${attack}`;
    if (!state.git) throw new Error("fixture missing git");
    state.git.branch = attack;
    const file = state.git.files[0];
    if (file) file.path = attack;
    const tree = state.git.worktrees[0];
    if (tree) tree.path = attack;
    state.activity = [
      { id: "bad", label: attack, detail: attack, state: "error" },
    ];
    const frame = renderDashboard(state, 140, 40, { color: false });
    assertFits(frame, 140, 40);
    expect(/[\p{Cc}\p{Cf}]/u.test(frame.replaceAll("\n", ""))).toBe(false);
    for (const value of [
      "\x1b",
      "stolen",
      "https://evil",
      "\r",
      "\t",
      "\u202e",
      "\u009b",
    ])
      expect(frame).not.toContain(value);
    const colored = renderDashboard(state, 140, 40);
    expect(stripVTControlCharacters(colored)).toBe(frame);
    expect(colored).not.toContain("\x1b[2J");
  });

  it("marks stale snapshots, refresh and errors explicitly", () => {
    const state = fixture();
    if (!state.git) throw new Error("fixture missing git");
    state.git.observedAt = Date.now() - 60_000;
    expect(renderDashboard(state, 140, 40, { color: false })).toContain(
      "STALE",
    );
    state.refreshing = true;
    expect(renderDashboard(state, 140, 40, { color: false })).toContain(
      "refreshing…",
    );
    state.gitError = "repository unavailable";
    const frame = renderDashboard(state, 140, 40, { color: false });
    expect(frame).toContain("last snapshot retained");
    expect(frame).toContain("repository unavailable");
  });

  it("shows pending admissions separately and makes commands discoverable", () => {
    const state = fixture();
    state.pendingInputs = 3;
    const frame = renderDashboard(state, 140, 40, { color: false });
    expect(frame).toContain("3 pending inputs");
    expect(frame).toContain("i ask (/help)");
    state.input = "/help";
    expect(renderDashboard(state, 80, 24, { color: false })).toContain(
      "/help commands · // literal slash",
    );
    delete state.runtimeUsage;
    state.runtimeUsageError = "runtime ledger unavailable";
    expect(renderDashboard(state, 140, 40, { color: false })).toContain(
      "Usage unavailable",
    );
  });

  it("separates the Git viewing worktree from the Runtime owner", () => {
    const state = fixture();
    state.cwd = "/project/agent";
    state.runtimeCwd = "/project/loom";
    if (!state.git) throw new Error("fixture missing git");
    state.git.root = "/project/agent";
    const frame = renderDashboard(state, 140, 40, { color: false });
    expect(frame).toContain(
      "Git viewing: /project/agent · Runtime executes: /project/loom",
    );
    expect(frame).toContain("loom · runtime executes");
    expect(frame).toContain("agent · viewing");
  });

  it("keeps the draft insertion point visible on narrow screens", () => {
    const state = fixture();
    state.input = `${"long prompt 中文👩‍💻".repeat(30)}尾部end`;
    for (const columns of [24, 40, 80]) {
      const frame = renderDashboard(state, columns, 24, { color: false });
      assertFits(frame, columns, 24);
      expect(frame.split("\n").at(-1)).toContain("尾部end▏");
    }
    state.inputAdmitting = true;
    state.inputNotice = "Admitting input · draft locked until persisted";
    const frame = renderDashboard(state, 80, 24, { color: false });
    expect(frame).toContain("[admitting]");
    expect(frame).toContain("draft locked until persisted");
  });
});
