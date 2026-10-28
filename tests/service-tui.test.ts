import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/providers/index.js";
import type { RunSummary } from "../src/service/catalog.js";
import type {
  BudgetReconciliation,
  ConnectionWriteResult,
  ServiceResult,
} from "../src/service/daemon.js";
import {
  parseAddCommand,
  parseEditCommand,
  parseStartCommand,
  ServiceWorkbench,
} from "../src/tui/service-controller.js";
import { renderServiceWorkbench } from "../src/tui/service-render.js";
import type { Evidence } from "../src/workflow/index.js";

const run = (id: string): RunSummary => ({
  runId: id,
  goal: "test",
  status: "blocked",
  active: false,
  operationId: "op",
  workspace: {
    path: "/tmp/tree",
    workspaceId: "tree",
    head: "abc",
    fingerprint: "abc",
  },
  steps: [
    {
      id: "verify",
      status: "failed",
      role: "verifier",
      dependsOn: [],
      requirement: "command",
      attempt: 1,
      evidenceIds: [],
      inputQuestion: null,
      inputAnswer: null,
      failure: "failed",
    },
  ],
  blockedReason: "unknown tool intent: review effects",
  usage: null,
  budget: null,
});

const evidenceItem = (
  id: string,
  stepId: string,
  detail:
    | {
        kind: "command";
        command: string;
        exitCode: number;
        collector: "execution_env";
      }
    | {
        kind: "review";
        reviewerId: string;
        implementerId: string;
        unresolvedFindings: number;
      }
    | { kind: "artifact"; producerId: string },
): Evidence => ({
  id,
  stepId,
  attempt: 1,
  planVersion: 1,
  workspace: { workspaceId: "tree", head: "abc", fingerprint: "abc" },
  artifactRef: `pi:feature/${id}`,
  recordedAt: 1,
  valid: true,
  ...detail,
});

