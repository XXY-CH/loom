import type { ProviderProfile } from "../providers/index.js";
import type { Evidence } from "../workflow/index.js";
import { fitCells, renderDashboard } from "./render.js";
import type { ServiceWorkbenchState } from "./service-controller.js";

/** Same info set as the web EvidenceView; the body view opens on `enter`. */
function evidenceDetail(item: Evidence): string {
  if (item.kind === "command")
    return `command: ${item.command} · exit ${item.exitCode}`;
  if (item.kind === "review")
    return `review by ${item.reviewerId} · ${item.unresolvedFindings} unresolved`;
  return `artifact by ${item.producerId}`;
}

/** Panel lines for the toggled evidence pane; every line goes through the
 * same terminal sanitizer as the rest of the workbench frame. The selected
 * entry is the cursor (`j/k` moves it, clamped to the last entry) and the
 * window follows it as a pure derivation: `max(0, cursor - viewport + 1)`
 * keeps the window put while the cursor moves inside it and scrolls
 * exactly one entry once the cursor passes its bottom edge. The `›` marker
 * rides the cursor and marks the entry `enter` opens; the artifact body
 * view replaces the list. */
function evidenceLines(
  state: ServiceWorkbenchState,
  bodyRows: number,
): string[] {
  if (!state.selectedRunId) return [" Evidence · select a run"];
  if (state.evidenceNotice) return [` Evidence · ${state.evidenceNotice}`];
  if (state.evidenceRunId !== state.selectedRunId)
    return [" Evidence · loading selected run…"];
  const entries = state.evidence ?? [];
  if (!entries.length) return [" Evidence · none recorded"];
  const header = ` Evidence (${entries.length}) · read-only Run DB projection`;
  if (state.artifactViewId !== undefined) {
    const body = state.artifactBodies.get(state.artifactViewId);
    if (!body) return [header, " Artifact body · unavailable · enter to retry"];
    return [
      ` artifact body · ${state.artifactViewId} · ${body.byteLength} byte${body.byteLength === 1 ? "" : "s"}${body.truncated ? " · truncated at 64 KiB" : ""}`,
      ...body.text
        .split("\n")
        .slice(state.artifactScroll)
        .map((line) => ` ${line}`),
    ];
  }
  if (state.artifactNotice)
    return [
      header,
      ` Artifact body · ${state.artifactNotice} · enter to retry`,
    ];
  // The header consumes one panel row; the cursor rides inside the rest.
  const viewport = Math.max(1, bodyRows - 1);
  const start = Math.max(0, state.evidenceCursor - viewport + 1);
  return [
    header,
    ...entries
      .slice(start)
      .map(
        (item, index) =>
          ` ${index === state.evidenceCursor - start ? "›" : " "} ${item.id} · ${item.stepId} · ${item.kind} · attempt ${item.attempt} · ${item.valid ? "valid" : "invalid"} · ${evidenceDetail(item)}`,
      ),
  ];
}

/** Panel lines for the toggled connections pane; every line goes through the
 * same terminal sanitizer as the rest of the workbench frame. The cursor and
 * window semantics mirror the evidence list (`j/k` moves the `›` cursor,
 * clamped to the last entry; the window follows it as a pure derivation).
 * The structured not-enabled or code-prefixed error message replaces the
 * list verbatim while it stands, and the header names the two management
 * keys that only work after a successful pull. */
function connectionLines(
  state: ServiceWorkbenchState,
  bodyRows: number,
): string[] {
  if (state.connectionsNotice)
    return [` Connections · ${state.connectionsNotice}`];
  if (state.connections === undefined)
    return [" Connections · loading catalog…"];
  const entries: ProviderProfile[] = state.connections;
  const header = ` Connections (${entries.length}) · read-only catalog projection · a add · u edit · d remove`;
  if (!entries.length) return [header];
  // The header consumes one panel row; the cursor rides inside the rest.
  const viewport = Math.max(1, bodyRows - 1);
  const start = Math.max(0, state.connectionsCursor - viewport + 1);
  return [
    header,
    ...entries
      .slice(start)
      .map(
        (entry, index) =>
          ` ${index === state.connectionsCursor - start ? "›" : " "} ${entry.id} · ${entry.kind} · ${entry.modelId}${entry.keyEnv ? ` · ${entry.keyEnv}` : ""}`,
      ),
  ];
}

