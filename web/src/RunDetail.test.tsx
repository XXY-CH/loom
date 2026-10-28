// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "./api.js";
import { RunDetail } from "./RunDetail.js";
import { jsonResponse, sampleRun } from "./test-utils.js";
import type { RunSummary } from "./types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "http://127.0.0.1:54321";
const TOKEN = "test-token-value";

function stubFetch(mock: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) =>
      mock(input.toString(), init) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("cancel posts to the action endpoint with the bearer token", async () => {
  const fetchMock = stubFetch(() =>
    jsonResponse({ ok: true, result: sampleRun({ status: "cancelled" }) }),
  );
  render(<RunDetail run={sampleRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/runs/addition/cancel`);
  expect(init?.method).toBe("POST");
  const headers = init?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(screen.queryByTestId("action-error")).toBeNull();
});

test("a structured resume error renders verbatim", async () => {
  stubFetch(() =>
    jsonResponse({ ok: false, error: "Cannot resume cancelled Run" }, 400),
  );
  render(
    <RunDetail
      run={sampleRun({ status: "cancelled" })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  const alert = await screen.findByTestId("action-error");
  expect(alert.textContent).toContain("Cannot resume cancelled Run");
});

test("loading diff and evidence hits the read-only endpoints and renders them", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.endsWith("/diff"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 1,
          files: [{ path: "sum.js" }, { path: "notes.txt" }],
          diffs: [
            {
              path: "sum.js",
              mode: "working",
              text: "-old\n+new\n… preview truncated (64 KiB)",
            },
            { path: "notes.txt", mode: "staged", text: "+staged note" },
          ],
          truncatedFiles: true,
        },
      });
    return jsonResponse({
      ok: true,
      result: [
        {
          id: "ev-1",
          stepId: "targeted_verify",
          attempt: 1,
          planVersion: 1,
          valid: true,
          recordedAt: 1,
          artifactRef: "sum.js",
          kind: "command",
          command: "node -e assert",
          exitCode: 0,
        },
      ],
    });
  });
  render(<RunDetail run={sampleRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
  expect(await screen.findByTestId("diff-working-sum.js")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load evidence" }));
  expect(await screen.findByTestId("evidence-ev-1")).toBeTruthy();
  const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url]) => url).sort()).toEqual([
    `${BASE}/runs/addition/diff`,
    `${BASE}/runs/addition/evidence`,
  ]);
  for (const [, init] of calls)
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
});

test("after loading the diff, the file index and on-demand file views are reachable", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.endsWith("/diff/files"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 2,
          total: 2,
          files: [{ path: "sum.js" }, { path: "deep/notes.txt" }],
          nextAfter: null,
        },
      });
    if (url.includes("/diff/file"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 3,
          path: "deep/notes.txt",
          mode: "staged",
          text: "+staged note",
        },
      });
    return jsonResponse({
      ok: true,
      result: {
        root: "/tmp/worktree-addition",
        observedAt: 1,
        files: [{ path: "sum.js" }],
        diffs: [{ path: "sum.js", mode: "working", text: "+new" }],
        truncatedFiles: false,
      },
    });
  });
  render(<RunDetail run={sampleRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
  expect(await screen.findByTestId("diff-working-sum.js")).toBeTruthy();
  // The aggregate render exposes the index entry point; no extra request
  // happens until the user asks for it.
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  const row = await screen.findByTestId("diff-index-file-deep/notes.txt");
  fireEvent.click(within(row).getByRole("button", { name: "staged" }));
  expect(
    await screen.findByTestId("diff-file-staged-deep/notes.txt"),
  ).toBeTruthy();
  const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(
    ([url]) => url,
  );
  expect(urls).toEqual([
    `${BASE}/runs/addition/diff`,
    `${BASE}/runs/addition/diff/files`,
    `${BASE}/runs/addition/diff/file?path=${encodeURIComponent("deep/notes.txt")}&mode=staged`,
  ]);
});

test("steps render with their status and the run blocks show the reason", () => {
  render(
    <RunDetail
      run={sampleRun({
        status: "blocked",
        active: false,
        blockedReason:
          "Unknown or blocked operation requires reconciliation before resume",
        steps: [
          ...sampleRun().steps,
          {
            id: "targeted_verify",
            role: "verifier",
            status: "failed",
            attempt: 2,
            evidenceIds: [],
            failure: "targeted command exited 1",
            inputQuestion: null,
            inputAnswer: null,
          },
        ],
      })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  expect(screen.getByTestId("step-scout").textContent).toContain("completed");
  expect(screen.getByTestId("step-targeted_verify").textContent).toContain(
    "failed",
  );
  expect(screen.getByTestId("step-failure").textContent).toContain(
    "targeted command exited 1",
  );
  expect(screen.getByTestId("run-blocked").textContent).toContain(
    "reconciliation",
  );
});

test("the budget line renders a reconciled:2 usage count", () => {
  render(
    <RunDetail
      run={sampleRun({
        usage: {
          limits: { maxCalls: 64, maxTokens: 1_000_000 },
          calls: 5,
          tokens: 1200,
          pending: 0,
          reconciled: 2,
        },
      })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  const budget = screen.getByTestId("run-budget").textContent ?? "";
  expect(budget).toContain("5/64 calls");
  expect(budget).toContain("0 pending");
  expect(budget).toContain("2 reconciled");
});

test("reconciled:0 keeps the segment rendered while usage:null keeps the prior form", () => {
  const { rerender } = render(
    <RunDetail run={sampleRun()} api={createApi(BASE, TOKEN)} />,
  );
  // `reconciled` is a ledger fact beside `pending`: it renders even at 0.
  const settled = screen.getByTestId("run-budget").textContent ?? "";
  expect(settled).toContain("3/64 calls");
  expect(settled).toContain("0 pending");
  expect(settled).toContain("0 reconciled");
  rerender(
    <RunDetail run={sampleRun({ usage: null })} api={createApi(BASE, TOKEN)} />,
  );
  expect(screen.getByTestId("run-budget").textContent).toBe(
    "64 calls / 1000000 tokens (no usage yet)",
  );
});

function pendingRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return sampleRun({
    status: "blocked",
    active: false,
    usage: {
      limits: { maxCalls: 64, maxTokens: 1_000_000 },
      calls: 1,
      tokens: 0,
      pending: 2,
      reconciled: 0,
    },
    ...overrides,
  });
}

test("the reconcile budget button appears only for a settled run with unsettled calls", () => {
  // pending > 0 and inactive: the action is offered.
  render(<RunDetail run={pendingRun()} api={createApi(BASE, TOKEN)} />);
  expect(screen.getByTestId("reconcile-budget-arm")).toBeTruthy();
  cleanup();
  // Active runs hold their own database lease (the in-flight call is itself a
  // pending row); the guaranteed-failing action is not offered.
  render(
    <RunDetail
      run={pendingRun({ active: true, status: "running" })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  expect(screen.queryByTestId("reconcile-budget-arm")).toBeNull();
  cleanup();
  // Settled ledgers and runs without a ledger projection hide it too.
  render(
    <RunDetail
      run={sampleRun({ active: false })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  expect(screen.queryByTestId("reconcile-budget-arm")).toBeNull();
  cleanup();
  render(
    <RunDetail
      run={sampleRun({ active: false, usage: null })}
      api={createApi(BASE, TOKEN)}
    />,
  );
  expect(screen.queryByTestId("reconcile-budget-arm")).toBeNull();
});

test("reconciling posts exactly once and only after the explicit confirmation", async () => {
  const fetchMock = stubFetch(() =>
    jsonResponse({
      ok: true,
      result: {
        database: "/tmp/worktree-data/runs/addition/agent.sqlite",
        before: {
          limits: { maxCalls: 64, maxTokens: 1_000_000 },
          calls: 1,
          tokens: 0,
          pending: 2,
          reconciled: 0,
        },
        after: {
          limits: { maxCalls: 64, maxTokens: 1_000_000 },
          calls: 1,
          tokens: 0,
          pending: 0,
          reconciled: 2,
        },
      },
    }),
  );
  render(<RunDetail run={pendingRun()} api={createApi(BASE, TOKEN)} />);
  // Arming the action alone sends nothing.
  fireEvent.click(screen.getByTestId("reconcile-budget-arm"));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Confirm reconcile budget" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm reconcile budget" }),
  );
  await screen.findByTestId("budget-reconciled");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/runs/addition/reconcile-budget`);
  expect(init?.method).toBe("POST");
  const headers = init?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  // Dismissing the confirmation never posts.
  cleanup();
  vi.unstubAllGlobals();
  const secondMock = stubFetch(() => jsonResponse({ ok: true, result: null }));
  render(<RunDetail run={pendingRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByTestId("reconcile-budget-arm"));
  fireEvent.click(screen.getByRole("button", { name: "Keep pending" }));
  expect(secondMock).not.toHaveBeenCalled();
});

test("a successful reconciliation renders the before/after summary and the disclaimer", async () => {
  stubFetch(() =>
    jsonResponse({
      ok: true,
      result: {
        database: "/tmp/worktree-data/runs/addition/agent.sqlite",
        before: {
          limits: { maxCalls: 64, maxTokens: 1_000_000 },
          calls: 1,
          tokens: 0,
          pending: 1,
          reconciled: 0,
        },
        after: {
          limits: { maxCalls: 64, maxTokens: 1_000_000 },
          calls: 1,
          tokens: 0,
          pending: 0,
          reconciled: 1,
        },
      },
    }),
  );
  render(<RunDetail run={pendingRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByTestId("reconcile-budget-arm"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm reconcile budget" }),
  );
  const summary = await screen.findByTestId("budget-reconciled");
  expect(summary.textContent).toContain("pending 1 → 0");
  expect(summary.textContent).toContain("reconciled 0 → 1");
  const note = await screen.findByTestId("budget-reconciled-note");
  expect(note.textContent).toContain("does not adopt them as succeeded");
  expect(note.textContent).toContain(
    "does not prove they never reached the endpoint",
  );
  expect(screen.queryByTestId("reconcile-error")).toBeNull();
});

test("a structured reconciliation error renders verbatim", async () => {
  stubFetch(() =>
    jsonResponse(
      {
        ok: false,
        error:
          "DATABASE_IN_USE: Database is already owned by another Loom runtime: /tmp/worktree-data/runs/addition/agent.sqlite",
      },
      400,
    ),
  );
  render(<RunDetail run={pendingRun()} api={createApi(BASE, TOKEN)} />);
  fireEvent.click(screen.getByTestId("reconcile-budget-arm"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm reconcile budget" }),
  );
  const alert = await screen.findByTestId("reconcile-error");
  expect(alert.textContent).toContain(
    "DATABASE_IN_USE: Database is already owned by another Loom runtime",
  );
  expect(screen.queryByTestId("budget-reconciled")).toBeNull();
  // The failure keeps the confirmation view open: an explicit retry is one
  // click away, and "Keep pending" still dismisses without posting.
  expect(
    screen.getByRole("button", { name: "Confirm reconcile budget" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep pending" })).toBeTruthy();
});
