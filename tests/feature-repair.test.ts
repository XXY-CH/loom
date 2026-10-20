import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FeatureRunner } from "../src/workflow/feature.js";
import {
  baselineSource,
  createFeatureFixture,
  featureModel,
  implementedSource,
} from "./feature-fixture.js";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
const runners: FeatureRunner[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await createFeatureFixture();
  roots.push(f.root);
  return f;
}
async function open(options: Parameters<typeof FeatureRunner.open>[0]) {
  const runner = await FeatureRunner.open(options);
  runners.push(runner);
  return runner;
}
function prompt(
  call: ReturnType<typeof featureModel>["calls"][number] | undefined,
) {
  if (!call) throw new Error("Missing expected fixture call");
  return JSON.parse(
    call.context.messages.find((message) => message.role === "user")
      ?.content as string,
  );
}

test("known targeted failure supplies collected diagnostics to a fresh implementer and completes all gates", async () => {
  const f = await fixture();
  const model = featureModel({
    implementationSources: [baselineSource, implementedSource],
  });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const result = await runner.run();
  expect(result.status).toBe("completed");
  const snapshot = await runner.store.read();
  expect(snapshot.state.verificationReworks).toBe(1);
  const implementations = model.calls.filter(
    (call) => call.step === "implement" && !call.afterTool,
  );
  expect(implementations).toHaveLength(2);
  const failure = result.evidence.find(
    (e) => e.kind === "command" && e.exitCode !== 0,
  );
  expect(failure).toMatchObject({ stepId: "targeted_verify", valid: false });
  const diagnostics = prompt(implementations[1]).repositoryData
    .verificationFailures;
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].evidence.id).toBe(failure?.id);
  expect(JSON.parse(diagnostics[0].artifact.body)).toMatchObject({
    exitCode: 1,
    cwd: f.spec.worktreePath,
  });
  expect(JSON.parse(diagnostics[0].artifact.body).stderr).toContain(
    "AssertionError",
  );
  expect(
    implementations[1]?.context.messages.filter(
      (message) => message.role === "user",
    ),
  ).toHaveLength(1);
  expect(
    implementations[1]?.context.messages.some(
      (message) =>
        message.role === "assistant" || message.role === "toolResult",
    ),
  ).toBe(false);
  const identities = result.evidence.filter((e) => e.stepId === "implement");
  expect(
    new Set(identities.map((e) => e.kind === "artifact" && e.producerId)).size,
  ).toBe(2);
  const review = model.calls.find(
    (call) => call.step === "review" && !call.afterTool,
  );
  const reviewData = prompt(review).repositoryData;
  expect(
    reviewData.verificationEvidence.every((e: { valid: boolean }) => e.valid),
  ).toBe(true);
  expect(reviewData.verificationArtifacts).toHaveLength(1);
  expect(reviewData.verificationFailures).toBeUndefined();
  expect(await readFile(join(f.spec.repositoryPath, "sum.js"), "utf8")).toBe(
    baselineSource,
  );
});

test("verification repair budget and pending repair survive restart and exhaustion cannot be retried", async () => {
  const f = await fixture();
  f.spec.targeted = [
    process.execPath,
    "-e",
    "process.stderr.write('persistent failure');process.exit(9)",
  ];
  const model = featureModel();
  let pause = true;
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
    afterStepForTest: async (step: string) => {
      if (step === "targeted_verify" && pause) {
        pause = false;
        throw new Error("repair boundary");
      }
    },
  };
  const runner = await open(options);
  await expect(runner.run()).rejects.toThrow("repair boundary");
  const boundary = await runner.store.read();
  expect(boundary.state.verificationReworks).toBe(1);
  expect(boundary.state.operation).toBeNull();
  expect(boundary.run.steps.find((s) => s.id === "implement")?.status).toBe(
    "pending",
  );
  await runner.close();
  const reopened = await open(options);
  await expect(reopened.run()).rejects.toThrow("Feature blocked");
  const exhausted = await reopened.store.read();
  expect(exhausted.state.verificationReworks).toBe(2);
  expect(exhausted.run.status).toBe("blocked");
  expect(
    exhausted.run.steps.find((s) => s.id === "targeted_verify")?.failures,
  ).toBe(3);
  expect(
    exhausted.run.evidence.filter(
      (e) => e.kind === "command" && e.exitCode === 9,
    ),
  ).toHaveLength(3);
  expect(exhausted.run.evidence.some((e) => e.stepId === "deliver")).toBe(
    false,
  );
  const count = model.calls.length;
  await reopened.close();
  const final = await open(options);
  await expect(final.run()).rejects.toThrow("Feature blocked");
  expect(model.calls).toHaveLength(count);
});

