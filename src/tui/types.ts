import type { RuntimeUsageSummary } from "../runtime/usage.js";

/** Read-only projections. Git observations never imply Loom owns a worktree. */
export interface GitFile {
  path: string;
  originalPath?: string;
  index: string;
  working: string;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface WorktreeSnapshot {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  changes?: {
    staged: number;
    working: number;
    untracked: number;
    conflicts: number;
  };
  statusUnavailable?: boolean;
}
export interface GitSnapshot {
  root: string;
  branch: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  worktrees: WorktreeSnapshot[];
  observedAt: number;
}
export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  output?: string;
  state: "info" | "running" | "done" | "error";
}
export interface WorkflowProjection {
  id: string;
  status: string;
  revision: number;
  currentStep?: string;
  completed: number;
  total: number;
  operation?: string;
  blockedReason?: string;
  observedAt: number;
}
export interface DashboardState {
  cwd: string;
  /** Runtime execution directory; remains stable while Git viewing moves. */
  runtimeCwd?: string;
  input?: string;
  inputAdmitting?: boolean;
  inputNotice?: string;
  pendingInputs?: number;
  diffMode?: "working" | "staged";
  git?: GitSnapshot;
  gitError?: string;
  refreshing: boolean;
  selectedWorktree: number;
  selectedFile: number;
  focus: "worktrees" | "files" | "activity";
  scroll: number;
  diff: string;
  activity: ActivityItem[];
  runtimeStatus: string;
  runtimeUsage?: RuntimeUsageSummary;
  runtimeUsageError?: string;
  readOnly?: boolean;
  workflow?: WorkflowProjection;
  lastRuntimeUpdate?: number;
}
