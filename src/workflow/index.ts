import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Session } from "@earendil-works/pi-durable";

export type WorkflowKind = "feature" | "debug";
export type Role =
  | "scout"
  | "planner"
  | "implementer"
  | "verifier"
  | "reviewer"
  | "coordinator";
export type StepStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed";
export type WorkspaceIdentity = {
  workspaceId: string;
  head: string;
  fingerprint: string;
};
export type StepDefinition = {
  id: string;
  role: Role;
  dependsOn: string[];
  requirement: "artifact" | "command" | "review";
};
export type WorkflowTemplate = {
  kind: WorkflowKind;
  version: number;
  steps: StepDefinition[];
};
export type Evidence = {
  id: string;
  stepId: string;
  attempt: number;
  planVersion: number;
  workspace: WorkspaceIdentity;
  artifactRef: string;
  recordedAt: number;
  valid: boolean;
} & (
  | { kind: "artifact"; producerId: string }
  | {
      kind: "command";
      command: string;
      exitCode: number;
      collector: "execution_env";
    }
  | {
      kind: "review";
      reviewerId: string;
      implementerId: string;
      unresolvedFindings: number;
    }
);
export type WorkflowStep = StepDefinition & {
  status: StepStatus;
  attempt: number;
  /** Failures for the current input revision; attempt remains a monotonic evidence identity. */
  failures?: number;
  evidenceIds: string[];
  inputQuestion: string | null;
  inputAnswer: string | null;
  failure: string | null;
};
export type WorkflowRun = {
  id: string;
  goal: string;
  template: WorkflowTemplate;
  planVersion: number;
  revision: number;
  workspace: WorkspaceIdentity;
  status:
    | "ready"
    | "running"
    | "waiting_input"
    | "blocked"
    | "completed"
    | "cancelled";
  steps: WorkflowStep[];
  evidence: Evidence[];
};

function template(kind: WorkflowKind, ids: string[]): WorkflowTemplate {
  return {
    kind,
    version: 1,
    steps: ids.map((id, index) => ({
      id,
      role:
        id === "review"
          ? "reviewer"
          : id.includes("verify") ||
              id.includes("regression") ||
              id === "reproduce" ||
              id === "reproduce_again" ||
              id === "hypothesis_test"
            ? "verifier"
            : id === "implement" || id === "fix"
              ? "implementer"
              : id === "contract" || id === "plan"
                ? "planner"
                : id === "deliver"
                  ? "coordinator"
                  : "scout",
      dependsOn: index === 0 ? [] : [ids[index - 1] as string],
      requirement:
        id === "review"
          ? "review"
          : id.includes("verify") ||
              id.includes("regression") ||
              id === "reproduce" ||
              id === "reproduce_again" ||
              id === "hypothesis_test"
            ? "command"
            : "artifact",
    })),
  };
}

const builtins = {
  feature: template("feature", [
    "scout",
    "contract",
    "plan",
    "implement",
    "targeted_verify",
    "review",
    "regression",
    "deliver",
  ]),
  debug: template("debug", [
    "symptom",
    "reproduce",
    "investigate",
    "hypothesis_test",
    "fix",
    "reproduce_again",
    "regression",
    "review",
    "deliver",
  ]),
};

/** Detached templates: publishing a replacement never mutates an existing Run. */
export function workflowTemplate(kind: WorkflowKind): WorkflowTemplate {
  return structuredClone(builtins[kind]);
}

export function createWorkflowRun(input: {
  id: string;
  goal: string;
  workspace: WorkspaceIdentity;
  template: WorkflowTemplate;
}): WorkflowRun {
  if (!input.id.trim() || !input.goal.trim())
    throw new Error("Run ID and goal are required");
  validateWorkspace(input.workspace);
  const ids = new Set<string>();
  for (const step of input.template.steps) {
    if (
      !step.id.trim() ||
      ids.has(step.id) ||
      step.dependsOn.some((id) => !ids.has(id))
    ) {
      throw new Error("Template requires unique, topologically ordered steps");
    }
    ids.add(step.id);
  }
  if (
    !ids.size ||
    !Number.isInteger(input.template.version) ||
    input.template.version < 1
  )
    throw new Error("Invalid template");
  return structuredClone({
    ...input,
    planVersion: 1,
    revision: 0,
    status: "ready",
    steps: input.template.steps.map((step) => ({
      ...step,
      status: "pending",
      attempt: 0,
      evidenceIds: [],
      inputQuestion: null,
      inputAnswer: null,
      failure: null,
    })),
    evidence: [],
  });
}

