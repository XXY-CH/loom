import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, expect, test } from "vitest";
import { inspectBudget, ModelBudget } from "../src/runtime/budget.js";
import { RuntimeSession } from "../src/runtime/session.js";

async function ledgerDirectory(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  directories.push(cwd);
  const runtimePath = join(cwd, "agent.sqlite");
  return { cwd, runtimePath, ledger: `${runtimePath}.budget.sqlite` };
}

function reportedMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const directories: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  budget: { maxCalls: number; maxTokens: number },
  toolLoop = false,
) {
  const cwd = await mkdtemp(join(tmpdir(), "loom-budget-"));
  directories.push(cwd);
  const model: Model<"openai-completions"> = {
    id: "fixture",
    name: "fixture",
    api: "openai-completions",
    provider: "fixture",
    baseUrl: "http://invalid.test",
    input: ["text"],
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let calls = 0;
  const models = createModels();
  const streamResponse = () => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 1,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    if (toolLoop && calls === 1) {
      message.content = [
        {
          type: "toolCall",
          id: "read-one",
          name: "read",
          arguments: { path: "missing.txt" },
        },
      ];
      message.stopReason = "toolUse";
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    return stream;
  };
  models.setProvider(
    createProvider({
      id: "fixture",
      models: [model],
      auth: {
        apiKey: {
          name: "fixture",
          resolve: async () => ({ auth: { apiKey: "fixture" } }),
        },
      },
      api: { stream: streamResponse, streamSimple: streamResponse },
    }),
  );
  const options = {
    cwd,
    dbPath: join(cwd, "runtime.sqlite"),
    models,
    model: { provider: model.provider, modelId: model.id },
    connectionIdentity: "fixture",
    featureWorkspace: true,
    budget,
  };
  const open = async () => {
    const session = await RuntimeSession.open(options);
    sessions.push(session);
    return session;
  };
  return { options, open, calls: () => calls };
}
test("model call budget aggregates root and isolated workers and survives reopen", async () => {
  const f = await fixture({ maxCalls: 2, maxTokens: 100 });
  const first = await f.open();
  await (await first.submit({ content: "root", requestId: "root" })).wait(
    BACKGROUND_CONTEXT,
  );
  const worker = await first.createWorker("implementer");
  await first.runWorker(
    worker,
    "worker",
    "worker",
    new AbortController().signal,
  );
  expect((await first.budgetSummary())?.calls).toBe(2);
  await first.close();
  const reopened = await f.open();
  const input = await reopened.submit({
    content: "blocked",
    requestId: "blocked",
  });
  expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
  expect(f.calls()).toBe(2);
});
test("token budget includes cached tokens and stops the next dispatch", async () => {
  const f = await fixture({ maxCalls: 10, maxTokens: 9 });
  const session = await f.open();
  await (await session.submit({ content: "first", requestId: "first" })).wait(
    BACKGROUND_CONTEXT,
  );
  expect((await session.budgetSummary())?.tokens).toBe(10);
  const input = await session.submit({
    content: "blocked",
    requestId: "blocked",
  });
  expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
  expect(f.calls()).toBe(1);
});
test("unknown in-flight reservations survive reopen and cannot be reset by changing limits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-budget-ledger-"));
  directories.push(cwd);
  const path = join(cwd, "budget.sqlite");
  const limits = { maxCalls: 3, maxTokens: 100 };
  const first = new ModelBudget(path, limits);
  first.reserve();
  first.close();
  const reopened = new ModelBudget(path, limits);
  expect(reopened.summary()?.pending).toBe(1);
  expect(() => reopened.reserve()).toThrow(/unsettled/i);
  reopened.close();
  expect(() => new ModelBudget(path, { maxCalls: 4, maxTokens: 100 })).toThrow(
    /configuration/i,
  );
});

test("omitting limits preserves configured budget and live reservations block overlapping calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-budget-ledger-"));
  directories.push(cwd);
  const path = join(cwd, "budget.sqlite");
  const first = new ModelBudget(path, { maxCalls: 2, maxTokens: 20 });
  first.reserve();
  expect(() => first.reserve()).toThrow(/unsettled/i);
  expect(first.summary()?.calls).toBe(1);
  first.close();
  const reopened = new ModelBudget(path);
  expect(reopened.summary()?.limits).toEqual({ maxCalls: 2, maxTokens: 20 });
  expect(() => reopened.reserve()).toThrow(/unsettled/i);
  reopened.close();
});

