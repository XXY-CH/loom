import { expect, test, vi } from "vitest";
import { superviseFeatureObserver } from "../src/cli/feature-observer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("observer failure during a running feature requests cancellation", async () => {
  const observer = deferred<void>();
  const feature = deferred<void>();
  const cancel = vi.fn(() => feature.resolve());
  const close = vi.fn();
  const supervised = superviseFeatureObserver(
    () => feature.promise,
    observer.promise,
    cancel,
    close,
  );
  observer.reject(new Error("observer startup failed"));
  await expect(supervised).rejects.toThrow("observer startup failed");
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test("observer teardown failure after completion does not cancel the feature", async () => {
  const observer = deferred<void>();
  const cancel = vi.fn();
  let featureActive = true;
  const interrupt = () => {
    if (featureActive) cancel();
  };
  const teardownError = new Error("observer teardown failed");
  await expect(
    superviseFeatureObserver(
      async () => {
        featureActive = false;
      },
      observer.promise,
      interrupt,
      () => {
        interrupt();
        observer.reject(teardownError);
      },
    ),
  ).rejects.toBe(teardownError);
  expect(cancel).not.toHaveBeenCalled();
});
