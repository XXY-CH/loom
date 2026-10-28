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
import { App } from "./App.js";
import { fillStartForm, jsonResponse, sampleRun } from "./test-utils.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const stream of streams) stream.end();
  streams.length = 0;
  sessionStorage.clear();
  window.localStorage?.clear();
  // The hash survives cleanup in happy-dom; without a reset the run selected
  // by one test auto-opens in the next and text queries see double matches.
  window.location.hash = "";
});

/**
 * vitest's happy-dom environment does not expose localStorage at all, so a
 * localStorage write from app code would throw into the console rather than
 * fail a test. Installing a spy makes any such write observable.
 */
function installLocalStorageSpy(): string[] {
  const writes: string[] = [];
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  return writes;
}

const BASE = "http://127.0.0.1:54321";
const TOKEN = "test-token-value";
const encoder = new TextEncoder();

/**
 * A controllable SSE stream: pushed chunks are delivered in order; while idle
 * the read pends until end() closes the stream (which triggers reconnect).
 */
type ControlledStream = {
  response: Response;
  push: (payload: unknown) => void;
  end: () => void;
};
const streams: ControlledStream[] = [];

function liveStream(): ControlledStream {
  const chunks: string[] = [];
  let ended = false;
  const stream: ControlledStream = {
    response: {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            while (true) {
              const chunk = chunks.shift();
              if (chunk !== undefined)
                return { done: false, value: encoder.encode(chunk) };
              if (ended) return { done: true, value: undefined };
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          },
        }),
      },
    } as unknown as Response,
    push: (payload: unknown) =>
      chunks.push(`data: ${JSON.stringify(payload)}\n\n`),
    end: () => {
      ended = true;
    },
  };
  streams.push(stream);
  return stream;
}