test("every generation inside the same worker tool loop consumes a call", async () => {
  const f = await fixture({ maxCalls: 1, maxTokens: 100 }, true);
  const session = await f.open();
  const worker = await session.createWorker("implementer");
  await expect(
    session.runWorker(
      worker,
      "read and answer",
      "tool-loop",
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.calls()).toBe(1);
  expect((await session.budgetSummary())?.calls).toBe(1);
  expect((await session.budgetSummary())?.pending).toBe(0);
});
test("completeSimple compaction path shares the same call gate and accounts tokens", async () => {
  const f = await fixture({ maxCalls: 1, maxTokens: 100 });
  const budget = new ModelBudget(
    `${f.options.dbPath}.budget.sqlite`,
    f.options.budget,
  );
  const models = budget.wrap(f.options.models);
  const model = f.options.models.getModel("fixture", "fixture");
  if (!model) throw new Error("missing fixture model");
  await models.completeSimple(model, { messages: [] });
  expect(budget.summary()).toMatchObject({ calls: 1, tokens: 10, pending: 0 });
  expect(() => models.completeSimple(model, { messages: [] })).toThrow(
    /exhausted/i,
  );
  expect(f.calls()).toBe(1);
  budget.close();
});
test("offline budget inspection is read-only and does not create absent ledgers", async () => {
  const f = await fixture({ maxCalls: 1, maxTokens: 100 });
  expect(inspectBudget(f.options.dbPath)).toBeNull();
  expect(existsSync(`${f.options.dbPath}.budget.sqlite`)).toBe(false);
  const session = await f.open();
  await (await session.submit({ content: "one", requestId: "one" })).wait(
    BACKGROUND_CONTEXT,
  );
  await session.close();
  const before = await readFile(`${f.options.dbPath}.budget.sqlite`);
  expect(inspectBudget(f.options.dbPath)).toMatchObject({
    calls: 1,
    tokens: 10,
    pending: 0,
  });
  expect(await readFile(`${f.options.dbPath}.budget.sqlite`)).toEqual(before);
});

test("a rejected stream result preserves the unknown reservation without detached rejection", async () => {
  const f = await fixture({ maxCalls: 2, maxTokens: 100 });
  const budget = new ModelBudget(
    `${f.options.dbPath}.budget.sqlite`,
    f.options.budget,
  );
  f.options.models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    stream.result = () => Promise.reject(new Error("fixture transport failed"));
    return stream;
  };
  const model = f.options.models.getModel("fixture", "fixture");
  if (!model) throw new Error("missing fixture model");
  const models = budget.wrap(f.options.models);
  await expect(
    models.streamSimple(model, { messages: [] }).result(),
  ).rejects.toThrow("fixture transport failed");
  expect(budget.summary()).toMatchObject({ calls: 1, tokens: 0, pending: 1 });
  expect(() => models.streamSimple(model, { messages: [] })).toThrow(
    /unsettled/i,
  );
  budget.close();
});

test("explicit reconciliation unblocks dispatch without fabricating tokens and survives reopen", async () => {
  const { runtimePath, ledger } = await ledgerDirectory("loom-budget-unlock-");
  const limits = { maxCalls: 3, maxTokens: 100 };
  const budget = new ModelBudget(ledger, limits);
  const unsettled = budget.reserve();
  expect(budget.summary()).toMatchObject({
    calls: 1,
    tokens: 0,
    pending: 1,
    reconciled: 0,
  });
  expect(() => budget.reserve()).toThrow(/unsettled/i);
  budget.reconcile();
  expect(budget.summary()).toMatchObject({
    calls: 1,
    tokens: 0,
    pending: 0,
    reconciled: 1,
  });
  // A late settle for a reconciled row must not fabricate its token count.
  budget.settle(unsettled, reportedMessage());
  expect(budget.summary()).toMatchObject({
    calls: 1,
    tokens: 0,
    pending: 0,
    reconciled: 1,
  });
  const settled = budget.reserve();
  budget.settle(settled, reportedMessage());
  expect(budget.summary()).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 0,
    reconciled: 1,
  });
  budget.close();
  const reopened = new ModelBudget(ledger, limits);
  expect(reopened.summary()).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 0,
    reconciled: 1,
  });
  reopened.close();
  expect(inspectBudget(runtimePath)).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 0,
    reconciled: 1,
  });
});

test("reconciling a ledger without unsettled calls fails explicitly", async () => {
  const { ledger } = await ledgerDirectory("loom-budget-noop-");
  const budget = new ModelBudget(ledger, { maxCalls: 2, maxTokens: 100 });
  expect(() => budget.reconcile()).toThrow(/no unsettled/i);
  const settled = budget.reserve();
  budget.settle(settled, reportedMessage());
  expect(() => budget.reconcile()).toThrow(/no unsettled/i);
  expect(budget.summary()).toMatchObject({ pending: 0, reconciled: 0 });
  budget.close();
});

test("legacy ledgers without the reconciliation marker stay read-compatible and migrate on reopen", async () => {
  const { runtimePath, ledger } = await ledgerDirectory("loom-budget-legacy-");
  const limits = { maxCalls: 3, maxTokens: 100 };
  const legacy = new DatabaseSync(ledger);
  legacy.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE configuration (id INTEGER PRIMARY KEY CHECK(id=1), limits TEXT NOT NULL);
    CREATE TABLE calls (id INTEGER PRIMARY KEY, tokens INTEGER);`);
  legacy
    .prepare("INSERT INTO configuration VALUES(1, ?)")
    .run(JSON.stringify(limits));
  legacy.prepare("INSERT INTO calls(id, tokens) VALUES(1, NULL)").run();
  legacy.prepare("INSERT INTO calls(id, tokens) VALUES(2, 10)").run();
  legacy.close();
  // The read-only projection tolerates the old schema without writing it.
  const before = await readFile(ledger);
  expect(inspectBudget(runtimePath)).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 1,
    reconciled: 0,
  });
  expect(await readFile(ledger)).toEqual(before);
  // Reopening through the writer migrates the marker, then reconciliation
  // clears exactly the legacy unsettled row.
  const migrated = new ModelBudget(ledger, limits);
  expect(migrated.summary()).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 1,
    reconciled: 0,
  });
  migrated.reconcile();
  expect(migrated.summary()).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 0,
    reconciled: 1,
  });
  migrated.close();
  expect(inspectBudget(runtimePath)).toMatchObject({
    calls: 2,
    tokens: 10,
    pending: 0,
    reconciled: 1,
  });
});
