import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "vitest";
import {
  createWorkflowRun,
  type Evidence,
  transitionWorkflow,
  type WorkflowAction,
  type WorkflowRun,
  WorkflowStore,
  workflowTemplate,
} from "../src/workflow/index.js";

const workspace = {
  workspaceId: "workspace-1",
  head: "abc123",
  fingerprint: "sha256:one",
};
function fixture(kind: "feature" | "debug" = "feature"): WorkflowRun {
  return createWorkflowRun({
    id: "run-1",
    goal: "Add a feature",
    workspace,
    template: workflowTemplate(kind),
  });
}
function proof(run: WorkflowRun, overrides: Partial<Evidence> = {}): Evidence {
  const step = run.steps.find((item) => item.status === "running");
  if (!step) throw new Error("No active step");
  const base = {
    id: `e-${run.revision}`,
    stepId: step.id,
    attempt: step.attempt,
    planVersion: run.planVersion,
    workspace: run.workspace,
    artifactRef: `artifacts/${step.id}`,
    recordedAt: 100,
    valid: true,
  };
  const details =
    step.requirement === "command"
      ? {
          kind: "command" as const,
          command: "npm test",
          exitCode: 0,
          collector: "execution_env" as const,
        }
      : step.requirement === "review"
        ? {
            kind: "review" as const,
            reviewerId: "reviewer",
            implementerId: "implementer",
            unresolvedFindings: 0,
          }
        : { kind: "artifact" as const, producerId: "host" };
  return { ...base, ...details, ...overrides } as Evidence;
}
function completeNext(run: WorkflowRun): WorkflowRun {
  const step = run.steps.find((item) => item.status === "pending");
  if (!step) throw new Error("No pending step");
  let next = transitionWorkflow(run, { type: "start", stepId: step.id });
  next = transitionWorkflow(next, {
    type: "record_evidence",
    evidence: proof(next),
  });
  return transitionWorkflow(next, { type: "complete", stepId: step.id });
}

test.each(["feature", "debug"] as const)(
  "%s completes only through ordered evidence gates",
  (kind) => {
    let run = fixture(kind);
    expect(() =>
      transitionWorkflow(run, { type: "start", stepId: "deliver" }),
    ).toThrow("Dependencies");
    const started = transitionWorkflow(run, {
      type: "start",
      stepId: run.steps[0]?.id ?? "",
    });
    expect(() =>
      transitionWorkflow(started, {
        type: "complete",
        stepId: started.steps[0]?.id ?? "",
      }),
    ).toThrow("evidence");
    while (run.status !== "completed") run = completeNext(run);
    expect(run.steps.every((step) => step.status === "completed")).toBe(true);
    expect(fixture(kind).revision).toBe(0);
  },
);

test("failed command blocks completion; retry consumes a fresh attempt and evidence", () => {
  let run = fixture();
  for (let i = 0; i < 4; i++) run = completeNext(run);
  run = transitionWorkflow(run, { type: "start", stepId: "targeted_verify" });
  run = transitionWorkflow(run, {
    type: "record_evidence",
    evidence: proof(run, { exitCode: 1 }),
  });
  expect(() =>
    transitionWorkflow(run, { type: "complete", stepId: "targeted_verify" }),
  ).toThrow("Command failed");
  run = transitionWorkflow(run, {
    type: "fail",
    stepId: "targeted_verify",
    reason: "Test failed",
  });
  run = transitionWorkflow(run, { type: "start", stepId: "targeted_verify" });
  expect(() =>
    transitionWorkflow(run, { type: "complete", stepId: "targeted_verify" }),
  ).toThrow("missing");
  run = transitionWorkflow(run, {
    type: "record_evidence",
    evidence: proof(run),
  });
  expect(
    transitionWorkflow(run, { type: "complete", stepId: "targeted_verify" })
      .status,
  ).toBe("ready");
});

