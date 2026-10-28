// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "./api.js";
import { DiffView } from "./DiffView.js";
import { jsonResponse } from "./test-utils.js";
import type { RunDiff, RunDiffFilePage } from "./types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "http://127.0.0.1:54321";
const TOKEN = "test-token-value";
const RUN_ID = "addition";

function stubFetch(mock: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) =>
      mock(input.toString(), init) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(
  fetchMock: ReturnType<typeof stubFetch>,
): [string, RequestInit | undefined] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("no fetch call recorded");
  return call as unknown as [string, RequestInit | undefined];
}

const diff: RunDiff = {
  root: "/tmp/worktree-addition",
  observedAt: 1,
  files: [{ path: "sum.js" }, { path: "notes.txt" }, { path: "untracked.txt" }],
  diffs: [
    {
      path: "sum.js",
      mode: "working",
      text: `-module.exports = (a, b) => a - b;\n+module.exports = (a, b) => a + b;\n… preview truncated (64 KiB)`,
    },
    { path: "notes.txt", mode: "staged", text: "+staged note" },
    {
      path: "untracked.txt",
      mode: "working",
      text: "Untracked file: untracked.txt\nloose note",
    },
  ],
  truncatedFiles: true,
};

test("renders one entry per file and layer with modes and paths", () => {
  render(<DiffView diff={diff} api={createApi(BASE, TOKEN)} runId={RUN_ID} />);
  expect(screen.getByTestId("diff-working-sum.js")).toBeTruthy();
  expect(screen.getByTestId("diff-staged-notes.txt")).toBeTruthy();
  expect(screen.getByTestId("diff-working-untracked.txt")).toBeTruthy();
  expect(screen.getByTestId("diff-working-sum.js").textContent).toContain(
    "working",
  );
  expect(screen.getByTestId("diff-working-sum.js").textContent).toContain(
    "a + b",
  );
  expect(screen.getByTestId("diff-staged-notes.txt").textContent).toContain(
    "staged note",
  );
});

test("the per-entry 64 KiB truncation marker and the file cap render honestly", () => {
  render(<DiffView diff={diff} api={createApi(BASE, TOKEN)} runId={RUN_ID} />);
  expect(screen.getByTestId("diff-working-sum.js").textContent).toContain(
    "… preview truncated (64 KiB)",
  );
  expect(screen.getByTestId("diff-working-sum.js").textContent).toContain(
    "truncated at 64 KiB",
  );
  expect(screen.getByTestId("diff-files-truncated").textContent).toContain(
    "50 files",
  );
  // Entries without the marker get no badge.
  expect(screen.getByTestId("diff-staged-notes.txt").textContent).not.toContain(
    "truncated at 64 KiB",
  );
});

