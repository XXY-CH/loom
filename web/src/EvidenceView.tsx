import { useState } from "react";
import type { WorkbenchApi } from "./api.js";
import type { Evidence, RunArtifact } from "./types.js";

function evidenceDetail(item: Evidence): string {
  if (item.kind === "command")
    return `command: ${item.command ?? "?"} · exit ${item.exitCode ?? "?"}`;
  if (item.kind === "review")
    return `review by ${item.reviewerId ?? "?"} · ${item.unresolvedFindings ?? 0} unresolved`;
  return `artifact by ${item.producerId ?? "?"}`;
}

/**
 * On-demand read-only view of one artifact body. A load happens only on an
 * explicit click; a loaded body stays cached, so hiding and reopening the
 * entry never refetches (a retry is offered only after a structured error).
 */
function ArtifactEntry({
  item,
  api,
  runId,
}: {
  item: Evidence;
  api: WorkbenchApi;
  runId: string;
}) {
  const [body, setBody] = useState<RunArtifact | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = async () => {
    if (body !== null) {
      setOpen(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      setBody(await api.artifact(runId, item.id));
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Artifact failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="evidence-artifact">
      <div className="evidence-entry-actions">
        {body !== null && open ? (
          <button type="button" onClick={() => setOpen(false)}>
            hide body
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => void view()}
            data-testid={`artifact-view-${item.id}`}
          >
            {body !== null ? "show body" : "view body"}
          </button>
        )}
      </div>
      {pending ? (
        <p data-testid={`artifact-pending-${item.id}`}>Loading artifact…</p>
      ) : null}
      {error ? (
        <p role="alert" data-testid={`artifact-error-${item.id}`}>
          {error}
        </p>
      ) : null}
      {open && body ? (
        <article data-testid={`artifact-body-${item.id}`}>
          <h4>
            artifact body · {body.byteLength} byte
            {body.byteLength === 1 ? "" : "s"}
            {body.truncated ? (
              <span className="truncated-badge">truncated at 64 KiB</span>
            ) : null}
          </h4>
          <pre className="evidence-artifact-body">
            <code>{body.text}</code>
          </pre>
        </article>
      ) : null}
    </div>
  );
}

/** Read-only evidence list straight from the Run DB projection; artifact
 * entries can additionally open their persisted body on demand. */
export function EvidenceView({
  evidence,
  api,
  runId,
}: {
  evidence: Evidence[];
  api: WorkbenchApi;
  runId: string;
}) {
  return (
    <section className="evidence-view" aria-label="Run evidence">
      <h3>Evidence ({evidence.length})</h3>
      {evidence.length === 0 ? (
        <p data-testid="evidence-empty">No evidence recorded yet.</p>
      ) : null}
      <ul>
        {evidence.map((item) => (
          <li key={item.id} data-testid={`evidence-${item.id}`}>
            <div className="evidence-entry-line">
              <span>{item.id}</span>
              <span>· {item.stepId}</span>
              <span>· {item.kind}</span>
              <span>· attempt {item.attempt}</span>
              <span>· {item.valid ? "valid" : "invalid"}</span>
              <span>· {evidenceDetail(item)}</span>
            </div>
            {item.kind === "artifact" ? (
              <ArtifactEntry item={item} api={api} runId={runId} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