export type WorkflowAction =
  | { type: "start"; stepId: string }
  | { type: "record_evidence"; evidence: Evidence }
  | { type: "complete"; stepId: string }
  | { type: "fail"; stepId: string; reason: string }
  | { type: "request_input"; stepId: string; question: string }
  | { type: "answer_input"; stepId: string; answer: string }
  | { type: "workspace_changed"; workspace: WorkspaceIdentity }
  | { type: "revise_plan" }
  | { type: "reopen"; stepId: string }
  | { type: "cancel" };

function validateWorkspace(value: WorkspaceIdentity): void {
  if (
    !value.workspaceId.trim() ||
    !value.head.trim() ||
    !value.fingerprint.trim()
  )
    throw new Error("Workspace, HEAD and content fingerprint are required");
}
function sameWorkspace(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.head === b.head &&
    a.fingerprint === b.fingerprint
  );
}
function invalidate(run: WorkflowRun, roots: Set<string>): void {
  for (const step of run.steps) {
    if (step.dependsOn.some((id) => roots.has(id))) roots.add(step.id);
    if (!roots.has(step.id)) continue;
    step.status = "pending";
    step.evidenceIds = [];
    step.inputQuestion = null;
    step.inputAnswer = null;
    step.failure = null;
    step.failures = 0;
  }
  for (const evidence of run.evidence)
    if (roots.has(evidence.stepId)) evidence.valid = false;
}

/** Deterministic gates only. Inputs must come from trusted host collectors, never model prose. */
export function transitionWorkflow(
  previous: WorkflowRun,
  action: WorkflowAction,
): WorkflowRun {
  if (previous.status === "cancelled")
    throw new Error("Cancelled Run is terminal");
  // Pi tx.doc returns a tracked proxy; JSON materialization detaches its JSON-only value.
  const run: WorkflowRun = JSON.parse(JSON.stringify(previous));
  const step =
    "stepId" in action
      ? run.steps.find((item) => item.id === action.stepId)
      : undefined;
  if ("stepId" in action && !step) throw new Error("Unknown workflow step");
  const running = () => {
    if (step?.status !== "running") throw new Error("Step must be running");
    return step;
  };
  switch (action.type) {
    case "start": {
      if (!step || (step.status !== "pending" && step.status !== "failed"))
        throw new Error("Step cannot start");
      if (
        run.steps.some(
          (item) =>
            item.status === "running" || item.status === "waiting_input",
        )
      )
        throw new Error("Another step is active");
      if (
        step.dependsOn.some(
          (id) =>
            run.steps.find((item) => item.id === id)?.status !== "completed",
        )
      )
        throw new Error("Dependencies are incomplete");
      if ((step.failures ?? 0) >= 3)
        throw new Error("Step retry limit reached");
      step.attempt += 1;
      step.status = "running";
      step.failure = null;
      break;
    }
    case "record_evidence": {
      const evidence = structuredClone(action.evidence);
      const owner = run.steps.find((item) => item.id === evidence.stepId);
      if (
        owner?.status !== "running" ||
        evidence.attempt !== owner.attempt ||
        evidence.planVersion !== run.planVersion
      )
        throw new Error("Evidence does not match active attempt");
      if (
        !evidence.id.trim() ||
        !evidence.artifactRef.trim() ||
        !Number.isFinite(evidence.recordedAt) ||
        run.evidence.some((item) => item.id === evidence.id)
      )
        throw new Error("Invalid evidence identity or artifact");
      if (!sameWorkspace(evidence.workspace, run.workspace) || !evidence.valid)
        throw new Error("Stale evidence");
      if (
        evidence.kind === "command" &&
        (!evidence.command.trim() ||
          !Number.isInteger(evidence.exitCode) ||
          evidence.collector !== "execution_env")
      )
        throw new Error("Invalid command evidence");
      if (evidence.kind === "artifact" && !evidence.producerId.trim())
        throw new Error("Artifact producer is required");
      if (
        evidence.kind === "review" &&
        (!evidence.reviewerId.trim() ||
          !evidence.implementerId.trim() ||
          evidence.reviewerId === evidence.implementerId ||
          !Number.isInteger(evidence.unresolvedFindings) ||
          evidence.unresolvedFindings < 0)
      )
        throw new Error("Independent review is required");
      run.evidence.push(evidence);
      owner.evidenceIds.push(evidence.id);
      break;
    }
    case "complete": {
      const current = running();
      const evidence = run.evidence.filter(
        (item) =>
          current.evidenceIds.includes(item.id) &&
          item.valid &&
          item.attempt === current.attempt &&
          item.planVersion === run.planVersion &&
          sameWorkspace(item.workspace, run.workspace),
      );
      if (!evidence.some((item) => item.kind === current.requirement))
        throw new Error("Required evidence is missing");
      // Failed commands remain visible and must be resolved by a new attempt, not hidden by a later success.
      if (
        evidence.some(
          (item) =>
            item.kind === "command" &&
            item.exitCode !== 0 &&
            current.id !== "reproduce",
        )
      )
        throw new Error("Command failed");
      if (
        evidence.some(
          (item) => item.kind === "review" && item.unresolvedFindings !== 0,
        )
      )
        throw new Error("Review has unresolved findings");
      current.status = "completed";
      break;
    }
    case "fail":
      if (!action.reason.trim()) throw new Error("Failure reason is required");
      running().failure = action.reason;
      running().failures = (running().failures ?? 0) + 1;
      running().status = "failed";
      break;
    case "request_input":
      if (!action.question.trim())
        throw new Error("Input question is required");
      running().inputQuestion = action.question;
      running().status = "waiting_input";
      break;
    case "answer_input":
      if (step?.status !== "waiting_input" || !action.answer.trim())
        throw new Error("No matching pending input");
      step.inputAnswer = action.answer;
      step.status = "running";
      break;
    case "workspace_changed":
      validateWorkspace(action.workspace);
      if (action.workspace.workspaceId !== run.workspace.workspaceId)
        throw new Error("Workspace replacement requires a new Run");
      if (!sameWorkspace(action.workspace, run.workspace)) {
        run.workspace = structuredClone(action.workspace);
        // Completed debug diagnosis describes the historical fault, not the edited revision.
        // Preserve its progress, but never reuse its old evidence as current-revision proof.
        invalidate(
          run,
          new Set(
            run.steps
              .filter((item) => {
                const historicalDiagnosis =
                  run.template.kind === "debug" &&
                  (item.id === "reproduce" || item.id === "hypothesis_test") &&
                  item.status === "completed";
                return (
                  item.id === "deliver" ||
                  (item.requirement !== "artifact" && !historicalDiagnosis)
                );
              })
              .map((item) => item.id),
          ),
        );
        for (const evidence of run.evidence)
          if (!sameWorkspace(evidence.workspace, run.workspace))
            evidence.valid = false;
      }
      break;
    case "revise_plan":
      run.planVersion += 1;
      invalidate(run, new Set(run.steps.map((item) => item.id)));
      break;
    case "reopen":
      invalidate(run, new Set([action.stepId]));
      break;
    case "cancel":
      run.status = "cancelled";
      break;
  }
  if (run.status !== "cancelled")
    run.status = run.steps.every((item) => item.status === "completed")
      ? "completed"
      : run.steps.some((item) => item.status === "waiting_input")
        ? "waiting_input"
        : run.steps.some((item) => item.status === "running")
          ? "running"
          : run.steps.some((item) => item.status === "failed")
            ? "blocked"
            : "ready";
  run.revision += 1;
  return run;
}