test("a clean worktree renders an empty aggregate, not an error", () => {
  render(
    <DiffView
      diff={{
        root: "/tmp/worktree-addition",
        observedAt: 1,
        files: [],
        diffs: [],
        truncatedFiles: false,
      }}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  expect(screen.getByTestId("diff-empty").textContent).toContain("No changes");
  expect(screen.queryByTestId("diff-files-truncated")).toBeNull();
});

test("the file index pages past the 50-file cap until nextAfter is null", async () => {
  // 56 changed files (>50): two pages, cursor = last entry of page one.
  const all = [
    { path: "sum.js" },
    ...Array.from({ length: 55 }, (_, i) => ({
      path: `gen-${String(i).padStart(2, "0")}.txt`,
    })),
  ];
  const firstPageFiles = all.slice(0, 50);
  const secondPageFiles = all.slice(50);
  const cursor = firstPageFiles.at(-1)?.path ?? "";
  const page = (
    files: Array<{ path: string }>,
    nextAfter: string | null,
  ): RunDiffFilePage => ({
    root: "/tmp/worktree-addition",
    observedAt: 1,
    total: all.length,
    files,
    nextAfter,
  });
  const fetchMock = stubFetch((url) => {
    if (!url.includes("/diff/files")) throw new Error(`unexpected ${url}`);
    const after = new URL(url).searchParams.get("after");
    return jsonResponse({
      ok: true,
      result:
        after === null
          ? page(firstPageFiles, cursor)
          : page(secondPageFiles, null),
    });
  });
  render(
    <DiffView
      diff={{ ...diff, files: firstPageFiles as RunDiff["files"] }}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  expect(await screen.findByTestId("diff-index-file-gen-48.txt")).toBeTruthy();
  // The second page is not loaded yet: its files stay invisible.
  expect(screen.queryByTestId("diff-index-file-gen-49.txt")).toBeNull();
  expect(screen.queryByTestId("diff-index-complete")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
  expect(await screen.findByTestId("diff-index-file-gen-54.txt")).toBeTruthy();
  // Every changed file is now listed, with the total pinned.
  for (const file of all)
    expect(screen.getByTestId(`diff-index-file-${file.path}`)).toBeTruthy();
  expect(screen.getByTestId("diff-index-complete").textContent).toContain(
    "All 56 changed files listed.",
  );
  // The continuation request carried the first page's cursor verbatim.
  const continuation = fetchMock.mock.calls.find(([url]) =>
    (url as string).includes("after="),
  );
  expect(continuation?.[0]).toBe(
    `${BASE}/runs/${RUN_ID}/diff/files?after=${encodeURIComponent(cursor)}`,
  );
});

test("a single file and layer opens on demand with the encoded path and bearer token", async () => {
  const path = "src/loose note.txt";
  const fetchMock = stubFetch((url) => {
    if (url.endsWith("/diff/files"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 1,
          total: 1,
          files: [{ path }],
          nextAfter: null,
        },
      });
    if (url.includes("/diff/file")) {
      const query = new URL(url).searchParams;
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 2,
          path,
          mode: query.get("mode") === "staged" ? "staged" : "working",
          text: "+loose line\n… preview truncated (64 KiB)",
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  render(<DiffView diff={diff} api={createApi(BASE, TOKEN)} runId={RUN_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  const row = await screen.findByTestId(`diff-index-file-${path}`);
  fireEvent.click(within(row).getByRole("button", { name: "working" }));
  const view = await screen.findByTestId(`diff-file-working-${path}`);
  // The single view reuses the aggregate rendering: text, marker, badge.
  expect(view.textContent).toContain("loose line");
  expect(view.textContent).toContain("… preview truncated (64 KiB)");
  expect(view.textContent).toContain("truncated at 64 KiB");
  const [url, init] = lastCall(fetchMock);
  expect(url).toBe(
    `${BASE}/runs/${RUN_ID}/diff/file?path=${encodeURIComponent(path)}&mode=working`,
  );
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  // The staged button requests the other layer of the same file.
  fireEvent.click(within(row).getByRole("button", { name: "staged" }));
  await waitFor(() =>
    expect(lastCall(fetchMock)[0]).toBe(
      `${BASE}/runs/${RUN_ID}/diff/file?path=${encodeURIComponent(path)}&mode=staged`,
    ),
  );
  expect(await screen.findByTestId(`diff-file-staged-${path}`)).toBeTruthy();
});

test("layer and path errors from the file view render verbatim", async () => {
  // Stale-snapshot scenarios: the layer no longer applies, then the path
  // itself vanished between the index load and the on-demand view.
  const errors = [
    "Diff mode does not apply to this file",
    "Unknown diff file path",
  ];
  let view = 0;
  stubFetch((url) => {
    if (url.endsWith("/diff/files"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 1,
          total: 1,
          files: [{ path: "notes.txt" }],
          nextAfter: null,
        },
      });
    if (url.includes("/diff/file")) {
      const error = errors[view++];
      if (!error) throw new Error("no scripted error left");
      return jsonResponse({ ok: false, error }, 400);
    }
    throw new Error(`unexpected ${url}`);
  });
  render(<DiffView diff={diff} api={createApi(BASE, TOKEN)} runId={RUN_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  const row = await screen.findByTestId("diff-index-file-notes.txt");
  fireEvent.click(within(row).getByRole("button", { name: "working" }));
  const layerError = await screen.findByTestId("diff-file-error");
  expect(layerError.textContent).toContain(
    "Diff mode does not apply to this file",
  );
  expect(screen.queryByTestId("diff-file-working-notes.txt")).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "staged" }));
  await waitFor(() =>
    expect(screen.getByTestId("diff-file-error").textContent).toContain(
      "Unknown diff file path",
    ),
  );
});

test("cursor invalidation shows the structured error and allows restarting from the first page", async () => {
  let pages = 0;
  const fetchMock = stubFetch((url) => {
    if (!url.includes("/diff/files")) throw new Error(`unexpected ${url}`);
    pages += 1;
    if (pages === 2)
      return jsonResponse(
        { ok: false, error: "Unknown diff files cursor" },
        400,
      );
    return jsonResponse({
      ok: true,
      result: {
        root: "/tmp/worktree-addition",
        observedAt: pages,
        total: pages === 1 ? 3 : 2,
        files: [{ path: "a.txt" }, { path: "b.txt" }],
        nextAfter: pages === 1 ? "b.txt" : null,
      },
    });
  });
  render(<DiffView diff={diff} api={createApi(BASE, TOKEN)} runId={RUN_ID} />);
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  expect(await screen.findByTestId("diff-index-file-b.txt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
  const error = await screen.findByTestId("diff-index-error");
  expect(error.textContent).toContain("Unknown diff files cursor");
  // No silent retry: still exactly two index requests, and the pages already
  // walked stay visible with the reload-from-first-page entry available.
  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(screen.getByTestId("diff-index-file-a.txt")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Reload file index" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload file index" }));
  expect(await screen.findByTestId("diff-index-complete")).toBeTruthy();
  expect(screen.queryByTestId("diff-index-error")).toBeNull();
});
