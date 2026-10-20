import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  InputWithdrawnError,
  InteractionController,
} from "../orchestrator/controller.js";
import type { RuntimeSession } from "../runtime/session.js";
import { readGitDiff, readGitSnapshot } from "../workspace/git.js";
import { ActivityProjection } from "./activity.js";
import { renderDashboard } from "./render.js";
import type { DashboardState } from "./types.js";

export interface DashboardOptions {
  cwd: string;
  runtime?: RuntimeSession;
  prompt?: string;
  requestId?: string;
  once?: boolean;
  readOnly?: boolean;
  signal?: AbortSignal;
  onInterrupt?: () => void;
}

/** Draft ownership lasts until durable admission succeeds, independently of execution. */
export class DashboardComposer {
  private requestId: string | undefined;
  constructor(
    private readonly state: DashboardState,
    private readonly send: (
      content: string,
      requestId?: string,
    ) => Promise<void>,
    private readonly changed: () => void,
  ) {}

  open(draft = "", requestId?: string) {
    if (this.state.input === undefined) {
      this.state.input = draft;
      this.requestId = requestId;
    }
    this.changed();
  }

  key(text: string, key: Key) {
    if (this.state.input === undefined) return;
    if (this.state.inputAdmitting) {
      this.state.inputNotice = "Admitting input · draft locked until persisted";
      this.changed();
      return;
    }
    delete this.state.inputNotice;
    if (key.name === "escape") {
      delete this.state.input;
      this.requestId = undefined;
    } else if (key.name === "return") {
      const content = this.state.input.trim();
      if (content) void this.admit(content);
    } else if (key.name === "backspace") {
      this.requestId = undefined;
      this.state.input = [...this.state.input].slice(0, -1).join("");
    } else if (text && !key.ctrl && !key.meta) {
      this.requestId = undefined;
      this.state.input = (
        this.state.input + text.replace(/[\r\n\t]/g, " ")
      ).slice(0, 8000);
    }
    this.changed();
  }

  private async admit(content: string) {
    this.state.inputAdmitting = true;
    this.requestId ??= randomUUID();
    try {
      await this.send(content, this.requestId);
      this.requestId = undefined;
      delete this.state.input;
      delete this.state.inputNotice;
    } catch (error) {
      this.state.inputNotice =
        error instanceof InputWithdrawnError
          ? "Host input cancelled · draft retained · edit for a new request; inspect /status"
          : "Admission failed · draft retained · inspect activity";
    } finally {
      this.state.inputAdmitting = false;
      this.changed();
    }
  }
}