function stubFetch(mock: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) =>
      mock(input.toString(), init) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("connect validates via list, stores the token only in sessionStorage", async () => {
  const localStorageWrites = installLocalStorageSpy();
  const fetchMock = stubFetch((url) => {
    if (url === `${BASE}/events`) return liveStream().response;
    return jsonResponse({ ok: true, result: [] });
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText("Service address"), {
    target: { value: `${BASE}/` },
  });
  fireEvent.change(screen.getByLabelText("Bearer token"), {
    target: { value: TOKEN },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(sessionStorage.getItem("loom.workbench.token")).toBe(TOKEN),
  );
  expect(sessionStorage.getItem("loom.workbench.base")).toBe(BASE);
  // sessionStorage only: no localStorage write may ever happen.
  expect(localStorageWrites).toEqual([]);
  // The validating list call carried the bearer token.
  const listCall = fetchMock.mock.calls.find(
    ([url]) => (url as string) === `${BASE}/runs`,
  );
  expect(listCall).toBeTruthy();
  const headers = listCall?.[1]?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
});

test("a rejected token surfaces the structured error and stores nothing", async () => {
  stubFetch(() => jsonResponse({ ok: false, error: "Unauthorized" }, 401));
  render(<App />);
  fireEvent.change(screen.getByLabelText("Service address"), {
    target: { value: BASE },
  });
  fireEvent.change(screen.getByLabelText("Bearer token"), {
    target: { value: "wrong-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  const alert = await screen.findByTestId("connect-error");
  expect(alert.textContent).toContain("Unauthorized");
  expect(sessionStorage.getItem("loom.workbench.token")).toBeNull();
});

test("SSE snapshots drive the run list live", async () => {
  const first = liveStream();
  stubFetch((url) => {
    if (url === `${BASE}/events`) return first.response;
    return jsonResponse({ ok: true, result: [] });
  });
  sessionStorage.setItem("loom.workbench.base", BASE);
  sessionStorage.setItem("loom.workbench.token", TOKEN);
  render(<App />);
  first.push([sampleRun()]);
  expect(await screen.findByText("addition")).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId("connection-state").textContent).toBe("live"),
  );
  // A later snapshot with one more run updates the list in place.
  first.push([
    sampleRun(),
    sampleRun({ runId: "subtraction", goal: "Subtract." }),
  ]);
  expect(await screen.findByText("subtraction")).toBeTruthy();
});

test("a dropped stream shows reconnecting and then recovers", async () => {
  const first = liveStream();
  const second = liveStream();
  let connections = 0;
  stubFetch((url) => {
    if (url === `${BASE}/events`) {
      connections += 1;
      return connections === 1 ? first.response : second.response;
    }
    return jsonResponse({ ok: true, result: [] });
  });
  sessionStorage.setItem("loom.workbench.base", BASE);
  sessionStorage.setItem("loom.workbench.token", TOKEN);
  render(<App />);
  first.push([sampleRun()]);
  await waitFor(() =>
    expect(screen.getByTestId("connection-state").textContent).toBe("live"),
  );
  // The stream ends (service stopped or page slept): the indicator flips and
  // the list keeps the last snapshot until the retry stream reconnects.
  first.end();
  await waitFor(() =>
    expect(screen.getByTestId("connection-state").textContent).toBe(
      "reconnecting",
    ),
  );
  expect(screen.getByText("addition")).toBeTruthy();
  second.push([sampleRun()]);
  await waitFor(
    () =>
      expect(screen.getByTestId("connection-state").textContent).toBe("live"),
    { timeout: 5_000 },
  );
  expect(connections).toBeGreaterThanOrEqual(2);
});

test("selecting a run routes by hash and renders its detail", async () => {
  const stream = liveStream();
  stubFetch((url) => {
    if (url === `${BASE}/events`) return stream.response;
    return jsonResponse({ ok: true, result: [] });
  });
  sessionStorage.setItem("loom.workbench.base", BASE);
  sessionStorage.setItem("loom.workbench.token", TOKEN);
  render(<App />);
  stream.push([sampleRun()]);
  fireEvent.click(await screen.findByText("addition"));
  expect(window.location.hash).toBe("#/runs/addition");
  const status = await screen.findByTestId("run-status");
  expect(status.textContent).toContain("running (active)");
  expect(screen.getByTestId("run-budget").textContent).toContain("3/64 calls");
});

test("the run detail exposes the file index and single-file views after loading the diff", async () => {
  const stream = liveStream();
  stubFetch((url) => {
    if (url === `${BASE}/events`) return stream.response;
    if (url.endsWith("/diff/files"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 2,
          total: 51,
          files: [{ path: "gen-50.txt" }],
          nextAfter: null,
        },
      });
    if (url.includes("/diff/file"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 3,
          path: "gen-50.txt",
          mode: "working",
          text: "+beyond the cap",
        },
      });
    if (url.endsWith("/diff"))
      return jsonResponse({
        ok: true,
        result: {
          root: "/tmp/worktree-addition",
          observedAt: 1,
          files: [{ path: "sum.js" }],
          diffs: [{ path: "sum.js", mode: "working", text: "+new" }],
          truncatedFiles: true,
        },
      });
    return jsonResponse({ ok: true, result: [] });
  });
  sessionStorage.setItem("loom.workbench.base", BASE);
  sessionStorage.setItem("loom.workbench.token", TOKEN);
  render(<App />);
  stream.push([sampleRun()]);
  fireEvent.click(await screen.findByText("addition"));
  fireEvent.click(screen.getByRole("button", { name: "Load diff" }));
  expect(await screen.findByTestId("diff-working-sum.js")).toBeTruthy();
  // The capped aggregate still offers the full index and per-file views.
  fireEvent.click(screen.getByRole("button", { name: "Load file index" }));
  const row = await screen.findByTestId("diff-index-file-gen-50.txt");
  fireEvent.click(within(row).getByRole("button", { name: "working" }));
  expect(
    await screen.findByTestId("diff-file-working-gen-50.txt"),
  ).toBeTruthy();
});

test("a start dispatched from the form is projected by SSE into the list", async () => {
  const stream = liveStream();
  const fetchMock = stubFetch((url, init) => {
    if (url === `${BASE}/events`) return stream.response;
    if (url === `${BASE}/runs` && init?.method === "POST")
      return jsonResponse({ ok: true, result: sampleRun() });
    return jsonResponse({ ok: true, result: [] });
  });
  sessionStorage.setItem("loom.workbench.base", BASE);
  sessionStorage.setItem("loom.workbench.token", TOKEN);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Start run…" }));
  fillStartForm();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByTestId("start-result")).toBeTruthy();
  // The dispatch itself posted to /runs with the bearer token.
  const startCall = fetchMock.mock.calls.find(
    ([url, init]) =>
      (url as string) === `${BASE}/runs` && init?.method === "POST",
  );
  expect(startCall).toBeTruthy();
  const headers = startCall?.[1]?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  // The SSE snapshot projects the dispatched run into the list…
  stream.push([sampleRun()]);
  fireEvent.click(await screen.findByText("addition"));
  // …and the unchanged hash routing opens its detail.
  expect(window.location.hash).toBe("#/runs/addition");
  const status = await screen.findByTestId("run-status");
  expect(status.textContent).toContain("running (active)");
  expect(screen.queryByTestId("start-result")).toBeNull();
});
