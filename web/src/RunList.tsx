import type { RunSummary } from "./types.js";

/** Read-only run list; live updates arrive as whole-snapshot replacements. */
export function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <section className="run-list" aria-label="Runs">
      <h2>Runs ({runs.length})</h2>
      {runs.length === 0 ? (
        <p data-testid="run-list-empty">No runs yet.</p>
      ) : null}
      <ul>
        {runs.map((run) => (
          <li key={run.runId}>
            <button
              type="button"
              className={run.runId === selectedId ? "selected" : undefined}
              onClick={() => onSelect(run.runId)}
            >
              <span className="run-id">{run.runId}</span>
              <span className={`run-status status-${run.status}`}>
                {run.status}
                {run.active ? " (active)" : ""}
              </span>
              <span className="run-goal">{run.goal}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
