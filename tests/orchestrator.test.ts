import type {
  SettledSubmissionRecord,
  Submission,
} from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { InteractionController } from "../src/orchestrator/controller.js";
import type { RuntimeSession } from "../src/runtime/session.js";
import {
  createWorkflowRun,
  transitionWorkflow,
  workflowTemplate,
} from "../src/workflow/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function handle(id: string) {
  const settled = deferred<SettledSubmissionRecord>();
  const submission = {
    id,
    wait: vi.fn(() => settled.promise),
  } as unknown as Submission;
  return { submission, settled };
}
function fixture() {
  const handles: ReturnType<typeof handle>[] = [];
  const runtime = {
    submit: vi.fn(async () => {
      const next = handle(`submission-${handles.length}`);
      handles.push(next);
      return next.submission;
    }),
    submissionCounts: vi.fn(async () => ({
      queued: 1,
      placed: 2,
      done: 3,
      unanswered: 4,
    })),
    recoveryStatus: vi.fn(async () => ({
      pendingOperationIds: [] as string[],
    })),
    resume: vi.fn(),
    cancel: vi.fn(async () => {}),
    workflowStatus: vi.fn<RuntimeSession["workflowStatus"]>(async () => null),
  };
  const changed = vi.fn();
  const controller = new InteractionController(runtime, changed);
  return { runtime, controller, handles, changed };
}
const done = { status: "done" } as SettledSubmissionRecord;

test("serializes admissions in invocation order while the first settlement is pending", async () => {
  const { runtime, controller, handles } = fixture();
  const admission = deferred<Submission>();
  const first = handle("first");
  runtime.submit.mockImplementationOnce(() => admission.promise);
  const a = controller.send("one", "a");
  const b = controller.send("two", "b");
  await Promise.resolve();
  expect(runtime.submit).toHaveBeenCalledTimes(1);
  admission.resolve(first.submission);
  await Promise.all([a, b]);
  expect(runtime.submit.mock.calls).toEqual([
    [{ content: "one", requestId: "a" }],
    [{ content: "two", requestId: "b" }],
  ]);
  expect(controller.pendingCount).toBe(2);
  first.settled.resolve(done);
  handles[0]?.settled.resolve(done);
  await expect.poll(() => controller.pendingCount).toBe(0);
  expect(
    controller.items.every((item) => item.label === "Submission done"),
  ).toBe(true);
});

test("failed admission rejects safely and does not poison same-ID retry", async () => {
  const { runtime, controller } = fixture();
  runtime.submit.mockRejectedValueOnce(new Error("api_key=credential-value"));
  await expect(controller.send("draft", "retry-id")).rejects.toThrow(
    "admission failed",
  );
  expect(controller.pendingCount).toBe(0);
  await controller.send("draft", "retry-id");
  expect(runtime.submit).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(controller.items)).not.toContain("credential-value");
});

test("commands use runtime control and workflow reads without model submissions", async () => {
  const { runtime, controller } = fixture();
  await controller.send("/workflow");
  expect(controller.items.at(-1)?.detail).toContain("No workflow Run");
  const run = transitionWorkflow(
    transitionWorkflow(
      createWorkflowRun({
        id: "real-run",
        goal: "test",
        template: workflowTemplate("feature"),
        workspace: {
          workspaceId: "workspace",
          head: "head",
          fingerprint: "fingerprint",
        },
      }),
      { type: "start", stepId: "scout" },
    ),
    {
      type: "request_input",
      stepId: "scout",
      question: "Which target? token=private-token",
    },
  );
  runtime.workflowStatus.mockResolvedValue(run);
  for (const command of ["/help", "/status", "/workflow", "/resume", "/cancel"])
    await controller.send(command);
  expect(runtime.submit).not.toHaveBeenCalled();
  expect(runtime.resume).toHaveBeenCalledOnce();
  expect(runtime.cancel).toHaveBeenCalledOnce();
  expect(
    controller.items.some((item) =>
      item.detail.includes("scout: waiting_input"),
    ),
  ).toBe(true);
  expect(JSON.stringify(controller.items)).not.toContain("private-token");
  await expect(controller.send("/unknown")).rejects.toThrow("Unknown command");
  await expect(controller.send("   ")).rejects.toThrow("blank");
  await controller.send("//status", "literal");
  expect(runtime.submit).toHaveBeenCalledWith({
    content: "/status",
    requestId: "literal",
  });
});

test("bounds outstanding admission and redacted activity; handles wait failures and detach", async () => {
  const { controller, runtime, handles, changed } = fixture();
  const sends = Array.from({ length: 16 }, (_, i) =>
    controller.send(`token=private-value ${"x".repeat(4000)}`, `id-${i}`),
  );
  await expect(controller.send("overflow")).rejects.toThrow("16 requests");
  await Promise.all(sends);
  expect(runtime.submit).toHaveBeenCalledTimes(16);
  expect(
    controller.items.every(
      (item) => item.label.length <= 100 && item.detail.length <= 2000,
    ),
  ).toBe(true);
  expect(JSON.stringify(controller.items)).not.toContain("private-value");
  controller.dispose();
  changed.mockClear();
  handles[0]?.settled.reject(new Error("password=private-error"));
  for (const next of handles.slice(1)) next.settled.resolve(done);
  await expect.poll(() => controller.pendingCount).toBe(0);
  expect(changed).not.toHaveBeenCalled();
  expect(runtime.cancel).not.toHaveBeenCalled();
  expect(controller.items[0]?.label).toBe("Settlement observation unavailable");
  expect(JSON.stringify(controller.items)).not.toContain("private-error");
});