/** Nonoverlapping polling catches external editors and Git ref/index changes too. */
export class DashboardController {
  readonly state: DashboardState;
  private stopped = false;
  private refreshing = false;
  private refreshAgain = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private diffRevision = 0;
  constructor(
    cwd: string,
    private readonly changed: () => void,
  ) {
    this.state = {
      cwd,
      refreshing: false,
      selectedWorktree: 0,
      selectedFile: 0,
      focus: "files",
      scroll: 0,
      diff: "",
      activity: [],
      runtimeStatus: "not attached · Git observer",
      readOnly: false,
      diffMode: "working",
    };
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    const cwd = this.state.cwd;
    this.refreshing = this.state.refreshing = true;
    this.changed();
    try {
      const snapshot = await readGitSnapshot(cwd);
      if (this.stopped || cwd !== this.state.cwd) return;
      const selectedPath = this.state.git?.files[this.state.selectedFile]?.path;
      this.state.selectedFile = Math.max(
        0,
        snapshot.files.findIndex((file) => file.path === selectedPath),
      );
      this.state.git = snapshot;
      delete this.state.gitError;
      this.state.selectedWorktree = Math.min(
        this.state.selectedWorktree,
        Math.max(0, snapshot.worktrees.length - 1),
      );
      await this.loadDiff();
    } catch {
      this.state.gitError =
        "Repository unavailable or observation limit reached";
    } finally {
      this.refreshing = this.state.refreshing = false;
      if (!this.stopped) this.changed();
      if (this.refreshAgain && !this.stopped) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }
  async loadDiff() {
    const revision = ++this.diffRevision;
    const file = this.state.git?.files[this.state.selectedFile];
    this.state.diff = "";
    if (file) {
      try {
        const diff = await readGitDiff(
          this.state.cwd,
          file,
          this.state.diffMode,
        );
        if (revision === this.diffRevision && !this.stopped)
          this.state.diff =
            diff || "No changes in this layer · s toggles staged/working";
      } catch {
        if (revision === this.diffRevision)
          this.state.diff = "Diff unavailable; refresh to reconcile";
      }
    }
    if (!this.stopped) this.changed();
  }
  start() {
    const tick = async () => {
      await this.refresh();
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 750);
    };
    void tick();
  }
  stop() {
    this.stopped = true;
    ++this.diffRevision;
    if (this.timer) clearTimeout(this.timer);
  }
  async key(name: string) {
    const state = this.state;
    if (name === "tab") {
      const panels = ["worktrees", "activity", "files"] as const;
      state.scroll = 0;
      state.focus =
        panels[(panels.indexOf(state.focus) + 1) % panels.length] ?? "files";
    } else if (["up", "k", "down", "j"].includes(name)) {
      const delta = name === "up" || name === "k" ? -1 : 1;
      if (state.focus === "worktrees")
        state.selectedWorktree = Math.max(
          0,
          Math.min(
            (state.git?.worktrees.length ?? 1) - 1,
            state.selectedWorktree + delta,
          ),
        );
      else if (state.focus === "activity")
        state.scroll = Math.max(0, state.scroll - delta * 2);
      else if (state.focus === "files") {
        state.selectedFile = Math.max(
          0,
          Math.min(
            (state.git?.files.length ?? 1) - 1,
            state.selectedFile + delta,
          ),
        );
        state.scroll = 0;
        await this.loadDiff();
      }
    } else if (name === "return" && state.focus === "worktrees") {
      const tree = state.git?.worktrees[state.selectedWorktree];
      if (tree && !tree.bare && !tree.prunable) {
        // View selection changes only the Git observer, never the Runtime cwd.
        state.cwd = tree.path;
        state.selectedFile = 0;
        state.scroll = 0;
        delete state.git;
        state.diff = "";
        await this.refresh();
      }
    } else if (name === "s") {
      state.diffMode = state.diffMode === "staged" ? "working" : "staged";
      state.scroll = 0;
      await this.loadDiff();
    } else if (name === "pagedown")
      state.scroll = Math.max(
        0,
        state.scroll + (state.focus === "activity" ? -8 : 8),
      );
    else if (name === "pageup")
      state.scroll = Math.max(
        0,
        state.scroll + (state.focus === "activity" ? 8 : -8),
      );
    else if (name === "r") await this.refresh();
    this.changed();
  }
}