describe("service run workbench", () => {
  it("preserves selection across live reordering and fetches selected status", async () => {
    let runs = [run("a"), run("b")];
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        return request.method === "list"
          ? runs
          : run("runId" in request ? request.runId : "a");
      },
    });
    await ui.refresh();
    await ui.key("down");
    expect(ui.state.selectedRunId).toBe("b");
    runs = [run("b"), run("a")];
    await ui.refresh();
    expect(ui.state.selectedRunId).toBe("b");
    expect(ui.state.detail?.runId).toBe("b");
    expect(requests).toContainEqual({ method: "status", runId: "b" });
    ui.stop();
  });

  it("observes initialization_pending without opening Git for a missing workspace", async () => {
    const pending: RunSummary = {
      ...run("pending"),
      status: "initialization_pending",
      workspace: null,
      steps: [],
      operationId: null,
      blockedReason: "Run initialization incomplete; explicit resume required",
    };
    const ui = new ServiceWorkbench({
      async request(request) {
        return request.method === "list" ? [pending] : pending;
      },
    });
    try {
      await ui.refresh();
      expect(ui.state.connected).toBe(true);
      expect(ui.state.detail?.workspace).toBeNull();
      expect(ui.state.detail?.status).toBe("initialization_pending");
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "initialization_pending",
      );
    } finally {
      ui.stop();
    }
  });

  it("never cancels on detach or refresh; sends cancel/resume only explicitly", async () => {
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        return request.method === "list" ? [run("a")] : run("a");
      },
    });
    await ui.refresh();
    await ui.key("x");
    await ui.key("p");
    ui.stop();
    expect(
      requests.filter((item) =>
        ["cancel", "resume"].includes((item as { method: string }).method),
      ),
    ).toEqual([
      { method: "cancel", runId: "a" },
      { method: "resume", runId: "a" },
    ]);
  });

  it("rejects malformed start commands and preserves explicit spec/profile paths", () => {
    expect(
      parseStartCommand(
        'start "/tmp/my spec.json" "/tmp/provider profile.json"',
      ),
    ).toEqual({
      specPath: "/tmp/my spec.json",
      profilePath: "/tmp/provider profile.json",
    });
    expect(() => parseStartCommand("start only-spec.json")).toThrow(/profile/);
    expect(() => parseStartCommand('start "unterminated profile')).toThrow();
  });

  it("discards a stale detail response when selection changes", async () => {
    let finish: ((value: ServiceResult) => void) | undefined;
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a"), run("b")];
        if ("runId" in request && request.runId === "a")
          return new Promise((resolve) => {
            finish = resolve;
          });
        return run("b");
      },
    });
    const refresh = ui.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ui.key("down");
    finish?.(run("a"));
    await refresh;
    expect(ui.state.detail?.runId).toBe("b");
    ui.stop();
  });

  it("renders blocked steps and usage without terminal injection or narrow overflow", () => {
    const ui = new ServiceWorkbench({
      async request() {
        return [];
      },
    });
    ui.state.runs = [run("a")];
    ui.state.selectedRunId = "a";
    ui.state.detail = {
      ...run("a"),
      blockedReason: "unknown intent\x1b[2J\nreview",
      usage: {
        calls: 12,
        tokens: 7,
        pending: 0,
        reconciled: 0,
        limits: { maxCalls: 12, maxTokens: 7 },
      },
      budget: { maxCalls: 12, maxTokens: 7 },
    };
    const wide = renderServiceWorkbench(ui.state, 120, 30, false);
    expect(wide).toContain("unknown intent");
    expect(wide).toContain("verify");
    expect(wide).toContain("12/12");
    // `reconciled` is a ledger fact beside `pending`: both render even at 0.
    expect(wide).toContain("0 pending");
    expect(wide).toContain("0 reconciled");
    expect(wide).not.toContain("\x1b");
    for (const width of [1, 12, 40, 80]) {
      for (const height of [1, 6, 8, 12]) {
        const lines = renderServiceWorkbench(
          ui.state,
          width,
          height,
          false,
        ).split("\n");
        expect(lines.length).toBeLessThanOrEqual(height);
        expect(lines.every((line) => [...line].length <= width)).toBe(true);
      }
    }
    ui.stop();
  });

  it("renders reconciled budget counts as a ledger segment without narrow overflow", () => {
    const ui = new ServiceWorkbench({
      async request() {
        return [];
      },
    });
    ui.state.runs = [run("a")];
    ui.state.selectedRunId = "a";
    ui.state.detail = {
      ...run("a"),
      usage: {
        calls: 15,
        tokens: 9,
        pending: 0,
        reconciled: 3,
        limits: { maxCalls: 15, maxTokens: 9 },
      },
      budget: { maxCalls: 15, maxTokens: 9 },
    };
    const wide = renderServiceWorkbench(ui.state, 120, 30, false);
    expect(wide).toContain("3 reconciled");
    expect(wide).toContain("0 pending");
    expect(wide).not.toContain("\x1b");
    for (const width of [1, 12, 40, 80]) {
      for (const height of [1, 6, 8, 12]) {
        const lines = renderServiceWorkbench(
          ui.state,
          width,
          height,
          false,
        ).split("\n");
        expect(lines.length).toBeLessThanOrEqual(height);
        expect(lines.every((line) => [...line].length <= width)).toBe(true);
      }
    }
    ui.stop();
  });

  it("fetches evidence with each refresh while the panel is open and discards stale responses across run switches", async () => {
    const evidenceA = [
      evidenceItem("ea-1", "targeted_verify", {
        kind: "command",
        command: "node -e targeted",
        exitCode: 0,
        collector: "execution_env",
      }),
    ];
    const evidenceB = [
      evidenceItem("eb-1", "regression", {
        kind: "command",
        command: "node -e regression",
        exitCode: 0,
        collector: "execution_env",
      }),
    ];
    const resolvers = new Map<string, ((value: ServiceResult) => void)[]>();
    const requests: unknown[] = [];
    const evidenceCalls = () =>
      requests.filter(
        (item): item is { method: "evidence"; runId: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { method: string }).method === "evidence",
      );
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a"), run("b")];
        if (request.method === "evidence")
          return new Promise<ServiceResult>((resolve) => {
            const queue = resolvers.get(request.runId) ?? [];
            queue.push(resolve);
            resolvers.set(request.runId, queue);
          });
        return run("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      // Panel closed by default: refreshes never ask for evidence.
      expect(evidenceCalls()).toEqual([]);
      const opening = ui.key("e");
      expect(evidenceCalls()).toEqual([{ method: "evidence", runId: "a" }]);
      // Switch runs while a's evidence is still in flight; b's lands first.
      // (Focus poked back to runs as with the draft in the start-input tests:
      // under evidence focus j/k would scroll the panel, not the selection.)
      ui.state.focus = "runs";
      const switching = ui.key("down");
      await vi.waitFor(() => expect(resolvers.get("b")).toHaveLength(1));
      resolvers.get("b")?.shift()?.(evidenceB);
      await switching;
      expect(ui.state.selectedRunId).toBe("b");
      expect(ui.state.evidenceRunId).toBe("b");
      expect(ui.state.evidence).toEqual(evidenceB);
      // The stale response for a must never land for b.
      resolvers.get("a")?.shift()?.(evidenceA);
      await opening;
      expect(ui.state.evidenceRunId).toBe("b");
      expect(ui.state.evidence).toEqual(evidenceB);
      // Later refreshes keep re-requesting evidence for the selected run.
      const refreshing = ui.refresh();
      await vi.waitFor(() => expect(evidenceCalls()).toHaveLength(3));
      resolvers.get("b")?.shift()?.(evidenceB);
      await refreshing;
      expect(evidenceCalls()).toEqual([
        { method: "evidence", runId: "a" },
        { method: "evidence", runId: "b" },
        { method: "evidence", runId: "b" },
      ]);
    } finally {
      ui.stop();
    }
  });

  it("renders evidence entries with kind details once the panel is toggled, and toggling off clears it", async () => {
    const entries = [
      evidenceItem("cmd-1", "targeted_verify", {
        kind: "command",
        command: "node\x1b[2J\ninject -e targeted",
        exitCode: 42,
        collector: "execution_env",
      }),
      evidenceItem("rev-1", "review", {
        kind: "review",
        reviewerId: "reviewer-1",
        implementerId: "implementer-1",
        unresolvedFindings: 0,
      }),
      evidenceItem("art-1", "implement", {
        kind: "artifact",
        producerId: "worker-1",
      }),
    ];
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence") return entries;
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      expect(ui.state.showEvidence).toBe(true);
      expect(ui.state.focus).toBe("evidence");
      expect(ui.state.evidence).toEqual(entries);
      // Panel-scoped navigation: j scrolls the evidence list, not the runs.
      await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(1);
      expect(ui.state.selectedRunId).toBe("a");
      await ui.key("k");
      expect(ui.state.evidenceCursor).toBe(0);
      const wide = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(wide).toContain("EVIDENCE (3)");
      expect(wide).toContain(
        "cmd-1 · targeted_verify · command · attempt 1 · valid",
      );
      expect(wide).toContain("command: node inject -e targeted");
      expect(wide).toContain("exit 42");
      expect(wide).toContain("review by reviewer-1 · 0 unresolved");
      expect(wide).toContain("artifact by worker-1");
      expect(wide).not.toContain("\x1b");
      // Narrow screens keep the fitted-line invariants with the panel open.
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      // Toggling off closes the panel, clears its state and restores focus.
      await ui.key("e");
      expect(ui.state.showEvidence).toBe(false);
      expect(ui.state.focus).toBe("runs");
      expect(ui.state.evidence).toBeUndefined();
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "EVIDENCE (3)",
      );
    } finally {
      ui.stop();
    }
  });

  it("degrades evidence failures to a panel-local hint without breaking run list and detail refreshes", async () => {
    let evidenceFails = true;
    let listCalls = 0;
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") {
          listCalls++;
          return [run("a")];
        }
        if (request.method === "evidence") {
          if (evidenceFails) throw new Error("evidence unavailable");
          return [];
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      expect(ui.state.connected).toBe(true);
      expect(ui.state.detail?.runId).toBe("a");
      expect(ui.state.notice).toBeUndefined();
      expect(ui.state.evidenceNotice).toContain("unavailable");
      expect(ui.state.evidence).toBeUndefined();
      // A failing evidence fetch never disturbs the run list/detail refresh.
      const detailBefore = ui.state.detail;
      await ui.refresh();
      expect(listCalls).toBe(2);
      expect(ui.state.connected).toBe(true);
      expect(ui.state.detail).toEqual(detailBefore);
      expect(ui.state.notice).toBeUndefined();
      const frame = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(frame).toContain("Evidence · unavailable");
      expect(frame).not.toContain("disconnected");
      // Recovery on the next fetch clears the panel-local hint.
      evidenceFails = false;
      await ui.refresh();
      expect(ui.state.evidenceNotice).toBeUndefined();
      expect(ui.state.evidence).toEqual([]);
    } finally {
      ui.stop();
    }
  });

  it("views artifact bodies on demand, caching them and degrading structured errors panel-locally", async () => {
    const entries = [
      evidenceItem("art-1", "implement", {
        kind: "artifact",
        producerId: "worker-1",
      }),
      evidenceItem("art-err", "deliver", {
        kind: "artifact",
        producerId: "host:delivery",
      }),
      evidenceItem("cmd-1", "targeted_verify", {
        kind: "command",
        command: "node -e targeted",
        exitCode: 0,
        collector: "execution_env",
      }),
      evidenceItem("rev-1", "review", {
        kind: "review",
        reviewerId: "reviewer-1",
        implementerId: "implementer-1",
        unresolvedFindings: 0,
      }),
    ];
    const requests: unknown[] = [];
    const artifactCalls = () =>
      requests.filter(
        (item): item is { method: "artifact"; runId: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { method: string }).method === "artifact",
      );
    const bodies = new Map<string, ServiceResult>([
      [
        "art-1",
        {
          text: "body\x1b[2J\nwith control chars",
          truncated: true,
          byteLength: 70_036,
        },
      ],
    ]);
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence") return entries;
        if (request.method === "artifact") {
          const body = bodies.get(request.evidenceId);
          if (!body) throw new Error("Unknown evidence id");
          return body;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      // Panel open with the artifact entry at the top of the list selected:
      // zero artifact traffic until the body view is requested.
      expect(ui.state.evidenceCursor).toBe(0);
      expect(artifactCalls()).toEqual([]);
      await ui.key("return");
      expect(artifactCalls()).toEqual([
        { method: "artifact", runId: "a", evidenceId: "art-1" },
      ]);
      expect(ui.state.artifactViewId).toBe("art-1");
      expect(ui.state.artifactBodies.get("art-1")).toEqual(bodies.get("art-1"));
      const frame = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(frame).toContain("truncated at 64 KiB");
      expect(frame).toContain("70036 bytes");
      // Control characters injected into the body never reach the frame.
      expect(frame).toContain("with control chars");
      expect(frame).not.toContain("\x1b");
      // Narrow screens keep the fitted-line invariants with the body open.
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      // Closing and reopening uses the cached body: still exactly one request.
      await ui.key("return");
      expect(ui.state.artifactViewId).toBeUndefined();
      await ui.key("return");
      expect(ui.state.artifactViewId).toBe("art-1");
      expect(artifactCalls()).toHaveLength(1);
      await ui.key("return");
      // A structured error degrades to a panel-local hint: no global notice,
      // no disconnect; the panel keeps its header and tab count while the
      // entry lines yield to the degrade hint.
      await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(1);
      await ui.key("return");
      expect(artifactCalls()).toHaveLength(2);
      expect(ui.state.artifactViewId).toBeUndefined();
      expect(ui.state.artifactNotice).toBe("Unknown evidence id");
      expect(ui.state.notice).toBeUndefined();
      expect(ui.state.connected).toBe(true);
      const degraded = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(degraded).toContain("Artifact body · Unknown evidence id");
      // The tab indicator keeps the panel count; the entry lines themselves
      // are replaced by the degrade hint while the error stands.
      expect(degraded).toContain("EVIDENCE (4)");
      expect(degraded).not.toContain("art-1 ·");
      // command and review entries have no body view and issue no request;
      // scrolling past the last entry clamps the selection there.
      await ui.key("j");
      await ui.key("return");
      await ui.key("j");
      await ui.key("return");
      await ui.key("j");
      await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(3);
      expect(artifactCalls()).toHaveLength(2);
      expect(ui.state.artifactViewId).toBeUndefined();
    } finally {
      ui.stop();
    }
  });

  it("keeps forwarding return to the Git observer outside the evidence panel", async () => {
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence") return [];
        return run("a");
      },
    });
    const forwarded = vi
      .spyOn(ui.observer, "key")
      .mockImplementation(async () => {});
    try {
      await ui.refresh();
      // Under git focus the observer keeps its own Enter-opens-worktree key
      // path; the evidence body view must not swallow the key there.
      ui.state.focus = "git";
      await ui.key("return");
      expect(forwarded).toHaveBeenCalledWith("return");
      expect(forwarded).toHaveBeenCalledTimes(1);
      // Inside the open evidence panel the same key drives the artifact body
      // view instead (empty list: no request, no view) and never forwards.
      await ui.key("e");
      await ui.key("return");
      expect(forwarded).toHaveBeenCalledTimes(1);
    } finally {
      forwarded.mockRestore();
      ui.stop();
    }
  });

  it("drops late artifact body responses across run switches", async () => {
    const evidenceA = [
      evidenceItem("a-art", "implement", {
        kind: "artifact",
        producerId: "worker-1",
      }),
    ];
    const evidenceB = [
      evidenceItem("b-art", "implement", {
        kind: "artifact",
        producerId: "worker-1",
      }),
    ];
    const resolvers = new Map<string, ((value: ServiceResult) => void)[]>();
    const waitQueueed = (key: string) =>
      vi.waitFor(() => expect(resolvers.get(key)).toHaveLength(1));
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a"), run("b")];
        if (request.method === "evidence" || request.method === "artifact")
          return new Promise<ServiceResult>((resolve) => {
            const key = `${request.method}:${request.runId}`;
            const queue = resolvers.get(key) ?? [];
            queue.push(resolve);
            resolvers.set(key, queue);
          });
        return run("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      const openingPanel = ui.key("e");
      await waitQueueed("evidence:a");
      resolvers.get("evidence:a")?.shift()?.(evidenceA);
      await openingPanel;
      expect(ui.state.evidenceRunId).toBe("a");
      // Open a's artifact body; the response hangs in flight.
      const opening = ui.key("return");
      await waitQueueed("artifact:a");
      // Switch runs while a's body fetch is in flight; b's evidence lands.
      ui.state.focus = "runs";
      const switching = ui.key("down");
      await waitQueueed("evidence:b");
      resolvers.get("evidence:b")?.shift()?.(evidenceB);
      await switching;
      expect(ui.state.selectedRunId).toBe("b");
      expect(ui.state.evidenceRunId).toBe("b");
      expect(ui.state.evidenceCursor).toBe(0);
      // The late artifact response for a never lands: no view, no cache.
      resolvers.get("artifact:a")?.shift()?.({
        text: "stale body",
        truncated: false,
        byteLength: 10,
      });
      await opening;
      expect(ui.state.artifactViewId).toBeUndefined();
      expect(ui.state.artifactBodies.size).toBe(0);
      // b's artifact lands through the same key path.
      ui.state.focus = "evidence";
      const viewing = ui.key("return");
      await waitQueueed("artifact:b");
      resolvers.get("artifact:b")?.shift()?.({
        text: "b body",
        truncated: false,
        byteLength: 6,
      });
      await viewing;
      expect(ui.state.artifactViewId).toBe("b-art");
      expect(ui.state.artifactBodies.get("b-art")).toEqual({
        text: "b body",
        truncated: false,
        byteLength: 6,
      });
    } finally {
      ui.stop();
    }
  });
});

