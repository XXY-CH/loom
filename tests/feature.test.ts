import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { FeatureRunner } from "../src/workflow/feature.js";
import { fingerprintWorkspace } from "../src/workspace/evidence.js";
import {
  baselineSource,
  createFeatureFixture,
  featureModel,
  git,
  implementedSource,
} from "./feature-fixture.js";

const roots: string[] = [];
const runners: FeatureRunner[] = [];
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const result = await createFeatureFixture();
  roots.push(result.root);
  return result;
}
async function open(options: Parameters<typeof FeatureRunner.open>[0]) {
  const runner = await FeatureRunner.open(options);
  runners.push(runner);
  return runner;
}

test("local Pi fixture completes all eight real feature stages and durable reopening does not implement again", async () => {
  const f = await fixture();
  const userSource = `${baselineSource}// user dirty source\n`;
  await writeFile(join(f.spec.repositoryPath, "sum.js"), userSource);
  await writeFile(
    join(f.spec.repositoryPath, "user-note.txt"),
    "preserve user note",
  );
  const model = featureModel({ forgedEvidence: true });
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  };
  const runner = await open(options);
  const result = await runner.run();
  expect(result.status).toBe("completed");
  expect(
    result.evidence.every(
      (e) => e.id !== "forged" && e.artifactRef !== "forged",
    ),
  ).toBe(true);
  expect(
    result.evidence
      .filter((e) => e.kind === "artifact")
      .every((e) => e.producerId !== "forged"),
  ).toBe(true);

  expect(result.steps.map((step) => [step.id, step.status])).toEqual(
    [
      "scout",
      "contract",
      "plan",
      "implement",
      "targeted_verify",
      "review",
      "regression",
      "deliver",
    ].map((step) => [step, "completed"]),
  );
  expect(await readFile(join(f.spec.repositoryPath, "sum.js"), "utf8")).toBe(
    userSource,
  );
  expect(
    await readFile(join(f.spec.repositoryPath, "user-note.txt"), "utf8"),
  ).toBe("preserve user note");
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
  expect(await git(f.spec.worktreePath, "diff", "--", "sum.js")).toContain(
    "a + b",
  );
  const snapshot = await runner.store.read();
  expect(snapshot.state.operation).toBeNull();
  expect(snapshot.state.artifacts).toHaveLength(8);
  const commandEvidence = result.evidence
    .filter((e) => e.kind === "command")
    .filter((e) => e.valid);
  expect(
    commandEvidence.map((e) => [e.stepId, e.exitCode, e.collector]),
  ).toEqual([
    ["targeted_verify", 0, "execution_env"],
    ["regression", 0, "execution_env"],
  ]);
  const targeted = snapshot.state.artifacts.find(
    (a) => a.stepId === "targeted_verify",
  );
  expect(targeted).toBeDefined();
  expect(JSON.parse(targeted?.body ?? "")).toMatchObject({
    command: JSON.stringify(f.spec.targeted),
    exitCode: 0,
    stdout: "targeted verified",
    cwd: f.spec.worktreePath,
  });
  const scout = result.evidence.find((e) => e.stepId === "scout");
  const implemented = result.evidence.find((e) => e.stepId === "implement");
  expect(scout?.workspace.fingerprint).not.toBe(
    implemented?.workspace.fingerprint,
  );
  const review = result.evidence.find((e) => e.kind === "review");
  expect(review?.kind).toBe("review");
  if (review?.kind === "review") expect(review.reviewerId).not.toBe("forged");
  if (review?.kind === "review" && implemented?.kind === "artifact")
    expect(review.reviewerId).not.toBe(implemented.producerId);
  const reviewCalls = model.calls.filter((c) => c.step === "review");
  expect(reviewCalls).toHaveLength(2);
  expect(
    reviewCalls[0]?.context.messages.filter((m) => m.role === "assistant"),
  ).toHaveLength(0);
  expect(
    reviewCalls[1]?.context.messages.some((m) => m.role === "toolResult"),
  ).toBe(true);
  const calls = model.calls.length;
  expect((await runner.run()).status).toBe("completed");
  expect(model.calls).toHaveLength(calls);
  await runner.close();
  const reopened = await open(options);
  expect((await reopened.run()).status).toBe("completed");
  expect(model.calls).toHaveLength(calls);
  const implementCalls = model.calls.filter(
    (call) => call.step === "implement",
  ).length;
  const oldGates = result.evidence.filter(
    (e) => e.valid && (e.kind === "command" || e.kind === "review"),
  );
  await appendFile(
    join(f.spec.worktreePath, "sum.js"),
    "// harmless user edit requires fresh acceptance\n",
  );
  const refreshed = await reopened.run();
  expect(refreshed.status).toBe("completed");
  expect(model.calls.filter((call) => call.step === "implement")).toHaveLength(
    implementCalls,
  );
  expect(refreshed.workspace.fingerprint).not.toBe(
    result.workspace.fingerprint,
  );
  expect(refreshed.workspace).toEqual(
    await fingerprintWorkspace((await reopened.store.read()).state.workspace),
  );
  for (const old of oldGates)
    expect(refreshed.evidence.find((e) => e.id === old.id)?.valid).toBe(false);
  const freshGates = refreshed.evidence.filter(
    (e) => e.valid && (e.kind === "command" || e.kind === "review"),
  );
  expect(freshGates.map((e) => e.stepId)).toEqual([
    "targeted_verify",
    "review",
    "regression",
  ]);
  for (const evidence of freshGates)
    expect(evidence.workspace).toEqual(refreshed.workspace);
  const freshReview = freshGates.find((e) => e.kind === "review");
  if (freshReview?.kind !== "review" || review?.kind !== "review")
    throw new Error("Expected independent review evidence");
  expect(freshReview.reviewerId).not.toBe(review.reviewerId);
  for (const id of ["targeted_verify", "review", "regression", "deliver"]) {
    expect(refreshed.steps.find((step) => step.id === id)?.attempt).toBe(
      (result.steps.find((step) => step.id === id)?.attempt ?? 0) + 1,
    );
  }
});

