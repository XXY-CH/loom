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
import { StartForm } from "./StartForm.js";
import {
  CONNECTIONS_NOT_ENABLED,
  catalogConnections,
  fillStartForm,
  jsonResponse,
  sampleRun,
  selectConnection,
} from "./test-utils.js";

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

/** Routes the mount-time catalog probe; services without --catalog answer
 * with the structured not-enabled error, so the manual profile path is the
 * default scenario for the dispatch tests. */
function stubManualCatalogFetch(
  start: unknown = { ok: true, result: sampleRun() },
) {
  return stubFetch((url) =>
    url === `${BASE}/connections`
      ? jsonResponse(CONNECTIONS_NOT_ENABLED, 400)
      : jsonResponse(start),
  );
}

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Start" }));

/** The dispatched POST /runs calls, excluding the catalog probe. */
function startCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      (url as string) === `${BASE}/runs` && init?.method === "POST",
  );
}

test("a feature start posts the exact spec and profile JSON with the bearer token", async () => {
  const fetchMock = stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  fillStartForm();
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  const [url, init] = startCalls(fetchMock)[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/runs`);
  expect(init?.method).toBe("POST");
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers["Content-Type"]).toBe("application/json");
  // Exact body: exact key set, argv one-per-line (blank lines dropped, inner
  // spaces preserved), optional profile numbers omitted when blank.
  expect(JSON.parse(String(init?.body))).toEqual({
    spec: {
      runId: "addition",
      goal: "Make sum.js add two numbers.",
      repositoryPath: "/tmp/loom-smoke/repo",
      baseCommit: "8f01c40ba4a2f5f7b7c1f1bd6f9cc1fcb1a3f55b",
      worktreePath: "/tmp/loom-smoke/worktree",
      workflow: "feature",
      targeted: ["node", "-e", "process.stdout.write('targeted verified')"],
      regression: ["npm", "test"],
      budget: { maxCalls: 16, maxTokens: 500000 },
    },
    profile: {
      id: "smoke",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "smoke-model",
      baseUrl: "http://127.0.0.1:1",
      keyEnv: "LOOM_SMOKE_KEY",
    },
  });
  const result = await screen.findByTestId("start-result");
  expect(result.textContent).toContain("Run addition: running");
  expect(screen.queryByTestId("start-error")).toBeNull();
});

test("debug workflow swaps the required argv fields and dispatches them", async () => {
  const fetchMock = stubManualCatalogFetch({
    ok: true,
    result: sampleRun({ runId: "debug-001" }),
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  // Feature is the default: targeted present, debug-only fields absent.
  expect(screen.getByLabelText("targeted")).toBeTruthy();
  expect(screen.queryByLabelText("reproduce")).toBeNull();
  expect(screen.queryByLabelText("hypothesis")).toBeNull();
  fireEvent.click(screen.getByLabelText("debug"));
  expect(screen.queryByLabelText("targeted")).toBeNull();
  expect(screen.getByLabelText("reproduce")).toBeTruthy();
  expect(screen.getByLabelText("hypothesis")).toBeTruthy();
  fillStartForm();
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  const [, init] = startCalls(fetchMock)[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(JSON.parse(String(init?.body))).toEqual({
    spec: {
      runId: "addition",
      goal: "Make sum.js add two numbers.",
      repositoryPath: "/tmp/loom-smoke/repo",
      baseCommit: "8f01c40ba4a2f5f7b7c1f1bd6f9cc1fcb1a3f55b",
      worktreePath: "/tmp/loom-smoke/worktree",
      workflow: "debug",
      reproduce: ["npm", "test", "--", "bug.test.ts"],
      hypothesis: ["node", "scripts/check-cause.js"],
      regression: ["npm", "test"],
      budget: { maxCalls: 16, maxTokens: 500000 },
    },
    profile: {
      id: "smoke",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "smoke-model",
      baseUrl: "http://127.0.0.1:1",
      keyEnv: "LOOM_SMOKE_KEY",
    },
  });
  expect((await screen.findByTestId("start-result")).textContent).toContain(
    "debug-001",
  );
});

test("local validation blocks submission before any dispatch", async () => {
  const fetchMock = stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  // Nothing filled: the submit is refused locally.
  submit();
  const empty = await screen.findByTestId("start-error");
  expect(empty.textContent).toContain("runId is required.");
  // Empty goal (everything else filled) still refuses with its message.
  fillStartForm({ goal: "" });
  submit();
  expect((await screen.findByTestId("start-error")).textContent).toContain(
    "goal is required",
  );
  // An empty regression argv refuses, and so does a malformed runId pattern.
  fillStartForm({ goal: "Make sum.js add two numbers.", regression: "" });
  submit();
  expect((await screen.findByTestId("start-error")).textContent).toContain(
    "regression",
  );
  fillStartForm({ regression: "npm\ntest", runId: "bad id!" });
  submit();
  expect((await screen.findByTestId("start-error")).textContent).toContain(
    "runId must start with",
  );
  // The only outgoing request is the catalog probe: no dispatch happened.
  expect(startCalls(fetchMock)).toEqual([]);
});

test("a server-side spec rejection renders verbatim", async () => {
  stubManualCatalogFetch({ ok: false, error: "Invalid feature spec" });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  // A >16000-character goal passes every local check; only the server's
  // spec validation rejects it with its structured error.
  fillStartForm({ goal: "x".repeat(16_001) });
  submit();
  const alert = await screen.findByTestId("start-error");
  expect(alert.textContent).toBe("Invalid feature spec");
  expect(screen.queryByTestId("start-result")).toBeNull();
});

test("an idempotent duplicate start renders the acknowledgement as success", async () => {
  const fetchMock = stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  fillStartForm();
  submit();
  expect(await screen.findByTestId("start-result")).toBeTruthy();
  // Same body again: the server answers 200 with the same RunSummary; the
  // form presents the acknowledgement exactly like the first acceptance.
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));
  const first = startCalls(fetchMock)[0]?.[1]?.body;
  const second = startCalls(fetchMock)[1]?.[1]?.body;
  expect(second).toBe(first);
  expect((await screen.findByTestId("start-result")).textContent).toContain(
    "Run addition: running",
  );
  expect(screen.queryByTestId("start-error")).toBeNull();
});

test("a persisted-configuration conflict renders the server error verbatim", async () => {
  stubManualCatalogFetch({
    ok: false,
    error: "Run request differs from persisted configuration",
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  fillStartForm();
  submit();
  const alert = await screen.findByTestId("start-error");
  expect(alert.textContent).toBe(
    "Run request differs from persisted configuration",
  );
  expect(screen.queryByTestId("start-result")).toBeNull();
});

test("the connection selector lists entries and prefills the exact profile", async () => {
  const fetchMock = stubFetch((url) =>
    url === `${BASE}/connections`
      ? jsonResponse({ ok: true, result: catalogConnections })
      : jsonResponse({ ok: true, result: sampleRun() }),
  );
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  // Loaded: the dropdown offers every catalog entry as id (modelId).
  const select = await screen.findByLabelText("Connection (from the catalog)");
  for (const entry of catalogConnections)
    expect(
      within(select).getByRole("option", {
        name: `${entry.id} (${entry.modelId})`,
      }),
    ).toBeTruthy();
  fillStartForm();
  await selectConnection("local-fixture");
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  const dispatch = JSON.parse(String(startCalls(fetchMock)[0]?.[1]?.body)) as {
    spec: unknown;
    profile: unknown;
  };
  // The selector only fills form fields: the spec keeps the manual inputs…
  expect(dispatch.spec).toEqual({
    runId: "addition",
    goal: "Make sum.js add two numbers.",
    repositoryPath: "/tmp/loom-smoke/repo",
    baseCommit: "8f01c40ba4a2f5f7b7c1f1bd6f9cc1fcb1a3f55b",
    worktreePath: "/tmp/loom-smoke/worktree",
    workflow: "feature",
    targeted: ["node", "-e", "process.stdout.write('targeted verified')"],
    regression: ["npm", "test"],
    budget: { maxCalls: 16, maxTokens: 500000 },
  });
  // …and the profile deep-equals the full entry with its exact key set.
  expect(dispatch.profile).toEqual(catalogConnections[0]);
  expect((await screen.findByTestId("start-result")).textContent).toContain(
    "Run addition: running",
  );

  // The minimal entry prefills only its own fields: optional blanks are
  // omitted from the body, never blank-filled.
  await selectConnection("anthropic-fixture");
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(2));
  const second = JSON.parse(String(startCalls(fetchMock)[1]?.[1]?.body)) as {
    profile: unknown;
  };
  expect(second.profile).toEqual(catalogConnections[1]);
});

test("edits after a selection override the prefilled entry values", async () => {
  const fetchMock = stubFetch((url) =>
    url === `${BASE}/connections`
      ? jsonResponse({ ok: true, result: catalogConnections })
      : jsonResponse({ ok: true, result: sampleRun() }),
  );
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  fillStartForm();
  await selectConnection("local-fixture");
  fireEvent.change(screen.getByLabelText("Profile modelId"), {
    target: { value: "edited-model" },
  });
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  const dispatch = JSON.parse(String(startCalls(fetchMock)[0]?.[1]?.body)) as {
    profile: unknown;
  };
  expect(dispatch.profile).toEqual({
    ...catalogConnections[0],
    modelId: "edited-model",
  });
});

test("a failing or empty connection list keeps the manual profile path", async () => {
  // The not-enabled error is answered by every service without --catalog.
  let fetchMock = stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  expect(await screen.findByTestId("connection-status")).toBeTruthy();
  expect(screen.queryByLabelText("Connection (from the catalog)")).toBeNull();
  fillStartForm();
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  expect(
    JSON.parse(String(startCalls(fetchMock)[0]?.[1]?.body)).profile,
  ).toEqual({
    id: "smoke",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "smoke-model",
    baseUrl: "http://127.0.0.1:1",
    keyEnv: "LOOM_SMOKE_KEY",
  });
  cleanup();
  // An empty enabled catalog behaves the same way.
  fetchMock = stubFetch((url) =>
    url === `${BASE}/connections`
      ? jsonResponse({ ok: true, result: [] })
      : jsonResponse({ ok: true, result: sampleRun() }),
  );
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  expect(await screen.findByTestId("connection-status")).toBeTruthy();
  expect(screen.queryByLabelText("Connection (from the catalog)")).toBeNull();
  fillStartForm();
  submit();
  await vi.waitFor(() => expect(startCalls(fetchMock)).toHaveLength(1));
  expect(
    JSON.parse(String(startCalls(fetchMock)[0]?.[1]?.body)).profile,
  ).toEqual({
    id: "smoke",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "smoke-model",
    baseUrl: "http://127.0.0.1:1",
    keyEnv: "LOOM_SMOKE_KEY",
  });
});

/** The catalog write calls, excluding the read probes. */
function connectionCalls(
  fetchMock: ReturnType<typeof stubFetch>,
  method: "POST" | "PUT" | "DELETE",
) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      (url as string).startsWith(`${BASE}/connections`) &&
      init?.method === method,
  );
}

/** Enabled-catalog routing stub: GET answers the current list (the POST
 * handler appends and the PUT handler replaces what a real service would
 * persist), writes answer `write` (400 when the scripted body is a failure
 * envelope), everything else is a successful start. */
function stubCatalogManagerFetch(write: unknown) {
  let list: Array<{ id: string }> = [...catalogConnections];
  const writeStatus = (write as { ok?: boolean }).ok === false ? 400 : 200;
  return {
    list: () => list,
    fetchMock: stubFetch((url, init) => {
      if (url === `${BASE}/connections` && init?.method === "POST") {
        const profile = JSON.parse(String(init.body)) as { id: string };
        list = [...list, profile].sort((a, b) => a.id.localeCompare(b.id));
        return jsonResponse(write, writeStatus);
      }
      if (
        init?.method === "PUT" &&
        (url as string).startsWith(`${BASE}/connections/`)
      ) {
        const profile = JSON.parse(String(init.body)) as { id: string };
        list = list.map((entry) => (entry.id === profile.id ? profile : entry));
        return jsonResponse(write, writeStatus);
      }
      if (
        init?.method === "DELETE" &&
        (url as string).startsWith(`${BASE}/connections/`)
      ) {
        const id = (url as string).slice(`${BASE}/connections/`.length);
        list = list.filter((entry) => entry.id !== id);
        return jsonResponse(write, writeStatus);
      }
      if (url === `${BASE}/connections`)
        return jsonResponse({ ok: true, result: list });
      return jsonResponse({ ok: true, result: sampleRun() });
    }),
  };
}

test("saving the assembled profile posts it exactly once and refreshes the selector", async () => {
  const { fetchMock } = stubCatalogManagerFetch({
    ok: true,
    result: { id: "smoke", status: "added" },
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  fillStartForm();
  fireEvent.click(
    screen.getByRole("button", { name: "Save profile to catalog" }),
  );
  await vi.waitFor(() =>
    expect(connectionCalls(fetchMock, "POST")).toHaveLength(1),
  );
  const [url, init] = connectionCalls(fetchMock, "POST")[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/connections`);
  expect(init?.method).toBe("POST");
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers["Content-Type"]).toBe("application/json");
  // The stored body is exactly the profile the dispatch would send — same
  // field assembly, blank optionals omitted.
  expect(JSON.parse(String(init?.body))).toEqual({
    id: "smoke",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "smoke-model",
    baseUrl: "http://127.0.0.1:1",
    keyEnv: "LOOM_SMOKE_KEY",
  });
  // Success: status line plus one refreshed list read; the selector then
  // offers the newly persisted entry.
  expect((await screen.findByTestId("catalog-status")).textContent).toBe(
    'Connection "smoke" added in the catalog.',
  );
  expect(screen.queryByTestId("catalog-error")).toBeNull();
  const reads = fetchMock.mock.calls.filter(
    ([url, init]) => url === `${BASE}/connections` && !init?.method,
  );
  expect(reads).toHaveLength(2); // mount probe + post-write refresh
  const select = screen.getByLabelText("Connection (from the catalog)");
  expect(
    within(select).getByRole("option", { name: "smoke (smoke-model)" }),
  ).toBeTruthy();
});

