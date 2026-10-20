import { describe, expect, it } from "vitest";
import { DashboardComposer } from "../src/tui/controller.js";
import type { DashboardState } from "../src/tui/types.js";

function state(): DashboardState {
  return {
    cwd: "/runtime",
    refreshing: false,
    selectedWorktree: 0,
    selectedFile: 0,
    focus: "activity",
    scroll: 0,
    diff: "",
    activity: [],
    runtimeStatus: "running",
  };
}

describe("dashboard input admission", () => {
  it("locks a draft until durable admission and ignores duplicate Enter and Escape", async () => {
    const view = state();
    let admit: (() => void) | undefined;
    const sent: string[] = [];
    const composer = new DashboardComposer(
      view,
      (content) => {
        sent.push(content);
        return new Promise<void>((resolve) => {
          admit = resolve;
        });
      },
      () => {},
    );
    composer.open();
    composer.key("first input", {});
    composer.key("", { name: "return" });
    composer.key("", { name: "return" });
    composer.key("", { name: "escape" });
    composer.key("overwrite", {});
    expect(sent).toEqual(["first input"]);
    expect(view.input).toBe("first input");
    expect(view.inputAdmitting).toBe(true);
    admit?.();
    await Promise.resolve();
    expect(view.input).toBeUndefined();
    expect(view.inputAdmitting).toBe(false);
    composer.open();
    composer.key("next input while running", {});
    expect(view.runtimeStatus).toBe("running");
    expect(view.input).toBe("next input while running");
  });

  it("retains rejected input for retry and allows normal discard afterwards", async () => {
    const view = state();
    const requestIds: (string | undefined)[] = [];
    const composer = new DashboardComposer(
      view,
      async (_content, requestId) => {
        requestIds.push(requestId);
        throw new Error("durable admission rejected");
      },
      () => {},
    );
    composer.open();
    composer.key("keep my draft", {});
    composer.key("", { name: "return" });
    await Promise.resolve();
    expect(view.input).toBe("keep my draft");
    expect(view.inputNotice).toContain("draft retained");
    expect(view.inputAdmitting).toBe(false);
    composer.key("", { name: "return" });
    await Promise.resolve();
    expect(requestIds[0]).toBeTruthy();
    expect(requestIds[1]).toBe(requestIds[0]);
    composer.key("", { name: "escape" });
    expect(view.input).toBeUndefined();
  });
});

it("retains a cancelled draft with a distinct notice and preserves retry identity", async () => {
  const { InputWithdrawnError } = await import(
    "../src/orchestrator/controller.js"
  );
  const view = state();
  const ids: (string | undefined)[] = [];
  const composer = new DashboardComposer(
    view,
    async (_content, id) => {
      ids.push(id);
      throw new InputWithdrawnError();
    },
    () => {},
  );
  composer.open("old input");
  composer.key("", { name: "return" });
  await Promise.resolve();
  expect(view.input).toBe("old input");
  expect(view.inputAdmitting).toBe(false);
  expect(view.inputNotice).toContain("cancelled");
  composer.key("", { name: "return" });
  await Promise.resolve();
  expect(ids[1]).toBe(ids[0]);
  composer.key(" new", {});
  composer.key("", { name: "return" });
  await Promise.resolve();
  expect(ids[2]).not.toBe(ids[0]);
});