test("a rejected review gets one bounded implementation rework", async () => {
  const f = await fixture();
  const model = featureModel({ reviewRejects: 1 });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const result = await runner.run();
  expect(result.status).toBe("completed");
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(2);
  expect(
    model.calls.filter((call) => call.step === "review" && !call.afterTool),
  ).toHaveLength(2);
  expect(result.evidence.filter((e) => e.kind === "review")).toHaveLength(2);
});

test("review rejection budget is durable and blocks repeated runs", async () => {
  const f = await fixture();
  const model = featureModel({ reviewRejects: 3 });
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  };
  const runner = await open(options);
  await expect(runner.run()).rejects.toThrow("Feature blocked");
  const calls = model.calls.length;
  const snapshot = await runner.store.read();
  expect(snapshot.state.reviewReworks).toBe(2);
  expect(snapshot.state.blockedReason).toContain("retry limit");
  expect(snapshot.run.status).toBe("blocked");
  await expect(runner.run()).rejects.toThrow("Feature blocked");
  expect(model.calls).toHaveLength(calls);
  await runner.close();
  const reopened = await open(options);
  await expect(reopened.run()).rejects.toThrow("Feature blocked");
  expect(model.calls).toHaveLength(calls);
});

test("malformed review blocks without opening implementation rework", async () => {
  const f = await fixture();
  const model = featureModel({ malformedReview: true });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  await expect(runner.run()).rejects.toThrow("Feature operation failed");
  const snapshot = await runner.store.read();
  expect(snapshot.state.reviewReworks).toBe(0);
  expect(snapshot.state.blockedReason).toContain("Operation failed");
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(1);
});

test("review rework invalidates old gates and only sends current verification artifact", async () => {
  const f = await fixture();
  const model = featureModel({
    reviewRejects: 1,
    implementationSources: [
      `${implementedSource}// first revision\n`,
      `${implementedSource}// second revision\n`,
    ],
  });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const result = await runner.run();
  expect(result.status).toBe("completed");
  const targeted = result.evidence.filter(
    (e) => e.stepId === "targeted_verify",
  );
  expect(targeted).toHaveLength(2);
  expect(targeted.filter((e) => e.valid)).toHaveLength(1);
  const reviewCalls = model.calls.filter(
    (call) => call.step === "review" && !call.afterTool,
  );
  expect(reviewCalls).toHaveLength(2);
  const secondPrompt = JSON.parse(
    reviewCalls[1]?.context.messages.find((m) => m.role === "user")
      ?.content as string,
  ) as { repositoryData: { verificationArtifacts: { id: string }[] } };
  expect(secondPrompt.repositoryData.verificationArtifacts).toHaveLength(1);
  expect(secondPrompt.repositoryData.verificationArtifacts[0]?.id).toBe(
    targeted.find((e) => e.valid)?.id,
  );
});

