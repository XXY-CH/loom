import { useState } from "react";
import type { WorkbenchApi } from "./api.js";
import type { RunDiff, RunDiffEntry, RunDiffFile } from "./types.js";

/** Marker embedded by git.ts when a per-file preview hits its 64 KiB cap. */
const PREVIEW_TRUNCATION_MARKER = "… preview truncated (64 KiB)";

function DiffEntryView({
  entry,
  testId,
}: {
  entry: RunDiffEntry | RunDiffFile;
  /** Aggregate entries keep the diff-<mode>-<path> ids; single-file views use
   * their own prefix so the same file can appear in both without collision. */
  testId?: string;
}) {
  const truncated = entry.text.includes(PREVIEW_TRUNCATION_MARKER);
  return (
    <article data-testid={testId ?? `diff-${entry.mode}-${entry.path}`}>
      <h4>
        {entry.path}
        {entry.originalPath ? ` (from ${entry.originalPath})` : ""} ·{" "}
        {entry.mode}
        {truncated ? (
          <span className="truncated-badge">truncated at 64 KiB</span>
        ) : null}
      </h4>
      <pre>
        <code>{entry.text}</code>
      </pre>
    </article>
  );
}

type IndexState = {
  files: Array<{ path: string; originalPath?: string }>;
  total: number;
  nextAfter: string | null;
};

/**
 * Read-only rendering of the single-response diff aggregate plus the on-demand
 * file-level views: the paginated index (diff/files) walks past the aggregate
 * 50-file cap, and any listed file can be opened per layer (diff/file). The
 * file cap (truncatedFiles), per-entry 64 KiB truncation, and every structured
 * service error render as-is, honestly; nothing retries silently.
 */
export function DiffView({
  diff,
  api,
  runId,
}: {
  diff: RunDiff;
  api: WorkbenchApi;
  runId: string;
}) {
  const [index, setIndex] = useState<IndexState | null>(null);
  const [indexPending, setIndexPending] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<RunDiffFile | null>(null);
  const [filePending, setFilePending] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const message = (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback;

  const loadFirstPage = async () => {
    setIndexPending(true);
    setIndexError(null);
    try {
      const page = await api.diffFiles(runId);
      setIndex({
        files: page.files,
        total: page.total,
        nextAfter: page.nextAfter,
      });
    } catch (cause) {
      setIndex(null);
      setIndexError(message(cause, "File index failed"));
    } finally {
      setIndexPending(false);
    }
  };
  const loadNextPage = async () => {
    const after = index?.nextAfter;
    if (after === undefined || after === null) return;
    setIndexPending(true);
    setIndexError(null);
    try {
      const page = await api.diffFiles(runId, after);
      setIndex((current) =>
        current === null
          ? null
          : {
              // Cursor invalidation keeps the pages already walked; the error
              // below tells the user to restart from the first page.
              files: [...current.files, ...page.files],
              total: page.total,
              nextAfter: page.nextAfter,
            },
      );
    } catch (cause) {
      setIndexError(message(cause, "File index failed"));
    } finally {
      setIndexPending(false);
    }
  };
  const viewFile = async (path: string, mode: "working" | "staged") => {
    setFilePending(true);
    setFileError(null);
    try {
      setFileView(await api.diffFile(runId, path, mode));
    } catch (cause) {
      setFileView(null);
      setFileError(message(cause, "File diff failed"));
    } finally {
      setFilePending(false);
    }
  };

  return (
    <section className="diff-view" aria-label="Run diff">
      <h3>
        Diff · {diff.files.length} changed file
        {diff.files.length === 1 ? "" : "s"}
      </h3>
      {diff.truncatedFiles ? (
        <p data-testid="diff-files-truncated">
          File list truncated at 50 files; load the worktree for the rest.
        </p>
      ) : null}
      {diff.diffs.length === 0 ? (
        <p data-testid="diff-empty">No changes in the run worktree.</p>
      ) : null}
      {diff.diffs.map((entry) => (
        <DiffEntryView key={`${entry.mode}:${entry.path}`} entry={entry} />
      ))}

      <section className="diff-index" aria-label="Changed file index">
        <h4>
          File index
          {index
            ? ` · ${index.files.length}/${index.total} file${
                index.total === 1 ? "" : "s"
              } listed`
            : ""}
        </h4>
        <div className="diff-index-actions">
          <button
            type="button"
            disabled={indexPending}
            onClick={() => void loadFirstPage()}
          >
            {index ? "Reload file index" : "Load file index"}
          </button>
          {index?.nextAfter ? (
            <button
              type="button"
              disabled={indexPending}
              onClick={() => void loadNextPage()}
            >
              Load more files
            </button>
          ) : null}
        </div>
        {indexError ? (
          <p role="alert" data-testid="diff-index-error">
            {indexError}
          </p>
        ) : null}
        {index ? (
          <ul className="diff-index-files">
            {index.files.map((file) => (
              <li key={file.path} data-testid={`diff-index-file-${file.path}`}>
                <span className="diff-index-path">
                  {file.path}
                  {file.originalPath ? ` (from ${file.originalPath})` : ""}
                </span>
                <button
                  type="button"
                  disabled={filePending}
                  onClick={() => void viewFile(file.path, "working")}
                >
                  working
                </button>
                <button
                  type="button"
                  disabled={filePending}
                  onClick={() => void viewFile(file.path, "staged")}
                >
                  staged
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {index && index.nextAfter === null ? (
          <p data-testid="diff-index-complete">
            All {index.total} changed files listed.
          </p>
        ) : null}
      </section>

      {filePending ? (
        <p data-testid="diff-file-pending">Loading file diff…</p>
      ) : null}
      {fileError ? (
        <p role="alert" data-testid="diff-file-error">
          {fileError}
        </p>
      ) : null}
      {fileView ? (
        <DiffEntryView
          entry={fileView}
          testId={`diff-file-${fileView.mode}-${fileView.path}`}
        />
      ) : null}
    </section>
  );
}
