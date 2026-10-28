import { readFile } from "node:fs/promises";
import {
  ProviderConfigError,
  type ProviderProfile,
} from "../providers/index.js";
import { loadProviderProfile } from "../providers/profile.js";
import type { RunSummary } from "../service/catalog.js";
import type {
  BudgetReconciliation,
  ConnectionWriteResult,
  RunArtifact,
  ServiceRequest,
  ServiceResult,
} from "../service/daemon.js";
import {
  type FeatureSpec,
  validateFeatureSpec,
} from "../workflow/feature-store.js";
import type { Evidence } from "../workflow/index.js";
import { DashboardController } from "./controller.js";

export interface ServiceTransport {
  request(request: ServiceRequest): Promise<ServiceResult>;
}
export interface ServiceWorkbenchState {
  runs: RunSummary[];
  selectedRunId?: string;
  detail?: RunSummary;
  focus: "runs" | "steps" | "evidence" | "connections" | "git";
  stepScroll: number;
  /** Evidence panel is toggled by `e` and only fetches while visible. */
  showEvidence: boolean;
  evidence?: Evidence[];
  /** Run the landed evidence belongs to; stale lists never render for another run. */
  evidenceRunId?: string;
  /** Panel-local degrade hint; never occupies the global notice slot. */
  evidenceNotice?: string;
  /** Selected evidence entry (the `›` cursor): `j/k` moves it within the
   * list, clamped to the last entry; the visible window is derived in the
   * renderer and follows the cursor. */
  evidenceCursor: number;
  /** Evidence id whose artifact body view is open; undefined renders the list. */
  artifactViewId?: string;
  /** Loaded artifact bodies cached per evidence id while the panel is open. */
  artifactBodies: Map<string, RunArtifact>;
  /** Body view scroll in lines. */
  artifactScroll: number;
  /** Panel-local artifact body degrade; structured service errors land here. */
  artifactNotice?: string;
  /** True between the reconcile arm key (`b`) and confirm/abandon — the
   * confirmation step itself issues no request, and it is not a draft: every
   * key but `return`/`escape` keeps working while it is armed. Opening the
   * start draft (`n`) disarms it: the draft hides the footer prompt and its
   * own `return` submits, so an armed ledger write never survives the
   * context switch. */
  reconcileConfirm?: boolean;
  /** In-flight reconcile-budget request; a second confirm key is a no-op. */
  reconciling: boolean;
  /** Landed before/after ledger summary, keyed to `reconcileRunId`. */
  reconcileResult?: BudgetReconciliation;
  /** Run the landed summary and structured error belong to; neither ever
   * renders for another run (a defensive guard symmetric with
   * `evidenceRunId` — the three run-switch paths already clear both). */
  reconcileRunId?: string;
  /** Structured reconcile error shown verbatim (the service prefixes the
   * DATABASE_IN_USE ownership code into the wire message); the armed
   * confirmation keeps `return` retry and `escape` abandon one key away. */
  reconcileNotice?: string;
  /** Connection panel toggled by `c`; shares the lower region with the
   * evidence pane one at a time — opening either closes the other, so focus
   * routing and the render region always have a single owner. */
  showConnections: boolean;
  /** Latest read-only connection list; undefined until the first pull lands. */
  connections?: ProviderProfile[];
  /** Cursor entry of the connection list (`j/k` moves it, clamped to the
   * last entry); the visible window is derived in the renderer and follows
   * the cursor, exactly like the evidence list. */
  connectionsCursor: number;
  /** Management gate — true only after a successful `connections` pull, the
   * TUI form of the web StartForm's catalogEnabled probe. `a`/`d` issue zero
   * requests while the last pull failed (including the structured
   * not-enabled message), so daemon wording changes can never silently
   * re-enable management. */
  connectionsEnabled: boolean;
  /** Panel-local notice: structured catalog/profile errors (code-prefixed by
   * the service) and degrade hints land here verbatim; never the global
   * notice, never a disconnect. */
  connectionsNotice?: string;
  /** Armed remove confirmation — the entry id `d` armed. Mutually exclusive
   * with `reconcileConfirm` and `connectionEdit` (arming any drops the
   * others), so `return` and `escape` always have exactly one owner; it is
   * not a draft, every other key keeps working while it is armed. */
  connectionRemoveId?: string;
  /** In-flight connections-remove request; a second confirm key is a no-op. */
  removingConnection: boolean;
  /** Armed edit confirmation — the cursor entry id the `u` draft submitted
   * against plus its typed profile path. Mutually exclusive with
   * `reconcileConfirm` and `connectionRemoveId` (arming any drops the
   * others); it is not a draft, every other key keeps working while it is
   * armed. The confirmation step is the only place the profile is loaded
   * from disk and the only place a `connections-update` wire request may
   * happen; the daemon stays the arbiter for everything the TUI cannot know
   * (an entry removed externally lands as UNKNOWN_CONNECTION there). */
  connectionEdit?: { id: string; profilePath: string };
  /** In-flight connections-update request; a second confirm key is a no-op. */
  updatingConnection: boolean;
  connected: boolean;
  refreshing: boolean;
  observedAt?: number;
  notice?: string;
  draft?: string;
  submitting: boolean;
  git: DashboardController["state"];
}

/** Read-only transports widened with diff/evidence results; TUI calls only these shapes. */
function isRunSummary(value: unknown): value is RunSummary {
  return typeof value === "object" && value !== null && "runId" in value;
}

