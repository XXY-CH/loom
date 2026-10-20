import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { RuntimeSession } from "../src/runtime/session.js";

const cwd = process.argv[2];
const mode = process.argv[3];
if (!cwd) throw new Error("Expected fixture workspace");
const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://invalid.test",
  input: ["text"],
  reasoning: false,
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let calls = 0;
const stream = () => {
  const events = createAssistantMessageEventStream();
  const tool = (mode === "start" || mode === "settle") && calls++ === 0;
  const answer: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: tool
      ? [
          {
            type: "toolCall",
            id: "shell-one",
            name: "bash",
            arguments: {
              command:
                "printf x >> executions; printf ready > started; sleep 0.5; printf late > late-side-effect",
            },
          },
        ]
      : [{ type: "text", text: "recovered without shell replay" }],
    stopReason: tool ? "toolUse" : "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  events.push({
    type: "done",
    reason: tool ? "toolUse" : "stop",
    message: answer,
  });
  return events;
};
const models = createModels();
models.setProvider(
  createProvider({
    id: "fixture",
    models: [model],
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => ({ auth: { apiKey: "fixture" } }),
      },
    },
    api: { stream, streamSimple: stream },
  }),
);
const session = await RuntimeSession.open({
  cwd,
  dbPath: join(cwd, "agent.sqlite"),
  models,
  model: { provider: "fixture", modelId: "fixture" },
  connectionIdentity: "fixture-v1",
  ...(mode === "settle"
    ? {
        afterOperationSettledForTest: async () => {
          await writeFile(join(cwd, "settled"), "ready");
          await new Promise<void>(() => {});
        },
      }
    : {}),
});
try {
  const submission = await session.submit({
    content: "shell fixture",
    requestId: "shell-fixture",
  });
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done")
    throw new Error(`Unsettled fixture: ${settled.status}`);
} finally {
  await session.close();
}
