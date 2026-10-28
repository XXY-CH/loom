import { useState } from "react";
import type { WorkbenchApi } from "./api.js";
import { DiffView } from "./DiffView.js";
import { EvidenceView } from "./EvidenceView.js";
import type {
  BudgetReconciliation,
  Evidence,
  RunDiff,
  RunSummary,
} from "./types.js";

/** One run: status projection plus pass-through cancel/resume, the read-only
 * diff/evidence loads, and the explicit budget reconciliation action.
 * Structured service errors render verbatim. */
export function RunDetail({
  run,
  api,
}: {
  run: RunSummary;
  api: WorkbenchApi;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [confirmingReconcile, setConfirmingReconcile] = useState(false);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<BudgetReconciliation | null>(
    null,
  );

  const act = async (action: "cancel" | "resume") => {
    setActionPending(true);
    setActionError(null);
    try {
      await api[action](run.runId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setActionPending(false);
    }
  };
  const reconcile = async () => {
    setReconcilePending(true);
    setReconcileError(null);
    try {
      setReconciled(await api.reconcileBudget(run.runId));
      setConfirmingReconcile(false);
    } catch (cause) {
      setReconcileError(
        cause instanceof Error ? cause.message : "Reconciliation failed",
      );
    } finally {
      setReconcilePending(false);
    }
  };
  const loadDiff = async () => {
    setDiffError(null);
    try {
      setDiff(await api.diff(run.runId));
    } catch (cause) {
      setDiff(null);
      setDiffError(cause instanceof Error ? cause.message : "Diff failed");
    }
  };
  const loadEvidence = async () => {
    setEvidenceError(null);
    try {
      setEvidence(await api.evidence(run.runId));
    } catch (cause) {
      setEvidence(null);
      setEvidenceError(
        cause instanceof Error ? cause.message : "Evidence failed",
      );
    }
  };
  // Only a settled run with unsettled calls offers the action: while the run
  // is dispatching, its own in-flight call is one pending row and the server
  // holds the run's database lease, so the request would fail closed with
  // DATABASE_IN_USE.
  const canReconcile =
    Boolean(run.usage && run.usage.pending > 0) && !run.active && !reconciled;

  return (
    <section className="run-detail" aria-label={`Run ${run.runId}`}>
      <h2>{run.runId}</h2>
      <dl>
        <dt>status</dt>
        <dd data-testid="run-status">
          {run.status}
          {run.active ? " (active)" : ""}
        </dd>
        <dt>goal</dt>
        <dd>{run.goal}</dd>
        {run.workspace ? (
          <>
            <dt>worktree</dt>
            <dd>{run.workspace.path}</dd>
          </>
        ) : null}
        {run.operationId ? (
          <>
            <dt>operation</dt>
            <dd>{run.operationId}</dd>
          </>
        ) : null}
        {run.blockedReason ? (
          <>
            <dt>blocked</dt>
            <dd data-testid="run-blocked">{run.blockedReason}</dd>
          </>
        ) : null}
        {run.budget ? (
          <>
            <dt>budget</dt>
            <dd data-testid="run-budget">
              {run.usage
                ? `${run.usage.calls}/${run.budget.maxCalls} calls, ${run.usage.tokens}/${run.budget.maxTokens} tokens, ${run.usage.pending} pending, ${run.usage.reconciled} reconciled`
                : `${run.budget.maxCalls} calls / ${run.budget.maxTokens} tokens (no usage yet)`}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="run-actions">
        <button
          type="button"
          disabled={actionPending}
          onClick={() => void act("cancel")}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={actionPending}
          onClick={() => void act("resume")}
        >
          Resume
        </button>
        <button type="button" onClick={() => void loadDiff()}>
          Load diff
        </button>
        <button type="button" onClick={() => void loadEvidence()}>
          Load evidence
        </button>
        {canReconcile ? (
          confirmingReconcile ? (
            <>
              <button
                type="button"
                disabled={reconcilePending}
                onClick={() => void reconcile()}
              >
                Confirm reconcile budget
              </button>
              <button
                type="button"
                disabled={reconcilePending}
                onClick={() => setConfirmingReconcile(false)}
              >
                Keep pending
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingReconcile(true)}
              data-testid="reconcile-budget-arm"
            >
              Reconcile budget…
            </button>
          )
        ) : null}
      </div>
      {actionError ? (
        <p role="alert" data-testid="action-error">
          {actionError}
        </p>
      ) : null}
      {reconcileError ? (
        <p role="alert" data-testid="reconcile-error">
          {reconcileError}
        </p>
      ) : null}
      {reconciled ? (
        <div data-testid="budget-reconciled">
          <p>
            Budget reconciled: pending {reconciled.before?.pending ?? "n/a"} →{" "}
            {reconciled.after?.pending ?? "n/a"}, reconciled{" "}
            {reconciled.before?.reconciled ?? "n/a"} →{" "}
            {reconciled.after?.reconciled ?? "n/a"}.
          </p>
          <p data-testid="budget-reconciled-note">
            Reconciliation unblocks future dispatch; it does not count tokens
            for the reconciled calls, does not adopt them as succeeded, and does
            not prove they never reached the endpoint.
          </p>
        </div>
      ) : null}
      <h3>Steps</h3>
      <table className="steps">
        <thead>
          <tr>
            <th>step</th>
            <th>role</th>
            <th>status</th>
            <th>attempt</th>
            <th>failures</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((step) => (
            <tr key={step.id} data-testid={`step-${step.id}`}>
              <td>{step.id}</td>
              <td>{step.role}</td>
              <td>{step.status}</td>
              <td>{step.attempt}</td>
              <td>{step.failures ?? 0}</td>
            </tr>
          ))}
          {run.steps.length === 0 ? (
            <tr>
              <td colSpan={5}>No steps recorded yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {stepFailure(run) ? (
        <p data-testid="step-failure">{stepFailure(run)}</p>
      ) : null}
      {diffError ? (
        <p role="alert" data-testid="diff-error">
          {diffError}
        </p>
      ) : null}
      {diff ? <DiffView diff={diff} api={api} runId={run.runId} /> : null}
      {evidenceError ? (
        <p role="alert" data-testid="evidence-error">
          {evidenceError}
        </p>
      ) : null}
      {evidence ? (
        <EvidenceView evidence={evidence} api={api} runId={run.runId} />
      ) : null}
    </section>
  );
}

function stepFailure(run: RunSummary): string | null {
  const failed = run.steps.find((step) => step.failure);
  return failed?.failure ?? null;
}
