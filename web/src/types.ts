/**
 * Structural mirrors of the service HTTP projections (RunSummary, RunDiff,
 * RunDiffFile, RunDiffFilePage, RunArtifact, Evidence) and of the start payload
 * (FeatureSpec, ProviderProfile). Only the fields the workbench renders or
 * sends are declared; the server shapes live in src/service/catalog.ts,
 * src/service/daemon.ts, src/workflow/feature-store.ts and
 * src/providers/index.ts and remain the source of truth.
 */

/** Mirror of FeatureSpec; validation and normalization stay server-side. */
export type FeatureSpec = {
  runId: string;
  goal: string;
  repositoryPath: string;
  baseCommit: string;
  worktreePath: string;
  workflow?: "feature" | "debug";
  budget?: { maxCalls: number; maxTokens: number };
  targeted?: string[];
  reproduce?: string[];
  hypothesis?: string[];
  regression: string[];
};

/** Mirror of the non-sensitive provider profile; credentials stay in the
 * keyEnv-referenced server-side environment, never in this object. */
export type ProviderProfile = {
  id: string;
  kind: "openai" | "openai-compatible" | "anthropic";
  protocol: "openai-responses" | "openai-completions" | "anthropic-messages";
  modelId: string;
  baseUrl?: string;
  keyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
};

/** Mirror of daemon.ts ConnectionWriteResult: one connection-catalog write
 * outcome (add, idempotent re-add, explicit same-id update, or removal); the
 * CLI subcommands print the same {id, status} shape. */
export type ConnectionWriteResult = {
  id: string;
  status: "added" | "unchanged" | "updated" | "removed";
};

export type StartRequest = { spec: FeatureSpec; profile: ProviderProfile };
export type RunStatus =
  | "ready"
  | "running"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "cancelled"
  | "initialization_pending";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed";

export type WorkflowStep = {
  id: string;
  role: string;
  status: StepStatus;
  attempt: number;
  failures?: number;
  evidenceIds: string[];
  failure: string | null;
  inputQuestion: string | null;
  inputAnswer: string | null;
};

export type ModelBudgetSummary = {
  limits: { maxCalls: number; maxTokens: number };
  calls: number;
  tokens: number;
  pending: number;
  /** Human-reconciled unsettled calls; a ledger fact beside `pending`, so the
   * workbench renders it even when zero. */
  reconciled: number;
};

/** Mirror of the service-side budget reconciliation decision (daemon.ts
 * BudgetReconciliation): the before/after ledger summaries around one
 * explicit human reconciliation. `database` is the canonical Run DB path. */
export type BudgetReconciliation = {
  database: string;
  before: ModelBudgetSummary | null;
  after: ModelBudgetSummary | null;
};

export type RunSummary = {
  runId: string;
  goal: string;
  status: RunStatus;
  active: boolean;
  operationId: string | null;
  blockedReason: string | null;
  workspace: { path: string } | null;
  steps: WorkflowStep[];
  budget: { maxCalls: number; maxTokens: number } | null;
  usage: ModelBudgetSummary | null;
};

export type RunDiffEntry = {
  path: string;
  originalPath?: string;
  mode: "working" | "staged";
  text: string;
};

export type RunDiff = {
  root: string;
  observedAt: number;
  files: Array<{ path: string; originalPath?: string }>;
  diffs: RunDiffEntry[];
  truncatedFiles: boolean;
};

/** Mirror of the single file/layer view (daemon.ts RunDiffFile); text keeps the
 * same embedded 64 KiB truncation marker as the aggregate entries. */
export type RunDiffFile = {
  root: string;
  observedAt: number;
  path: string;
  originalPath?: string;
  mode: "working" | "staged";
  text: string;
};

/** Mirror of one page of the full changed-file index (daemon.ts
 * RunDiffFilePage); order and cursors follow the server contract. */
export type RunDiffFilePage = {
  root: string;
  observedAt: number;
  total: number;
  files: Array<{ path: string; originalPath?: string }>;
  nextAfter: string | null;
};

/** Mirror of the persisted artifact body view (daemon.ts RunArtifact); text
 * keeps the same embedded 64 KiB truncation marker as the diff projections
 * and byteLength is the full stored size, larger than the text when
 * truncated. */
export type RunArtifact = {
  text: string;
  truncated: boolean;
  byteLength: number;
};

export type Evidence = {
  id: string;
  stepId: string;
  attempt: number;
  planVersion: number;
  valid: boolean;
  recordedAt: number;
  artifactRef: string;
  kind: "artifact" | "command" | "review";
  producerId?: string;
  command?: string;
  exitCode?: number;
  reviewerId?: string;
  implementerId?: string;
  unresolvedFindings?: number;
};