export const WorkflowDoc = defineDoc<{ run: WorkflowRun | null }>({
  kind: "loom.workflow",
  version: 1,
  scope: "session",
  initial: () => ({ run: null }),
});

/** Reuses the owning Harness's commit line/storage; no new scheduler or database. */
export class WorkflowStore {
  constructor(private readonly session: Pick<Session, "commit" | "snapshot">) {}

  async create(
    input: Parameters<typeof createWorkflowRun>[0],
  ): Promise<WorkflowRun> {
    return this.session.commit(async (tx) => {
      const doc = await tx.doc(WorkflowDoc);
      if (doc.run) throw new Error("Harness already has a workflow Run");
      const run = createWorkflowRun(input);
      doc.run = run;
      return structuredClone(run);
    }, BACKGROUND_CONTEXT);
  }

  async read(): Promise<WorkflowRun | null> {
    return structuredClone(
      (await this.session.snapshot(WorkflowDoc, BACKGROUND_CONTEXT))?.run ??
        null,
    );
  }

  async dispatch(
    action: WorkflowAction,
    expectedRevision: number,
  ): Promise<WorkflowRun> {
    return this.session.commit(async (tx) => {
      const doc = await tx.doc(WorkflowDoc);
      if (!doc.run) throw new Error("Workflow Run not initialized");
      if (doc.run.revision !== expectedRevision)
        throw new Error("Workflow revision conflict");
      const next = transitionWorkflow(doc.run, action);
      doc.run = next;
      return structuredClone(next);
    }, BACKGROUND_CONTEXT);
  }
}