test("review rework budget survives a stage-boundary restart", async () => {
  const f = await fixture();
  const model = featureModel({ reviewRejects: 1 });
  let implementCompletions = 0;
  let pause = true;
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
    afterStepForTest: async (step: string) => {
      if (step === "implement") {
        implementCompletions += 1;
        if (pause && implementCompletions === 2) {
          pause = false;
          throw new Error("stage boundary pause");
        }
      }
    },
  };
  const runner = await open(options);
  await expect(runner.run()).rejects.toThrow("stage boundary pause");
  expect((await runner.store.read()).state.reviewReworks).toBe(1);
  await runner.close();
  const reopened = await open(options);
  const result = await reopened.run();
  expect(result.status).toBe("completed");
  expect((await reopened.store.read()).state.reviewReworks).toBe(1);
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(2);
});

test("restart after rejected review resumes the pending rework once", async () => {
  const f = await fixture();
  const model = featureModel({ reviewRejects: 1 });
  let pause = true;
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
    afterStepForTest: async (step: string) => {
      if (step === "review" && pause) {
        pause = false;
        throw new Error("review boundary pause");
      }
    },
  };
  const runner = await open(options);
  await expect(runner.run()).rejects.toThrow("review boundary pause");
  const snapshot = await runner.store.read();
  expect(snapshot.state.reviewReworks).toBe(1);
  expect(snapshot.state.operation).toBeNull();
  expect(
    snapshot.run.steps.find((step) => step.id === "implement")?.status,
  ).toBe("pending");
  await runner.close();
  const reopened = await open(options);
  expect((await reopened.run()).status).toBe("completed");
  expect((await reopened.store.read()).state.reviewReworks).toBe(1);
  expect(
    model.calls.filter((call) => call.step === "implement" && !call.afterTool),
  ).toHaveLength(2);
});

test("two runtime databases cannot acquire the same workspace writer", async () => {
  const f = await fixture();
  const model = featureModel();
  await open({ spec: f.spec, runtime: { ...model.runtime, dbPath: f.dbPath } });
  await expect(
    FeatureRunner.open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: join(f.root, "second.sqlite") },
    }),
  ).rejects.toThrow("owned");
});

test("a database under worktree/..cache is inside the worktree and rejected", async () => {
  const f = await fixture();
  const model = featureModel();
  await expect(
    FeatureRunner.open({
      spec: f.spec,
      runtime: {
        ...model.runtime,
        dbPath: join(f.spec.worktreePath, "..cache", "feature.sqlite"),
      },
    }),
  ).rejects.toThrow("outside its worktree");
  expect(model.calls).toHaveLength(0);
});

test("an external database symlink cannot bypass database path validation", async () => {
  const f = await fixture();
  const model = featureModel();
  const directory = join(f.root, "database");
  await mkdir(directory);
  const target = join(directory, "target.sqlite");
  const link = join(directory, "feature.sqlite");
  await writeFile(target, "");
  await symlink(target, link);
  await expect(
    FeatureRunner.open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: link },
    }),
  ).rejects.toThrow("symlink");
  expect(model.calls).toHaveLength(0);
});

test("an existing worktree binding refuses a database whose feature state was lost", async () => {
  const f = await fixture();
  const model = featureModel();
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  };
  const runner = await open(options);
  await runner.close();
  // Simulate missing state while preserving the stable ownership lease inode and Git binding.
  for (const suffix of [
    "",
    "-wal",
    "-shm",
    ".operations.sqlite",
    ".operations.sqlite-wal",
    ".operations.sqlite-shm",
  ])
    await rm(`${f.dbPath}${suffix}`, { force: true });
  await expect(FeatureRunner.open(options)).rejects.toThrow(
    "Bound Runtime has no feature state",
  );
  expect(model.calls).toHaveLength(0);
});

test.each([
  "command failure",
  "invalid review",
  "verification mutation",
] as const)("%s cannot produce delivery", async (failure) => {
  const f = await fixture();
  const model = featureModel({ invalidReview: failure === "invalid review" });
  if (failure === "command failure")
    f.spec.targeted = [
      process.execPath,
      "-e",
      "process.stderr.write('real failure');process.exit(9)",
    ];
  if (failure === "verification mutation")
    f.spec.targeted = [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync('sum.js','// verifier mutation\\n')",
    ];
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  await expect(runner.run()).rejects.toThrow();
  const snapshot = await runner.store.read();
  expect(snapshot.run.status).not.toBe("completed");
  expect(snapshot.state.blockedReason).toBeTruthy();
  expect(
    snapshot.run.evidence.some((e) => e.stepId === "deliver" && e.valid),
  ).toBe(false);
  if (failure === "command failure") {
    const evidence = snapshot.run.evidence.find((e) => e.kind === "command");
    expect(evidence).toMatchObject({ exitCode: 9, collector: "execution_env" });
    const artifact = snapshot.state.artifacts.find(
      (a) => a.stepId === "targeted_verify",
    );
    expect(JSON.parse(artifact?.body ?? "")).toMatchObject({
      exitCode: 9,
      stderr: "real failure",
    });
  }
});

