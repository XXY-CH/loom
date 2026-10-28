import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FeatureRunner } from "../src/workflow/feature.js";
import { validateFeatureSpec } from "../src/workflow/feature-store.js";
import {
  baselineSource,
  createFeatureFixture,
  featureModel,
  implementedSource,
} from "./feature-fixture.js";

vi.setConfig({ testTimeout: 45000 });

const runners: FeatureRunner[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(behavior: Parameters<typeof featureModel>[0] = {}) {
  const f = await createFeatureFixture();
  roots.push(f.root);
  Object.assign(f.spec, {
    workflow: "debug",
    reproduce: f.spec.targeted,
    hypothesis: [
      process.execPath,
      "-e",
      "require('node:assert/strict').equal(require('./sum.js')(2,3),-1)",
    ],
  });
  const model = featureModel(behavior);
  const runner = await FeatureRunner.open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  runners.push(runner);
  return { f, model, runner };
}

test("debug closes a real failure through isolated fix, current verification and independent review", async () => {
  const { f, model, runner } = await setup();
  const run = await runner.run();
  expect(run.template.kind).toBe("debug");
  expect(run.status).toBe("completed");
  expect(run.steps.map((s) => s.id)).toEqual([
    "symptom",
    "reproduce",
    "investigate",
    "hypothesis_test",
    "fix",
    "reproduce_again",
    "regression",
    "review",
    "deliver",
  ]);
  const initial = run.evidence.find((e) => e.stepId === "reproduce");
  expect(initial).toMatchObject({ kind: "command", exitCode: 1, valid: false });
  expect(
    run.evidence
      .filter((e) => e.valid && e.kind === "command")
      .map((e) => e.stepId),
  ).toEqual(["reproduce_again", "regression"]);
  const review = run.evidence.find((e) => e.kind === "review");
  expect(
    review?.kind === "review" && review.reviewerId !== review.implementerId,
  ).toBe(true);
  expect(model.calls.filter((c) => !c.afterTool).map((c) => c.step)).toEqual([
    "symptom",
    "investigate",
    "fix",
    "review",
  ]);
  expect(await readFile(join(f.spec.repositoryPath, "sum.js"), "utf8")).toBe(
    baselineSource,
  );
});

test("successful original reproduction blocks before investigation or fix", async () => {
  const { runner, model } = await setup();
  await runner.store.update((state) => {
    state.spec.reproduce = [process.execPath, "-e", "process.exit(0)"];
  });
  await expect(runner.run()).rejects.toThrow();
  const snapshot = await runner.store.read();
  expect(snapshot.state.blockedReason).toMatch(/reproduc/i);
  expect(
    model.calls.some((c) => c.step === "fix" || c.step === "investigate"),
  ).toBe(false);
});

test.each(["spawn", "signal"])(
  "%s failure is not original reproduction evidence",
  async (mode) => {
    const { runner } = await setup();
    await runner.store.update((state) => {
      state.spec.reproduce =
        mode === "spawn"
          ? ["/nonexistent-loom-debug-command"]
          : [process.execPath, "-e", "process.kill(process.pid,'SIGTERM')"];
    });
    await expect(runner.run()).rejects.toThrow();
    const snapshot = await runner.store.read();
    expect(snapshot.state.operation?.stepId).toBe("reproduce");
    expect(snapshot.run.evidence.some((e) => e.stepId === "reproduce")).toBe(
      false,
    );
  },
);

test("failed repaired reproduction and rejected review return to fix with bounded attempts", async () => {
  const { runner, model } = await setup({
    implementationSources: [baselineSource],
    reviewRejects: 1,
  });
  expect((await runner.run()).status).toBe("completed");
  const snapshot = await runner.store.read();
  expect(snapshot.state.verificationReworks).toBe(1);
  expect(snapshot.state.reviewReworks).toBe(1);
  expect(
    model.calls.filter((c) => c.step === "fix" && !c.afterTool),
  ).toHaveLength(3);
  expect(
    model.calls.filter((c) => c.step === "investigate" && !c.afterTool),
  ).toHaveLength(1);
});

test("cancelling an in-flight fix preserves unknown write intent", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { runner, f } = await setup({
    pauseAfterWrite: true,
    onCall: (step, _context, afterTool) => {
      if (step === "fix" && afterTool) entered();
    },
  });
  const pending = expect(runner.run()).rejects.toThrow();
  await started;
  await runner.cancel();
  await pending;
  const snapshot = await runner.store.read();
  expect(snapshot.run.status).toBe("cancelled");
  expect(snapshot.state.operation?.stepId).toBe("fix");
  expect(snapshot.state.blockedReason).toMatch(/reconciliation/);
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
});

