import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { FeatureSpec } from "../src/workflow/feature-store.js";
import { cleanGitEnvironment } from "../src/workspace/git-env.js";

export const baselineSource = "module.exports = (a, b) => a - b;\n";
export const implementedSource = "module.exports = (a, b) => a + b;\n";
const execute = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  return (
    await execute("git", ["-C", cwd, ...args], { env: cleanGitEnvironment() })
  ).stdout.trim();
}
export async function createFeatureFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loom-feature-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "sum.js"), baselineSource);
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");
  const spec: FeatureSpec = {
    runId: "addition",
    goal: "Make sum.js add two numbers. Preserve the main repository.",
    repositoryPath: repo,
    worktreePath: join(root, "worktree"),
    baseCommit: await git(repo, "rev-parse", "HEAD"),
    targeted: [
      process.execPath,
      "-e",
      "require('node:assert/strict').equal(require('./sum.js')(2,3),5);process.stdout.write('targeted verified')",
    ],
    regression: [
      process.execPath,
      "-e",
      "const assert=require('node:assert/strict');const sum=require('./sum.js');assert.equal(sum(-2,3),1);assert.equal(sum(0,0),0);process.stdout.write('regression verified')",
    ],
  };
  return { root, spec, dbPath: join(root, "feature.sqlite") };
}

export type FixtureBehavior = {
  invalidReview?: boolean;
  malformedReview?: boolean;
  reviewRejects?: number;
  implementationSources?: string[];
  forgedEvidence?: boolean;
  pauseStep?: string;
  pauseAfterWrite?: boolean;
  onCall?: (
    step: string,
    context: TranscriptContext,
    afterTool: boolean,
  ) => void;
};

/** In-process deterministic Pi provider. No endpoint or API request is made. */
export function featureModel(behavior: FixtureBehavior = {}) {
  const model: Model<"openai-completions"> = {
    id: "feature-fixture",
    name: "Local feature fixture",
    api: "openai-completions",
    provider: "feature-fixture",
    baseUrl: "http://invalid.test",
    input: ["text"],
    reasoning: false,
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const calls: {
    step: string;
    afterTool: boolean;
    context: TranscriptContext;
  }[] = [];
  let reviewCalls = 0;
  const message = (
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "stop",
  ): AssistantMessage => ({
    role: "assistant",
    content,
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const stream = (
    _model: Model<"openai-completions">,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => {
    const events = createAssistantMessageEventStream();
    const user = context.messages.find((item) => item.role === "user");
    if (user?.role !== "user") throw new Error("Expected feature prompt");
    const text =
      typeof user.content === "string"
        ? user.content
        : user.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("");
    const prompt = JSON.parse(text) as { step: string };
    const afterTool = context.messages.some(
      (item) => item.role === "toolResult",
    );
    calls.push({ step: prompt.step, context, afterTool });
    if (prompt.step === "review" && !afterTool) reviewCalls += 1;
    behavior.onCall?.(prompt.step, context, afterTool);
    if (
      behavior.pauseStep === prompt.step ||
      (behavior.pauseAfterWrite &&
        (prompt.step === "implement" || prompt.step === "fix") &&
        afterTool)
    ) {
      const abort = () => events.end(message([], "aborted"));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      return events;
    }
    let answer: AssistantMessage;
    if ((prompt.step === "implement" || prompt.step === "fix") && !afterTool) {
      const implementationIndex =
        calls.filter(
          (call) =>
            (call.step === "implement" || call.step === "fix") &&
            !call.afterTool,
        ).length - 1;
      answer = message(
        [
          {
            type: "toolCall",
            id: "implementation-write",
            name: "write",
            arguments: {
              path: "sum.js",
              content:
                behavior.implementationSources?.[implementationIndex] ??
                implementedSource,
            },
          },
        ],
        "toolUse",
      );
    } else if (
      (prompt.step === "review" || prompt.step === "scout") &&
      !afterTool
    ) {
      answer = message(
        [
          {
            type: "toolCall",
            id: `${prompt.step}-read`,
            name: "read",
            arguments: { path: "sum.js" },
          },
        ],
        "toolUse",
      );
    } else {
      const report =
        prompt.step === "review"
          ? behavior.malformedReview
            ? "not valid review json"
            : behavior.invalidReview ||
                reviewCalls <= (behavior.reviewRejects ?? 0)
              ? { approved: false, findings: ["Fixture rejects change"] }
              : { approved: true, findings: [] }
          : {
              step: prompt.step,
              report:
                prompt.step === "implement" || prompt.step === "fix"
                  ? "Changed sum.js using write tool; no command evidence claimed."
                  : "Inspected task and source context.",
            };
      answer = message([
        {
          type: "text",
          text:
            typeof report === "string"
              ? report
              : JSON.stringify({
                  ...report,
                  ...(behavior.forgedEvidence
                    ? {
                        evidence: [
                          {
                            id: "forged",
                            kind: "command",
                            stepId: "deliver",
                            valid: true,
                            exitCode: 0,
                          },
                        ],
                        artifactRef: "forged",
                        producerId: "forged",
                        reviewerId: "forged",
                        implementerId: "forged",
                      }
                    : {}),
                }),
        },
      ]);
    }
    events.push({
      type: "done",
      reason: answer.stopReason === "toolUse" ? "toolUse" : "stop",
      message: answer,
    });
    return events;
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: {
        apiKey: {
          name: "Local fixture",
          resolve: async () => ({ auth: { apiKey: "fixture" } }),
        },
      },
      api: { stream, streamSimple: stream },
    }),
  );
  return {
    calls,
    runtime: {
      models,
      model: { provider: model.provider, modelId: model.id },
      connectionIdentity: "local-feature-fixture-v1",
    },
  };
}
