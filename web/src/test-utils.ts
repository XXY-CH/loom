import { fireEvent, screen } from "@testing-library/react";
import type { RunSummary } from "./types.js";

/** Test doubles for fetch-level responses; no real network is touched. */

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
  } as unknown as Response;
}

export const dataEvent = (payload: unknown) =>
  `data: ${JSON.stringify(payload)}\n\n`;

/**
 * A scripted SSE response. After the script is exhausted the reader either
 * resolves done (stream ended, triggering reconnect) or hangs forever
 * (open-ended stream), depending on hangAfterScript.
 */
export function sseResponse(
  script: string[],
  options?: { hangAfterScript?: boolean },
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          const chunk = script[index++];
          if (chunk === undefined) {
            if (options?.hangAfterScript) return new Promise(() => {});
            return { done: true, value: undefined };
          }
          return { done: false, value: encoder.encode(chunk) };
        },
      }),
    },
  } as unknown as Response;
}

export function sampleRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "addition",
    goal: "Make sum.js add two numbers.",
    status: "running",
    active: true,
    operationId: null,
    blockedReason: null,
    workspace: { path: "/tmp/worktree-addition" },
    steps: [
      {
        id: "scout",
        role: "scout",
        status: "completed",
        attempt: 1,
        evidenceIds: [],
        failure: null,
        inputQuestion: null,
        inputAnswer: null,
      },
      {
        id: "implement",
        role: "implementer",
        status: "running",
        attempt: 1,
        evidenceIds: [],
        failure: null,
        inputQuestion: null,
        inputAnswer: null,
      },
    ],
    budget: { maxCalls: 64, maxTokens: 1_000_000 },
    usage: {
      limits: { maxCalls: 64, maxTokens: 1_000_000 },
      calls: 3,
      tokens: 900,
      pending: 0,
      reconciled: 0,
    },
    ...overrides,
  };
}

/**
 * Default start-form inputs shared by the StartForm and App tests. They mirror
 * the no-credential smoke profile: baseUrl points at the dead loopback port
 * 127.0.0.1:1 and keyEnv names an environment variable, never a secret.
 * `regression` contains a blank line to pin the one-argument-per-line contract
 * (blank lines dropped, inner spaces preserved).
 */
export const startFormDefaults = {
  runId: "addition",
  goal: "Make sum.js add two numbers.",
  repositoryPath: "/tmp/loom-smoke/repo",
  baseCommit: "8f01c40ba4a2f5f7b7c1f1bd6f9cc1fcb1a3f55b",
  worktreePath: "/tmp/loom-smoke/worktree",
  budgetCalls: "16",
  budgetTokens: "500000",
  targeted: "node\n-e\nprocess.stdout.write('targeted verified')",
  reproduce: "npm\ntest\n--\nbug.test.ts",
  hypothesis: "node\nscripts/check-cause.js",
  regression: "npm\n\ntest",
  profileId: "smoke",
  modelId: "smoke-model",
  baseUrl: "http://127.0.0.1:1",
  keyEnv: "LOOM_SMOKE_KEY",
};

/**
 * Fills every start-form field that is currently rendered (feature mode shows
 * `targeted`; debug mode shows `reproduce`/`hypothesis`). Empty-string
 * overrides leave a field blank for local-validation cases.
 */
export function fillStartForm(
  overrides: Partial<typeof startFormDefaults> = {},
): void {
  const values = { ...startFormDefaults, ...overrides };
  const fields: Array<[string, string]> = [
    ["runId", values.runId],
    ["goal", values.goal],
    ["repositoryPath", values.repositoryPath],
    ["baseCommit", values.baseCommit],
    ["worktreePath", values.worktreePath],
    ["budget maxCalls (optional)", values.budgetCalls],
    ["budget maxTokens (optional)", values.budgetTokens],
    ["targeted", values.targeted],
    ["reproduce", values.reproduce],
    ["hypothesis", values.hypothesis],
    ["regression", values.regression],
    ["Profile id", values.profileId],
    ["Profile modelId", values.modelId],
    [
      "Profile baseUrl (optional; required for openai-compatible)",
      values.baseUrl,
    ],
    ["Profile keyEnv (optional)", values.keyEnv],
  ];
  for (const [label, value] of fields) {
    const field = screen.queryByLabelText(label);
    if (field) fireEvent.change(field, { target: { value } });
  }
}

/**
 * Well-formed catalog entries for the connection selector tests (deep-equal
 * dispatch assertions require every field valid: in-union kind/protocol and
 * positive numbers — the server's parseProviderProfile checks that required
 * strings are non-empty, that optional fields have their types (baseUrl/keyEnv
 * strings, contextWindow/maxTokens numbers) and rejects unknown fields, but
 * not kind/protocol union membership or numeric positivity/integrality, so
 * hand-edited catalogs could carry odd shapes that the form degrades to
 * local validation or the server's structured error).
 */
export const catalogConnections = [
  {
    id: "local-fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "catalog-fixture-model",
    baseUrl: "http://127.0.0.1:1",
    keyEnv: "LOOM_SMOKE_KEY",
    contextWindow: 32768,
    maxTokens: 4096,
  },
  {
    id: "anthropic-fixture",
    kind: "anthropic",
    protocol: "anthropic-messages",
    modelId: "claude-fixture",
  },
] as const;

/** Selects a catalog entry in the connection selector once it has loaded. */
export async function selectConnection(id: string): Promise<void> {
  const select = await screen.findByLabelText("Connection (from the catalog)");
  fireEvent.change(select, { target: { value: id } });
}

/** The structured daemon error a service without --catalog answers with. */
export const CONNECTIONS_NOT_ENABLED = {
  ok: false as const,
  error:
    "Connection catalog is not enabled; start the service with --catalog DIR",
};