/** Every service-supplied cell passes the same terminal sanitizer as Git. */
export function renderServiceWorkbench(
  state: ServiceWorkbenchState,
  columns: number,
  rows: number,
  color = true,
): string {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const render = (text: string, accent = false) => {
    const fitted = fitCells(text, width);
    return color && accent ? `\x1b[38;5;80m${fitted}\x1b[0m` : fitted;
  };
  const selected = state.detail;
  const age = state.observedAt
    ? `${Math.floor((Date.now() - state.observedAt) / 1000)}s ago`
    : "awaiting snapshot";
  const lines = [
    render(
      ` LOOM / RUN WORKBENCH   ${state.connected ? "connected" : "disconnected"} · ${age}`,
      true,
    ),
  ];
  if (height < 8 || width < 24)
    return [...lines, render(" Resize · q detach")].slice(0, height).join("\n");
  const capacity = Math.min(8, Math.max(2, Math.floor((height - 8) / 2)));
  const index = Math.max(
    0,
    state.runs.findIndex((run) => run.runId === state.selectedRunId),
  );
  const start = Math.max(0, index - capacity + 1);
  const runs = state.runs.slice(start, start + capacity);
  const details: string[] = [];
  if (selected) {
    details.push(
      `${selected.runId} · ${selected.status}${selected.active ? " · ACTIVE" : ""}`,
    );
    details.push(
      `Block: ${selected.blockedReason ?? "none"}${selected.operationId ? ` · operation ${selected.operationId}` : ""}`,
    );
    const budget = selected.budget;
    const usage = selected.usage;
    details.push(
      `Budget: calls ${usage?.calls ?? "?"}/${budget?.maxCalls ?? "∞"} · tokens ${usage?.tokens ?? "?"}/${budget?.maxTokens ?? "∞"}`,
    );
    // `pending` and `reconciled` are both ledger facts, so both segments stay
    // visible even at 0; the explicit reconcile key (`b`) is the only action.
    details.push(
      `Usage: ${usage ? `${usage.calls} calls · ${usage.tokens} tokens · ${usage.pending} pending · ${usage.reconciled} reconciled` : "ledger unavailable"}`,
    );
    // The landed summary is a ledger fact of this run only; the same guard as
    // the evidence projection keeps it from ever rendering for another run.
    // The declaration keeps the workbench wording, split across lines that
    // survive the 77-cell detail column of a 120-column frame.
    if (state.reconcileRunId === selected.runId && state.reconcileResult) {
      const { before, after } = state.reconcileResult;
      details.push(
        `Reconciled: pending ${before?.pending ?? "n/a"} → ${after?.pending ?? "n/a"} · reconciled ${before?.reconciled ?? "n/a"} → ${after?.reconciled ?? "n/a"}`,
      );
      details.push("Reconcile unblocks dispatch · not adopted as succeeded");
      details.push("no token fabrication · endpoint non-receipt unproven");
    }
    // A structured error renders verbatim up to the terminal fit, keyed to
    // the run it landed on — the same defensive guard as the summary above
    // keeps it from ever rendering for another run. The armed confirmation
    // keeps the retry (`return`) and abandon (`escape`) keys in the footer
    // prompt.
    if (state.reconcileRunId === selected.runId && state.reconcileNotice)
      details.push(`Reconcile failed · ${state.reconcileNotice}`);
    for (const step of selected.steps.slice(state.stepScroll))
      details.push(
        `${step.status === "completed" ? "✓" : step.status === "failed" ? "!" : "·"} ${step.id} · ${step.status} · attempt ${step.attempt}${step.inputQuestion ? ` · ${step.inputQuestion}` : ""}${step.failure ? ` · ${step.failure}` : ""}`,
      );
  } else
    details.push(
      state.runs.length
        ? "Loading selected run…"
        : "No runs · n to start with explicit spec and profile",
    );
  const ownedEvidence =
    state.evidenceRunId === state.selectedRunId ? state.evidence : undefined;
  // Evidence and connections are mutually exclusive panels, so at most one
  // of the two auxiliary tabs renders.
  lines.push(
    render(
      ` ${state.focus === "runs" ? "●" : "○"} RUNS (${state.runs.length})                     ${state.focus === "steps" ? "●" : "○"} STATUS / STEPS${state.showEvidence ? `   ${state.focus === "evidence" ? "●" : "○"} EVIDENCE${ownedEvidence ? ` (${ownedEvidence.length})` : ""}` : ""}${state.showConnections ? `   ${state.focus === "connections" ? "●" : "○"} CONNECTIONS${state.connections ? ` (${state.connections.length})` : ""}` : ""}`,
      true,
    ),
  );
  if (width >= 90) {
    const left = Math.min(40, Math.floor(width / 3));
    for (let row = 0; row < capacity; row++) {
      const run = runs[row];
      lines.push(
        render(
          `${fitCells(run ? ` ${run.runId === state.selectedRunId ? "›" : " "} ${run.runId} · ${run.status}${run.active ? " *" : ""}` : "", left)} │ ${details[row] ?? ""}`,
        ),
      );
    }
  } else {
    if (state.focus === "runs") {
      for (const run of runs)
        lines.push(
          render(
            ` ${run.runId === state.selectedRunId ? "›" : " "} ${run.runId} · ${run.status}${run.active ? " *" : ""}`,
          ),
        );
      lines.push(
        render(
          ` ${selected?.blockedReason ?? selected?.status ?? "Select a run"}`,
        ),
      );
    } else
      for (const line of details.slice(0, capacity))
        lines.push(render(` ${line}`));
  }
  const footer = [
    render(
      ` ${state.submitting ? "Submitting…" : state.removingConnection ? "Removing connection…" : state.updatingConnection ? "Updating connection…" : state.reconciling ? "Reconciling budget…" : (state.notice ?? "Socket client · closing this view detaches execution")}`,
    ),
    render(
      state.draft !== undefined
        ? ` › ${state.draft}▏`
        : state.reconcileConfirm
          ? ` reconcile budget ${state.selectedRunId}? · return confirm · esc abandon`
          : state.connectionRemoveId !== undefined
            ? ` remove connection ${state.connectionRemoveId}? · return confirm · esc abandon`
            : state.connectionEdit !== undefined
              ? ` update connection ${state.connectionEdit.id}? · return confirm · esc abandon`
              : " n run · c conns · u edit · x canc · p res · b reconcile · e ev · tab jk · ↵ body · g git · s stage · r ref · q detach",
    ),
  ];
  // The lower region hosts the Git dashboard or, when toggled with `e`/`c`,
  // the evidence or connections pane (mutually exclusive); neither pane has
  // a minimum height and each fits any budget.
  const bodyRows = height - lines.length - footer.length;
  if (state.showEvidence) {
    const evidence = evidenceLines(state, bodyRows);
    for (let row = 0; row < bodyRows; row++)
      lines.push(render(evidence[row] ?? ""));
  } else if (state.showConnections) {
    const connections = connectionLines(state, bodyRows);
    for (let row = 0; row < bodyRows; row++)
      lines.push(render(connections[row] ?? ""));
  } else if (bodyRows >= 7) {
    const gitView = {
      ...state.git,
      readOnly: true,
      runtimeStatus: "service observer",
    };
    if (selected?.workspace)
      lines.push(
        ...renderDashboard(gitView, width, bodyRows, { color }).split("\n"),
      );
    else
      lines.push(
        ...Array.from({ length: bodyRows }, (_, row) =>
          render(
            row === 0 ? " Git / worktrees · awaiting selected workspace" : "",
          ),
        ),
      );
  } else while (lines.length < height - footer.length) lines.push(render(""));
  return [...lines, ...footer].slice(0, height).join("\n");
}
