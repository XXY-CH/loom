// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "./api.js";
import { EvidenceView } from "./EvidenceView.js";
import { jsonResponse } from "./test-utils.js";
import type { Evidence, RunArtifact } from "./types.js";

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

const artifact = (): RunArtifact => ({
  text: `{"step":"implement","report":"changed sum.js"}`,
  truncated: false,
  byteLength: 44,
});

const evidence: Evidence[] = [
  {
    id: "ev-command",
    stepId: "targeted_verify",
    attempt: 1,
    planVersion: 1,
    valid: true,
    recordedAt: 1,
    artifactRef: "pi:feature/ev-command",
    kind: "command",
    command: "node -e require('./sum.js')",
    exitCode: 0,
  },
  {
    id: "ev-review",
    stepId: "review",
    attempt: 1,
    planVersion: 1,
    valid: false,
    recordedAt: 2,
    artifactRef: "pi:feature/ev-review",
    kind: "review",
    reviewerId: "reviewer",
    implementerId: "implementer",
    unresolvedFindings: 2,
  },
  {
    id: "ev-artifact",
    stepId: "implement",
    attempt: 2,
    planVersion: 1,
    valid: true,
    recordedAt: 3,
    artifactRef: "pi:feature/ev-artifact",
    kind: "artifact",
    producerId: "implementer",
  },
];

test("renders each evidence entry with kind, step, validity and detail", () => {
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  for (const item of evidence)
    expect(screen.getByTestId(`evidence-${item.id}`)).toBeTruthy();
  expect(screen.getByTestId("evidence-ev-command").textContent).toContain(
    "node -e require('./sum.js')",
  );
  expect(screen.getByTestId("evidence-ev-command").textContent).toContain(
    "exit 0",
  );
  expect(screen.getByTestId("evidence-ev-review").textContent).toContain(
    "2 unresolved",
  );
  expect(screen.getByTestId("evidence-ev-review").textContent).toContain(
    "invalid",
  );
  expect(screen.getByTestId("evidence-ev-artifact").textContent).toContain(
    "artifact by implementer",
  );
});

test("an empty evidence list renders an explicit empty state", () => {
  render(
    <EvidenceView evidence={[]} api={createApi(BASE, TOKEN)} runId={RUN_ID} />,
  );
  expect(screen.getByTestId("evidence-empty").textContent).toContain(
    "No evidence",
  );
});

test("only artifact entries offer a body view; command and review do not", () => {
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  expect(screen.getByTestId("artifact-view-ev-artifact")).toBeTruthy();
  expect(screen.queryByTestId("artifact-view-ev-command")).toBeNull();
  expect(screen.queryByTestId("artifact-view-ev-review")).toBeNull();
  // The command row keeps its summary but never grows view controls.
  expect(
    screen.getByTestId("evidence-ev-command").querySelector("button"),
  ).toBeNull();
});

test("viewing an artifact body fetches once with the encoded id and bearer token", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.includes("/artifact"))
      return jsonResponse({ ok: true, result: artifact() });
    throw new Error(`unexpected ${url}`);
  });
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  const body = await screen.findByTestId("artifact-body-ev-artifact");
  expect(body.textContent).toContain("changed sum.js");
  expect(body.textContent).toContain("44 bytes");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(
    `${BASE}/runs/${RUN_ID}/artifact?evidence=${encodeURIComponent("ev-artifact")}`,
  );
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
});

test("the truncated badge renders only when the server truncated the body", async () => {
  stubFetch((url) => {
    if (!url.includes("/artifact")) throw new Error(`unexpected ${url}`);
    return jsonResponse({
      ok: true,
      result: {
        text: `${"x".repeat(64)}\n… preview truncated (64 KiB)`,
        truncated: true,
        byteLength: 70_000,
      } satisfies RunArtifact,
    });
  });
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  const body = await screen.findByTestId("artifact-body-ev-artifact");
  expect(body.textContent).toContain("truncated at 64 KiB");
  expect(body.textContent).toContain("70000 bytes");
});

test("structured errors render verbatim, collapse, and retry on demand", async () => {
  let calls = 0;
  const fetchMock = stubFetch((url) => {
    if (!url.includes("/artifact")) throw new Error(`unexpected ${url}`);
    calls += 1;
    if (calls === 1)
      return jsonResponse({ ok: false, error: "Unknown evidence id" }, 400);
    return jsonResponse({ ok: true, result: artifact() });
  });
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  const error = await screen.findByTestId("artifact-error-ev-artifact");
  expect(error.textContent).toContain("Unknown evidence id");
  expect(screen.queryByTestId("artifact-body-ev-artifact")).toBeNull();
  // A retry is explicit: the same button refetches instead of silently retrying.
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  expect(await screen.findByTestId("artifact-body-ev-artifact")).toBeTruthy();
  expect(screen.queryByTestId("artifact-error-ev-artifact")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("hiding a loaded body and reopening it never refetches", async () => {
  const fetchMock = stubFetch((url) => {
    if (url.includes("/artifact"))
      return jsonResponse({ ok: true, result: artifact() });
    throw new Error(`unexpected ${url}`);
  });
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  await screen.findByTestId("artifact-body-ev-artifact");
  fireEvent.click(screen.getByRole("button", { name: "hide body" }));
  expect(screen.queryByTestId("artifact-body-ev-artifact")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "show body" }));
  expect(await screen.findByTestId("artifact-body-ev-artifact")).toBeTruthy();
  // One load, cached across the hide/show cycle.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a pending load shows the loading state and no body until it settles", async () => {
  let release: ((value: Response) => void) | undefined;
  stubFetch((url) => {
    if (!url.includes("/artifact")) throw new Error(`unexpected ${url}`);
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  render(
    <EvidenceView
      evidence={evidence}
      api={createApi(BASE, TOKEN)}
      runId={RUN_ID}
    />,
  );
  fireEvent.click(screen.getByTestId("artifact-view-ev-artifact"));
  expect(
    await screen.findByTestId("artifact-pending-ev-artifact"),
  ).toBeTruthy();
  expect(screen.queryByTestId("artifact-body-ev-artifact")).toBeNull();
  release?.(jsonResponse({ ok: true, result: artifact() }));
  expect(await screen.findByTestId("artifact-body-ev-artifact")).toBeTruthy();
  expect(screen.queryByTestId("artifact-pending-ev-artifact")).toBeNull();
});
