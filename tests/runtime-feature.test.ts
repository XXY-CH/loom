import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  AgentDoc,
  type ConversationId,
  type Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeSession } from "../src/runtime/session.js";
import { FeatureRunner } from "../src/workflow/feature.js";
import { createFeatureFixture, featureModel } from "./feature-fixture.js";

const dirs: string[] = [];
const sessions: RuntimeSession[] = [];
const featureRunners: FeatureRunner[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(featureRunners.splice(0).map((runner) => runner.close()));
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const model: Model<"openai-completions"> = {
  id: "feature-fixture",
  name: "Feature Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://invalid.test",
  input: ["text"],
  reasoning: true,
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function answer(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
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
  };
}
const text = (value = '{"result":"ok"}') =>
  answer([{ type: "text", text: value }]);
async function fixture(
  respond: (
    context: TranscriptContext,
    call: number,
  ) => AssistantMessage | undefined,
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "loom-feature-runtime-")),
  );
  dirs.push(base);
  const cwd = join(base, "workspace");
  await mkdir(cwd);
  const calls: {
    model: string;
    context: TranscriptContext;
    options: StreamOptions | undefined;
  }[] = [];
  let aborts = 0;
  const stream = (
    selected: Model<"openai-completions">,
    context: TranscriptContext,
    options?: StreamOptions,
  ) => {
    calls.push({ model: selected.id, context, options });
    const events = createAssistantMessageEventStream();
    const response = respond(context, calls.length);
    if (!response) {
      const abort = () => {
        aborts++;
        events.end(answer([], "aborted"));
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    } else
      events.push({
        type: "done",
        reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
        message: response,
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
  const options = {
    cwd,
    dbPath: join(base, "runtime.sqlite"),
    models,
    model: { provider: "fixture", modelId: model.id },
    connectionIdentity: "feature-fixture",
    featureWorkspace: true,
  };
  const open = async () => {
    const session = await RuntimeSession.open(options);
    sessions.push(session);
    return session;
  };
  return { base, cwd, options, calls, aborts: () => aborts, open };
}
const id = (value: string) => Number(value) as ConversationId;

test("Pi cache identity and request prefix survive reopen without sharing worker sessions", async () => {
  const f = await fixture(() => text());
  const session = await f.open();
  await (
    await session.submit({ content: "stable task", requestId: "first" })
  ).wait(BACKGROUND_CONTEXT);
  const first = f.calls[0];
  expect(first?.options?.sessionId).toBeTruthy();
  await session.close();
  const reopened = await f.open();
  await (
    await reopened.submit({ content: "follow up", requestId: "second" })
  ).wait(BACKGROUND_CONTEXT);
  const second = f.calls[1];
  expect(second?.options?.sessionId).toBe(first?.options?.sessionId);
  expect(
    second?.context.messages.slice(0, first?.context.messages.length),
  ).toEqual(first?.context.messages);
  for (const role of ["scout", "reviewer"] as const) {
    const worker = await reopened.createWorker(role);
    await reopened.runWorker(
      worker,
      "isolated task",
      role,
      new AbortController().signal,
    );
  }
  expect(new Set(f.calls.map((call) => call.options?.sessionId)).size).toBe(3);
  expect(
    f.calls
      .slice(2)
      .every(
        (call) =>
          !JSON.stringify(call.context.messages).includes("stable task"),
      ),
  ).toBe(true);
  // Do not opt into longer paid retention or override provider defaults.
  expect(
    f.calls.every((call) => call.options?.cacheRetention === undefined),
  ).toBe(true);
  const expectedUsage = {
    input: 4,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    cacheReadPromptRatio: 0,
  };
  expect((await reopened.usageSummary()).total).toEqual(expectedUsage);
  await reopened.close();
  const afterWorkers = await f.open();
  expect((await afterWorkers.usageSummary()).total).toEqual(expectedUsage);
});

test("cancel invalidates a worker admitted before its conversation lookup completes", async () => {
  const f = await fixture(() => text());
  const session = await f.open();
  const worker = await session.createWorker("reviewer");
  const harness = (session as unknown as { harness: Harness }).harness;
  const lookup = harness.conversation.bind(harness);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args) => {
    entered = true;
    await gate;
    return lookup(...args);
  });
  const outcome = session
    .runWorker(
      worker,
      "must not start",
      "stale-admission",
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  await expect.poll(() => entered).toBe(true);
  await session.cancel();
  release();
  expect(await outcome).toBeInstanceOf(Error);
  expect(f.calls).toHaveLength(0);
});

test("cancel joins an in-flight durable worker submit before aborting it", async () => {
  const f = await fixture(() => undefined);
  const session = await f.open();
  const worker = await session.createWorker("implementer");
  const harness = (session as unknown as { harness: Harness }).harness;
  const conversation = await harness.conversation(
    id(worker),
    BACKGROUND_CONTEXT,
  );
  if (!conversation) throw new Error("Missing fixture worker");
  const submit = conversation.submit.bind(conversation);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  vi.spyOn(conversation, "submit").mockImplementationOnce(async (...args) => {
    entered = true;
    await gate;
    return submit(...args);
  });
  vi.spyOn(harness, "conversation").mockResolvedValue(conversation);
  const outcome = session
    .runWorker(
      worker,
      "pending submit",
      "pending",
      new AbortController().signal,
    )
    .catch((error: unknown) => error);
  await expect.poll(() => entered).toBe(true);
  let cancelled = false;
  const cancellation = session.cancel().then(() => {
    cancelled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(cancelled).toBe(false);
  release();
  await cancellation;
  expect(await outcome).toBeInstanceOf(Error);
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  expect(inspection.tasks).toHaveLength(0);
  expect(
    inspection.submissions.filter(
      (submission) => submission.status === "queued",
    ),
  ).toHaveLength(0);
});

test("concurrent calls cannot both submit to the same worker", async () => {
  const f = await fixture(() => undefined);
  const session = await f.open();
  const worker = await session.createWorker("scout");
  const outcomes = ["first", "second"].map((requestId) =>
    session
      .runWorker(worker, requestId, requestId, new AbortController().signal)
      .catch((error: unknown) => error),
  );
  await expect.poll(() => f.calls.length).toBe(1);
  await session.cancel();
  const results = await Promise.all(outcomes);
  expect(results.every((result) => result instanceof Error)).toBe(true);
  expect(
    results.some(
      (result) =>
        result instanceof Error &&
        result.message === "Worker is already running",
    ),
  ).toBe(true);
  expect(f.calls).toHaveLength(1);
});

test("a stalled admission times out cancellation, keeps the barrier, and permits cancellation retry after late settlement", async () => {
  const f = await fixture(() => undefined);
  const session = await f.open();
  const worker = await session.createWorker("implementer");
  const harness = (session as unknown as { harness: Harness }).harness;
  const conversation = await harness.conversation(
    id(worker),
    BACKGROUND_CONTEXT,
  );
  if (!conversation) throw new Error("Missing fixture worker");
  const submit = conversation.submit.bind(conversation);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  vi.spyOn(conversation, "submit").mockImplementationOnce(async (...args) => {
    entered = true;
    await gate;
    return submit(...args);
  });
  vi.spyOn(harness, "conversation").mockResolvedValue(conversation);
  const outcome = session
    .runWorker(worker, "late submit", "late", new AbortController().signal)
    .catch((error: unknown) => error);
  await expect.poll(() => entered).toBe(true);
  await expect(session.cancel()).rejects.toThrow(
    "did not settle within 2000ms",
  );
  await expect(session.createWorker("reviewer")).rejects.toThrow("stopping");
  expect(() =>
    session.submit({ content: "blocked", requestId: "blocked" }),
  ).toThrow("stopping");
  release();
  expect(await outcome).toBeInstanceOf(Error);
  await session.cancel();
  expect(await session.createWorker("reviewer")).toMatch(/^\d+$/);
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  expect(inspection.tasks).toHaveLength(0);
});

test("creates empty ownerless workers, keeps the configured model and thinking, and limits each role's tools", async () => {
  const f = await fixture(() => text());
  const session = await f.open();
  await session.documentSession().commit(async (tx) => {
    (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).thinkingLevel = "medium";
  }, BACKGROUND_CONTEXT);
  const root = await session.submit({
    content: "private root context",
    requestId: "root",
  });
  await root.wait(BACKGROUND_CONTEXT);
  const implementer = await session.createWorker("implementer");
  const reviewer = await session.createWorker("reviewer");
  expect(implementer).not.toBe(reviewer);
  const workerAgent = await session
    .documentSession()
    .snapshot(AgentDoc, id(implementer), BACKGROUND_CONTEXT);
  expect(workerAgent).toMatchObject({
    cwd: f.cwd,
    model: f.options.model,
    thinkingLevel: "medium",
    tools: ["read", "write", "edit"],
  });
  const reviewAgent = await session
    .documentSession()
    .snapshot(AgentDoc, id(reviewer), BACKGROUND_CONTEXT);
  expect(reviewAgent?.tools).toEqual(["read"]);
  expect(reviewAgent?.instructions).toContain('"approved":boolean');
  const workerAnswer = await session.runWorker(
    implementer,
    "implement only",
    "implement",
    new AbortController().signal,
  );
  expect(workerAnswer).toBe('{"result":"ok"}');
  await session.runWorker(
    reviewer,
    "review only",
    "review",
    new AbortController().signal,
  );
  expect(JSON.stringify(f.calls[1]?.context.messages)).not.toContain(
    "private root context",
  );
  expect(JSON.stringify(f.calls[2]?.context.messages)).not.toContain(
    "implement only",
  );
  expect(f.calls.map((call) => call.model)).toEqual([
    model.id,
    model.id,
    model.id,
  ]);
  const offered = (context: TranscriptContext | undefined) =>
    context?.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );
  expect(offered(f.calls[1]?.context)).toEqual(["read", "write", "edit"]);
  expect(offered(f.calls[2]?.context)).toEqual(["read"]);
  expect(
    (await session.entries()).filter((entry) => entry.kind === "pi.user"),
  ).toHaveLength(1);
  expect(await session.workflowStore().read()).toBeNull();
});

test("real Pi file tools permit workspace edits and reject escape, .git and symlink writes and shell", async () => {
  const targets = [
    "inside.txt",
    "../outside.txt",
    ".git/config",
    "linked/stolen.txt",
  ];
  const f = await fixture((_context, call) =>
    call === 1
      ? answer(
          [
            ...targets.map((path, index) => ({
              type: "toolCall" as const,
              id: `write-${index}`,
              name: "write",
              arguments: { path, content: "changed" },
            })),
            {
              type: "toolCall",
              id: "shell",
              name: "bash",
              arguments: { command: "touch shell-ran" },
            },
          ],
          "toolUse",
        )
      : text(),
  );
  await mkdir(join(f.cwd, ".git"));
  await writeFile(join(f.cwd, ".git/config"), "original");
  await symlink(f.base, join(f.cwd, "linked"));
  const session = await f.open();
  await session.runWorker(
    await session.createWorker("implementer"),
    "write",
    "write",
    new AbortController().signal,
  );
  expect(await readFile(join(f.cwd, "inside.txt"), "utf8")).toBe("changed");
  expect(await readFile(join(f.cwd, ".git/config"), "utf8")).toBe("original");
  for (const path of [
    join(f.base, "outside.txt"),
    join(f.base, "stolen.txt"),
    join(f.cwd, "shell-ran"),
  ])
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    f.calls[1]?.context.messages.filter(
      (message) => message.role === "toolResult" && message.isError,
    ),
  ).toHaveLength(4);
});

test("a reviewer cannot execute a write even if the provider emits an unadvertised call", async () => {
  const f = await fixture((_context, call) =>
    call === 1
      ? answer(
          [
            {
              type: "toolCall",
              id: "forbidden-write",
              name: "write",
              arguments: { path: "reviewer.txt", content: "forbidden" },
            },
          ],
          "toolUse",
        )
      : text('{"approved":false,"findings":["write rejected"]}'),
  );
  const session = await f.open();
  const result = await session.runWorker(
    await session.createWorker("reviewer"),
    "review",
    "review",
    new AbortController().signal,
  );
  expect(JSON.parse(result)).toMatchObject({ approved: false });
  await expect(readFile(join(f.cwd, "reviewer.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    f.calls[1]?.context.messages.some(
      (message) => message.role === "toolResult" && message.isError,
    ),
  ).toBe(true);
});

test.each(["signal", "cancel"] as const)(
  "%s aborts actual worker generation and permits a fresh worker",
  async (operation) => {
    const f = await fixture((_context, call) =>
      call === 1 ? undefined : text(),
    );
    const session = await f.open();
    const controller = new AbortController();
    const result = session
      .runWorker(
        await session.createWorker("scout"),
        "wait",
        "wait",
        controller.signal,
      )
      .catch((error: unknown) => error);
    await expect.poll(() => f.calls.length).toBe(1);
    if (operation === "signal") controller.abort(new Error("fixture timeout"));
    else await session.cancel();
    expect(await result).toBeInstanceOf(Error);
    expect(f.aborts()).toBe(1);
    await session.runWorker(
      await session.createWorker("reviewer"),
      "fresh",
      "fresh",
      new AbortController().signal,
    );
    expect(f.calls).toHaveLength(2);
  },
);

test("root cancellation joins every running feature worker", async () => {
  const f = await fixture(() => undefined);
  const session = await f.open();
  const workers = await Promise.all([
    session.createWorker("implementer"),
    session.createWorker("reviewer"),
  ]);
  const outcomes = workers.map((worker, index) =>
    session
      .runWorker(
        worker,
        `task ${index}`,
        `task-${index}`,
        new AbortController().signal,
      )
      .catch((error: unknown) => error),
  );
  await expect.poll(() => f.calls.length).toBe(2);
  await session.cancel();
  expect(
    (await Promise.all(outcomes)).every((result) => result instanceof Error),
  ).toBe(true);
  expect(f.aborts()).toBe(2);
});

test("reopen seals feature mode and cancels persisted unknown workers before any new submit resumes Pi", async () => {
  const f = await fixture((_context, call) => (call <= 2 ? undefined : text()));
  const first = await f.open();
  const stale = await first.createWorker("implementer");
  const interrupted = first
    .runWorker(stale, "old unknown", "old", new AbortController().signal)
    .catch(() => undefined);
  const other = first
    .runWorker(
      await first.createWorker("reviewer"),
      "other unknown",
      "other",
      new AbortController().signal,
    )
    .catch(() => undefined);
  await expect.poll(() => f.calls.length).toBe(2);
  await first.close();
  await interrupted;
  await other;
  await expect(
    RuntimeSession.open({ ...f.options, featureWorkspace: false }),
  ).rejects.toThrow("feature workspace mode");
  const reopened = await f.open();
  expect(f.calls).toHaveLength(2);
  await expect(
    reopened.runWorker(
      stale,
      "old unknown",
      "old",
      new AbortController().signal,
    ),
  ).rejects.toThrow("freshly created");
  // Root submit also enables global scheduling. Old feature tasks must already carry abort intent.
  const root = await reopened.submit({
    content: "new root",
    requestId: "new-root",
  });
  await root.wait(BACKGROUND_CONTEXT);
  expect(f.calls).toHaveLength(3);
  expect(JSON.stringify(f.calls[2]?.context.messages)).not.toContain(
    "old unknown",
  );
  await reopened.abortWorkers();
  expect(f.calls).toHaveLength(3);
});

test("inspection-only reopen skips worker recovery abort and fences controls", async () => {
  const f = await fixture(() => undefined);
  const first = await f.open();
  const worker = await first.createWorker("implementer");
  const pending = first
    .runWorker(
      worker,
      "still unknown",
      "inspection-check",
      new AbortController().signal,
    )
    .catch(() => undefined);
  await expect.poll(() => f.calls.length).toBe(1);
  await first.close();
  await pending;
  const abortsBeforeInspection = f.aborts();

  const inspected = await RuntimeSession.open({
    ...f.options,
    inspectOnly: true,
  });
  sessions.push(inspected);
  expect(f.aborts()).toBe(abortsBeforeInspection);
  await expect(inspected.cancel()).rejects.toThrow("inspection only");
  expect(() => inspected.abortWorkers()).toThrow("inspection only");
  await expect(inspected.acknowledgeRecovery([])).rejects.toThrow(
    "inspection only",
  );
  expect(() => inspected.resume()).toThrow("inspection only");
  expect(() => inspected.documentSession()).toThrow("inspection only");
  await inspected.close();
  expect(f.aborts()).toBe(abortsBeforeInspection);
});

test("read-only feature inspection does not mutate persisted Pi tasks or documents", async () => {
  const f = await createFeatureFixture();
  dirs.push(f.root);
  const runner = await FeatureRunner.open({
    spec: f.spec,
    runtime: {
      ...featureModel({ pauseStep: "implement" }).runtime,
      dbPath: f.dbPath,
    },
  });
  featureRunners.push(runner);
  const worker = await runner.runtime.createWorker("implementer");
  const pending = runner.runtime
    .runWorker(
      worker,
      JSON.stringify({ step: "implement" }),
      "read-only-feature-inspection",
      new AbortController().signal,
    )
    .catch(() => undefined);
  await expect
    .poll(() => {
      const database = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        return Number(
          (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'",
              )
              .get() as { count: number }
          ).count,
        );
      } finally {
        database.close();
      }
    })
    .toBeGreaterThan(0);
  await runner.runtime.close();
  await pending;
  const persistedRunning = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    expect(
      (
        persistedRunning
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'",
          )
          .get() as { count: number }
      ).count,
    ).toBeGreaterThan(0);
  } finally {
    persistedRunning.close();
  }

  const readSnapshot = () => {
    const database = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      const tasks = database
        .prepare("SELECT id, record FROM tasks ORDER BY id")
        .all();
      const documents = database
        .prepare("SELECT id, record FROM documents ORDER BY id")
        .all();
      const revisions = database
        .prepare(
          "SELECT document_id, seq, kind, version, content FROM document_revisions ORDER BY document_id, seq",
        )
        .all();
      const metadata = database
        .prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1")
        .get();
      return JSON.stringify({ tasks, documents, revisions, metadata });
    } finally {
      database.close();
    }
  };
  const before = readSnapshot();
  const feature = await import("../src/workflow/feature-store.js");
  const database = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    const inspected = feature.FeatureStore.inspectDatabase(database);
    expect(inspected?.run.id).toBe(f.spec.runId);
    expect(inspected?.state.spec.goal).toBe(f.spec.goal);
  } finally {
    database.close();
  }
  expect(readSnapshot()).toBe(before);
});