test("a structured add rejection renders verbatim", async () => {
  stubCatalogManagerFetch({
    ok: false,
    error:
      'CONNECTION_CONFLICT: Connection "smoke" already exists with different settings; remove it first or use a new id.',
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  fillStartForm();
  fireEvent.click(
    screen.getByRole("button", { name: "Save profile to catalog" }),
  );
  const alert = await screen.findByTestId("catalog-error");
  expect(alert.textContent).toBe(
    'CONNECTION_CONFLICT: Connection "smoke" already exists with different settings; remove it first or use a new id.',
  );
  expect(screen.queryByTestId("catalog-status")).toBeNull();
});

test("removing an entry sends zero requests before confirm and exactly one DELETE after", async () => {
  const { fetchMock } = stubCatalogManagerFetch({
    ok: true,
    result: { id: "local-fixture", status: "removed" },
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByTestId("connection-entries");
  // Arming the confirm step sends nothing.
  fireEvent.click(
    screen.getByRole("button", { name: "Remove local-fixture…" }),
  );
  expect(connectionCalls(fetchMock, "DELETE")).toEqual([]);
  expect(screen.getByTestId("confirm-remove-connection")).toBeTruthy();
  // Cancel keeps zero requests; re-arm and confirm for exactly one DELETE.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(connectionCalls(fetchMock, "DELETE")).toEqual([]);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove local-fixture…" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await vi.waitFor(() =>
    expect(connectionCalls(fetchMock, "DELETE")).toHaveLength(1),
  );
  const [url, init] = connectionCalls(fetchMock, "DELETE")[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/connections/local-fixture`);
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  // Success: status line, refreshed list, entry gone from the selector.
  expect((await screen.findByTestId("catalog-status")).textContent).toBe(
    'Connection "local-fixture" removed from the catalog.',
  );
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove local-fixture…" }),
    ).toBeNull(),
  );
  const select = screen.getByLabelText("Connection (from the catalog)");
  expect(
    within(select).queryByRole("option", {
      name: "local-fixture (catalog-fixture-model)",
    }),
  ).toBeNull();
});

test("a structured remove rejection renders verbatim and keeps the confirm armed", async () => {
  stubCatalogManagerFetch({
    ok: false,
    error:
      "UNKNOWN_CONNECTION: Unknown connection id: local-fixture. Run connections list to inspect the catalog.",
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByTestId("connection-entries");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove local-fixture…" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  const alert = await screen.findByTestId("catalog-error");
  expect(alert.textContent).toBe(
    "UNKNOWN_CONNECTION: Unknown connection id: local-fixture. Run connections list to inspect the catalog.",
  );
  expect(screen.getByTestId("confirm-remove-connection")).toBeTruthy();
  expect(screen.queryByTestId("catalog-status")).toBeNull();
});

test("the catalog management UI stays hidden when the catalog is not enabled", async () => {
  stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  expect(await screen.findByTestId("connection-status")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Save profile to catalog" }),
  ).toBeNull();
  expect(screen.queryByTestId("connection-entries")).toBeNull();
});

test("updating the selected connection sends exactly one PUT and refreshes the selector", async () => {
  const { fetchMock } = stubCatalogManagerFetch({
    ok: true,
    result: { id: "local-fixture", status: "updated" },
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  // No selection yet: the entry point exists but is disabled.
  expect(
    (
      screen.getByRole("button", {
        name: "Update selected connection",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await selectConnection("local-fixture");
  expect(
    (
      screen.getByRole("button", {
        name: "Update selected connection",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Update selected connection" }),
  );
  await vi.waitFor(() =>
    expect(connectionCalls(fetchMock, "PUT")).toHaveLength(1),
  );
  const [url, init] = connectionCalls(fetchMock, "PUT")[0] as unknown as [
    string,
    RequestInit | undefined,
  ];
  expect(url).toBe(`${BASE}/connections/local-fixture`);
  expect(init?.method).toBe("PUT");
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers["Content-Type"]).toBe("application/json");
  // The body deep-equals the profile assembled from the prefilled fields —
  // the selector loaded every field of the selected entry.
  expect(JSON.parse(String(init?.body))).toEqual(catalogConnections[0]);
  // Success: status line plus one refreshed list read (mount probe + refresh).
  expect((await screen.findByTestId("catalog-status")).textContent).toBe(
    'Connection "local-fixture" updated in the catalog.',
  );
  expect(screen.queryByTestId("catalog-error")).toBeNull();
  const reads = fetchMock.mock.calls.filter(
    ([url, init]) => url === `${BASE}/connections` && !init?.method,
  );
  expect(reads).toHaveLength(2);
});

test("an idempotent unchanged update renders as success", async () => {
  stubCatalogManagerFetch({
    ok: true,
    result: { id: "local-fixture", status: "unchanged" },
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  await selectConnection("local-fixture");
  fireEvent.click(
    screen.getByRole("button", { name: "Update selected connection" }),
  );
  expect((await screen.findByTestId("catalog-status")).textContent).toBe(
    'Connection "local-fixture" unchanged in the catalog.',
  );
  expect(screen.queryByTestId("catalog-error")).toBeNull();
});

test("a structured update rejection renders verbatim and stays retryable", async () => {
  const { fetchMock } = stubCatalogManagerFetch({
    ok: false,
    error:
      "UNKNOWN_CONNECTION: Unknown connection id: local-fixture. Run connections list to inspect the catalog.",
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  await selectConnection("local-fixture");
  fireEvent.click(
    screen.getByRole("button", { name: "Update selected connection" }),
  );
  const alert = await screen.findByTestId("catalog-error");
  expect(alert.textContent).toBe(
    "UNKNOWN_CONNECTION: Unknown connection id: local-fixture. Run connections list to inspect the catalog.",
  );
  expect(screen.queryByTestId("catalog-status")).toBeNull();
  // The button stays usable: an explicit retry sends exactly one more PUT.
  fireEvent.click(
    screen.getByRole("button", { name: "Update selected connection" }),
  );
  await vi.waitFor(() =>
    expect(connectionCalls(fetchMock, "PUT")).toHaveLength(2),
  );
});

test("editing the profile id after a selection warns before the server rejects it", async () => {
  stubCatalogManagerFetch({
    ok: true,
    result: { id: "smoke", status: "added" },
  });
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  await screen.findByLabelText("Connection (from the catalog)");
  await selectConnection("local-fixture");
  // While the assembled id still names the selected entry there is no warning.
  expect(screen.queryByTestId("connection-id-mismatch")).toBeNull();
  fireEvent.change(screen.getByLabelText("Profile id"), {
    target: { value: "renamed" },
  });
  expect(
    (await screen.findByTestId("connection-id-mismatch")).textContent,
  ).toContain("Profile id differs from the selected connection");
});

test("the update entry point stays hidden when the catalog is not enabled", async () => {
  stubManualCatalogFetch();
  render(<StartForm api={createApi(BASE, TOKEN)} onCancel={() => {}} />);
  expect(await screen.findByTestId("connection-status")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Update selected connection" }),
  ).toBeNull();
});