test("retains at most 100 activity items and sanitizes command failures", async () => {
  const { runtime, controller } = fixture();
  for (let index = 0; index < 110; index++) await controller.send("/help");
  expect(controller.items).toHaveLength(100);
  runtime.cancel.mockRejectedValueOnce(new Error("Cookie=private-cookie"));
  await expect(controller.send("/cancel")).rejects.toThrow(
    "Control command failed",
  );
  expect(JSON.stringify(controller.items)).not.toContain("private-cookie");
});

test("cancel fences slow admission and discards queued input before returning", async () => {
  const { runtime, controller, handles } = fixture();
  const slow = deferred<Submission>();
  const first = handle("slow");
  const order: string[] = [];
  runtime.submit.mockImplementationOnce(async () => {
    order.push("submit:start");
    const result = await slow.promise;
    order.push("submit:admitted");
    return result;
  });
  runtime.cancel.mockImplementation(async () => {
    order.push("cancel:return");
  });
  const a = controller
    .send("one", "one")
    .catch((error: Error) => error.message);
  const b = controller
    .send("two", "two")
    .catch((error: Error) => error.message);
  await Promise.resolve();
  const cancelled = controller.send("/cancel");
  let returned = false;
  void cancelled.then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(runtime.cancel).not.toHaveBeenCalled();
  await expect(controller.send("during", "during")).rejects.toThrow(
    "Cancellation",
  );
  await expect(controller.send("/resume")).rejects.toThrow();
  slow.resolve(first.submission);
  await cancelled;
  expect(await a).toContain("cancelled");
  expect(await b).toContain("cancelled");
  expect(order).toEqual(["submit:start", "submit:admitted", "cancel:return"]);
  expect(runtime.submit).toHaveBeenCalledTimes(1);
  expect(controller.pendingCount).toBe(0);
  // A late observer cannot decrement a cancelled request twice.
  first.settled.resolve(done);
  await controller.send("new", "new-id");
  expect(runtime.submit).toHaveBeenLastCalledWith({
    content: "new",
    requestId: "new-id",
  });
  handles.at(-1)?.settled.resolve(done);
  await expect.poll(() => controller.pendingCount).toBe(0);
});

test("cancel timeout is bounded and stays fenced until an explicit successful cancel", async () => {
  vi.useFakeTimers();
  try {
    const { runtime, controller } = fixture();
    const slow = deferred<Submission>();
    const late = handle("late");
    runtime.submit.mockImplementationOnce(() => slow.promise);
    const sending = controller
      .send("old", "stable-id")
      .catch((error: Error) => error.message);
    await Promise.resolve();
    const cancelling = controller
      .send("/cancel")
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await cancelling).toContain("failed");
    expect(await sending).toContain("cancelled");
    expect(controller.pendingCount).toBe(0);
    await expect(controller.send("blocked")).rejects.toThrow("Cancellation");
    await expect(controller.send("/resume")).rejects.toThrow();
    const retry = controller
      .send("/cancel")
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await retry).toContain("failed");
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(controller.pendingCount).toBe(0);
    slow.resolve(late.submission);
    await controller.send("/cancel");
    await controller.send("old", "stable-id");
    expect(runtime.submit).toHaveBeenLastCalledWith({
      content: "old",
      requestId: "stable-id",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("failed cancellation and failed admission neither leak pending nor silently reopen the fence", async () => {
  const { runtime, controller, handles } = fixture();
  await controller.send("admitted", "admitted");
  runtime.cancel.mockRejectedValueOnce(new Error("private failure"));
  await expect(controller.send("/cancel")).rejects.toThrow("failed");
  expect(controller.pendingCount).toBe(0);
  await expect(controller.send("new")).rejects.toThrow("Cancellation");
  handles[0]?.settled.resolve(done);
  await controller.send("/cancel");
  expect(controller.pendingCount).toBe(0);
  const slow = deferred<Submission>();
  runtime.submit.mockImplementationOnce(() => slow.promise);
  const a = controller
    .send("failing", "retry-id")
    .catch((error: Error) => error.message);
  await Promise.resolve();
  const cancelled = controller.send("/cancel");
  slow.reject(new Error("admission failed"));
  await cancelled;
  expect(await a).toContain("cancelled");
  expect(controller.pendingCount).toBe(0);
  await controller.send("failing", "retry-id");
  expect(runtime.submit).toHaveBeenLastCalledWith({
    content: "failing",
    requestId: "retry-id",
  });
  handles.at(-1)?.settled.resolve(done);
  await expect.poll(() => controller.pendingCount).toBe(0);
});

test("concurrent cancels share bounded runtime cancellation and late completion requires explicit confirmation", async () => {
  vi.useFakeTimers();
  try {
    const { runtime, controller } = fixture();
    const slowCancel = deferred<void>();
    runtime.cancel.mockImplementationOnce(() => slowCancel.promise);
    const a = controller.send("/cancel").catch((e: Error) => e.message);
    const b = controller.send("/cancel").catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await a).toContain("failed");
    expect(await b).toContain("failed");
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    slowCancel.resolve();
    await Promise.resolve();
    await expect(controller.send("not yet")).rejects.toThrow("Cancellation");
    await controller.send("/cancel");
    await controller.send("new", "after-cancel");
    expect(runtime.submit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("one retry recovers a cancellation that rejected after its deadline", async () => {
  vi.useFakeTimers();
  try {
    const { runtime, controller } = fixture();
    const late = deferred<void>();
    runtime.cancel.mockImplementationOnce(() => late.promise);
    const first = controller.send("/cancel").catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await first).toContain("failed");
    late.reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    await controller.send("/cancel");
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    await controller.send("fresh", "fresh");
    expect(controller.pendingCount).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