test("independent review, stale attempts and workspace fingerprints are enforced", () => {
  let run = fixture();
  for (let i = 0; i < 5; i++) run = completeNext(run);
  run = transitionWorkflow(run, { type: "start", stepId: "review" });
  for (const overrides of [
    { reviewerId: "implementer" },
    { attempt: 9 },
    { workspace: { ...workspace, fingerprint: "changed" } },
  ]) {
    expect(() =>
      transitionWorkflow(run, {
        type: "record_evidence",
        evidence: proof(run, overrides),
      }),
    ).toThrow();
  }
  run = transitionWorkflow(run, {
    type: "record_evidence",
    evidence: proof(run, { unresolvedFindings: 1 }),
  });
  expect(() =>
    transitionWorkflow(run, { type: "complete", stepId: "review" }),
  ).toThrow("unresolved");
  run = transitionWorkflow(run, { type: "reopen", stepId: "implement" });
  expect(run.steps.find((step) => step.id === "targeted_verify")?.status).toBe(
    "pending",
  );
  expect(
    run.evidence
      .filter((item) => item.stepId === "review")
      .every((item) => !item.valid),
  ).toBe(true);
});

test("a completed Run becomes incomplete when HEAD or uncommitted content changes", () => {
  for (const changed of [
    { ...workspace, fingerprint: "sha256:two" },
    { ...workspace, head: "def456" },
  ]) {
    let run = fixture();
    while (run.status !== "completed") run = completeNext(run);
    const next = transitionWorkflow(run, {
      type: "workspace_changed",
      workspace: changed,
    });
    expect(next.status).toBe("ready");
    expect(next.evidence.every((item) => !item.valid)).toBe(true);
    expect(
      next.steps.find((step) => step.id === "targeted_verify")?.status,
    ).toBe("pending");
    expect(next.steps.find((step) => step.id === "deliver")?.status).toBe(
      "pending",
    );
    expect(run.status).toBe("completed");
  }
});

test("template publication is isolated and plan revision invalidates evidence", () => {
  const spec = workflowTemplate("feature");
  let run = createWorkflowRun({
    id: "run",
    goal: "goal",
    workspace,
    template: spec,
  });
  spec.version = 2;
  spec.steps.reverse();
  expect(run.template.version).toBe(1);
  expect(run.steps[0]?.id).toBe("scout");
  run = completeNext(run);
  run = transitionWorkflow(run, { type: "revise_plan" });
  expect(run.planVersion).toBe(2);
  expect(run.steps.every((item) => item.status === "pending")).toBe(true);
  expect(run.evidence[0]?.valid).toBe(false);
});

test("retry bound and cancellation are terminal gates", () => {
  let run = fixture();
  for (let i = 0; i < 3; i++) {
    run = transitionWorkflow(run, { type: "start", stepId: "scout" });
    run = transitionWorkflow(run, {
      type: "fail",
      stepId: "scout",
      reason: "Unavailable",
    });
  }
  expect(() =>
    transitionWorkflow(run, { type: "start", stepId: "scout" }),
  ).toThrow("retry limit");
  run = transitionWorkflow(run, { type: "cancel" });
  expect(() =>
    transitionWorkflow(run, { type: "reopen", stepId: "scout" }),
  ).toThrow("terminal");
});

