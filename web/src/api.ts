import type {
  BudgetReconciliation,
  ConnectionWriteResult,
  Evidence,
  FeatureSpec,
  ProviderProfile,
  RunArtifact,
  RunDiff,
  RunDiffFile,
  RunDiffFilePage,
  RunSummary,
} from "./types.js";

/** Structured service error: the {ok:false,error} envelope as a thrown value. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const SSE_RETRY_DELAY_MS = 1_000;

export type WorkbenchApi = ReturnType<typeof createApi>;

export function createApi(base: string, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    let body: { ok?: boolean; result?: T; error?: string } | undefined;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = undefined;
    }
    if (!response.ok || !body?.ok || body.result === undefined)
      throw new ApiError(
        body?.error ?? `HTTP ${response.status}`,
        response.status,
      );
    return body.result;
  };
  const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}`;
  return {
    listRuns: () => request<RunSummary[]>("/runs"),
    /** Read-only connection catalog projection; servers started without
     * --catalog answer with a structured error, which callers treat as "no
     * catalog" and fall back to manual profile entry. */
    listConnections: () => request<ProviderProfile[]>("/connections"),
    /** Connection catalog write (one POST of the assembled non-secret
     * profile; requires --catalog). Structured errors arrive with their code
     * prefixed (CONNECTION_CONFLICT/INVALID_PROFILE/CATALOG_BUSY: …) and are
     * meant to be shown verbatim. */
    addConnection: (profile: ProviderProfile) =>
      request<ConnectionWriteResult>("/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      }),
    /** Connection catalog update (one PUT of the assembled non-secret
     * profile; requires --catalog). The path id names the entry to replace
     * and the body must carry the same id, so an edited id field is rejected
     * server-side instead of silently renaming or upserting. Structured
     * errors arrive with their code prefixed (UNKNOWN_CONNECTION/
     * INVALID_PROFILE/CATALOG_BUSY: …) and are meant to be shown verbatim. */
    updateConnection: (id: string, profile: ProviderProfile) =>
      request<ConnectionWriteResult>(`/connections/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      }),
    /** Connection catalog removal (one DELETE; requires --catalog). The id is
     * URL-encoded — catalog ids are arbitrary non-empty strings, not run-id
     * shaped. */
    removeConnection: (id: string) =>
      request<ConnectionWriteResult>(`/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    start: (spec: FeatureSpec, profile: ProviderProfile) =>
      request<RunSummary>("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, profile }),
      }),
    cancel: (runId: string) =>
      request<RunSummary>(`${runPath(runId)}/cancel`, { method: "POST" }),
    resume: (runId: string) =>
      request<RunSummary>(`${runPath(runId)}/resume`, { method: "POST" }),
    /** Explicit budget ledger reconciliation (one POST). The server fails
     * closed with a structured DATABASE_IN_USE error while any process holds
     * the run's database lease (e.g. the service is dispatching the run). */
    reconcileBudget: (runId: string) =>
      request<BudgetReconciliation>(`${runPath(runId)}/reconcile-budget`, {
        method: "POST",
      }),
    diff: (runId: string) => request<RunDiff>(`${runPath(runId)}/diff`),
    /** Page of the full changed-file index; `after` is the previous page's
     * nextAfter cursor (a file path). The server default limit is used. */
    diffFiles: (runId: string, after?: string) =>
      request<RunDiffFilePage>(
        `${runPath(runId)}/diff/files${
          after === undefined ? "" : `?after=${encodeURIComponent(after)}`
        }`,
      ),
    /** Single file/layer view; path must hit the current snapshot and mode must
     * be a layer that file actually has (server rejects with 400 otherwise). */
    diffFile: (runId: string, path: string, mode: "working" | "staged") =>
      request<RunDiffFile>(
        `${runPath(runId)}/diff/file?path=${encodeURIComponent(path)}&mode=${mode}`,
      ),
    evidence: (runId: string) =>
      request<Evidence[]>(`${runPath(runId)}/evidence`),
    /** Artifact body behind one evidence entry; the server resolves only
     * pi:feature/<evidence id> references and caps the text at 64 KiB. */
    artifact: (runId: string, evidenceId: string) =>
      request<RunArtifact>(
        `${runPath(runId)}/artifact?evidence=${encodeURIComponent(evidenceId)}`,
      ),
  };
}

/**
 * Opens the SSE snapshot stream. Implemented with fetch streaming instead of
 * EventSource because EventSource cannot send an Authorization header and the
 * service accepts the bearer token only there (no query-parameter auth).
 */
export async function openEventStream(
  base: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${base}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok || !response.body)
    throw new ApiError(
      `Event stream failed (HTTP ${response.status})`,
      response.status,
    );
  return response;
}

/** Consumes one SSE response body and invokes onData per `data:` payload. */
export async function consumeEventStream(
  response: Response,
  onData: (payload: unknown) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Event stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n"))
        if (line.startsWith("data: "))
          onData(JSON.parse(line.slice("data: ".length)));
      boundary = buffer.indexOf("\n\n");
    }
  }
}