export async function runDashboard(options: DashboardOptions): Promise<void> {
  const cwd = await realpath(options.cwd);
  const output = process.stdout;
  const input = process.stdin;
  if (!options.once && (!output.isTTY || !input.isTTY))
    throw new Error(
      "TUI requires an interactive terminal; use --once for plain output",
    );
  if (options.readOnly && options.prompt !== undefined)
    throw new Error("Read-only TUI cannot submit an initial prompt");
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let workflowTimer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (!active || drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = undefined;
      if (!active) return;
      output.write(
        `\x1b[H${renderDashboard(controller.state, output.columns || 120, output.rows || 32, { color: !process.env.NO_COLOR }).replaceAll("\n", "\r\n")}`,
      );
    }, 40);
  };
  const controller = new DashboardController(
    cwd,
    options.once ? () => {} : draw,
  );
  controller.state.readOnly = options.readOnly ?? false;
  const projection = new ActivityProjection();
  const runtime = options.runtime;
  if (runtime) controller.state.runtimeCwd = cwd;
  let events: Awaited<ReturnType<RuntimeSession["watchEvents"]>> | undefined;
  let interaction: InteractionController | undefined;
  const activityOrder = new Map<string, number>();
  let activitySerial = 0;
  const syncActivity = () => {
    // Preserve both sources, even after Pi rebuilds its projection from a snapshot.
    const items = [
      ...projection.items.map((item) => ({ item, key: `pi:${item.id}` })),
      ...(interaction?.items ?? []).map((item) => ({
        item,
        key: `input:${item.id}`,
      })),
    ];
    const liveKeys = new Set(items.map(({ key }) => key));
    for (const key of activityOrder.keys())
      if (!liveKeys.has(key)) activityOrder.delete(key);
    for (const { key } of items)
      if (!activityOrder.has(key)) activityOrder.set(key, ++activitySerial);
    controller.state.activity = items
      .sort(
        (a, b) =>
          (activityOrder.get(a.key) ?? 0) - (activityOrder.get(b.key) ?? 0),
      )
      .slice(-100)
      .map(({ item }) => item);
    controller.state.pendingInputs = interaction?.pendingCount ?? 0;
    draw();
  };
  const readWorkflow = async () => {
    if (!runtime || !active) return;
    try {
      controller.state.runtimeUsage = await runtime.usageSummary();
      delete controller.state.runtimeUsageError;
    } catch {
      delete controller.state.runtimeUsage;
      controller.state.runtimeUsageError = "runtime ledger unavailable";
    }
    try {
      const snapshot = await runtime.workflowStatus();
      if (!snapshot) {
        delete controller.state.workflow;
      } else {
        const current = snapshot.steps.find(
          (step) =>
            step.status === "running" || step.status === "waiting_input",
        );
        controller.state.workflow = {
          id: snapshot.id,
          status: snapshot.status,
          revision: snapshot.revision,
          ...(current ? { currentStep: current.id } : {}),
          completed: snapshot.steps.filter(
            (step) => step.status === "completed",
          ).length,
          total: snapshot.steps.length,
          observedAt: Date.now(),
        };
      }
      draw();
    } catch {
      delete controller.state.workflow;
    }
    if (active) workflowTimer = setTimeout(() => void readWorkflow(), 750);
  };
  if (runtime && !options.readOnly)
    interaction = new InteractionController(runtime, syncActivity);
  const send = async (content: string, requestId?: string) => {
    if (!interaction) return;
    await interaction.send(content, requestId);
    syncActivity();
  };
  const composer = new DashboardComposer(controller.state, send, draw);
  let settleExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve;
  });
  const exit = () => settleExit?.();
  const onAbort = () => exit();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) exit();
  let terminalEntered = false;
  const submit = (
    content: string,
    requestId: string = randomUUID(),
    preserveDraft = false,
  ) => {
    void send(content, requestId).catch(() => {
      if (preserveDraft && controller.state.input === undefined) {
        composer.open(content, requestId);
        controller.state.inputNotice =
          "Admission failed · draft retained · inspect activity";
      }
      draw();
    });
  };
  const onKey = (text: string, key: Key) => {
    if (key.ctrl && key.name === "c") {
      options.onInterrupt?.();
      return exit();
    }
    if (controller.state.input !== undefined) {
      composer.key(text, key);
      return;
    }
    if (key.name === "q") return exit();
    if (key.name === "i") {
      if (runtime && !options.readOnly) composer.open();
      return;
    }
    if (key.name === "p" && runtime && !options.readOnly) {
      submit("/resume");
      return;
    }
    if (key.name === "x" && runtime && !options.readOnly) {
      submit("/cancel");
      return;
    }
    void controller.key(key.name ?? text).catch(() => {
      controller.state.gitError = "Navigation failed; refresh to reconcile";
      draw();
    });
  };
  try {
    if (runtime) {
      await readWorkflow();
      events = await runtime.watchEvents();
      const apply: Parameters<typeof events.start>[0] = async (batch) => {
        projection.apply(batch);
        syncActivity();
        controller.state.runtimeStatus = `${projection.status} · ${cwd}`;
        controller.state.lastRuntimeUpdate = Date.now();
        draw();
      };
      await apply([events.snapshot], BACKGROUND_CONTEXT);
      events.start(apply);
      const recovery = await runtime.recoveryStatus();
      if (recovery.pendingOperationIds.length)
        controller.state.runtimeStatus = `RECOVERY_REQUIRED · ${recovery.pendingOperationIds.length} operations · ${cwd}`;
    }
    if (options.once) {
      await controller.refresh();
      output.write(
        `${renderDashboard(controller.state, 120, 32, { color: false })}\n`,
      );
      return;
    }
    terminalEntered = true;
    output.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    output.on("resize", draw);
    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
    controller.start();
    if (options.prompt) submit(options.prompt, options.requestId, true);
    await exited;
  } finally {
    active = false;
    options.signal?.removeEventListener("abort", onAbort);
    if (workflowTimer) clearTimeout(workflowTimer);
    interaction?.dispose();
    controller.stop();
    if (drawTimer) clearTimeout(drawTimer);
    try {
      await events?.stop();
    } finally {
      if (terminalEntered) {
        input.removeListener("keypress", onKey);
        output.removeListener("resize", draw);
        process.removeListener("SIGINT", exit);
        process.removeListener("SIGTERM", exit);
        input.setRawMode(false);
        input.pause();
        output.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
      }
    }
  }
}
