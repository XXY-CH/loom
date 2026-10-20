import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { parseOptions } from "../src/cli/options.js";
import type { RuntimeSession } from "../src/runtime/session.js";
import { DashboardController, runDashboard } from "../src/tui/controller.js";
import { renderDashboard } from "../src/tui/render.js";
import { FeatureRunner } from "../src/workflow/feature.js";
import { createFeatureFixture, featureModel } from "./feature-fixture.js";

const execute = promisify(execFile);
const dirs: string[] = [];
const controllers: DashboardController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "loom-tui-")));
  dirs.push(cwd);
  const git = (...args: string[]) =>
    execute("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(cwd, "file.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  return { cwd, git };
}
test("live polling observes external edits; layer navigation and worktree selection use actual Git", async () => {
  const { cwd, git } = await fixture();
  // Unique path kept under the temporary root's cleanup ownership.
  const worktree = join(cwd, "tree");
  await git("worktree", "add", "-b", "topic", worktree);
  await writeFile(join(cwd, "file.txt"), "base\nstaged\n");
  await git("add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "base\nstaged\nworking\n");
  let frames = 0;
  const controller = new DashboardController(cwd, () => {
    frames++;
  });
  controllers.push(controller);
  controller.start();
  await expect.poll(() => controller.state.diff).toContain("+working");
  expect(
    renderDashboard(controller.state, 140, 32, { color: false }),
  ).toContain("1 staged · 1 unstaged");
  await controller.key("s");
  expect(controller.state.diff).toContain("+staged");
  expect(controller.state.diff).not.toContain("+working");
  await writeFile(join(cwd, "file.txt"), "base\nexternal\n");
  await controller.key("s");
  await expect.poll(() => controller.state.diff).toContain("+external");
  expect(frames).toBeGreaterThan(2);
  controller.state.focus = "worktrees";
  controller.state.selectedWorktree =
    controller.state.git?.worktrees.findIndex(
      (item) => item.path === worktree,
    ) ?? -1;
  await controller.key("return");
  await expect.poll(() => controller.state.git?.branch).toBe("topic");
  expect(controller.state.cwd).toBe(worktree);
});
test("observer retains its last snapshot and marks errors when a worktree disappears", async () => {
  const { cwd } = await fixture();
  const controller = new DashboardController(cwd, () => {});
  controllers.push(controller);
  await controller.refresh();
  const snapshot = controller.state.git;
  await rm(cwd, { recursive: true, force: true });
  await controller.refresh();
  expect(controller.state.git).toBe(snapshot);
  expect(controller.state.gitError).toBeTruthy();
});
test("CLI once is plain read-only output and does not require model credentials", async () => {
  const { cwd } = await fixture();
  const before = await readFile(join(cwd, ".git/index"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", "tui", "--cwd", cwd, "--once"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  expect(code).toBe(0);
  expect(output).toContain("LOOM");
  expect(output).toContain("Working tree clean");
  expect(output).not.toContain("Runtime executes:");
  expect(output).not.toContain("\x1b");
  expect(await readFile(join(cwd, ".git/index"))).toEqual(before);
  expect(parseOptions(["tui", "--cwd", cwd])?.command).toBe("tui");
  expect(() => parseOptions(["tui", "--cwd", cwd, "--db", "x"])).toThrow(
    "both",
  );
});

test("feature TUI observes its live Runtime in-process without control capabilities", async () => {
  const fixture = await createFeatureFixture();
  dirs.push(fixture.root);
  const model = featureModel({ pauseStep: "scout" });
  const runner = await FeatureRunner.open({
    spec: fixture.spec,
    runtime: { ...model.runtime, dbPath: fixture.dbPath },
  });
  try {
    const runtime = runner.runtime as RuntimeSession;
    const submit = vi.spyOn(runtime, "submit");
    const resume = vi.spyOn(runtime, "resume");
    const cancel = vi.spyOn(runtime, "cancel");
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await runDashboard({
        cwd: fixture.spec.worktreePath,
        runtime,
        readOnly: true,
        once: true,
      });
      expect(
        output.mock.calls.map(([value]) => String(value)).join(""),
      ).toContain("Workflow addition · ready");
      expect(
        output.mock.calls.map(([value]) => String(value)).join(""),
      ).toContain("Tokens in");
      expect(submit).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      submit.mockRestore();
      resume.mockRestore();
      cancel.mockRestore();
    }
  } finally {
    await runner.close();
  }
});

test("read-only observer rejects an initial prompt", async () => {
  const { cwd } = await fixture();
  await expect(
    runDashboard({
      cwd,
      readOnly: true,
      prompt: "must not submit",
      once: true,
    }),
  ).rejects.toThrow("Read-only TUI cannot submit an initial prompt");
});

test("read-only observer routes Ctrl-C to its interrupt handler", async () => {
  const { cwd } = await fixture();
  const input = process.stdin;
  const output = process.stdout;
  const inputTty = Object.getOwnPropertyDescriptor(input, "isTTY");
  const outputTty = Object.getOwnPropertyDescriptor(output, "isTTY");
  const setRawMode = Object.getOwnPropertyDescriptor(input, "setRawMode");
  const write = vi.spyOn(output, "write").mockImplementation(() => true);
  const interrupted = vi.fn();
  Object.defineProperty(input, "isTTY", { configurable: true, value: true });
  Object.defineProperty(output, "isTTY", { configurable: true, value: true });
  Object.defineProperty(input, "setRawMode", {
    configurable: true,
    value: vi.fn(),
  });
  try {
    const dashboard = runDashboard({
      cwd,
      readOnly: true,
      onInterrupt: interrupted,
    });
    await vi.waitFor(() =>
      expect(input.listenerCount("keypress")).toBeGreaterThan(0),
    );
    input.emit("keypress", "\x03", { ctrl: true, name: "c" });
    await dashboard;
    expect(interrupted).toHaveBeenCalledOnce();
  } finally {
    write.mockRestore();
    for (const [target, key, descriptor] of [
      [input, "isTTY", inputTty],
      [output, "isTTY", outputTty],
      [input, "setRawMode", setRawMode],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});

test("observer startup failure is returned to the caller", async () => {
  const { cwd } = await fixture();
  const runtime = {
    workflowStatus: vi.fn().mockResolvedValue(undefined),
    watchEvents: vi
      .fn()
      .mockRejectedValue(new Error("observer startup failed")),
  } as unknown as RuntimeSession;
  await expect(runDashboard({ cwd, runtime, once: true })).rejects.toThrow(
    "observer startup failed",
  );
});

test("once observer polls Runtime usage even when no workflow exists", async () => {
  const { cwd } = await fixture();
  const usageSummary = vi.fn().mockResolvedValue({
    models: {},
    total: {
      input: 42,
      output: 7,
      cacheRead: 5,
      cacheWrite: 1,
      cacheReadPromptRatio: 5 / 48,
    },
  });
  const runtime = {
    workflowStatus: vi.fn().mockResolvedValue(undefined),
    usageSummary,
    watchEvents: vi.fn().mockResolvedValue({
      snapshot: { type: "snapshot", run: false, entries: [], tools: [] },
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    }),
    recoveryStatus: vi.fn().mockResolvedValue({ pendingOperationIds: [] }),
  } as unknown as RuntimeSession;
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    await runDashboard({ cwd, runtime, once: true });
    expect(usageSummary).toHaveBeenCalled();
    expect(
      output.mock.calls.map(([value]) => String(value)).join(""),
    ).toContain("Tokens in");
  } finally {
    output.mockRestore();
  }
});