describe("evidence window follows the cursor", () => {
  const windowEntries = Array.from({ length: 30 }, (_, index) =>
    evidenceItem(`ev-${String(index).padStart(2, "0")}`, "implement", {
      kind: "artifact",
      // One entry carries terminal control characters: the sanitizer must
      // strip them wherever the window happens to expose the entry.
      producerId: index === 12 ? "worker\x1b[2J\n-12" : `worker-${index}`,
    }),
  );

  it("moves the cursor inside the window and scrolls one entry at the edges", async () => {
    let shortList = false;
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence")
          return shortList ? windowEntries.slice(0, 5) : windowEntries;
        if (request.method === "artifact")
          return { text: "body", truncated: false, byteLength: 4 };
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      // 120x14 leaves 7 body rows for the panel: the header plus a 6-entry
      // window over the 30-entry list.
      const frame = () => renderServiceWorkbench(ui.state, 120, 14, false);
      expect(ui.state.evidenceCursor).toBe(0);
      expect(frame()).toContain("› ev-00");
      expect(frame()).toContain("ev-05");
      expect(frame()).not.toContain("ev-06");
      // While the cursor stays inside the window, the window does not move.
      for (let step = 0; step < 5; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(5);
      const inside = frame();
      for (const id of ["ev-00", "ev-01", "ev-04", "ev-05"])
        expect(inside).toContain(id);
      expect(inside).not.toContain("ev-06");
      expect(inside).toContain("› ev-05");
      expect(inside).not.toContain("› ev-04");
      // One j past the bottom edge scrolls the window exactly one entry.
      await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(6);
      const scrolled = frame();
      expect(scrolled).toContain("ev-01");
      expect(scrolled).toContain("› ev-06");
      expect(scrolled).not.toContain("ev-00");
      expect(scrolled).not.toContain("ev-07");
      // Further j keys keep the cursor riding the bottom edge.
      for (let step = 0; step < 3; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(9);
      const deep = frame();
      expect(deep).toContain("ev-04");
      expect(deep).toContain("› ev-09");
      expect(deep).not.toContain("ev-03");
      // k scrolls the window back one entry per key while it is scrolled.
      await ui.key("k");
      expect(ui.state.evidenceCursor).toBe(8);
      const up = frame();
      expect(up).toContain("ev-03");
      expect(up).toContain("› ev-08");
      expect(up).not.toContain("ev-09");
      // Enter opens the cursor's entry, not the window's first.
      for (let step = 0; step < 10; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(18);
      await ui.key("return");
      expect(ui.state.artifactViewId).toBe("ev-18");
      await ui.key("return");
      expect(ui.state.artifactViewId).toBeUndefined();
      // The cursor clamps at the last entry and the window follows it.
      for (let step = 0; step < 40; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(29);
      const last = frame();
      expect(last).toContain("ev-24");
      expect(last).toContain("› ev-29");
      expect(last).not.toContain("ev-23");
      // …and clamps at the first entry all the way back up.
      for (let step = 0; step < 40; step++) await ui.key("k");
      expect(ui.state.evidenceCursor).toBe(0);
      const first = frame();
      expect(first).toContain("› ev-00");
      expect(first).not.toContain("ev-06");
      // A refreshed, shorter list clamps the cursor to the new length.
      for (let step = 0; step < 20; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(20);
      shortList = true;
      await ui.refresh();
      expect(ui.state.evidenceCursor).toBe(4);
    } finally {
      ui.stop();
    }
  });

  it("keeps the scrolled window fitted and terminal-clean on narrow screens", async () => {
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence") return windowEntries;
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      // Scroll deep into the list so the window [11..15] — control-character
      // entry ev-12 included — is under fit stress at every narrow size.
      for (let step = 0; step < 15; step++) await ui.key("j");
      expect(ui.state.evidenceCursor).toBe(15);
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      const wide = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(wide).toContain("ev-10");
      expect(wide).toContain("› ev-15");
      expect(wide).not.toContain("\x1b");
    } finally {
      ui.stop();
    }
  });
});

describe("service budget reconcile key", () => {
  const ledger = {
    limits: { maxCalls: 64, maxTokens: 1_000_000 },
    calls: 1,
    tokens: 0,
    pending: 1,
    reconciled: 0,
  };
  const pendingRun = (id: string): RunSummary => ({
    ...run(id),
    usage: { ...ledger },
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
  });
  const reconciliation: BudgetReconciliation = {
    database: "/tmp/loom/runs/a/agent.sqlite",
    before: { ...ledger },
    after: { ...ledger, pending: 0, reconciled: 1 },
  };
  const reconcileCalls = (requests: unknown[]) =>
    requests.filter(
      (item): item is { method: "reconcile-budget"; runId: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { method: string }).method === "reconcile-budget",
    );

  it("arms an explicit reconcile step and sends exactly one reconcile-budget request per confirmation", async () => {
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [pendingRun("a")];
        if (request.method === "reconcile-budget") return reconciliation;
        return pendingRun("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      // Arming and abandoning the confirmation step both send nothing.
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      await ui.key("escape");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(reconcileCalls(requests)).toEqual([]);
      // Armed again, the footer prompts for the explicit confirmation.
      await ui.key("b");
      const armed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(armed).toContain("reconcile budget a?");
      expect(armed).toContain("return confirm");
      await ui.key("return");
      expect(reconcileCalls(requests)).toEqual([
        { method: "reconcile-budget", runId: "a" },
      ]);
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(ui.state.reconcileResult).toEqual(reconciliation);
      // The landed summary renders the before/after ledger shape plus the
      // "not adopted as succeeded" declaration clauses.
      const settled = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(settled).toContain("Reconciled: pending 1 → 0 · reconciled 0 → 1");
      expect(settled).toContain("not adopted as succeeded");
      expect(settled).toContain("no token fabrication");
      expect(settled).toContain("endpoint non-receipt unproven");
      expect(settled).not.toContain("reconcile budget a?");
      // The footer hint line keeps every key visible at 120 columns, the
      // reconcile key included.
      expect(settled).toContain("b reconcile");
      expect(settled).toContain("q detach");
    } finally {
      ui.stop();
    }
  });

  it("shows structured reconcile errors verbatim with an explicit retry and never disconnects", async () => {
    let reconcileFails = true;
    const message =
      "DATABASE_IN_USE: Database is already owned by another Loom runtime: /tmp/loom/runs/a/agent.sqlite";
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [pendingRun("a")];
        if (request.method === "reconcile-budget") {
          if (reconcileFails) throw new Error(message);
          return reconciliation;
        }
        return pendingRun("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("b");
      await ui.key("return");
      // The structured message lands verbatim; the connection, the armed
      // confirmation and the retry stay intact, and the global notice slot
      // (used by act() for generic failures) is never touched.
      expect(ui.state.reconcileNotice).toBe(message);
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(ui.state.connected).toBe(true);
      expect(ui.state.notice).toBeUndefined();
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      // The details column shows as much of the verbatim message as the
      // terminal fits (77 cells at 120 columns, like every other
      // service-supplied string); the exact message lives in the state, and
      // the footer's armed prompt keeps the retry and abandon keys visible.
      expect(failed).toContain(
        "Reconcile failed · DATABASE_IN_USE: Database is already owned",
      );
      expect(failed).toContain("reconcile budget a? · return confirm");
      expect(failed).not.toContain("pending 1 → 0");
      // The explicit retry sends a second request and lands the summary.
      reconcileFails = false;
      await ui.key("return");
      expect(reconcileCalls(requests)).toHaveLength(2);
      expect(ui.state.reconcileNotice).toBeUndefined();
      expect(ui.state.reconcileResult?.after).toMatchObject({
        pending: 0,
        reconciled: 1,
      });
    } finally {
      ui.stop();
    }
  });

  it("offers no reconcile entry for settled ledgers, dispatching runs or missing usage", async () => {
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        return request.method === "list" ? [run("a")] : run("a");
      },
    });
    const usage = pendingRun("a").usage;
    if (!usage) throw new Error("fixture usage missing");
    try {
      await ui.refresh();
      // The reconcile state exists from the start, unarmed and idle.
      expect(ui.state.reconciling).toBe(false);
      // usage:null (the base run helper) never arms the key.
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      // A dispatching run's in-flight call is itself one pending row, but the
      // service holds the lease: no entry while active.
      ui.state.detail = { ...pendingRun("a"), active: true };
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      // A fully settled ledger has nothing left to reconcile.
      ui.state.detail = { ...pendingRun("a"), usage: { ...usage, pending: 0 } };
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "return confirm",
      );
      expect(reconcileCalls(requests)).toEqual([]);
    } finally {
      ui.stop();
    }
  });

  it("clears the confirmation and summary across run switches, start acceptance and selection resets", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-reconcile-"));
    const resolvers: ((value: ServiceResult) => void)[] = [];
    let holdReconcile = true;
    let runs = [pendingRun("a"), pendingRun("b"), pendingRun("fresh")];
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return runs;
        if (request.method === "start") return run("fresh");
        if (request.method === "reconcile-budget") {
          if (holdReconcile)
            return new Promise<ServiceResult>((resolve) => {
              resolvers.push(resolve);
            });
          return reconciliation;
        }
        return pendingRun("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      // Arm and confirm on a; the reconcile response hangs in flight.
      await ui.key("b");
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      // Switching runs drops the armed confirmation; the late response for
      // a never lands for b (revision guard, like evidence and artifacts).
      await ui.key("down");
      expect(ui.state.selectedRunId).toBe("b");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      resolvers[0]?.(reconciliation);
      await confirming;
      expect(ui.state.reconcileResult).toBeUndefined();
      expect(ui.state.reconcileRunId).toBeUndefined();
      // A landed summary for b clears again when start accepts a new runId.
      holdReconcile = false;
      await ui.key("b");
      await ui.key("return");
      expect(ui.state.reconcileResult).toEqual(reconciliation);
      expect(ui.state.reconcileRunId).toBe("b");
      const spec = {
        runId: "fresh",
        goal: "test",
        repositoryPath: directory,
        worktreePath: join(directory, "tree"),
        baseCommit: "abc",
        targeted: ["true"],
        regression: ["true"],
      };
      const profile = {
        id: "fixture",
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
      };
      await writeFile(join(directory, "spec.json"), JSON.stringify(spec));
      await writeFile(join(directory, "profile.json"), JSON.stringify(profile));
      ui.state.draft = `start "${directory}/spec.json" "${directory}/profile.json"`;
      await ui.submitDraft();
      expect(ui.state.selectedRunId).toBe("fresh");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(ui.state.reconcileResult).toBeUndefined();
      expect(ui.state.reconcileRunId).toBeUndefined();
      // After a disconnect that drops the run from the list, the selection
      // reset never keeps the previous run's summary around.
      await ui.key("b");
      await ui.key("return");
      expect(ui.state.reconcileResult).toEqual(reconciliation);
      runs = [pendingRun("a")];
      await ui.refresh();
      expect(ui.state.selectedRunId).toBe("a");
      expect(ui.state.reconcileResult).toBeUndefined();
      expect(ui.state.reconcileRunId).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opening a draft disarms the armed reconcile while landed summaries and in-flight responses survive", async () => {
    const busy =
      "DATABASE_IN_USE: Database is already owned by another Loom runtime: /tmp/loom/runs/a/agent.sqlite";
    const requests: unknown[] = [];
    let holdReconcile = false;
    const failures: (() => void)[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [pendingRun("a")];
        if (request.method === "reconcile-budget") {
          if (holdReconcile)
            return new Promise<ServiceResult>((_resolve, reject) => {
              failures.push(() => reject(new Error(busy)));
            });
          return reconciliation;
        }
        return pendingRun("runId" in request ? request.runId : "a");
      },
    });
    try {
      await ui.refresh();
      // Arming then opening the draft disarms the confirmation: the draft
      // hides the footer prompt and its own `return` submits, so a hidden
      // armed ledger write must not survive the context switch.
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      await ui.key("n");
      expect(ui.state.draft).toBe("start ");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "return confirm",
      );
      // Closing the draft mirrors runServiceDashboard's Esc handler: the
      // draft key path lives in the dashboard host (which needs a real
      // TTY), not in the controller, so the controller-level test deletes
      // the draft directly — the same state-manipulation precedent the
      // start-input tests use to set it.
      delete ui.state.draft;
      await ui.key("return");
      expect(reconcileCalls(requests)).toEqual([]);
      // A landed summary survives the disarm untouched.
      await ui.key("b");
      await ui.key("return");
      expect(ui.state.reconcileResult).toEqual(reconciliation);
      expect(ui.state.reconcileRunId).toBe("a");
      await ui.key("n");
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "Reconciled: pending 1 → 0",
      );
      delete ui.state.draft;
      // An in-flight confirmation keeps its guards: disarming only drops the
      // armed state, and the late failure still lands for its own run (now
      // recorded with the runId the render guard keys on).
      holdReconcile = true;
      await ui.key("b");
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(failures).toHaveLength(1));
      await ui.key("n");
      expect(ui.state.draft).toBe("start ");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      failures[0]?.();
      await confirming;
      expect(ui.state.reconcileNotice).toBe(busy);
      expect(ui.state.reconcileRunId).toBe("a");
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "Reconcile failed · DATABASE_IN_USE: Database is already owned",
      );
      // With the draft closed the key re-arms fresh; the next arm clears the
      // failure notice exactly like the first arm did.
      delete ui.state.draft;
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(ui.state.reconcileNotice).toBeUndefined();
    } finally {
      ui.stop();
    }
  });

  it("renders the reconcile notice only for the run it landed on", () => {
    const ui = new ServiceWorkbench({
      async request() {
        return [];
      },
    });
    try {
      ui.state.runs = [pendingRun("a"), pendingRun("b")];
      ui.state.selectedRunId = "b";
      ui.state.detail = pendingRun("b");
      ui.state.reconcileRunId = "a";
      ui.state.reconcileNotice =
        "DATABASE_IN_USE: Database is already owned by another Loom runtime";
      // Defensive symmetry with the summary guard: a notice keyed to another
      // run never renders, even though the three run-switch paths already
      // clear it before the selection could move.
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "Reconcile failed",
      );
      ui.state.reconcileRunId = "b";
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "Reconcile failed · DATABASE_IN_USE: Database is already owned",
      );
    } finally {
      ui.stop();
    }
  });

  it("keeps reconcile lines fitted and terminal-clean on narrow screens", async () => {
    const ui = new ServiceWorkbench({
      async request() {
        return [];
      },
    });
    ui.state.runs = [pendingRun("a")];
    ui.state.selectedRunId = "a";
    ui.state.detail = pendingRun("a");
    ui.state.reconcileConfirm = true;
    // The notice render guard keys it to the run the failed request targeted
    // (the controller records it together with the error), so the fixture
    // carries it.
    ui.state.reconcileRunId = "a";
    ui.state.reconcileNotice =
      "DATABASE_IN_USE: Database is already owned\x1b[2J\nby another Loom runtime: /tmp/runs/a";
    try {
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain("Reconcile failed · DATABASE_IN_USE");
      expect(failed).not.toContain("\x1b");
      // The landed summary with control characters in the database path is
      // rendered through the same sanitizer and the same narrow fits.
      delete ui.state.reconcileConfirm;
      delete ui.state.reconcileNotice;
      ui.state.reconcileRunId = "a";
      ui.state.reconcileResult = {
        ...reconciliation,
        database: "/tmp\x1b[2J\n/loom/runs/a",
      };
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      const settled = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(settled).toContain("Reconciled: pending 1 → 0");
      expect(settled).not.toContain("\x1b");
    } finally {
      ui.stop();
    }
  });
});