test("cancellation joins an in-flight local model and persists a cancelled run", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const model = featureModel({ pauseStep: "scout", onCall: () => entered() });
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const pending = runner.run();
  const failed = expect(pending).rejects.toThrow();
  await started;
  await runner.cancel();
  await failed;
  const snapshot = await runner.store.read();
  expect(snapshot.run.status).toBe("cancelled");
  expect(snapshot.state.operation).toBeNull();
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    baselineSource,
  );
});

test("a stage boundary pause resumes after reopen without repeating completed stages", async () => {
  const f = await fixture();
  const model = featureModel();
  const options = {
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  };
  const pause = new Error("fixture stage pause");
  const runner = await open({
    ...options,
    afterStepForTest: async (step) => {
      if (step === "implement") throw pause;
    },
  });
  await expect(runner.run()).rejects.toThrow(pause);
  const partial = await runner.store.read();
  expect(partial.state.operation).toBeNull();
  expect(partial.state.blockedReason).toBeNull();
  expect(
    partial.run.steps.find((step) => step.id === "implement")?.status,
  ).toBe("completed");
  const implementCalls = model.calls.filter(
    (call) => call.step === "implement",
  ).length;
  await runner.close();
  const reopened = await open(options);
  expect((await reopened.run()).status).toBe("completed");
  expect(model.calls.filter((call) => call.step === "implement")).toHaveLength(
    implementCalls,
  );
});

test("a persisted implementation requires matching reconciliation before restart can deliver", async () => {
  const f = await fixture();
  const marker = join(f.root, "worker-ready");
  const configPath = join(f.root, "worker-config.json");
  await writeFile(configPath, JSON.stringify(f));
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./feature-worker.ts", import.meta.url)),
      configPath,
      "implement-write",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const ready = await waitForFile(marker, join(f.root, "worker-failed"));
    worker.kill("SIGKILL");
    await once(worker, "exit");
    const model = featureModel();
    const runner = await open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: f.dbPath },
    });
    const snapshot = await runner.store.inspect();
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error("Expected persisted feature snapshot");
    expect(snapshot.state.operation).toMatchObject({
      stepId: "implement",
    });
    expect(snapshot.state.operation?.conversationId).toBeTruthy();
    await expect(runner.run()).rejects.toThrow("Unknown feature operation");
    expect(model.calls).toHaveLength(0);
    const operation = snapshot.state.operation;
    if (!operation) throw new Error("Expected operation for reconciliation");
    const current = await fingerprintWorkspace(snapshot.state.workspace);
    await expect(
      runner.reconcile({
        operationId: "wrong-operation",
        expectedWorkspace: current,
        effectsReviewed: true,
      }),
    ).rejects.toThrow("Unknown feature operation");
    await expect(
      runner.reconcile({
        operationId: operation.id,
        expectedWorkspace: snapshot.run.workspace,
        effectsReviewed: true,
      }),
    ).rejects.toThrow("Expected workspace identity");
    await expect(
      runner.reconcile({
        operationId: operation.id,
        expectedWorkspace: current,
        effectsReviewed: true,
      }),
    ).resolves.toBeUndefined();
    const reconciled = await runner.store.read();
    expect(reconciled.state.operation).toBeNull();
    expect(reconciled.state.blockedReason).toBeNull();
    expect(reconciled.state.reconciliations).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    await runner.close();
    const resumed = await open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: f.dbPath },
    });
    expect((await resumed.store.read()).state.reconciliations).toHaveLength(1);
    const completed = await resumed.run();
    expect(completed.status).toBe("completed");
    expect(
      completed.evidence
        .filter((e) => e.valid && e.kind === "command")
        .map((e) => e.stepId),
    ).toEqual(["targeted_verify", "regression"]);
    expect(completed.evidence.some((e) => e.valid && e.kind === "review")).toBe(
      true,
    );
    expect(
      model.calls.filter(
        (call) => call.step === "implement" && !call.afterTool,
      ),
    ).toHaveLength(1);
    expect(ready).toBeTruthy();
  } finally {
    worker.kill("SIGKILL");
  }
});

