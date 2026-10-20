import { rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { FeatureRunner } from "../src/workflow/feature.js";
import { createFeatureFixture, featureModel } from "./feature-fixture.js";

test("feature requests share stable goal and policy prefixes while reviewer stays isolated", async () => {
  const fixture = await createFeatureFixture();
  const model = featureModel();
  let runner: FeatureRunner | undefined;
  try {
    runner = await FeatureRunner.open({
      spec: fixture.spec,
      runtime: { ...model.runtime, dbPath: fixture.dbPath },
    });
    expect((await runner.run()).status).toBe("completed");
    const firstCalls = model.calls.filter((call) => !call.afterTool);
    const prompts = firstCalls.map((call) => {
      const user = call.context.messages.find((entry) => entry.role === "user");
      if (user?.role !== "user" || typeof user.content !== "string")
        throw new Error("Expected fixture user prompt");
      return user.content;
    });
    const goalPrefix = `${JSON.stringify({ goal: fixture.spec.goal }).slice(0, -1)},`;
    expect(prompts.every((prompt) => prompt.startsWith(goalPrefix))).toBe(true);
    const policies = prompts.map((prompt) => JSON.parse(prompt).instruction);
    expect(new Set(policies).size).toBe(1);
    expect(
      prompts.every(
        (prompt) =>
          prompt.indexOf('"workspace":') > prompt.indexOf('"repositoryData":'),
      ),
    ).toBe(true);
    const review = firstCalls.find((call) => call.step === "review");
    expect(review).toBeDefined();
    expect(
      review?.context.messages.filter((entry) => entry.role === "user"),
    ).toHaveLength(1);
    expect(
      review?.context.messages.some((entry) => entry.role === "assistant"),
    ).toBe(false);
    const reviewPrompt = prompts
      .map((prompt) => JSON.parse(prompt))
      .find((prompt) => prompt.step === "review");
    expect(
      reviewPrompt.repositoryData.priorArtifacts.every(
        (artifact: { stepId: string }) => artifact.stepId !== "implement",
      ),
    ).toBe(true);
    expect(reviewPrompt.repositoryData.verificationEvidence).toHaveLength(1);
  } finally {
    await runner?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 20000);