/** Shape check for the evidence projection; malformed lists degrade locally. */
function isEvidence(value: unknown): value is Evidence {
  return (
    typeof value === "object" &&
    value !== null &&
    "stepId" in value &&
    "artifactRef" in value &&
    "valid" in value
  );
}

/** Shape check for the artifact body projection; malformed bodies degrade
 * locally instead of opening a body view with unknown content. */
function isRunArtifact(value: unknown): value is RunArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { truncated?: unknown }).truncated === "boolean" &&
    typeof (value as { byteLength?: unknown }).byteLength === "number"
  );
}

/** Shape check for the budget reconciliation projection; malformed results
 * degrade to a structured error instead of rendering unknown numbers. */
function isBudgetReconciliation(value: unknown): value is BudgetReconciliation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    database?: unknown;
    before?: unknown;
    after?: unknown;
  };
  if (typeof record.database !== "string") return false;
  for (const side of [record.before, record.after]) {
    if (side === null) continue;
    if (typeof side !== "object") return false;
    const summary = side as { pending?: unknown; reconciled?: unknown };
    if (
      typeof summary.pending !== "number" ||
      typeof summary.reconciled !== "number"
    )
      return false;
  }
  return true;
}

/** Shape check for the connection projection; malformed lists degrade
 * locally instead of rendering unknown entries. */
function isProviderProfile(value: unknown): value is ProviderProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { modelId?: unknown }).modelId === "string"
  );
}

/** Shape check for the connection write outcome; malformed results degrade
 * to a structured panel error instead of rendering an unknown status. The
 * status union matches the wire contract, `updated` included — a real field
 * change on `connections-update` succeeds with it. */
function isConnectionWriteResult(
  value: unknown,
): value is ConnectionWriteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    ["added", "unchanged", "updated", "removed"].includes(
      (value as { status?: unknown }).status as string,
    )
  );
}

/** Quoted-argument tokenizer shared by the command drafts, with no shell
 * expansion or execution; an unterminated quote is a usage error. */