async function waitForFile(path: string, failedPath: string): Promise<string> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value) return value;
    const failure = await readFile(failedPath, "utf8").catch(() => "");
    if (failure) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fixture never reached ${path}`);
}

test("cancellation stops a real verification command before its delayed side effect", async () => {
  const f = await fixture();
  const marker = join(f.root, "command-started");
  const late = join(f.root, "late-command-effect");
  f.spec.targeted = [
    process.execPath,
    "-e",
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'leaked'),800);setInterval(()=>{},1000)`,
  ];
  const model = featureModel();
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const pending = runner.run();
  const failed = expect(pending).rejects.toThrow();
  await waitForFile(marker, join(f.root, "absent-failure-marker"));
  await runner.cancel();
  await failed;
  const snapshot = await runner.store.read();
  expect(snapshot.run.status).toBe("cancelled");
  expect(snapshot.state.operation).toMatchObject({ stepId: "targeted_verify" });
  expect(snapshot.state.blockedReason).toMatch(/reconciliation/);
  expect(
    snapshot.run.evidence.some((e) => e.stepId === "deliver" && e.valid),
  ).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await expect(readFile(late)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancellation preserves verification intent when a command already had side effects", async () => {
  const f = await fixture();
  const marker = join(f.root, "command-started");
  const attempts = join(f.root, "command-attempts");
  f.spec.targeted = [
    process.execPath,
    "-e",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(attempts)},'once\\n');fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`,
  ];
  const model = featureModel();
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const pending = runner.run();
  const failed = expect(pending).rejects.toThrow();
  await waitForFile(marker, join(f.root, "absent-failure-marker"));
  await runner.cancel();
  await failed;
  const snapshot = await runner.store.read();
  expect(snapshot.state.operation).toMatchObject({ stepId: "targeted_verify" });
  expect(snapshot.state.blockedReason).toMatch(/reconciliation/);
  expect(snapshot.run.status).toBe("cancelled");
  expect(await readFile(attempts, "utf8")).toBe("once\n");
  await runner.close();

  const reopened = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  await expect(reopened.run()).rejects.toThrow("Unknown feature operation");
  await expect(
    reopened.reconcile({
      operationId: snapshot.state.operation?.id as string,
      expectedWorkspace: await fingerprintWorkspace(snapshot.state.workspace),
      effectsReviewed: true,
    }),
  ).rejects.toThrow("Cancelled Run");
  const after = await reopened.store.read();
  expect(after.state.operation).toEqual(snapshot.state.operation);
  expect(after.state.blockedReason).toBe(snapshot.state.blockedReason);
  expect(await readFile(attempts, "utf8")).toBe("once\n");
});

test.each(["implement-write", "command-effect"] as const)(
  "SIGKILL after %s preserves unknown intent and restart does not replay",
  async (mode) => {
    const f = await fixture();
    const marker = join(f.root, "worker-ready");
    const attempts = join(f.root, "command-attempts");
    if (mode === "command-effect")
      f.spec.targeted = [
        process.execPath,
        "-e",
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(attempts)},'once\\n');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)}else{require('node:assert/strict').equal(require('./sum.js')(2,3),5)}`,
      ];
    const configPath = join(f.root, "worker-config.json");
    await writeFile(configPath, JSON.stringify(f));
    const worker = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./feature-worker.ts", import.meta.url)),
        configPath,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(worker, "exit");
    let commandPid: number | undefined;
    let stderr = "";
    worker.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      const ready = await waitForFile(
        marker,
        join(f.root, "worker-failed"),
      ).catch((error) => {
        throw new Error(`${String(error)}; worker stderr: ${stderr}`);
      });
      if (mode === "command-effect") commandPid = Number(ready);
      expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
        implementedSource,
      );
      worker.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      const model = featureModel();
      if (commandPid) process.kill(commandPid, 0);
      await expect(
        FeatureRunner.open({
          spec: f.spec,
          runtime: {
            ...model.runtime,
            dbPath: join(f.root, "evade-unknown-intent.sqlite"),
          },
        }),
      ).rejects.toThrow("bound");
      expect(model.calls).toHaveLength(0);
      // SIGKILL cannot run parent cleanup. Stop this deliberately orphaned fixture command.
      if (commandPid) {
        process.kill(commandPid, "SIGKILL");
        commandPid = undefined;
      }
      const runner = await open({
        spec: f.spec,
        runtime: { ...model.runtime, dbPath: f.dbPath },
      });
      const before = await runner.store.read();
      expect(before.state.operation?.stepId).toBe(
        mode === "implement-write" ? "implement" : "targeted_verify",
      );
      await expect(runner.run()).rejects.toThrow("Unknown feature operation");
      await expect(runner.cancel()).rejects.toThrow("reconciliation");
      expect(model.calls).toHaveLength(0);
      const after = await runner.store.read();
      expect(after.state.operation).toEqual(before.state.operation);
      expect(after.run.status).not.toBe("completed");
      if (mode === "command-effect") {
        expect(await readFile(attempts, "utf8")).toBe("once\n");
        await runner.reconcile({
          operationId: before.state.operation?.id as string,
          expectedWorkspace: await fingerprintWorkspace(before.state.workspace),
          effectsReviewed: true,
        });
        expect(model.calls).toHaveLength(0);
        expect(await readFile(attempts, "utf8")).toBe("once\n");
        await runner.close();
        const resumed = await open({
          spec: f.spec,
          runtime: { ...model.runtime, dbPath: f.dbPath },
        });
        const completed = await resumed.run();
        expect(completed.status).toBe("completed");
        expect(await readFile(attempts, "utf8")).toBe("once\nonce\n");
        expect(model.calls.some((call) => call.step === "implement")).toBe(
          false,
        );
        expect(
          completed.evidence.filter((e) => e.valid).map((e) => e.stepId),
        ).toEqual(
          expect.arrayContaining([
            "targeted_verify",
            "review",
            "regression",
            "deliver",
          ]),
        );
      }
    } finally {
      worker.kill("SIGKILL");
      await exited;
      if (commandPid) {
        try {
          process.kill(commandPid, "SIGKILL");
        } catch {}
      }
    }
  },
);

