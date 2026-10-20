import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, expect, test, vi } from "vitest";
import { InteractionController } from "../src/orchestrator/controller.js";
import { ManagedExecutionEnv } from "../src/runtime/managed-env.js";
import { OperationJournal } from "../src/runtime/recovery.js";
import { RuntimeSession } from "../src/runtime/session.js";

const dirs: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

function message(
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

async function setup(respond: (calls: number) => AssistantMessage | undefined) {
  const cwd = await mkdtemp(join(tmpdir(), "loom-runtime-"));
  dirs.push(cwd);
  let calls = 0;
  const stream = (
    _model: Model<"openai-completions">,
    _context: TranscriptContext,
    options?: StreamOptions,
  ) => {
    const events = createAssistantMessageEventStream();
    const answer = respond(++calls);
    if (!answer) {
      const abort = () => events.end(message([], "aborted"));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      return events;
    }
    if (answer.stopReason === "error") {
      events.push({ type: "error", reason: "error", error: answer });
      return events;
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
    dbPath: join(cwd, "agent.sqlite"),
    models,
    model: { provider: "fixture", modelId: "fixture" },
    connectionIdentity: "fixture-v1",
  };
  const open = async () => {
    const session = await RuntimeSession.open(options);
    sessions.push(session);
    return session;
  };
  return { cwd, options, open, calls: () => calls };
}

test.each(["cleanup", "checkpoint"] as const)(
  "retries failed %s on close while retaining ownership and stopping execution",
  async (failure) => {
    const fixture = await setup(() =>
      message([{ type: "text", text: "done" }]),
    );
    const session = await fixture.open();
    const submission = await session.submit({
      content: "hello",
      requestId: "before-close",
    });
    await submission.wait(BACKGROUND_CONTEXT);
    const fault = new Error(`injected ${failure} failure`);
    const injected =
      failure === "cleanup"
        ? vi
            .spyOn(ManagedExecutionEnv.prototype, "cleanup")
            .mockRejectedValueOnce(fault)
        : vi
            .spyOn(OperationJournal.prototype, "checkpoint")
            .mockImplementationOnce(() => {
              throw fault;
            });
    await expect(session.close()).rejects.toThrow(fault);
    injected.mockRestore();
    await expect(RuntimeSession.open(fixture.options)).rejects.toThrow("owned");
    expect(() => session.resume()).toThrow("Runtime is stopping");
    expect(() =>
      session.submit({ content: "blocked", requestId: "blocked" }),
    ).toThrow("Runtime is stopping");
    await expect(session.acknowledgeRecovery([])).rejects.toThrow(
      "Runtime must be idle",
    );
    await expect(session.cancel()).rejects.toThrow("Runtime is stopping");
    await session.close();
    await session.close();
    const reopened = await fixture.open();
    expect((await reopened.submissionCounts()).done).toBe(1);
    expect(fixture.calls()).toBe(1);
  },
);

test("persists a response and deduplicates requestId across reopen", async () => {
  const fixture = await setup(() =>
    message([{ type: "text", text: "fixture answer" }]),
  );
  const first = await fixture.open();
  const submission = await first.submit({ content: "hello", requestId: "one" });
  expect(await first.answer(await submission.wait(BACKGROUND_CONTEXT))).toBe(
    "fixture answer",
  );
  await first.close();
  const reopened = await fixture.open();
  const repeated = await reopened.submit({
    content: "hello",
    requestId: "one",
  });
  expect(repeated.id).toBe(submission.id);
  expect((await repeated.wait(BACKGROUND_CONTEXT)).status).toBe("done");
  expect(fixture.calls()).toBe(1);
  expect(
    (await reopened.entries()).filter((entry) => entry.kind === "pi.user"),
  ).toHaveLength(1);
});

test("executes a real CodingTools write against the selected cwd", async () => {
  const fixture = await setup((calls) =>
    calls === 1
      ? message(
          [
            {
              type: "toolCall",
              id: "write-one",
              name: "write",
              arguments: { path: "result.txt", content: "written by fixture" },
            },
          ],
          "toolUse",
        )
      : message([{ type: "text", text: "written" }]),
  );
  const session = await fixture.open();
  const observed: string[] = [];
  const events = await session.watchEvents();
  events.start(async (batch) => {
    for (const event of batch) observed.push(event.type);
  });
  const submission = await session.submit({
    content: "write",
    requestId: "write",
  });
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
  expect(await readFile(join(fixture.cwd, "result.txt"), "utf8")).toBe(
    "written by fixture",
  );
  await expect.poll(() => observed).toContain("tool_execution_end");
  expect(observed).toContain("tool_execution_start");
  await events.stop();
  expect(
    (await session.entries()).some((entry) => entry.kind === "pi.tool-result"),
  ).toBe(true);
});

test("rejects a changed connection and releases ownership after failed open", async () => {
  const fixture = await setup(() => message([{ type: "text", text: "ok" }]));
  const first = await fixture.open();
  await first.close();
  await expect(
    RuntimeSession.open({ ...fixture.options, connectionIdentity: "other" }),
  ).rejects.toThrow("connection differs");
  const reopened = await fixture.open();
  await expect(RuntimeSession.open(fixture.options)).rejects.toMatchObject({
    code: "DATABASE_IN_USE",
  });
  await reopened.close();
});

test("close/reopen resumes an interrupted generation without duplicating input", async () => {
  const fixture = await setup((calls) =>
    calls === 1 ? undefined : message([{ type: "text", text: "recovered" }]),
  );
  const first = await fixture.open();
  const submission = await first.submit({
    content: "recover",
    requestId: "recover",
  });
  await expect.poll(fixture.calls).toBe(1);
  await first.close();
  const reopened = await fixture.open();
  reopened.resume();
  await reopened.waitUntilIdle();
  const repeated = await reopened.submit({
    content: "recover",
    requestId: "recover",
  });
  expect(repeated.id).toBe(submission.id);
  expect(await reopened.answer(await repeated.wait(BACKGROUND_CONTEXT))).toBe(
    "recovered",
  );
  expect(
    (await reopened.entries()).filter((entry) => entry.kind === "pi.user"),
  ).toHaveLength(1);
});

test("cancel aborts work and settles its submission", async () => {
  const fixture = await setup(() => undefined);
  const session = await fixture.open();
  const submission = await session.submit({
    content: "cancel",
    requestId: "cancel",
  });
  await expect.poll(fixture.calls).toBe(1);
  await session.cancel();
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
});

test("provider failure settles unanswered with retry disabled", async () => {
  const fixture = await setup(() => ({
    ...message([], "error"),
    errorMessage: "fixture provider unavailable",
  }));
  const session = await fixture.open();
  const submission = await session.submit({
    content: "failure",
    requestId: "failure",
  });
  expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
  expect(fixture.calls()).toBe(1);
});

test("SIGKILL blocks progression until explicit reconciliation, then does not replay bash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-crash-"));
  dirs.push(cwd);
  const worker = fileURLToPath(new URL("./runtime-worker.ts", import.meta.url));
  const start = spawn(
    process.execPath,
    ["--import", "tsx", worker, cwd, "settle"],
    { stdio: "ignore" },
  );
  const killed = once(start, "exit");
  try {
    await expect
      .poll(
        async () => readFile(join(cwd, "settled"), "utf8").catch(() => ""),
        { timeout: 5000 },
      )
      .toBe("ready");
    start.kill("SIGKILL");
    await killed;
    const fixture = await setup(() =>
      message([{ type: "text", text: "unused" }]),
    );
    const blocked = await RuntimeSession.open({
      ...fixture.options,
      cwd,
      dbPath: join(cwd, "agent.sqlite"),
    });
    sessions.push(blocked);
    const recovery = await blocked.recoveryStatus();
    expect(recovery.pendingOperationIds).toHaveLength(1);
    expect(() =>
      blocked.submit({ content: "blocked", requestId: "blocked" }),
    ).toThrow("explicit reconciliation");
    expect(() => blocked.resume()).toThrow("explicit reconciliation");
    await expect(blocked.acknowledgeRecovery([])).rejects.toThrow("exactly");
    // Observe the orphan's final delayed side effect before acknowledging it is reconciled.
    await expect
      .poll(async () =>
        readFile(join(cwd, "late-side-effect"), "utf8").catch(() => ""),
      )
      .toBe("late");
    await blocked.acknowledgeRecovery(recovery.pendingOperationIds);
    await blocked.close();
    const recover = spawn(
      process.execPath,
      ["--import", "tsx", worker, cwd, "recover"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    recover.stderr.on("data", (data: Buffer) => {
      errors += data.toString();
    });
    const exited = once(recover, "exit");
    const timeout = setTimeout(() => recover.kill("SIGKILL"), 5000);
    try {
      const [code] = await exited;
      expect(code, errors).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
    expect(await readFile(join(cwd, "executions"), "utf8")).toBe("x");
    const inspected = await RuntimeSession.open({
      ...fixture.options,
      cwd,
      dbPath: join(cwd, "agent.sqlite"),
    });
    sessions.push(inspected);
    const toolResult = (await inspected.entries()).find(
      (entry) => entry.kind === "pi.tool-result",
    );
    expect(
      toolResult?.model?.some(
        (item) => item.role === "toolResult" && item.isError,
      ),
    ).toBe(true);
  } finally {
    if (start.exitCode === null && start.signalCode === null) {
      start.kill("SIGKILL");
      await killed;
    }
  }
}, 15000);

test.each(["close", "cancel"] as const)(
  "%s stops owned bash before releasing runtime ownership",
  async (operation) => {
    const fixture = await setup((calls) =>
      calls === 1
        ? message(
            [
              {
                type: "toolCall",
                id: "cleanup-shell",
                name: "bash",
                arguments: {
                  command:
                    "printf ready > started; sleep 0.5; printf late > unwanted-side-effect",
                },
              },
            ],
            "toolUse",
          )
        : message([{ type: "text", text: "done" }]),
    );
    const session = await fixture.open();
    await session.submit({ content: "cleanup", requestId: "cleanup" });
    await expect
      .poll(async () =>
        readFile(join(fixture.cwd, "started"), "utf8").catch(() => ""),
      )
      .toBe("ready");
    await session[operation]();
    if (operation === "cancel") await session.close();
    const reopened = await fixture.open();
    expect((await reopened.recoveryStatus()).pendingOperationIds).toHaveLength(
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expect(
      readFile(join(fixture.cwd, "unwanted-side-effect"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("host cancellation withdraws real Pi queued input and allows a fresh request", async () => {
  const fixture = await setup((calls) =>
    calls === 1 ? undefined : message([{ type: "text", text: "fresh answer" }]),
  );
  const session = await fixture.open();
  const controller = new InteractionController(session, () => {});
  try {
    await controller.send("first", "cancel-first");
    await expect.poll(() => fixture.calls()).toBe(1);
    await controller.send("queued", "cancel-queued");
    await controller.send("/cancel");
    expect(controller.pendingCount).toBe(0);
    const counts = await session.submissionCounts();
    expect(counts.queued + counts.placed).toBe(0);
    expect(counts.unanswered).toBe(2);
    expect(fixture.calls()).toBe(1);
    await controller.send("fresh", "fresh-id");
    await expect.poll(() => controller.pendingCount).toBe(0);
    expect((await session.submissionCounts()).done).toBe(1);
    // Retrying a cancelled ID preserves Pi idempotency instead of executing it again.
    await controller.send("first", "cancel-first");
    await expect.poll(() => controller.pendingCount).toBe(0);
    expect(fixture.calls()).toBe(2);
  } finally {
    controller.dispose();
  }
});