test("Pi SQLite document restores pending human input and rejects stale concurrent writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-workflow-"));
  const db = join(dir, "agent.sqlite");
  let session = createSession(await openNodeSqliteStorage(db));
  try {
    let store = new WorkflowStore(session);
    let run = await store.create({
      id: "run",
      goal: "goal",
      workspace,
      template: workflowTemplate("feature"),
    });
    run = await store.dispatch(
      { type: "start", stepId: "scout" },
      run.revision,
    );
    run = await store.dispatch(
      {
        type: "request_input",
        stepId: "scout",
        question: "Which behavior is required?",
      },
      run.revision,
    );
    await session.close(BACKGROUND_CONTEXT);
    session = createSession(await openNodeSqliteStorage(db));
    store = new WorkflowStore(session);
    expect(await store.read()).toEqual(run);
    const actions: WorkflowAction[] = [
      {
        type: "answer_input",
        stepId: "scout",
        answer: "Preserve existing behavior",
      },
      { type: "cancel" },
    ];
    const outcomes = await Promise.allSettled(
      actions.map((action) => store.dispatch(action, run.revision)),
    );
    expect(outcomes.map((item) => item.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await store.read())?.steps[0]?.inputAnswer).toBe(
      "Preserve existing behavior",
    );
  } finally {
    await session.close(BACKGROUND_CONTEXT);
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["feature", "debug"] as const)(
  "%s preserves running implementation across edits but requires current verification",
  (kind) => {
    let run = fixture(kind);
    const implementation = kind === "debug" ? "fix" : "implement";
    const firstCheck = kind === "debug" ? "reproduce_again" : "targeted_verify";
    while (
      run.steps.find((step) => step.status === "pending")?.id !== implementation
    )
      run = completeNext(run);
    run = transitionWorkflow(run, { type: "start", stepId: implementation });
    run = transitionWorkflow(run, {
      type: "workspace_changed",
      workspace: { ...workspace, fingerprint: "edited" },
    });
    expect(run.steps.find((step) => step.id === implementation)?.status).toBe(
      "running",
    );
    if (kind === "debug") {
      for (const id of ["reproduce", "investigate", "hypothesis_test"])
        expect(run.steps.find((step) => step.id === id)?.status).toBe(
          "completed",
        );
    }
    expect(run.evidence.every((e) => !e.valid)).toBe(true);
    expect(() =>
      transitionWorkflow(run, { type: "complete", stepId: implementation }),
    ).toThrow("missing");
    run = transitionWorkflow(run, {
      type: "record_evidence",
      evidence: proof(run),
    });
    run = transitionWorkflow(run, { type: "complete", stepId: implementation });
    expect(() =>
      transitionWorkflow(run, { type: "start", stepId: "deliver" }),
    ).toThrow("Dependencies");
    run = transitionWorkflow(run, { type: "start", stepId: firstCheck });
    expect(() =>
      transitionWorkflow(run, {
        type: "record_evidence",
        evidence: proof(run, { workspace }),
      }),
    ).toThrow("Stale");
    expect(() =>
      transitionWorkflow(run, { type: "complete", stepId: firstCheck }),
    ).toThrow("missing");
    run = transitionWorkflow(run, {
      type: "record_evidence",
      evidence: proof(run),
    });
    run = transitionWorkflow(run, { type: "complete", stepId: firstCheck });
    // An additional edit after real verification must reopen checks, without replaying diagnosis.
    run = transitionWorkflow(run, {
      type: "workspace_changed",
      workspace: { ...workspace, fingerprint: "edited-again" },
    });
    expect(run.steps.find((s) => s.id === firstCheck)?.status).toBe("pending");
    expect(run.steps.find((s) => s.id === implementation)?.status).toBe(
      "completed",
    );
    while (run.steps.find((s) => s.status === "pending")?.id !== "review")
      run = completeNext(run);
    run = transitionWorkflow(run, { type: "start", stepId: "review" });
    expect(() =>
      transitionWorkflow(run, { type: "complete", stepId: "review" }),
    ).toThrow("missing");
    run = transitionWorkflow(run, {
      type: "record_evidence",
      evidence: proof(run),
    });
    run = transitionWorkflow(run, { type: "complete", stepId: "review" });
    while (run.status !== "completed") run = completeNext(run);
    // Even a fully accepted Run must be reverified and redelivered after a new revision.
    run = transitionWorkflow(run, {
      type: "workspace_changed",
      workspace: { ...workspace, head: "new-head", fingerprint: "third" },
    });
    expect(run.status).toBe("ready");
    expect(run.steps.find((s) => s.id === "deliver")?.status).toBe("pending");
    expect(run.steps.find((s) => s.id === "review")?.status).toBe("pending");
    expect(run.evidence.every((e) => !e.valid)).toBe(true);
    expect(() =>
      transitionWorkflow(run, { type: "start", stepId: "deliver" }),
    ).toThrow("Dependencies");
  },
);

test("successful checks on new revisions do not exhaust failure retry budget", () => {
  let run = fixture();
  for (let revision = 0; revision < 5; revision++) {
    while (run.status !== "completed") run = completeNext(run);
    run = transitionWorkflow(run, {
      type: "workspace_changed",
      workspace: { ...workspace, fingerprint: `revision-${revision}` },
    });
  }
  expect(run.steps.find((s) => s.id === "targeted_verify")?.attempt).toBe(5);
});