test("reconciliation fences concurrent controls and releases its gate after journal rejection", async () => {
  const f = await fixture();
  const model = featureModel();
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  const snapshot = await runner.store.read();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(runner.runtime, "recoveryStatus").mockImplementationOnce(
    async () => {
      await gate;
      return { pendingOperationIds: ["pending-shell"] };
    },
  );
  const options = {
    operationId: "not-an-operation",
    expectedWorkspace: snapshot.run.workspace,
    effectsReviewed: true,
  };
  const pending = runner.reconcile(options);
  const failed = expect(pending).rejects.toThrow("journal is pending");
  try {
    await expect(runner.run()).rejects.toThrow("stopping");
    await expect(runner.cancel()).rejects.toThrow(
      "reconciliation is in progress",
    );
    await expect(runner.close()).rejects.toThrow(
      "reconciliation is in progress",
    );
    await expect(runner.reconcile(options)).rejects.toThrow(
      "already in progress",
    );
    expect(model.calls).toHaveLength(0);
  } finally {
    release();
    await failed;
  }
  await expect(runner.reconcile(options)).rejects.toThrow(
    "Unknown feature operation",
  );
  expect((await runner.store.read()).state.reconciliations).toEqual([]);
  await runner.close();
});

test("close synchronously fences new runs while runtime teardown is pending", async () => {
  const f = await fixture();
  const model = featureModel();
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = runner.runtime.close.bind(runner.runtime);
  vi.spyOn(runner.runtime, "close").mockImplementationOnce(async () => {
    await gate;
    await original();
  });
  const closing = runner.close();
  try {
    await expect(runner.run()).rejects.toThrow("stopping");
    expect(model.calls).toHaveLength(0);
  } finally {
    release();
    await closing;
  }
});

test("failed runner close retains ownership, fences work, and permits teardown retry", async () => {
  const f = await fixture();
  const model = featureModel();
  const runner = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  vi.spyOn(runner.runtime, "close").mockRejectedValueOnce(
    new Error("fixture teardown failure"),
  );
  await expect(runner.close()).rejects.toThrow("fixture teardown failure");
  await expect(runner.run()).rejects.toThrow("stopping");
  await expect(
    FeatureRunner.open({
      spec: f.spec,
      runtime: { ...model.runtime, dbPath: join(f.root, "other.sqlite") },
    }),
  ).rejects.toThrow("owned");
  await runner.close();
  const reopened = await open({
    spec: f.spec,
    runtime: { ...model.runtime, dbPath: f.dbPath },
  });
  expect((await reopened.store.read()).state.operation).toBeNull();
  expect(model.calls).toHaveLength(0);
});