function tokenizeCommand(text: string, usage: string): string[] {
  const parts: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s"']+)/gy;
  let offset = 0;
  while (offset < text.length) {
    while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++;
    if (offset >= text.length) break;
    expression.lastIndex = offset;
    const match = expression.exec(text);
    if (!match) throw new Error(usage);
    parts.push(
      match[1] !== undefined
        ? match[1].replace(/\\(["\\])/g, "$1")
        : (match[2] ?? match[3] ?? ""),
    );
    offset = expression.lastIndex;
  }
  return parts;
}

/** Two quoted path arguments, with no shell expansion or execution. */
export function parseStartCommand(text: string): {
  specPath: string;
  profilePath: string;
} {
  const parts = tokenizeCommand(
    text,
    "Use start <spec path> <profile path>; quote paths containing spaces",
  );
  if (parts.length !== 3 || parts[0] !== "start" || !parts[1] || !parts[2])
    throw new Error(
      "Use start <spec path> <profile path>; both paths are required",
    );
  return { specPath: parts[1], profilePath: parts[2] };
}

/** One quoted profile path argument — the `a` connection draft, the same
 * explicit-disk-file form as the start draft. */
export function parseAddCommand(text: string): { profilePath: string } {
  const parts = tokenizeCommand(
    text,
    "Use add <profile path>; quote paths containing spaces",
  );
  if (parts.length !== 2 || parts[0] !== "add" || !parts[1])
    throw new Error("Use add <profile path>; profile path is required");
  return { profilePath: parts[1] };
}

/** One quoted profile path argument — the `u` edit draft, the same
 * explicit-disk-file form as the add draft (the TUI never assembles profile
 * fields itself; an edit also only names a disk file). */
export function parseEditCommand(text: string): { profilePath: string } {
  const parts = tokenizeCommand(
    text,
    "Use edit <profile path>; quote paths containing spaces",
  );
  if (parts.length !== 2 || parts[0] !== "edit" || !parts[1])
    throw new Error("Use edit <profile path>; profile path is required");
  return { profilePath: parts[1] };
}

/** Socket projections only. Detaching never stops the daemon or a run. */
export class ServiceWorkbench {
  readonly state: ServiceWorkbenchState;
  readonly observer: DashboardController;
  private stopped = false;
  private refreshing = false;
  private revision = 0;
  private evidenceRevision = 0;
  private artifactRevision = 0;
  private reconcileRevision = 0;
  private connectionsRevision = 0;
  /** Guards only the connections-remove write path. Kept separate from
   * `connectionsRevision` — which every periodic list pull increments — so a
   * 750ms refresh tick can never drop an in-flight remove outcome; it moves
   * only on the confirm itself, an abandon, a panel close or stop(), the
   * same membership as `reconcileRevision`. */
  private removeRevision = 0;
  /** Guards only the connections-update write path — the same membership as
   * `removeRevision` (the confirm itself, an abandon, a panel close or
   * stop()), kept separate from `connectionsRevision` for the same reason:
   * a 750ms list refresh tick can never drop an in-flight edit outcome. */
  private updateRevision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly client: ServiceTransport,
    private readonly changed: () => void = () => {},
    cwd = process.cwd(),
  ) {
    this.observer = new DashboardController(cwd, changed);
    this.observer.state.readOnly = true;
    this.state = {
      runs: [],
      focus: "runs",
      stepScroll: 0,
      showEvidence: false,
      evidenceCursor: 0,
      artifactBodies: new Map(),
      artifactScroll: 0,
      reconciling: false,
      showConnections: false,
      connectionsCursor: 0,
      connectionsEnabled: false,
      removingConnection: false,
      updatingConnection: false,
      connected: false,
      refreshing: false,
      submitting: false,
      git: this.observer.state,
    };
  }
  async refresh() {
    if (this.stopped || this.refreshing) return;
    this.refreshing = this.state.refreshing = true;
    try {
      const runs = await this.client.request({ method: "list" });
      if (this.stopped) return;
      if (!Array.isArray(runs) || !runs.every(isRunSummary))
        throw new Error("Expected service list");
      this.state.runs = runs;
      if (!runs.some((run) => run.runId === this.state.selectedRunId)) {
        const first = runs[0];
        if (first) this.state.selectedRunId = first.runId;
        else delete this.state.selectedRunId;
        delete this.state.detail;
        ++this.revision;
        ++this.evidenceRevision;
        this.state.evidenceCursor = 0;
        delete this.state.evidenceNotice;
        this.clearArtifactView();
        this.clearReconcile();
      }
      if (!this.state.connected) delete this.state.notice;
      this.state.connected = true;
      this.state.observedAt = Date.now();
      await this.selectDetail();
      await this.refreshEvidence();
      await this.refreshConnections();
    } catch {
      if (!this.stopped) {
        this.state.connected = false;
        this.state.notice =
          "Service unavailable · last observations may be stale · reconnecting";
      }
    } finally {
      this.refreshing = this.state.refreshing = false;
      if (!this.stopped) this.changed();
    }
  }
  private async selectDetail() {
    const runId = this.state.selectedRunId;
    const revision = ++this.revision;
    if (!runId || this.stopped) return;
    const detail = await this.client.request({ method: "status", runId });
    if (
      this.stopped ||
      revision !== this.revision ||
      runId !== this.state.selectedRunId
    )
      return;
    if (
      Array.isArray(detail) ||
      !isRunSummary(detail) ||
      detail.runId !== runId
    )
      throw new Error("Invalid service status");
    this.state.detail = detail;
    const path = detail.workspace?.path;
    if (path && path !== this.observer.state.cwd) {
      this.observer.state.cwd = path;
      delete this.observer.state.git;
      this.observer.state.diff = "";
    }
    if (path) await this.observer.refresh();
    this.changed();
  }
  /** List-only read of the selected run's evidence; failures degrade to a
   * panel-local hint and never mark the workbench disconnected or disturb
   * the run list/detail refreshes. Panel hidden means no request at all. */
  private async refreshEvidence() {
    const runId = this.state.selectedRunId;
    const revision = ++this.evidenceRevision;
    if (!this.state.showEvidence || !runId || this.stopped) return;
    try {
      const evidence = await this.client.request({
        method: "evidence",
        runId,
      });
      if (
        this.stopped ||
        revision !== this.evidenceRevision ||
        runId !== this.state.selectedRunId
      )
        return;
      if (!Array.isArray(evidence) || !evidence.every(isEvidence))
        throw new Error("Expected evidence list");
      this.state.evidence = evidence;
      this.state.evidenceRunId = runId;
      // The selection survives list refreshes (evidence is append-only) but
      // can never point past the freshly landed list.
      this.state.evidenceCursor = Math.min(
        this.state.evidenceCursor,
        Math.max(0, evidence.length - 1),
      );
      delete this.state.evidenceNotice;
    } catch {
      if (!this.stopped && revision === this.evidenceRevision)
        this.state.evidenceNotice =
          "unavailable · run list and details unaffected";
    } finally {
      if (!this.stopped) this.changed();
    }
  }
  /** The evidence entry `enter` acts on: the cursor entry, clamped to the
   * last entry of the list; undefined while the selected run's list has
   * not landed yet. */
  private selectedEvidence(): Evidence | undefined {
    if (this.state.evidenceRunId !== this.state.selectedRunId) return undefined;
    const entries = this.state.evidence ?? [];
    return entries[
      Math.min(this.state.evidenceCursor, Math.max(0, entries.length - 1))
    ];
  }
  /** Drops the artifact body view, cache and panel-local degrade hint, and
   * invalidates any in-flight body fetch; used on run switches, panel close
   * and start acceptance so stale bodies never render for another run. */
  private clearArtifactView() {
    ++this.artifactRevision;
    delete this.state.artifactViewId;
    this.state.artifactBodies.clear();
    this.state.artifactScroll = 0;
    delete this.state.artifactNotice;
  }
  /** On-demand single fetch of one artifact body over the existing socket
   * `artifact` method. A cached body opens without any request; a structured
   * error degrades to a panel-local hint and never touches the global notice
   * or the connection state. Late responses are dropped by the same
   * revision/run guard pattern as the evidence list. */
  private async viewArtifact(evidenceId: string) {
    const runId = this.state.selectedRunId;
    if (!runId || this.stopped) return;
    const cached = this.state.artifactBodies.get(evidenceId);
    if (cached) {
      this.state.artifactViewId = evidenceId;
      this.state.artifactScroll = 0;
      delete this.state.artifactNotice;
      return;
    }
    const revision = ++this.artifactRevision;
    try {
      const body = await this.client.request({
        method: "artifact",
        runId,
        evidenceId,
      });
      if (
        this.stopped ||
        revision !== this.artifactRevision ||
        runId !== this.state.selectedRunId
      )
        return;
      if (!isRunArtifact(body)) throw new Error("Expected artifact body");
      // Bodies are immutable once recorded, so the cache is safe within a run.
      this.state.artifactBodies.set(evidenceId, body);
      if (!this.state.showEvidence) return;
      this.state.artifactViewId = evidenceId;
      this.state.artifactScroll = 0;
      delete this.state.artifactNotice;
    } catch (error) {
      if (
        !this.stopped &&
        this.state.showEvidence &&
        revision === this.artifactRevision &&
        runId === this.state.selectedRunId
      )
        this.state.artifactNotice =
          error instanceof Error && error.message
            ? error.message
            : "artifact body unavailable";
    } finally {
      if (!this.stopped) this.changed();
    }
  }
  /** Drops the armed confirmation, landed summary, structured error and
   * in-flight flag, and invalidates any reconcile still in flight; used on
   * run switches, selection resets and start acceptance so ledger facts and
   * late responses never land for another run. */
  private clearReconcile() {
    ++this.reconcileRevision;
    delete this.state.reconcileConfirm;
    this.state.reconciling = false;
    delete this.state.reconcileResult;
    delete this.state.reconcileRunId;
    delete this.state.reconcileNotice;
  }
  /** The same gate as the workbench button: only a run that is not
   * dispatching (while active, the in-flight call is itself one pending row
   * and the service holds the run's database lease, so the request would
   * fail closed with DATABASE_IN_USE) and still shows unsettled calls. */
  private canReconcile(): boolean {
    const detail = this.state.detail;
    return Boolean(
      this.state.selectedRunId &&
        detail &&
        detail.runId === this.state.selectedRunId &&
        detail.usage &&
        detail.usage.pending > 0 &&
        !detail.active,
    );
  }
  /** One explicit reconcile-budget request over the existing socket write
   * method — a dedicated path, not act(): its catch collapses errors into a
   * generic notice, while structured messages (the service prefixes the
   * DATABASE_IN_USE code into the wire error) must land verbatim with the
   * retry one key away. The daemon stays the only arbiter — lease fail-closed,
   * no queueing, no auto retry; late responses are dropped by the same
   * revision/run guard pattern as evidence and artifact bodies. */
  private async confirmReconcile() {
    const runId = this.state.selectedRunId;
    if (!runId || this.state.reconciling || this.stopped) return;
    const revision = ++this.reconcileRevision;
    this.state.reconciling = true;
    this.changed();
    try {
      const result = await this.client.request({
        method: "reconcile-budget",
        runId,
      });
      if (
        this.stopped ||
        revision !== this.reconcileRevision ||
        runId !== this.state.selectedRunId
      )
        return;
      if (!isBudgetReconciliation(result))
        throw new Error("Expected budget reconciliation");
      this.state.reconcileResult = result;
      this.state.reconcileRunId = runId;
      delete this.state.reconcileConfirm;
      delete this.state.reconcileNotice;
      // The settled ledger changes the usage projection; refresh it now.
      await this.refresh();
    } catch (error) {
      if (
        !this.stopped &&
        revision === this.reconcileRevision &&
        runId === this.state.selectedRunId
      ) {
        // Verbatim structured message; the confirmation stays armed so
        // `return` retries explicitly and `escape` abandons. The notice is
        // keyed to the run it failed on — the same defensive render guard
        // as the landed summary.
        this.state.reconcileNotice =
          error instanceof Error && error.message
            ? error.message
            : "reconcile-budget failed";
        this.state.reconcileRunId = runId;
      }
    } finally {
      this.state.reconciling = false;
      if (!this.stopped) this.changed();
    }
  }
  /** Drops the evidence projection, panel-local hint and artifact body view,
   * and invalidates any in-flight evidence/body fetch; shared by the `e`
   * toggle-off and the `c` toggle-on (the lower region hosts one auxiliary
   * panel at a time). */
  private closeEvidence() {
    ++this.evidenceRevision;
    this.state.showEvidence = false;
    delete this.state.evidence;
    delete this.state.evidenceRunId;
    delete this.state.evidenceNotice;
    this.clearArtifactView();
  }
  /** Drops the whole connection panel state — list, gate, notice and any
   * armed remove/edit confirmation — and invalidates in-flight pulls and
   * writes; used on toggle-off and by `e` toggle-on, mirroring closeEvidence.
   * The panel is service-scoped, so run switches and start acceptance never
   * touch it. */
  private closeConnections() {
    ++this.connectionsRevision;
    ++this.removeRevision;
    ++this.updateRevision;
    this.state.showConnections = false;
    delete this.state.connections;
    this.state.connectionsCursor = 0;
    this.state.connectionsEnabled = false;
    delete this.state.connectionsNotice;
    delete this.state.connectionRemoveId;
    this.state.removingConnection = false;
    delete this.state.connectionEdit;
    this.state.updatingConnection = false;
  }
  /** Drops the armed remove confirmation and panel-local notice, and
   * invalidates any remove still in flight (`escape` abandon). */
  private clearConnectionConfirm() {
    ++this.removeRevision;
    delete this.state.connectionRemoveId;
    this.state.removingConnection = false;
    delete this.state.connectionsNotice;
  }
  /** Drops the armed edit confirmation and panel-local notice, and
   * invalidates any update still in flight (`escape` abandon). */
  private clearEditConfirm() {
    ++this.updateRevision;
    delete this.state.connectionEdit;
    this.state.updatingConnection = false;
    delete this.state.connectionsNotice;
  }
  /** Read-only connection catalog pull over the existing socket
   * `connections` method; only while the panel is visible (panel closed
   * means no connection traffic at all). Failures degrade to a panel-local
   * notice and flip the management gate off — the successful pull itself is
   * the gate (the web form's catalogEnabled shape, no message-text matching)
   * — and never mark the workbench disconnected or disturb the run
   * list/detail refreshes. */
  private async refreshConnections() {
    const revision = ++this.connectionsRevision;
    if (!this.state.showConnections || this.stopped) return;
    try {
      const list = await this.client.request({ method: "connections" });
      if (
        this.stopped ||
        revision !== this.connectionsRevision ||
        !this.state.showConnections
      )
        return;
      if (!Array.isArray(list) || !list.every(isProviderProfile))
        throw new Error("Expected connection list");
      this.state.connections = list;
      this.state.connectionsEnabled = true;
      // The cursor can never point past the freshly landed list.
      this.state.connectionsCursor = Math.min(
        this.state.connectionsCursor,
        Math.max(0, list.length - 1),
      );
      delete this.state.connectionsNotice;
    } catch (error) {
      if (
        !this.stopped &&
        revision === this.connectionsRevision &&
        this.state.showConnections
      ) {
        this.state.connectionsEnabled = false;
        this.state.connectionsNotice =
          error instanceof Error && error.message
            ? error.message
            : "connection catalog unavailable";
      }
    } finally {
      if (!this.stopped) this.changed();
    }
  }
  /** One explicit connections-remove request over the existing socket write
   * method — the same dedicated path as confirmReconcile (act()'s catch
   * collapses errors into a generic notice, while the structured
   * code-prefixed messages must land verbatim with the retry one key away).
   * The armed id stays armed until success, an explicit abandon, a draft
   * opening or the panel closing; late responses are dropped by a dedicated
   * revision counter that only those paths (and stop()) move — periodic list
   * pulls keep their own counter and can never drop an in-flight outcome,
   * exactly the reconcileRevision membership. The daemon stays the only
   * arbiter. */
  private async confirmRemoveConnection() {
    const id = this.state.connectionRemoveId;
    if (id === undefined || this.state.removingConnection || this.stopped)
      return;
    const revision = ++this.removeRevision;
    this.state.removingConnection = true;
    this.changed();
    try {
      const outcome = await this.client.request({
        method: "connections-remove",
        id,
      });
      if (this.stopped || revision !== this.removeRevision) return;
      if (!isConnectionWriteResult(outcome))
        throw new Error("Expected connection write result");
      delete this.state.connectionRemoveId;
      delete this.state.connectionsNotice;
      // The refreshed list is the outcome render: the entry disappears.
      await this.refreshConnections();
    } catch (error) {
      if (!this.stopped && revision === this.removeRevision) {
        // Verbatim structured message; the confirmation stays armed so
        // `return` retries explicitly and `escape` abandons.
        this.state.connectionsNotice =
          error instanceof Error && error.message
            ? error.message
            : "connections-remove failed";
      }
    } finally {
      this.state.removingConnection = false;
      if (!this.stopped) this.changed();
    }
  }
  /** One explicit connections-update request over the existing socket write
   * method — the same dedicated path as confirmRemoveConnection. This is the
   * only place the armed profile path is read from disk: a client-side load
   * failure (INVALID_PROFILE, thrown before any request) and an id mismatch
   * against the armed entry both land in the panel-local notice verbatim
   * with zero wire requests — a TUI-side tightening of the web form's
   * mismatch hint (the form still sends the PUT and shows the service 400);
   * the daemon stays the only arbiter for everything else, wire errors land
   * verbatim with the confirmation kept armed for an explicit retry, and
   * late responses are dropped by the dedicated `updateRevision` — the same
   * removeRevision membership, never moved by periodic list pulls. */
  private async confirmEditConnection() {
    const armed = this.state.connectionEdit;
    if (!armed || this.state.updatingConnection || this.stopped) return;
    const revision = ++this.updateRevision;
    this.state.updatingConnection = true;
    this.changed();
    try {
      const profile = await loadProviderProfile(armed.profilePath);
      if (this.stopped || revision !== this.updateRevision) return;
      if (profile.id !== armed.id) {
        this.state.connectionsNotice = `Profile id ${profile.id} differs from entry ${armed.id}; no update request sent`;
        return;
      }
      const outcome = await this.client.request({
        method: "connections-update",
        profile,
      });
      if (this.stopped || revision !== this.updateRevision) return;
      if (!isConnectionWriteResult(outcome))
        throw new Error("Expected connection write result");
      // "unchanged" is the catalog's idempotent acknowledgement — success.
      delete this.state.connectionEdit;
      delete this.state.connectionsNotice;
      // The refreshed list is the outcome render: the entry's fields change.
      await this.refreshConnections();
    } catch (error) {
      if (!this.stopped && revision === this.updateRevision) {
        // Verbatim structured message; the confirmation stays armed so
        // `return` retries explicitly and `escape` abandons. A client-side
        // ProviderConfigError gets the same code prefix the daemon puts on
        // the wire, so INVALID_PROFILE reads uniformly.
        this.state.connectionsNotice =
          error instanceof ProviderConfigError
            ? `${error.code}: ${error.message}`
            : error instanceof Error && error.message
              ? error.message
              : "connections-update failed";
      }
    } finally {
      this.state.updatingConnection = false;
      if (!this.stopped) this.changed();
    }
  }
  async key(name: string) {
    if (name === "tab") {
      // Each auxiliary pane joins the rotation only while visible; evidence
      // and connections are mutually exclusive, so the rotation holds at
      // most one of them.
      const focuses: ServiceWorkbenchState["focus"][] = this.state.showEvidence
        ? ["runs", "steps", "evidence", "git"]
        : this.state.showConnections
          ? ["runs", "steps", "connections", "git"]
          : ["runs", "steps", "git"];
      this.state.focus =
        focuses[(focuses.indexOf(this.state.focus) + 1) % focuses.length] ??
        "runs";
    } else if (name === "n") {
      // Opening the start draft disarms every armed confirmation (the
      // reconcile, the remove and the edit): the draft hides the footer
      // confirmation prompt and its own `return` submits, so an armed write
      // must not survive the context switch. Only the confirmations drop —
      // landed summaries stay and in-flight responses keep their revision
      // guards and land for their own target.
      this.state.draft = "start ";
      delete this.state.reconcileConfirm;
      delete this.state.connectionRemoveId;
      delete this.state.connectionEdit;
    } else if (name === "a") {
      // The add draft, gated exactly like the web management UI: only while
      // the panel is open and the last pull succeeded — zero requests and
      // no draft otherwise. Opening it disarms any armed confirmation for
      // the same reason as `n`.
      if (this.state.showConnections && this.state.connectionsEnabled) {
        this.state.draft = "add ";
        delete this.state.reconcileConfirm;
        delete this.state.connectionRemoveId;
        delete this.state.connectionEdit;
      }
    } else if (name === "u") {
      // The edit draft, gated like `a` plus a cursor entry — an empty
      // catalog has nothing to edit, so the key is a strict no-op there —
      // and like `d` plus an in-flight guard (`!removingConnection` there,
      // `!updatingConnection` here): arming again while a
      // connections-update is still in flight would let the late response
      // silently clear the new confirmation on success or land its stale
      // error over it on failure, so until the write is idle the key is a
      // strict zero-state no-op. The draft names a disk profile path only
      // (the same explicit-disk-file form as add/start; the TUI never
      // assembles profile fields); submitting it arms the edit
      // confirmation, and the confirmation — not this key — is where the
      // profile is loaded and the single connections-update may happen.
      // Opening it disarms any armed confirmation for the same reason as
      // `n`/`a`.
      if (
        this.state.showConnections &&
        this.state.connectionsEnabled &&
        !this.state.updatingConnection
      ) {
        const entries = this.state.connections ?? [];
        const entry =
          entries[
            Math.min(
              this.state.connectionsCursor,
              Math.max(0, entries.length - 1),
            )
          ];
        if (entry) {
          this.state.draft = "edit ";
          delete this.state.reconcileConfirm;
          delete this.state.connectionRemoveId;
          delete this.state.connectionEdit;
        }
      }
    } else if (name === "x" || name === "p") {
      const runId = this.state.selectedRunId;
      if (runId)
        await this.act({ method: name === "x" ? "cancel" : "resume", runId });
    } else if (name === "r") await this.refresh();
    else if (name === "b") {
      // Arm only — the confirmation step itself issues no request. Placed
      // before the git forwarding branch below (like `e`) so the key also
      // works under git focus, where the observer treats it as a no-op.
      // Arming drops any armed remove or edit: at most one confirmation owns
      // `return`/`escape` at any time.
      if (this.canReconcile() && !this.state.reconciling) {
        this.state.reconcileConfirm = true;
        delete this.state.reconcileNotice;
        delete this.state.connectionRemoveId;
        delete this.state.connectionEdit;
      }
    } else if (name === "d") {
      // Arm only on the cursor entry — the confirmation step itself issues
      // no request. Gated on the same successful-pull flag as `a` and placed
      // before the git forwarding branch (like `b`/`e`) so the key also
      // works under git focus; an empty list arms nothing. Arming drops any
      // armed reconciliation or edit (mutual exclusion, see `b`).
      if (
        this.state.showConnections &&
        this.state.connectionsEnabled &&
        !this.state.removingConnection
      ) {
        const entries = this.state.connections ?? [];
        const entry =
          entries[
            Math.min(
              this.state.connectionsCursor,
              Math.max(0, entries.length - 1),
            )
          ];
        if (entry) {
          this.state.connectionRemoveId = entry.id;
          delete this.state.reconcileConfirm;
          delete this.state.connectionEdit;
          delete this.state.connectionsNotice;
        }
      }
    } else if (name === "return" && this.state.reconcileConfirm) {
      // The armed reconciliation swallows `return` before the evidence body
      // view and the Git observer forwarding: enter confirms, escape abandons.
      await this.confirmReconcile();
    } else if (name === "escape" && this.state.reconcileConfirm) {
      this.clearReconcile();
    } else if (
      name === "return" &&
      this.state.connectionRemoveId !== undefined
    ) {
      // The armed remove swallows `return` the same way; mutual exclusion
      // with the armed reconcile keeps exactly one confirmation live.
      await this.confirmRemoveConnection();
    } else if (
      name === "escape" &&
      this.state.connectionRemoveId !== undefined
    ) {
      this.clearConnectionConfirm();
    } else if (name === "return" && this.state.connectionEdit !== undefined) {
      // The armed edit swallows `return` the same way; mutual exclusion with
      // the armed reconcile and remove keeps exactly one confirmation live.
      await this.confirmEditConnection();
    } else if (name === "escape" && this.state.connectionEdit !== undefined) {
      this.clearEditConfirm();
    } else if (
      name === "return" &&
      this.state.focus === "evidence" &&
      this.state.showEvidence
    ) {
      // Evidence panel only, and the guard is part of the branch condition:
      // under any other focus (git included) `return` keeps falling through
      // to the observer forwarding below, preserving the Git dashboard's own
      // Enter-opens-worktree key path. Inside the panel, `enter` opens the
      // selected artifact body or closes the open body view; command/review
      // entries have no body view and never issue a request.
      if (this.state.artifactViewId !== undefined) {
        delete this.state.artifactViewId;
        this.state.artifactScroll = 0;
        delete this.state.artifactNotice;
      } else {
        const entry = this.selectedEvidence();
        if (entry?.kind === "artifact") await this.viewArtifact(entry.id);
      }
    } else if (name === "e") {
      // Before the git forwarding branch so `e` works under git focus too,
      // where the observer itself treats it as a no-op key. The lower region
      // hosts one auxiliary panel at a time: opening evidence closes the
      // connections panel.
      this.state.showEvidence = !this.state.showEvidence;
      this.state.evidenceCursor = 0;
      this.state.focus = this.state.showEvidence ? "evidence" : "runs";
      if (this.state.showEvidence) {
        this.closeConnections();
        await this.refreshEvidence();
      } else this.closeEvidence();
    } else if (name === "c") {
      // The connection panel toggle, the exact shape of `e` (also placed
      // before the git forwarding branch). Mutual exclusion: opening the
      // connections panel closes the evidence pane, so the lower region and
      // the focus rotation always have a single owner.
      this.state.showConnections = !this.state.showConnections;
      this.state.connectionsCursor = 0;
      this.state.focus = this.state.showConnections ? "connections" : "runs";
      if (this.state.showConnections) {
        this.closeEvidence();
        await this.refreshConnections();
      } else this.closeConnections();
    } else if (this.state.focus === "git")
      await this.observer.key(name === "g" ? "tab" : name);
    else if (["up", "k", "down", "j", "pageup", "pagedown"].includes(name)) {
      const delta = ["up", "k", "pageup"].includes(name) ? -1 : 1;
      if (this.state.focus === "steps")
        this.state.stepScroll = Math.max(0, this.state.stepScroll + delta);
      else if (this.state.focus === "connections") {
        // List view: j/k moves the cursor — never the run selection; the
        // renderer derives the visible window and follows the cursor, and
        // the cursor clamps to the last entry (evidence precedent).
        const count = this.state.connections?.length ?? 0;
        this.state.connectionsCursor = Math.min(
          Math.max(0, count - 1),
          Math.max(0, this.state.connectionsCursor + delta),
        );
      } else if (this.state.focus === "evidence") {
        if (this.state.artifactViewId !== undefined) {
          // Body view: j/k scrolls body lines, clamped to the loaded body.
          const lines =
            this.state.artifactBodies
              .get(this.state.artifactViewId)
              ?.text.split("\n").length ?? 1;
          this.state.artifactScroll = Math.min(
            Math.max(0, lines - 1),
            Math.max(0, this.state.artifactScroll + delta),
          );
        } else {
          // List view: j/k moves the cursor — the selection — and never the
          // run selection; the renderer derives the visible window and
          // follows the cursor, and the cursor clamps to the last entry.
          const count = this.state.evidence?.length ?? 0;
          this.state.evidenceCursor = Math.min(
            Math.max(0, count - 1),
            Math.max(0, this.state.evidenceCursor + delta),
          );
        }
      } else {
        const index = this.state.runs.findIndex(
          (run) => run.runId === this.state.selectedRunId,
        );
        const selected =
          this.state.runs[
            Math.max(0, Math.min(this.state.runs.length - 1, index + delta))
          ];
        if (selected && selected.runId !== this.state.selectedRunId) {
          this.state.selectedRunId = selected.runId;
          delete this.state.detail;
          this.state.stepScroll = 0;
          this.state.evidenceCursor = 0;
          delete this.state.evidenceNotice;
          this.clearArtifactView();
          this.clearReconcile();
          await this.selectDetail();
          await this.refreshEvidence();
        }
      }
    }
    this.changed();
  }
  async submitDraft() {
    if (this.state.submitting || this.stopped) return;
    if (/^add(?:\s|$)/.test((this.state.draft ?? "").trimStart())) {
      await this.submitAddDraft();
      return;
    }
    if (/^edit(?:\s|$)/.test((this.state.draft ?? "").trimStart())) {
      await this.submitEditDraft();
      return;
    }
    this.state.submitting = true;
    this.changed();
    try {
      const { specPath, profilePath } = parseStartCommand(
        this.state.draft ?? "",
      );
      const [text, profile] = await Promise.all([
        readFile(specPath, "utf8"),
        loadProviderProfile(profilePath),
      ]);
      const spec = JSON.parse(text) as FeatureSpec;
      validateFeatureSpec(spec);
      this.state.submitting = false;
      await this.act({ method: "start", spec, profile });
    } catch {
      this.state.submitting = false;
      this.state.notice =
        "Unable to load spec/profile · use start <spec path> <profile path>; quote paths containing spaces";
      this.changed();
    }
  }
  /** The `a` draft: load the non-sensitive profile from the typed disk path
   * (the same explicit-file form as the start draft — the TUI never
   * assembles profile fields itself) and send exactly one connections-add.
   * Client-side load failures (INVALID_PROFILE, thrown before any request)
   * and wire errors (code-prefixed by the service) both land in the
   * panel-local notice verbatim — never the start draft's generic global
   * notice — and the draft is retained for path editing and an explicit
   * retry. */
  private async submitAddDraft() {
    this.state.submitting = true;
    this.changed();
    try {
      const { profilePath } = parseAddCommand(this.state.draft ?? "");
      const profile = await loadProviderProfile(profilePath);
      const outcome = await this.client.request({
        method: "connections-add",
        profile,
      });
      if (this.stopped) return;
      if (!isConnectionWriteResult(outcome))
        throw new Error("Expected connection write result");
      // "unchanged" is the catalog's idempotent acknowledgement — success.
      delete this.state.draft;
      delete this.state.connectionsNotice;
      await this.refreshConnections();
    } catch (error) {
      if (!this.stopped) {
        // A client-side ProviderConfigError gets the same code prefix the
        // daemon puts on the wire, so INVALID_PROFILE reads uniformly.
        this.state.connectionsNotice =
          error instanceof ProviderConfigError
            ? `${error.code}: ${error.message}`
            : error instanceof Error && error.message
              ? error.message
              : "connections-add failed";
      }
    } finally {
      this.state.submitting = false;
      if (!this.stopped) this.changed();
    }
  }
  /** The `u` draft: parse the typed disk path (usage errors keep the draft,
   * exactly like add) and arm the edit confirmation on the cursor entry —
   * zero wire requests here. The confirmation step owns the profile load
   * and the single connections-update, so this only records the entry id
   * and the path. Arming drops any other armed confirmation (mutual
   * exclusion invariant held even if one armed while the draft was open,
   * where the host-level key routing cannot reach them). While a
   * connections-update is in flight the arming point itself is guarded —
   * the load-bearing twin of the `u` key's gate, not a purely defensive
   * one: the dashboard host treats an open draft as free text (any
   * printable character appends, backspace deletes), so an `n`/`a` draft
   * can be rewritten into `edit …` and submitted mid-flight; the guard
   * keeps that submit a zero-state no-op (the draft stays for an explicit
   * resubmit once idle) so the late response can never clear a new arming
   * on success or string its stale error over one on failure. */
  private async submitEditDraft() {
    if (this.state.updatingConnection) return;
    this.state.submitting = true;
    this.changed();
    try {
      const { profilePath } = parseEditCommand(this.state.draft ?? "");
      const entries = this.state.connections ?? [];
      const entry =
        entries[
          Math.min(
            this.state.connectionsCursor,
            Math.max(0, entries.length - 1),
          )
        ];
      if (!entry) {
        this.state.connectionsNotice =
          "No connection entry under the cursor; nothing to edit";
        return;
      }
      this.state.connectionEdit = { id: entry.id, profilePath };
      delete this.state.reconcileConfirm;
      delete this.state.connectionRemoveId;
      delete this.state.draft;
      delete this.state.connectionsNotice;
    } catch (error) {
      if (!this.stopped) {
        // Usage errors land in the panel-local notice like add's, and the
        // draft stays for path editing.
        this.state.connectionsNotice =
          error instanceof Error && error.message
            ? error.message
            : "Use edit <profile path>; profile path is required";
      }
    } finally {
      this.state.submitting = false;
      if (!this.stopped) this.changed();
    }
  }
  private async act(request: ServiceRequest) {
    if (this.state.submitting || this.stopped) return;
    this.state.submitting = true;
    this.changed();
    try {
      const accepted = await this.client.request(request);
      if (this.stopped) return;
      this.state.notice = `${request.method} accepted · inspect persisted status`;
      if (request.method === "start") {
        delete this.state.draft;
        if (!Array.isArray(accepted) && isRunSummary(accepted)) {
          this.state.selectedRunId = accepted.runId;
          // Never keep the previously selected run's evidence for the new one.
          delete this.state.evidence;
          delete this.state.evidenceRunId;
          delete this.state.evidenceNotice;
          this.state.evidenceCursor = 0;
          this.clearArtifactView();
          // Nor its armed reconciliation or landed ledger summary.
          this.clearReconcile();
        }
      }
      await this.refresh();
    } catch {
      this.state.notice = `${request.method} failed or acknowledgement lost · refresh status before retry`;
    } finally {
      this.state.submitting = false;
      if (!this.stopped) this.changed();
    }
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
    ++this.revision;
    ++this.artifactRevision;
    ++this.reconcileRevision;
    ++this.connectionsRevision;
    ++this.removeRevision;
    ++this.updateRevision;
    if (this.timer) clearTimeout(this.timer);
    this.observer.stop();
  }
}