const regressionBug = "module.exports = (a, b) => a + b + (a < 0 ? 1 : 0);\n";
test("regression failure invalidates prior review and requires new targeted, independent review and regression", async () => {
  const f = await fixture();
  const model = featureModel({
    implementationSources: [regressionBug, implementedSource],
  });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const result = await runner.run();
  expect(result.status).toBe("completed");
  expect((await runner.store.read()).state.verificationReworks).toBe(1);
  for (const stepId of ["targeted_verify", "review", "regression"]) {
    const evidence = result.evidence.filter((e) => e.stepId === stepId);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.valid)).toEqual([false, true]);
  }
  const repair = model.calls.filter(
    (call) => call.step === "implement" && !call.afterTool,
  )[1];
  expect(
    prompt(repair).repositoryData.verificationFailures[0].evidence.stepId,
  ).toBe("regression");
  const reviews = result.evidence.filter((e) => e.kind === "review");
  expect(
    new Set(reviews.map((e) => e.kind === "review" && e.reviewerId)).size,
  ).toBe(2);
});

test("two review reworks and two late verification repairs fit the bounded dispatch loop", async () => {
  const f = await fixture();
  const model = featureModel({
    reviewRejects: 2,
    implementationSources: [
      regressionBug,
      regressionBug,
      regressionBug,
      regressionBug,
      implementedSource,
    ],
  });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  expect((await runner.run()).status).toBe("completed");
  const { state } = await runner.store.read();
  expect(state.reviewReworks).toBe(2);
  expect(state.verificationReworks).toBe(2);
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(5);
});

test.each(["spawn", "mutation", "output-limit", "signal", "timeout"])(
  "%s failure does not enter verification repair",
  async (kind) => {
    const f = await fixture();
    f.spec.targeted =
      kind === "spawn"
        ? [join(f.root, "missing-command")]
        : [
            process.execPath,
            "-e",
            kind === "mutation"
              ? "require('node:fs').appendFileSync('sum.js','// mutation');process.exit(1)"
              : kind === "output-limit"
                ? "process.stdout.write(Buffer.alloc(1024 * 1024 + 1))"
                : kind === "timeout"
                  ? "setInterval(() => {}, 1000)"
                  : "process.kill(process.pid, 'SIGTERM')",
          ];
    const model = featureModel();
    const runner = await open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: f.dbPath },
    });
    await expect(runner.run()).rejects.toThrow();
    const snapshot = await runner.store.read();
    expect(snapshot.state.verificationReworks ?? 0).toBe(0);
    expect(snapshot.run.evidence.some((e) => e.stepId === "deliver")).toBe(
      false,
    );
    expect(
      model.calls.filter(
        (call) => call.step === "implement" && !call.afterTool,
      ),
    ).toHaveLength(1);
    if (kind !== "mutation") {
      expect(snapshot.state.operation?.stepId).toBe("targeted_verify");
      const calls = model.calls.length;
      await expect(runner.run()).rejects.toThrow("Unknown feature operation");
      expect(model.calls).toHaveLength(calls);
    }
  },
  40_000,
);

test("restart after repair implementation resumes verification without replaying the write", async () => {
  const f = await fixture();
  const model = featureModel({
    implementationSources: [baselineSource, implementedSource],
  });
  let implementations = 0;
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
    afterStepForTest: async (step: string) => {
      if (step === "implement" && ++implementations === 2)
        throw new Error("repaired implementation boundary");
    },
  };
  const runner = await open(options);
  await expect(runner.run()).rejects.toThrow(
    "repaired implementation boundary",
  );
  expect((await runner.store.read()).state.verificationReworks).toBe(1);
  await runner.close();
  const reopened = await open(options);
  expect((await reopened.run()).status).toBe("completed");
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(2);
});

test("targeted and regression failures share the same durable verification repair budget", async () => {
  const f = await fixture();
  const model = featureModel({
    implementationSources: [baselineSource, regressionBug, implementedSource],
  });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const result = await runner.run();
  expect(result.status).toBe("completed");
  expect((await runner.store.read()).state.verificationReworks).toBe(2);
  const repairs = model.calls
    .filter((call) => call.step === "implement" && !call.afterTool)
    .slice(1);
  expect(
    repairs.map(
      (call) =>
        prompt(call).repositoryData.verificationFailures[0].evidence.stepId,
    ),
  ).toEqual(["targeted_verify", "regression"]);
});