describe("service connection panel", () => {
  const profile = (id: string): ProviderProfile => ({
    id,
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: `model-${id}`,
    baseUrl: "http://127.0.0.1:1/v1",
    ...(id.startsWith("key-")
      ? { keyEnv: `KEY_${id.slice(4).toUpperCase()}` }
      : {}),
  });
  const method = (requests: unknown[], name: string) =>
    requests.filter(
      (item): item is { method: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { method?: string }).method === name,
    );

  it("parses add commands with quoted paths and rejects malformed ones", () => {
    expect(parseAddCommand('add "/tmp/my profile.json"')).toEqual({
      profilePath: "/tmp/my profile.json",
    });
    expect(parseAddCommand("add /tmp/profile.json")).toEqual({
      profilePath: "/tmp/profile.json",
    });
    expect(() => parseAddCommand("add")).toThrow(/required/);
    expect(() => parseAddCommand("add a b")).toThrow(/required/);
    expect(() => parseAddCommand('add "unterminated')).toThrow(/quote/);
  });

  it("opens and closes the panel, gating management keys on a successful pull", async () => {
    const requests: unknown[] = [];
    let enabled = false;
    let entries = [profile("alpha"), profile("beta")];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") {
          if (!enabled)
            throw new Error(
              "Connection catalog is not enabled; start the service with --catalog DIR",
            );
          return entries;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      // Panel closed: refreshes never ask for connections, and the
      // management keys are strict no-ops (no state change, no requests).
      expect(method(requests, "connections")).toEqual([]);
      await ui.key("d");
      await ui.key("a");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(ui.state.draft).toBeUndefined();
      expect(method(requests, "connections")).toEqual([]);
      // Opening into a disabled catalog lands the structured not-enabled
      // message verbatim in the panel, keeps the gate closed and sends no
      // write requests from a/d.
      await ui.key("c");
      expect(ui.state.showConnections).toBe(true);
      expect(ui.state.focus).toBe("connections");
      expect(ui.state.connections).toBeUndefined();
      expect(ui.state.connectionsEnabled).toBe(false);
      expect(ui.state.connectionsNotice).toBe(
        "Connection catalog is not enabled; start the service with --catalog DIR",
      );
      const denied = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(denied).toContain(
        "Connections · Connection catalog is not enabled; start the service with --catalog DIR",
      );
      await ui.key("a");
      expect(ui.state.draft).toBeUndefined();
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(method(requests, "connections-add")).toEqual([]);
      expect(method(requests, "connections-remove")).toEqual([]);
      expect(ui.state.connected).toBe(true);
      // Recovery: the next pull succeeds, flips the gate and lists entries.
      enabled = true;
      await ui.refresh();
      expect(ui.state.connectionsEnabled).toBe(true);
      expect(ui.state.connectionsNotice).toBeUndefined();
      expect(ui.state.connections).toEqual([profile("alpha"), profile("beta")]);
      const listed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(listed).toContain("CONNECTIONS (2)");
      expect(listed).toContain("alpha · openai-compatible · model-alpha");
      // An empty catalog is a legitimate landed state: d arms nothing there.
      entries = [];
      await ui.refresh();
      expect(ui.state.connectionsEnabled).toBe(true);
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(method(requests, "connections-remove")).toEqual([]);
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "Connections (0)",
      );
      // Closing clears the whole panel state and restores the focus.
      entries = [profile("alpha")];
      await ui.refresh();
      await ui.key("c");
      expect(ui.state.showConnections).toBe(false);
      expect(ui.state.focus).toBe("runs");
      expect(ui.state.connections).toBeUndefined();
      expect(ui.state.connectionsEnabled).toBe(false);
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "CONNECTIONS (1)",
      );
    } finally {
      ui.stop();
    }
  });

  it("moves the connection cursor with j/k while the window follows it", async () => {
    let entries = Array.from({ length: 30 }, (_, index) =>
      profile(`conn-${String(index).padStart(2, "0")}`),
    );
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // 120x14 leaves 7 body rows for the panel: the header plus a 6-entry
      // window over the 30-entry list (the evidence panel's geometry).
      const frame = () => renderServiceWorkbench(ui.state, 120, 14, false);
      expect(ui.state.connectionsCursor).toBe(0);
      expect(frame()).toContain("› conn-00");
      expect(frame()).toContain("conn-05");
      expect(frame()).not.toContain("conn-06");
      // While the cursor stays inside the window, the window does not move.
      for (let step = 0; step < 5; step++) await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(5);
      expect(frame()).toContain("› conn-05");
      expect(frame()).not.toContain("conn-06");
      // One j past the bottom edge scrolls the window exactly one entry.
      await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(6);
      expect(frame()).toContain("conn-01");
      expect(frame()).toContain("› conn-06");
      expect(frame()).not.toContain("conn-00");
      // k scrolls the window back one entry per key; the cursor moves, the
      // run selection never does.
      await ui.key("k");
      expect(ui.state.connectionsCursor).toBe(5);
      expect(ui.state.selectedRunId).toBe("a");
      expect(frame()).toContain("› conn-05");
      // The cursor clamps at the last entry and the window follows it.
      for (let step = 0; step < 40; step++) await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(29);
      expect(frame()).toContain("conn-24");
      expect(frame()).toContain("› conn-29");
      expect(frame()).not.toContain("conn-23");
      // A refreshed, shorter list clamps the cursor to the new length.
      entries = entries.slice(0, 5);
      await ui.refresh();
      expect(ui.state.connectionsCursor).toBe(4);
    } finally {
      ui.stop();
    }
  });

  it("hosts one lower panel at a time: c closes evidence and e closes connections", async () => {
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "evidence") return [];
        if (request.method === "connections") return [profile("alpha")];
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("e");
      expect(ui.state.showEvidence).toBe(true);
      await ui.key("c");
      expect(ui.state.showConnections).toBe(true);
      expect(ui.state.showEvidence).toBe(false);
      expect(ui.state.evidence).toBeUndefined();
      expect(ui.state.focus).toBe("connections");
      const frame = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(frame).toContain("CONNECTIONS (1)");
      expect(frame).not.toContain("EVIDENCE (");
      // The other direction: opening evidence closes connections and drops
      // its whole state, including any armed remove.
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("alpha");
      await ui.key("e");
      expect(ui.state.showEvidence).toBe(true);
      expect(ui.state.showConnections).toBe(false);
      expect(ui.state.connections).toBeUndefined();
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "CONNECTIONS (1)",
      );
      // The tab rotation joins whichever panel is open: reopening the
      // connections pane puts it (not evidence) into the cycle.
      await ui.key("c");
      expect(ui.state.focus).toBe("connections");
      await ui.key("tab");
      expect(ui.state.focus).toBe("git");
    } finally {
      ui.stop();
    }
  });

  it("arms an explicit remove step and sends exactly one connections-remove per confirmation", async () => {
    const requests: unknown[] = [];
    let entries = [profile("alpha"), profile("beta")];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-remove") {
          entries = entries.filter((entry) => entry.id !== request.id);
          const removal: ConnectionWriteResult = {
            id: request.id,
            status: "removed",
          };
          return removal;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(1);
      // Arming and abandoning the confirmation step both send nothing.
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("beta");
      const armed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(armed).toContain(
        "remove connection beta? · return confirm · esc abandon",
      );
      await ui.key("escape");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(method(requests, "connections-remove")).toEqual([]);
      // Armed again on the cursor entry and confirmed: exactly one request,
      // the confirmation drops, the refreshed list is the outcome render.
      await ui.key("d");
      await ui.key("return");
      expect(method(requests, "connections-remove")).toEqual([
        { method: "connections-remove", id: "beta" },
      ]);
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual(["alpha"]);
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).toContain(
        "CONNECTIONS (1)",
      );
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "remove connection",
      );
    } finally {
      ui.stop();
    }
  });

  it("shows structured remove errors verbatim with the confirmation armed for an explicit retry", async () => {
    let removeFails = true;
    const message =
      "UNKNOWN_CONNECTION: Unknown connection id: beta. Run connections list to inspect the catalog.";
    const requests: unknown[] = [];
    let entries = [profile("alpha"), profile("beta")];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-remove") {
          if (removeFails) throw new Error(message);
          entries = entries.filter((entry) => entry.id !== request.id);
          const removal: ConnectionWriteResult = {
            id: request.id,
            status: "removed",
          };
          return removal;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("j");
      await ui.key("d");
      await ui.key("return");
      // The structured message lands verbatim in the panel; the connection,
      // the armed confirmation and the retry stay intact, and the global
      // notice slot is never touched.
      expect(ui.state.connectionsNotice).toBe(message);
      expect(ui.state.connectionRemoveId).toBe("beta");
      expect(ui.state.connected).toBe(true);
      expect(ui.state.notice).toBeUndefined();
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain(
        "Connections · UNKNOWN_CONNECTION: Unknown connection id: beta.",
      );
      expect(failed).toContain("remove connection beta? · return confirm");
      // The explicit retry sends a second request and lands the removal.
      removeFails = false;
      await ui.key("return");
      expect(method(requests, "connections-remove")).toHaveLength(2);
      expect(ui.state.connectionsNotice).toBeUndefined();
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual(["alpha"]);
    } finally {
      ui.stop();
    }
  });

  it("adds entries from a disk profile file once, keeping the draft on failures", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-add-"));
    const requests: unknown[] = [];
    const tuiProfile: ProviderProfile = {
      id: "tui-fixture",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:1/v1",
      keyEnv: "LOOM_TUI_PROBE_KEY",
    };
    const entries = [profile("existing")];
    let outcome: "added" | "unchanged" | Error = "added";
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections")
          return [...entries].sort((a, b) => a.id.localeCompare(b.id));
        if (request.method === "connections-add") {
          if (outcome instanceof Error) throw outcome;
          if (
            outcome === "added" &&
            !entries.some((entry) => entry.id === request.profile.id)
          )
            entries.push(request.profile);
          const result: ConnectionWriteResult = {
            id: request.profile.id,
            status: outcome,
          };
          return result;
        }
        return run("a");
      },
    });
    try {
      await writeFile(
        join(directory, "profile.json"),
        JSON.stringify(tuiProfile),
      );
      await writeFile(
        join(directory, "bad.json"),
        JSON.stringify({ id: "x", bogus: 1 }),
      );
      await ui.refresh();
      await ui.key("c");
      await ui.key("a");
      expect(ui.state.draft).toBe("add ");
      ui.state.draft = `add "${join(directory, "profile.json")}"`;
      await ui.submitDraft();
      // Exactly one connections-add, its body the loaded disk profile.
      expect(method(requests, "connections-add")).toEqual([
        { method: "connections-add", profile: tuiProfile },
      ]);
      expect(ui.state.draft).toBeUndefined();
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "existing",
        "tui-fixture",
      ]);
      // An idempotent re-add is presented as success (unchanged).
      outcome = "unchanged";
      await ui.key("a");
      ui.state.draft = `add "${join(directory, "profile.json")}"`;
      await ui.submitDraft();
      expect(method(requests, "connections-add")).toHaveLength(2);
      expect(ui.state.draft).toBeUndefined();
      expect(ui.state.connectionsNotice).toBeUndefined();
      // A wire error lands verbatim in the panel and keeps the draft.
      const conflict =
        'CONNECTION_CONFLICT: Connection "tui-fixture" already exists with different settings; remove it first or use a new id.';
      outcome = new Error(conflict);
      await ui.key("a");
      ui.state.draft = `add "${join(directory, "profile.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionsNotice).toBe(conflict);
      expect(ui.state.draft).toBe(`add "${join(directory, "profile.json")}"`);
      // A client-side INVALID_PROFILE (disk load, before any request) is
      // code-prefixed into the same panel channel and sends nothing; the
      // start draft's generic global notice is never used.
      const addsBefore = method(requests, "connections-add").length;
      ui.state.draft = `add "${join(directory, "bad.json")}"`;
      await ui.submitDraft();
      expect(method(requests, "connections-add")).toHaveLength(addsBefore);
      expect(ui.state.connectionsNotice).toBe(
        "INVALID_PROFILE: Invalid provider profile: unknown fields; use keyEnv for credentials",
      );
      expect(ui.state.draft).toBe(`add "${join(directory, "bad.json")}"`);
      expect(ui.state.notice).toBeUndefined();
      // The usage error routes to the panel too.
      ui.state.draft = "add";
      await ui.submitDraft();
      expect(ui.state.connectionsNotice).toBe(
        "Use add <profile path>; profile path is required",
      );
      // The draft submits through the real key path once corrected.
      outcome = "added";
      ui.state.draft = `add "${join(directory, "profile.json")}"`;
      await ui.submitDraft();
      expect(method(requests, "connections-add")).toHaveLength(addsBefore + 1);
      expect(ui.state.draft).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disarms the armed remove on any draft and keeps armed states mutually exclusive", async () => {
    const requests: unknown[] = [];
    let entries = [profile("alpha"), profile("beta")];
    const pending: RunSummary = {
      ...run("a"),
      usage: {
        limits: { maxCalls: 64, maxTokens: 1_000_000 },
        calls: 1,
        tokens: 0,
        pending: 1,
        reconciled: 0,
      },
      budget: { maxCalls: 64, maxTokens: 1_000_000 },
    };
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [pending];
        if (request.method === "connections") return entries;
        if (request.method === "connections-remove") {
          entries = entries.filter((entry) => entry.id !== request.id);
          const removal: ConnectionWriteResult = {
            id: request.id,
            status: "removed",
          };
          return removal;
        }
        return pending;
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // Arming d drops an armed b; return then confirms the remove only.
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("alpha");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      await ui.key("return");
      expect(method(requests, "reconcile-budget")).toEqual([]);
      expect(method(requests, "connections-remove")).toEqual([
        { method: "connections-remove", id: "alpha" },
      ]);
      // And the other direction: arming b drops an armed d.
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("beta");
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(ui.state.connectionRemoveId).toBeUndefined();
      await ui.key("escape");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      // Opening any draft (`a` here) disarms the armed remove; the hidden
      // confirmation never survives the context switch. Closing the draft
      // needs the dashboard host (a real TTY), so the controller-level test
      // deletes it directly — the same precedent as the start-input tests.
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("beta");
      await ui.key("a");
      expect(ui.state.draft).toBe("add ");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "return confirm",
      );
      delete ui.state.draft;
      await ui.key("return");
      expect(method(requests, "connections-remove")).toHaveLength(1);
      // The start draft disarms the armed remove the same way.
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("beta");
      await ui.key("n");
      expect(ui.state.draft).toBe("start ");
      expect(ui.state.connectionRemoveId).toBeUndefined();
      delete ui.state.draft;
      await ui.key("return");
      expect(method(requests, "connections-remove")).toHaveLength(1);
    } finally {
      ui.stop();
    }
  });

  it("drops late connection responses when the panel closes or the workbench stops", async () => {
    const resolvers: ((value: ServiceResult) => void)[] = [];
    let hold = true;
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (
          request.method === "connections" ||
          request.method === "connections-remove"
        ) {
          if (hold)
            return new Promise<ServiceResult>((resolve) => {
              resolvers.push(resolve);
            });
          if (request.method === "connections") return [profile("alpha")];
          const removal: ConnectionWriteResult = {
            id: request.id,
            status: "removed",
          };
          return removal;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      // Opening the panel queues a pull; closing it before the response must
      // drop the list (and the whole panel state) when it finally lands.
      const opening = ui.key("c");
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      await ui.key("c");
      resolvers[0]?.([profile("alpha")]);
      await opening;
      expect(ui.state.showConnections).toBe(false);
      expect(ui.state.connections).toBeUndefined();
      // Reopen and land the list, then arm a remove; stop() invalidates the
      // in-flight request so neither the removal nor a late notice lands.
      hold = false;
      await ui.key("c");
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual(["alpha"]);
      hold = true;
      await ui.key("d");
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      ui.stop();
      resolvers[1]?.({ id: "alpha", status: "removed" });
      await confirming;
      expect(ui.state.connectionRemoveId).toBe("alpha");
      expect(ui.state.removingConnection).toBe(false);
      expect(ui.state.connectionsNotice).toBeUndefined();
    } finally {
      ui.stop();
    }
  });

  it("lands in-flight remove outcomes across periodic refresh ticks", async () => {
    const finishers: ((outcome: ServiceResult | Error) => void)[] = [];
    let hold = false;
    let heldId = "";
    let entries = [profile("alpha"), profile("beta")];
    const message =
      "CATALOG_BUSY: Connection catalog is locked; retry after the other catalog operation finishes.";
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-remove") {
          if (hold) {
            heldId = request.id;
            return new Promise<ServiceResult>((resolve, reject) => {
              finishers.push((outcome) =>
                outcome instanceof Error ? reject(outcome) : resolve(outcome),
              );
            });
          }
          entries = entries.filter((entry) => entry.id !== request.id);
          const removal: ConnectionWriteResult = {
            id: request.id,
            status: "removed",
          };
          return removal;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // A remove hangs in flight while a full periodic refresh tick runs
      // (refresh() pulls the connection list again) — the remove guard must
      // not share the list-pull revision, or the outcome is silently dropped
      // and the armed id lingers. Success first: the confirmation drops and
      // the list refresh after it lands.
      hold = true;
      await ui.key("d");
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(1));
      await ui.refresh();
      entries = entries.filter((entry) => entry.id !== heldId);
      finishers[0]?.({ id: heldId, status: "removed" });
      await confirming;
      expect(ui.state.connectionRemoveId).toBeUndefined();
      expect(ui.state.removingConnection).toBe(false);
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual(["beta"]);
      // The structured error path survives a tick too: the message lands
      // verbatim with the confirmation kept armed for an explicit retry.
      await ui.key("d");
      const retrying = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(2));
      await ui.refresh();
      finishers[1]?.(new Error(message));
      await retrying;
      expect(ui.state.connectionsNotice).toBe(message);
      expect(ui.state.connectionRemoveId).toBe("beta");
      expect(ui.state.connected).toBe(true);
      // Abandon still drops a late response for the abandoned confirmation.
      await ui.key("escape");
      expect(ui.state.connectionRemoveId).toBeUndefined();
    } finally {
      ui.stop();
    }
  });

  it("keeps the panel fitted and terminal-clean on narrow screens with every footer key visible", async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      ...profile(`conn-${String(index).padStart(2, "0")}`),
      // One entry carries terminal control characters in its id: the
      // sanitizer must strip them wherever the window happens to expose it.
      ...(index === 12 ? { id: "conn\x1b[2J\n-12" } : {}),
    }));
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // Scroll deep into the list so the window around the control-character
      // entry conn-12 is under fit stress at every narrow size.
      for (let step = 0; step < 15; step++) await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(15);
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      const wide = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(wide).toContain("conn-10");
      expect(wide).toContain("› conn-15");
      expect(wide).not.toContain("\x1b");
      // The re-compressed footer keeps the new panel key, the reconcile key
      // and detach visible at exactly 120 columns.
      expect(wide).toContain("c conns");
      expect(wide).toContain("b reconcile");
      expect(wide).toContain("q detach");
    } finally {
      ui.stop();
    }
  });

  it("parses edit commands with quoted paths and rejects malformed ones", () => {
    expect(parseEditCommand('edit "/tmp/my profile.json"')).toEqual({
      profilePath: "/tmp/my profile.json",
    });
    expect(parseEditCommand("edit /tmp/profile.json")).toEqual({
      profilePath: "/tmp/profile.json",
    });
    expect(() => parseEditCommand("edit")).toThrow(/required/);
    expect(() => parseEditCommand("edit a b")).toThrow(/required/);
    expect(() => parseEditCommand('edit "unterminated')).toThrow(/quote/);
  });

  it("keeps the edit draft gated: closed panel, closed gate and empty list are zero-state no-ops", async () => {
    const requests: unknown[] = [];
    let enabled = false;
    const entries: ProviderProfile[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") {
          if (!enabled)
            throw new Error(
              "Connection catalog is not enabled; start the service with --catalog DIR",
            );
          return entries;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      // Panel closed: u never opens a draft, and refreshes never ask for
      // connections at all.
      await ui.key("u");
      expect(ui.state.draft).toBeUndefined();
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(method(requests, "connections")).toEqual([]);
      // Disabled gate (the structured not-enabled message standing): the
      // management key stays a strict no-op — no draft, no write request.
      await ui.key("c");
      expect(ui.state.connectionsEnabled).toBe(false);
      await ui.key("u");
      expect(ui.state.draft).toBeUndefined();
      expect(method(requests, "connections-update")).toEqual([]);
      // Enabled but empty: a legitimate landed state with no cursor entry
      // to edit — the key opens nothing and sends nothing.
      enabled = true;
      await ui.refresh();
      expect(ui.state.connectionsEnabled).toBe(true);
      expect(ui.state.connections).toEqual([]);
      await ui.key("u");
      expect(ui.state.draft).toBeUndefined();
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(method(requests, "connections-update")).toEqual([]);
    } finally {
      ui.stop();
    }
  });

  it("edits the cursor entry from a disk profile through an armed confirmation, sending exactly one connections-update", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-edit-"));
    const requests: unknown[] = [];
    const editProfile: ProviderProfile = {
      id: "existing",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "edited-model",
      baseUrl: "http://127.0.0.1:1/v1",
      keyEnv: "LOOM_TUI_EDIT_KEY",
    };
    let entries = [profile("existing"), profile("beta")];
    let outcome: "updated" | "unchanged" | Error = "updated";
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-update") {
          if (outcome instanceof Error) throw outcome;
          if (outcome === "updated")
            entries = entries.map((entry) =>
              entry.id === request.profile.id ? request.profile : entry,
            );
          const result: ConnectionWriteResult = {
            id: request.profile.id,
            status: outcome,
          };
          return result;
        }
        return run("a");
      },
    });
    try {
      await writeFile(
        join(directory, "edit.json"),
        JSON.stringify(editProfile),
      );
      await ui.refresh();
      await ui.key("c");
      // u opens the edit draft on the cursor entry; submitting it arms the
      // confirmation and sends nothing yet — the draft is consumed.
      await ui.key("u");
      expect(ui.state.draft).toBe("edit ");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "existing",
        profilePath: join(directory, "edit.json"),
      });
      expect(ui.state.draft).toBeUndefined();
      expect(method(requests, "connections-update")).toEqual([]);
      const armed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(armed).toContain(
        "update connection existing? · return confirm · esc abandon",
      );
      // return loads the disk profile and sends exactly one
      // connections-update whose body is the loaded profile; the refreshed
      // list is the outcome render and the confirmation drops.
      await ui.key("return");
      expect(method(requests, "connections-update")).toEqual([
        { method: "connections-update", profile: editProfile },
      ]);
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(
        ui.state.connections?.find((entry) => entry.id === "existing")?.modelId,
      ).toBe("edited-model");
      expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
        "update connection existing?",
      );
      // The idempotent unchanged acknowledgement is presented as success.
      outcome = "unchanged";
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      await ui.key("return");
      expect(method(requests, "connections-update")).toHaveLength(2);
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.connectionsNotice).toBeUndefined();
      // A usage error keeps the draft and lands in the panel notice, like
      // the add draft's usage errors.
      ui.state.draft = "edit";
      await ui.submitDraft();
      expect(ui.state.connectionsNotice).toBe(
        "Use edit <profile path>; profile path is required",
      );
      expect(ui.state.draft).toBe("edit");
      // Abandoning the armed edit sends nothing and drops it.
      delete ui.state.connectionsNotice;
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("existing");
      await ui.key("escape");
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(method(requests, "connections-update")).toHaveLength(2);
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("intercepts profile id mismatches client-side with zero wire requests", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-mismatch-"));
    const requests: unknown[] = [];
    await writeFile(
      join(directory, "other.json"),
      JSON.stringify({ ...profile("alpha"), id: "other" }),
    );
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return [profile("alpha")];
        if (request.method === "connections-update") {
          const result: ConnectionWriteResult = {
            id: request.profile.id,
            status: "updated",
          };
          return result;
        }
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "other.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      await ui.key("return");
      // The loaded profile id differs from the armed entry: the panel
      // prompt lands client-side and the wire never sees a request — a
      // TUI-side tightening of the web form's mismatch hint (the form
      // still sends the PUT and shows the service 400).
      expect(method(requests, "connections-update")).toEqual([]);
      expect(ui.state.connectionsNotice).toBe(
        "Profile id other differs from entry alpha; no update request sent",
      );
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "other.json"),
      });
      expect(ui.state.connected).toBe(true);
      const mismatch = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(mismatch).toContain(
        "Connections · Profile id other differs from entry alpha",
      );
      expect(mismatch).toContain("update connection alpha? · return confirm");
      // Abandoning and re-arming with a matching profile sends exactly one
      // update: the prompt is not a dead end.
      await ui.key("escape");
      await writeFile(
        join(directory, "matching.json"),
        JSON.stringify({ ...profile("alpha"), modelId: "matched-model" }),
      );
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "matching.json")}"`;
      await ui.submitDraft();
      await ui.key("return");
      expect(method(requests, "connections-update")).toEqual([
        {
          method: "connections-update",
          profile: { ...profile("alpha"), modelId: "matched-model" },
        },
      ]);
      expect(ui.state.connectionEdit).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefixes client-side edit load failures like the wire and keeps the confirmation armed", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-editload-"));
    const requests: unknown[] = [];
    await writeFile(
      join(directory, "bad.json"),
      JSON.stringify({ id: "alpha", bogus: 1 }),
    );
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return [profile("alpha")];
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "bad.json")}"`;
      await ui.submitDraft();
      await ui.key("return");
      // The confirmation-time disk load fails before any request: the
      // code-prefixed INVALID_PROFILE lands verbatim in the panel and the
      // armed confirmation stays for an explicit retry or abandon.
      expect(method(requests, "connections-update")).toEqual([]);
      expect(ui.state.connectionsNotice).toBe(
        "INVALID_PROFILE: Invalid provider profile: unknown fields; use keyEnv for credentials",
      );
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "bad.json"),
      });
      expect(ui.state.notice).toBeUndefined();
      expect(ui.state.connected).toBe(true);
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain(
        "Connections · INVALID_PROFILE: Invalid provider profile: unknown fields",
      );
      expect(failed).toContain("update connection alpha? · return confirm");
      await ui.key("escape");
      expect(ui.state.connectionEdit).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows structured update errors verbatim with the confirmation armed for an explicit retry", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-editerr-"));
    const requests: unknown[] = [];
    let updateFails = true;
    const message =
      "UNKNOWN_CONNECTION: Unknown connection id: alpha. Run connections list to inspect the catalog.";
    let entries = [profile("alpha"), profile("beta")];
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-update") {
          if (updateFails) throw new Error(message);
          entries = entries.map((entry) =>
            entry.id === request.profile.id ? request.profile : entry,
          );
          const result: ConnectionWriteResult = {
            id: request.profile.id,
            status: "updated",
          };
          return result;
        }
        return run("a");
      },
    });
    try {
      await writeFile(
        join(directory, "edit.json"),
        JSON.stringify(editProfile),
      );
      await ui.refresh();
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      await ui.key("return");
      // The structured message lands verbatim in the panel; the connection,
      // the armed confirmation and the retry stay intact, and the global
      // notice slot is never touched.
      expect(ui.state.connectionsNotice).toBe(message);
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      expect(ui.state.connected).toBe(true);
      expect(ui.state.notice).toBeUndefined();
      const failed = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(failed).toContain(
        "Connections · UNKNOWN_CONNECTION: Unknown connection id: alpha.",
      );
      expect(failed).toContain("update connection alpha? · return confirm");
      // The explicit retry sends a second request and lands the update.
      updateFails = false;
      await ui.key("return");
      expect(method(requests, "connections-update")).toHaveLength(2);
      expect(ui.state.connectionsNotice).toBeUndefined();
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(
        ui.state.connections?.find((entry) => entry.id === "alpha")?.modelId,
      ).toBe("edited-model");
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the three armed confirmations mutually exclusive and disarmed by any draft", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-mutex-"));
    const requests: unknown[] = [];
    const pending: RunSummary = {
      ...run("a"),
      usage: {
        limits: { maxCalls: 64, maxTokens: 1_000_000 },
        calls: 1,
        tokens: 0,
        pending: 1,
        reconciled: 0,
      },
      budget: { maxCalls: 64, maxTokens: 1_000_000 },
    };
    const entries = [profile("alpha"), profile("beta")];
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [pending];
        if (request.method === "connections") return entries;
        if (request.method === "connections-update") {
          const result: ConnectionWriteResult = {
            id: request.profile.id,
            status: "updated",
          };
          return result;
        }
        return pending;
      },
    });
    try {
      await writeFile(
        join(directory, "edit.json"),
        JSON.stringify(editProfile),
      );
      await ui.refresh();
      await ui.key("c");
      // Opening the u draft disarms an armed b, and the draft's submission
      // itself arms the edit while dropping anything that armed while the
      // draft was open (controller-level defensive invariant) — return then
      // confirms the update only.
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      await ui.key("u");
      expect(ui.state.draft).toBe("edit ");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      expect(ui.state.reconcileConfirm).toBeUndefined();
      await ui.key("return");
      expect(method(requests, "reconcile-budget")).toEqual([]);
      expect(method(requests, "connections-update")).toEqual([
        { method: "connections-update", profile: editProfile },
      ]);
      // d arming drops an armed edit; return then confirms the remove only.
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      await ui.key("d");
      expect(ui.state.connectionRemoveId).toBe("alpha");
      expect(ui.state.connectionEdit).toBeUndefined();
      await ui.key("escape");
      // b arming drops an armed edit the other direction.
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      await ui.key("b");
      expect(ui.state.reconcileConfirm).toBe(true);
      expect(ui.state.connectionEdit).toBeUndefined();
      await ui.key("escape");
      // Every draft opening — n, a and u — disarms the armed edit; the
      // hidden confirmation never survives the context switch. Closing the
      // drafts needs the dashboard host (a real TTY), so the controller
      // -level tests delete them directly (existing precedent).
      for (const key of ["n", "a", "u"]) {
        await ui.key("u");
        ui.state.draft = `edit "${join(directory, "edit.json")}"`;
        await ui.submitDraft();
        expect(ui.state.connectionEdit?.id).toBe("alpha");
        await ui.key(key);
        expect(
          ui.state.connectionEdit,
          `draft ${key} must disarm the armed edit`,
        ).toBeUndefined();
        expect(renderServiceWorkbench(ui.state, 120, 32, false)).not.toContain(
          "return confirm",
        );
        delete ui.state.draft;
      }
      await ui.key("return");
      expect(method(requests, "connections-update")).toHaveLength(1);
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops late update responses when the panel closes or the workbench stops", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-editlate-"));
    const resolvers: ((value: ServiceResult) => void)[] = [];
    const hold = true;
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    await writeFile(join(directory, "edit.json"), JSON.stringify(editProfile));
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return [profile("alpha")];
        if (request.method === "connections-update" && hold)
          return new Promise<ServiceResult>((resolve) => {
            resolvers.push(resolve);
          });
        if (request.method === "connections-update")
          return { id: request.profile.id, status: "updated" };
        return run("a");
      },
    });
    try {
      await ui.refresh();
      // Arm and confirm; the update hangs in flight while the panel closes
      // — the late outcome must never land.
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      await ui.key("c");
      resolvers[0]?.({ id: "alpha", status: "updated" });
      await confirming;
      expect(ui.state.showConnections).toBe(false);
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.updatingConnection).toBe(false);
      expect(ui.state.connectionsNotice).toBeUndefined();
      // Reopen, land the list and arm again; stop() invalidates the
      // in-flight request so neither the update nor a late notice lands.
      await ui.key("c");
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual(["alpha"]);
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      const confirmingAgain = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      ui.stop();
      resolvers[1]?.({ id: "alpha", status: "updated" });
      await confirmingAgain;
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      expect(ui.state.updatingConnection).toBe(false);
      expect(ui.state.connectionsNotice).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lands in-flight update outcomes across periodic refresh ticks", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-edittick-"));
    const finishers: ((outcome: ServiceResult | Error) => void)[] = [];
    let hold = false;
    let entries = [profile("alpha"), profile("beta")];
    const message =
      "CATALOG_BUSY: Connection catalog is locked; retry after the other catalog operation finishes.";
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-update") {
          if (hold)
            return new Promise<ServiceResult>((resolve, reject) => {
              finishers.push((outcome) =>
                outcome instanceof Error ? reject(outcome) : resolve(outcome),
              );
            });
          entries = entries.map((entry) =>
            entry.id === request.profile.id ? request.profile : entry,
          );
          return { id: request.profile.id, status: "updated" };
        }
        return run("a");
      },
    });
    try {
      await writeFile(
        join(directory, "edit.json"),
        JSON.stringify(editProfile),
      );
      await ui.refresh();
      await ui.key("c");
      // An update hangs in flight while a full periodic refresh tick runs
      // (refresh() pulls the connection list again) — the update guard must
      // not share the list-pull revision, or the outcome is silently
      // dropped and the armed edit lingers. Success first: the confirmation
      // drops and the refreshed list shows the edited fields.
      hold = true;
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(1));
      await ui.refresh();
      entries = entries.map((entry) =>
        entry.id === "alpha" ? editProfile : entry,
      );
      finishers[0]?.({ id: "alpha", status: "updated" });
      await confirming;
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.updatingConnection).toBe(false);
      expect(
        ui.state.connections?.find((entry) => entry.id === "alpha")?.modelId,
      ).toBe("edited-model");
      // The structured error path survives a tick too: the message lands
      // verbatim with the confirmation kept armed for an explicit retry.
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      const retrying = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(2));
      await ui.refresh();
      finishers[1]?.(new Error(message));
      await retrying;
      expect(ui.state.connectionsNotice).toBe(message);
      expect(ui.state.connectionEdit?.id).toBe("alpha");
      expect(ui.state.connected).toBe(true);
      // Abandon still drops a late response for the abandoned confirmation.
      await ui.key("escape");
      expect(ui.state.connectionEdit).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the edit key a zero-state no-op while a connections-update is in flight, arming fresh once idle", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-ufly-"));
    const requests: unknown[] = [];
    const resolvers: ((value: ServiceResult) => void)[] = [];
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    await writeFile(join(directory, "edit.json"), JSON.stringify(editProfile));
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return [profile("alpha")];
        if (request.method === "connections-update")
          return new Promise<ServiceResult>((resolve) => {
            resolvers.push(resolve);
          });
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // Arm the edit confirmation and confirm it; the update hangs in flight.
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "edit.json"),
      });
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      expect(ui.state.updatingConnection).toBe(true);
      // A second `u` during the flight is a strict zero-state no-op — the
      // symmetric twin of `d`'s `!removingConnection` guard: no draft opens
      // (which would disarm the in-flight confirmation's owner), the armed
      // target keeps its original entry and path, and nothing new goes to
      // the wire.
      expect(method(requests, "connections-update")).toHaveLength(1);
      await ui.key("u");
      expect(ui.state.draft).toBeUndefined();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "edit.json"),
      });
      expect(method(requests, "connections-update")).toHaveLength(1);
      // Releasing the hang as success lands for its own request: the
      // confirmation clears per the existing success semantics and the
      // list refreshes.
      resolvers[0]?.({ id: "alpha", status: "updated" });
      await confirming;
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.updatingConnection).toBe(false);
      // Idle again, `u` re-opens the draft normally.
      await ui.key("u");
      expect(ui.state.draft).toBe("edit ");
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("guards the edit draft arming point while a connections-update is in flight (draft rewrite path)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-uarm-"));
    const requests: unknown[] = [];
    const resolvers: ((value: ServiceResult) => void)[] = [];
    const first: ProviderProfile = {
      ...profile("alpha"),
      modelId: "first-model",
    };
    const second: ProviderProfile = {
      ...profile("alpha"),
      modelId: "second-model",
    };
    await writeFile(join(directory, "first.json"), JSON.stringify(first));
    await writeFile(join(directory, "second.json"), JSON.stringify(second));
    const entries = [profile("alpha")];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        if (request.method === "connections-update")
          return new Promise<ServiceResult>((resolve) => {
            resolvers.push(resolve);
          });
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "first.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "first.json"),
      });
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      expect(ui.state.updatingConnection).toBe(true);
      // The dashboard host treats an open draft as free text (any printable
      // character appends, backspace deletes), so an `n`/`a` draft can be
      // rewritten into `edit …` and submitted while the update hangs — the
      // arming-point guard is load-bearing for that real host path, not a
      // purely defensive twin of the `u` key gate. Controller-level tests
      // set the draft directly (the existing convention for host-level
      // typing). The blocked submit is a zero-state no-op: the original
      // armed target survives untouched, the draft is not consumed and
      // nothing goes to the wire.
      ui.state.draft = `edit "${join(directory, "second.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "first.json"),
      });
      expect(ui.state.draft).toBe(`edit "${join(directory, "second.json")}"`);
      expect(method(requests, "connections-update")).toHaveLength(1);
      // The late success lands for its own request only: the original
      // confirmation clears, and the surviving draft can arm fresh once
      // idle — the resubmit consumes it against the second path.
      resolvers[0]?.({ id: "alpha", status: "updated" });
      await confirming;
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.updatingConnection).toBe(false);
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "second.json"),
      });
      expect(ui.state.draft).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the original edit arming through a hanging CATALOG_BUSY failure with no new arming to cross-talk", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-ufail-"));
    const requests: unknown[] = [];
    const finishers: ((outcome: ServiceResult | Error) => void)[] = [];
    const message =
      "CATALOG_BUSY: Connection catalog is locked; retry after the other catalog operation finishes.";
    const editProfile: ProviderProfile = {
      ...profile("alpha"),
      modelId: "edited-model",
    };
    await writeFile(join(directory, "edit.json"), JSON.stringify(editProfile));
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return [profile("alpha")];
        if (request.method === "connections-update")
          return new Promise<ServiceResult>((resolve, reject) => {
            finishers.push((outcome) =>
              outcome instanceof Error ? reject(outcome) : resolve(outcome),
            );
          });
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      await ui.key("u");
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      const confirming = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(1));
      // Both re-arm paths stay closed during the flight: the key (no draft
      // opens, the armed target survives) and the draft submit (a rewritten
      // `edit …` draft is neither consumed nor armed).
      await ui.key("u");
      expect(ui.state.draft).toBeUndefined();
      ui.state.draft = `edit "${join(directory, "edit.json")}"`;
      await ui.submitDraft();
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "edit.json"),
      });
      expect(ui.state.draft).toBe(`edit "${join(directory, "edit.json")}"`);
      expect(method(requests, "connections-update")).toHaveLength(1);
      // The failure lands as its own request's notice: verbatim,
      // panel-local, with the original confirmation kept armed for the
      // explicit retry — no new arming ever existed for the stale error to
      // cross-talk with.
      finishers[0]?.(new Error(message));
      await confirming;
      expect(ui.state.connectionsNotice).toBe(message);
      expect(ui.state.connectionEdit).toEqual({
        id: "alpha",
        profilePath: join(directory, "edit.json"),
      });
      expect(ui.state.updatingConnection).toBe(false);
      expect(ui.state.connected).toBe(true);
      expect(ui.state.notice).toBeUndefined();
      // Idle again, the explicit retry works: the second request succeeds,
      // the confirmation drops and the notice clears.
      delete ui.state.draft;
      const retrying = ui.key("return");
      await vi.waitFor(() => expect(finishers).toHaveLength(2));
      finishers[1]?.({ id: "alpha", status: "updated" });
      await retrying;
      expect(method(requests, "connections-update")).toHaveLength(2);
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.connectionsNotice).toBeUndefined();
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still submits an add draft after the panel closes mid-draft; an edit draft degrades to the no-entry notice", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-uclose-"));
    const requests: unknown[] = [];
    const diskProfile: ProviderProfile = {
      id: "tui-fixture",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "fixture-model",
      baseUrl: "http://127.0.0.1:1/v1",
      keyEnv: "LOOM_TUI_PROBE_KEY",
    };
    const entries = [profile("alpha")];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "list") return [run("a")];
        if (request.method === "connections")
          return [...entries].sort((a, b) => a.id.localeCompare(b.id));
        if (request.method === "connections-add") {
          entries.push(request.profile);
          const addition: ConnectionWriteResult = {
            id: request.profile.id,
            status: "added",
          };
          return addition;
        }
        return run("a");
      },
    });
    try {
      await writeFile(
        join(directory, "profile.json"),
        JSON.stringify(diskProfile),
      );
      await ui.refresh();
      await ui.key("c");
      // add half: the draft opens under the open gate, then the panel
      // closes with the draft still standing. `c` with a draft open is
      // unreachable in the real host (the open draft swallows every key,
      // see runServiceDashboard), so the controller-level test drives the
      // key directly — pinning the tolerated existing behavior the
      // previous slice's boundary paragraph declared unverified.
      await ui.key("a");
      expect(ui.state.draft).toBe("add ");
      ui.state.draft = `add "${join(directory, "profile.json")}"`;
      await ui.key("c");
      expect(ui.state.showConnections).toBe(false);
      expect(ui.state.connections).toBeUndefined();
      const connectionsBefore = method(requests, "connections").length;
      await ui.submitDraft();
      // The add still goes out: exactly one connections-add whose body is
      // the loaded disk profile; the post-add list refresh no-ops with the
      // panel closed (zero connection traffic) and the draft is consumed.
      expect(method(requests, "connections-add")).toEqual([
        { method: "connections-add", profile: diskProfile },
      ]);
      expect(method(requests, "connections")).toHaveLength(connectionsBefore);
      expect(ui.state.draft).toBeUndefined();
      // edit half: same shape, opposite outcome — closeConnections deleted
      // the list, so the submit finds no cursor entry and lands the panel
      // notice with zero wire requests and no arming; the draft stays.
      await ui.key("c");
      expect(ui.state.connections?.map((entry) => entry.id)).toEqual([
        "alpha",
        "tui-fixture",
      ]);
      await ui.key("u");
      expect(ui.state.draft).toBe("edit ");
      ui.state.draft = `edit "${join(directory, "profile.json")}"`;
      await ui.key("c");
      await ui.submitDraft();
      expect(method(requests, "connections-update")).toEqual([]);
      expect(ui.state.connectionsNotice).toBe(
        "No connection entry under the cursor; nothing to edit",
      );
      expect(ui.state.connectionEdit).toBeUndefined();
      expect(ui.state.draft).toBe(`edit "${join(directory, "profile.json")}"`);
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the armed edit prompt fitted and terminal-clean on narrow screens with every footer key visible", async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      ...profile(`conn-${String(index).padStart(2, "0")}`),
      // The armed entry carries terminal control characters in its id: the
      // confirmation prompt must stay sanitized wherever it renders.
      ...(index === 12 ? { id: "conn\x1b[2J\n-12" } : {}),
    }));
    const ui = new ServiceWorkbench({
      async request(request) {
        if (request.method === "list") return [run("a")];
        if (request.method === "connections") return entries;
        return run("a");
      },
    });
    try {
      await ui.refresh();
      await ui.key("c");
      // Move the cursor onto the control-character entry and arm the edit
      // there — the path only needs to parse, the profile loads on confirm.
      for (let step = 0; step < 12; step++) await ui.key("j");
      expect(ui.state.connectionsCursor).toBe(12);
      await ui.key("u");
      ui.state.draft = 'edit "/tmp/loom-edit-profile.json"';
      await ui.submitDraft();
      expect(ui.state.connectionEdit?.id).toBe("conn\x1b[2J\n-12");
      for (const width of [1, 12, 40, 80]) {
        for (const height of [1, 6, 8, 12]) {
          const lines = renderServiceWorkbench(
            ui.state,
            width,
            height,
            false,
          ).split("\n");
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => [...line].length <= width)).toBe(true);
        }
      }
      const wide = renderServiceWorkbench(ui.state, 120, 32, false);
      // The sanitizer strips the escape sequence and turns the injected
      // newline into a space — the armed id renders "conn -12", sanitized.
      expect(wide).toContain("update connection conn -12? · return confirm");
      expect(wide).not.toContain("\x1b");
      // Abandoned, the re-compressed footer keeps the edit key, the panel
      // key, the reconcile key and detach visible at exactly 120 columns.
      await ui.key("escape");
      const keys = renderServiceWorkbench(ui.state, 120, 32, false);
      expect(keys).toContain("u edit");
      expect(keys).toContain("c conns");
      expect(keys).toContain("b reconcile");
      expect(keys).toContain("q detach");
    } finally {
      ui.stop();
    }
  });
});

describe("service start input", () => {
  it("loads the explicit files and sends objects once, retaining the draft on failure", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "loom-tui-start-"));
    const spec = {
      runId: "a",
      goal: "test",
      repositoryPath: directory,
      worktreePath: join(directory, "tree"),
      baseCommit: "abc",
      targeted: ["true"],
      regression: ["true"],
    };
    const profile = {
      id: "fixture",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
    };
    const requests: unknown[] = [];
    const ui = new ServiceWorkbench({
      async request(request) {
        requests.push(request);
        if (request.method === "start") throw new Error("acknowledgement lost");
        return [];
      },
    });
    try {
      await writeFile(join(directory, "spec.json"), JSON.stringify(spec));
      await writeFile(join(directory, "profile.json"), JSON.stringify(profile));
      const draft = `start "${directory}/spec.json" "${directory}/profile.json"`;
      ui.state.draft = draft;
      await Promise.all([ui.submitDraft(), ui.submitDraft()]);
      expect(requests).toEqual([{ method: "start", spec, profile }]);
      expect(ui.state.draft).toBe(draft);
      expect(ui.state.notice).toContain("acknowledgement lost");
      expect(ui.state.submitting).toBe(false);
    } finally {
      ui.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the last snapshot across disconnect and clears stale warning after reconnect", async () => {
    let connected = true;
    const ui = new ServiceWorkbench({
      async request(request) {
        if (!connected) throw new Error("offline");
        return request.method === "list" ? [run("a")] : run("a");
      },
    });
    await ui.refresh();
    connected = false;
    await ui.refresh();
    expect(ui.state.connected).toBe(false);
    expect(ui.state.detail?.runId).toBe("a");
    expect(ui.state.notice).toContain("stale");
    connected = true;
    await ui.refresh();
    expect(ui.state.connected).toBe(true);
    expect(ui.state.notice).toBeUndefined();
    ui.stop();
  });
});

it("runs the standalone once client against a real socket without opening a Runtime", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const { LoomService } = await import("../src/service/daemon.js");
  const directory = await mkdtemp(join(tmpdir(), "loom-tui-socket-"));
  const service = await LoomService.open({
    dataRoot: directory,
    runtimeFactory() {
      throw new Error("TUI must not open Runtime");
    },
  });
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/service-tui.ts",
        "--data-root",
        directory,
        "--once",
      ],
      { cwd: process.cwd() },
    );
    expect(stdout).toContain("RUN WORKBENCH");
    expect(stdout).toContain("connected");
    expect(stdout).toContain("No runs");
    expect(stdout).not.toContain("\x1b");
    expect(await readdir(join(directory, "runs"))).toEqual([]);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