test.each(["verification", "review"])(
  "persistent %s rejection blocks after bounded fix rework",
  async (mode) => {
    const { runner, model } = await setup(
      mode === "review"
        ? { invalidReview: true }
        : {
            implementationSources: [
              baselineSource,
              baselineSource,
              baselineSource,
            ],
          },
    );
    await expect(runner.run()).rejects.toThrow();
    const snapshot = await runner.store.read();
    expect(snapshot.run.status).not.toBe("completed");
    expect(snapshot.state.blockedReason).toBeTruthy();
    expect(
      model.calls.filter((c) => c.step === "fix" && !c.afterTool),
    ).toHaveLength(3);
    expect(
      snapshot.run.evidence.some((e) => e.stepId === "deliver" && e.valid),
    ).toBe(false);
  },
);

test("debug resumes at a persisted fix boundary without repeating diagnosis", async () => {
  const { f, runner, model } = await setup();
  await runner.close();
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  };
  const paused = await FeatureRunner.open({
    ...options,
    afterStepForTest: async (step) => {
      if (step === "fix") throw new Error("boundary pause");
    },
  });
  runners.push(paused);
  await expect(paused.run()).rejects.toThrow("boundary pause");
  const before = await paused.store.read();
  expect(before.run.steps.find((s) => s.id === "fix")?.status).toBe(
    "completed",
  );
  await paused.close();
  const resumed = await FeatureRunner.open(options);
  runners.push(resumed);
  expect((await resumed.run()).status).toBe("completed");
  expect(
    model.calls.filter((c) => c.step === "fix" && !c.afterTool),
  ).toHaveLength(1);
  expect(
    model.calls.filter((c) => c.step === "investigate" && !c.afterTool),
  ).toHaveLength(1);
});

test("reproduction timeout retains unknown intent and cannot count as observed fault", async () => {
  const { runner } = await setup();
  await runner.store.update((state) => {
    state.spec.reproduce = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  });
  await expect(runner.run()).rejects.toThrow();
  const snapshot = await runner.store.read();
  expect(snapshot.state.operation?.stepId).toBe("reproduce");
  expect(snapshot.state.blockedReason).toMatch(/reconciliation/);
  expect(snapshot.run.evidence.some((e) => e.stepId === "reproduce")).toBe(
    false,
  );
});

test("regression failure also returns to fix and reruns repaired reproduction", async () => {
  const { runner, model } = await setup({
    implementationSources: ["module.exports = (a,b) => a === 2 ? 5 : 0;\n"],
  });
  expect((await runner.run()).status).toBe("completed");
  const snapshot = await runner.store.read();
  expect(snapshot.state.verificationReworks).toBe(1);
  expect(
    snapshot.run.evidence.filter((e) => e.stepId === "reproduce_again"),
  ).toHaveLength(2);
  expect(
    model.calls.filter((c) => c.step === "fix" && !c.afterTool),
  ).toHaveLength(2);
});

test("spec validation requires debug commands, preserves feature defaults and validates budget", async () => {
  const f = await createFeatureFixture();
  roots.push(f.root);
  expect(() => validateFeatureSpec(f.spec)).not.toThrow();
  const { targeted, ...base } = f.spec;
  if (!targeted) throw new Error("Expected fixture targeted command");
  const debug = {
    ...base,
    workflow: "debug" as const,
    reproduce: targeted,
    hypothesis: [process.execPath, "-e", "process.exit(0)"],
  };
  expect(() => validateFeatureSpec(debug)).not.toThrow();
  const { reproduce: _reproduce, ...withoutReproduce } = debug;
  expect(() => validateFeatureSpec(withoutReproduce)).toThrow();
  expect(() => validateFeatureSpec({ ...debug, hypothesis: [] })).toThrow();
  expect(() =>
    validateFeatureSpec({ ...debug, budget: { maxCalls: 0, maxTokens: 100 } }),
  ).toThrow();
});

test("workflow budget is sourced from spec and cannot be omitted on restart", async () => {
  const f = await createFeatureFixture();
  roots.push(f.root);
  const model = featureModel();
  const runtime = { ...model.runtime, dbPath: f.dbPath };
  await expect(
    FeatureRunner.open({
      spec: f.spec,
      runtime: { ...runtime, budget: { maxCalls: 20, maxTokens: 1000 } },
    }),
  ).rejects.toThrow("declared in its spec");
  f.spec.budget = { maxCalls: 20, maxTokens: 1000 };
  const runner = await FeatureRunner.open({ spec: f.spec, runtime });
  runners.push(runner);
  expect(await runner.runtime.budgetSummary()).toMatchObject({
    limits: { maxCalls: 20, maxTokens: 1000 },
  });
  await runner.close();
  const { budget: _budget, ...withoutBudget } = f.spec;
  await expect(
    FeatureRunner.open({ spec: withoutBudget, runtime }),
  ).rejects.toThrow();
  expect(model.calls).toHaveLength(0);
});
