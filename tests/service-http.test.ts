import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectionCatalog } from "../src/providers/catalog.js";
import type { RunSummary } from "../src/service/catalog.js";
import { ServiceClient } from "../src/service/client.js";
import {
  LoomService,
  type RunArtifact,
  type RunDiff,
  type RunDiffFile,
  type RunDiffFilePage,
  type ServiceRequest,
  type ServiceResult,
  serviceSocketPath,
} from "../src/service/daemon.js";
import { httpTokenPath, ServiceHttpProjection } from "../src/service/http.js";
import { FeatureStore } from "../src/workflow/feature-store.js";
import type { Evidence } from "../src/workflow/index.js";
import {
  baselineSource,
  createFeatureFixture,
  featureModel,
  git,
  implementedSource,
} from "./feature-fixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const execute = promisify(execFile);
const serviceEntry = fileURLToPath(
  new URL("../src/service/entry.ts", import.meta.url),
);
const cliEntry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const roots: string[] = [];
const services: LoomService[] = [];
const projections: ServiceHttpProjection[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const projection of projections.splice(0)) await projection.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const profile = {
  id: "fixture",
  kind: "openai-compatible",
  protocol: "openai-completions",
  modelId: "feature-fixture",
  baseUrl: "http://invalid.test",
} as const;
const catalogAlpha = {
  id: "alpha",
  kind: "openai-compatible",
  protocol: "openai-completions",
  modelId: "fixture-alpha",
  baseUrl: "http://127.0.0.1:1/v1",
  keyEnv: "LOOM_ALPHA_KEY",
} as const;
const catalogZeta = {
  id: "zeta",
  kind: "anthropic",
  protocol: "anthropic-messages",
  modelId: "fixture-zeta",
} as const;

type HttpResponse = {
  ok: boolean;
  result?: RunSummary | RunSummary[];
  error?: string;
};
async function payload(response: Response): Promise<HttpResponse> {
  return (await response.json()) as HttpResponse;
}
function resultOf(response: Response): Promise<RunSummary> {
  return payload(response).then((body) => body.result as RunSummary);
}
function latestRuns(events: unknown[]): RunSummary[] {
  const latest = events[events.length - 1];
  if (!Array.isArray(latest)) throw new Error("no SSE snapshot yet");
  return latest as RunSummary[];
}

async function httpFixture(behavior: Parameters<typeof featureModel>[0] = {}) {
  const f = await createFeatureFixture();
  roots.push(f.root);
  const model = featureModel(behavior);
  const dataRoot = join(f.root, "service");
  const open = async () => {
    const service = await LoomService.open({
      dataRoot,
      http: true,
      runtimeFactory: () => model.runtime,
    });
    services.push(service);
    return service;
  };
  return { ...f, model, dataRoot, open };
}

type HttpClient = {
  base: string;
  headers: Record<string, string>;
  get: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, body?: unknown, init?: RequestInit) => Promise<Response>;
  del: (path: string, init?: RequestInit) => Promise<Response>;
};

function httpClient(base: string, token: string): HttpClient {
  const headers = { Authorization: `Bearer ${token}` };
  const merge = (init?: RequestInit): RequestInit => {
    const { headers: extra, ...rest } = init ?? {};
    return {
      ...rest,
      headers: { ...headers, ...((extra as Record<string, string>) ?? {}) },
    };
  };
  return {
    base,
    headers,
    get: (path, init) => fetch(`${base}${path}`, merge(init)),
    post: (path, body, init) =>
      fetch(`${base}${path}`, {
        ...merge(init),
        method: "POST",
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    del: (path, init) =>
      fetch(`${base}${path}`, { ...merge(init), method: "DELETE" }),
  };
}

async function client(service: LoomService): Promise<HttpClient> {
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const token = (
    await readFile(httpTokenPath(service.dataRoot), "utf8")
  ).trim();
  return httpClient(`http://127.0.0.1:${port}`, token);
}

/** Reads an SSE response in the background, collecting parsed data payloads. */
async function subscribe(
  connection: { base: string; headers: Record<string, string> },
  events: unknown[],
  signal: AbortSignal,
  onEvent?: () => void,
): Promise<void> {
  const response = await fetch(`${connection.base}/events`, {
    headers: connection.headers,
    signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = response.body;
  if (!body) throw new Error("SSE response has no body");
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        for (const line of block.split("\n"))
          if (line.startsWith("data: ")) {
            events.push(JSON.parse(line.slice("data: ".length)));
            onEvent?.();
          }
        separator = buffer.indexOf("\n\n");
      }
    }
  })().catch(() => {});
}

test("HTTP list and status mirror the socket RunSummary projection", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  const empty = await c.get("/runs");
  expect(empty.status).toBe(200);
  expect(await payload(empty)).toEqual({ ok: true, result: [] });

  const [one, two] = await Promise.all([
    c.post("/runs", { spec: f.spec, profile }),
    c.post("/runs", { spec: f.spec, profile }),
  ]);
  expect(one.status).toBe(200);
  expect(two.status).toBe(200);
  const accepted = await resultOf(one);
  expect(accepted.runId).toBe(f.spec.runId);
  expect((await resultOf(two)).status).toBe(accepted.status);

  const listing = (await payload(await c.get("/runs"))).result as RunSummary[];
  const socket = new ServiceClient(serviceSocketPath(f.dataRoot));
  expect(listing).toEqual(await socket.request({ method: "list" }));
  expect(await resultOf(await c.get(`/runs/${f.spec.runId}`))).toEqual(
    await socket.request({ method: "status", runId: f.spec.runId }),
  );

  const conflicting = await c.post("/runs", {
    spec: { ...f.spec, goal: "changed" },
    profile,
  });
  expect(conflicting.status).toBe(400);
  expect((await payload(conflicting)).error).toContain("differs");

  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      expect((await resultOf(status)).status).toBe("completed");
    },
    { timeout: 20_000 },
  );
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
});

test("services opened without http keep socket-only behavior", async () => {
  const f = await httpFixture();
  const service = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
  });
  services.push(service);
  expect(service.http).toBeUndefined();
  await expect(stat(httpTokenPath(f.dataRoot))).rejects.toThrow("ENOENT");
  expect((await stat(serviceSocketPath(f.dataRoot))).mode & 0o777).toBe(0o600);
  // The socket protocol is unchanged for existing clients.
  const socket = new ServiceClient(serviceSocketPath(f.dataRoot));
  expect(await socket.request({ method: "list" })).toEqual([]);
});

test("HTTP actions pass through cancel, terminal no-op and resume errors", async () => {
  const f = await httpFixture({ pauseStep: "scout" });
  const service = await f.open();
  const c = await client(service);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(() => expect(f.model.calls.length).toBeGreaterThan(0));
  const cancel = await c.post(`/runs/${f.spec.runId}/cancel`);
  expect(cancel.status).toBe(200);
  expect((await resultOf(cancel)).status).toBe("cancelled");
  const again = await c.post(`/runs/${f.spec.runId}/cancel`);
  expect((await resultOf(again)).status).toBe("cancelled");
  const resume = await c.post(`/runs/${f.spec.runId}/resume`);
  expect(resume.status).toBe(400);
  expect(await payload(resume)).toEqual({
    ok: false,
    error: "Cannot resume cancelled Run",
  });
  const unknown = await c.get("/runs/missing-run");
  expect(unknown.status).toBe(404);
  expect(await payload(unknown)).toEqual({ ok: false, error: "Unknown Run" });
});

test("reconcile-budget gates on token first, is POST-only, and maps the structured service errors", async () => {
  const f = await httpFixture({ pauseStep: "scout" });
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  const c = await client(service);
  // The token gate comes first: no or wrong token is 401 with no run data.
  for (const headers of [undefined, { Authorization: "Bearer wrong" }]) {
    const init: RequestInit = headers ? { headers } : {};
    const anonymous = await fetch(
      `${base}/runs/${f.spec.runId}/reconcile-budget`,
      { method: "POST", ...init },
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      ok: false,
      error: "Unauthorized",
    });
  }
  // Non-POST verbs never reach the action; the route adds no other verb.
  expect((await c.get(`/runs/${f.spec.runId}/reconcile-budget`)).status).toBe(
    404,
  );
  // Unknown run ids keep the single 404 mapping.
  const unknown = await c.post("/runs/missing-run/reconcile-budget");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ ok: false, error: "Unknown Run" });
  // A run persisted without initialization has neither Run DB nor ledger.
  await mkdir(join(f.dataRoot, "runs", "pending-run"), { recursive: true });
  await writeFile(
    join(f.dataRoot, "runs", "pending-run", "request.json"),
    JSON.stringify({ spec: { ...f.spec, runId: "pending-run" }, profile }),
  );
  const pending = await c.post("/runs/pending-run/reconcile-budget");
  expect(pending.status).toBe(400);
  expect(await pending.json()).toEqual({
    ok: false,
    error: "No persisted model budget ledger for this database",
  });
  // While the service dispatches the run (lease held), the request fails
  // closed with the structured ownership error, code carried in the message.
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      expect((await resultOf(status)).active).toBe(true);
    },
    { timeout: 20_000 },
  );
  const busy = await c.post(`/runs/${f.spec.runId}/reconcile-budget`);
  expect(busy.status).toBe(400);
  expect((await payload(busy)).error).toMatch(
    /^DATABASE_IN_USE: Database is already owned by another Loom runtime: /,
  );
  const cancel = await c.post(`/runs/${f.spec.runId}/cancel`);
  expect((await resultOf(cancel)).status).toBe("cancelled");
});

test("blocked resume surfaces the structured service error over HTTP", async () => {
  const f = await httpFixture({
    onCall: (step, _context, afterTool) => {
      if (step === "implement" && afterTool)
        throw new Error("local fixture disconnect after write");
    },
  });
  const service = await f.open();
  const c = await client(service);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      const run = await resultOf(status);
      expect(run.active).toBe(false);
      expect(run.operationId).toBeTruthy();
    },
    { timeout: 20_000 },
  );
  const resume = await c.post(`/runs/${f.spec.runId}/resume`);
  expect(resume.status).toBe(400);
  expect((await payload(resume)).error).toContain("reconciliation");
});

test("SSE sends the initial snapshot and pushes run completion", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  const events: unknown[] = [];
  const controller = new AbortController();
  await subscribe(c, events, controller.signal);
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  expect(events[0]).toEqual([]);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    () => {
      const latest = latestRuns(events);
      expect(latest.find((run) => run.runId === f.spec.runId)?.status).toBe(
        "completed",
      );
    },
    { timeout: 20_000 },
  );
  controller.abort();
});

test("aborting SSE and HTTP clients never stops the service or its runs", async () => {
  const f = await httpFixture({ pauseStep: "scout" });
  const service = await f.open();
  const c = await client(service);
  const events: unknown[] = [];
  const controller = new AbortController();
  await subscribe(c, events, controller.signal);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    () => {
      const latest = latestRuns(events);
      expect(latest.some((run) => run.runId === f.spec.runId)).toBe(true);
    },
    { timeout: 20_000 },
  );
  controller.abort();
  const aborted = new AbortController();
  const pending = c.get("/runs", { signal: aborted.signal });
  aborted.abort();
  await expect(pending).rejects.toThrow();
  // A fresh client still reaches the same service; the run survived detach.
  const fresh = await client(service);
  const run = await resultOf(await fresh.get(`/runs/${f.spec.runId}`));
  expect(run.runId).toBe(f.spec.runId);
  expect(run.status).not.toBe("completed");
  const cancel = await fresh.post(`/runs/${f.spec.runId}/cancel`);
  expect((await resultOf(cancel)).status).toBe("cancelled");
});

test("SSE pushes steps-only snapshot diffs and stays silent without changes", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "loom-http-stub-"));
  roots.push(dataRoot);
  const running = (steps: unknown[]) =>
    [
      { runId: "addition", status: "running", active: true, steps },
    ] as unknown as RunSummary[];
  const snapshots = [
    running([{ id: "scout", status: "completed" }]),
    running([
      { id: "scout", status: "completed" },
      { id: "contract", status: "running" },
    ]),
  ];
  const duplicate = snapshots[1];
  if (!duplicate) throw new Error("snapshot missing");
  snapshots.push(duplicate); // identical snapshot must not push again
  let index = 0;
  const transport = {
    request: async (request: ServiceRequest): Promise<ServiceResult> => {
      if (request.method !== "list") throw new Error("unexpected action");
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      if (!snapshot) throw new Error("snapshot missing");
      return snapshot;
    },
  };
  const projection = await ServiceHttpProjection.open(transport, {
    dataRoot,
    pollIntervalMs: 25,
  });
  projections.push(projection);
  expect(projection.address.host).toBe("127.0.0.1");
  expect((await stat(httpTokenPath(dataRoot))).mode & 0o777).toBe(0o600);
  const token = (await readFile(httpTokenPath(dataRoot), "utf8")).trim();
  const events: unknown[] = [];
  const controller = new AbortController();
  await subscribe(
    httpClient(`http://127.0.0.1:${projection.address.port}`, token),
    events,
    controller.signal,
    () => {
      index = Math.min(index + 1, snapshots.length - 1);
    },
  );
  await vi.waitFor(() => expect(events.length).toBe(2));
  const first = events[0];
  const second = events[1];
  if (!Array.isArray(first) || !Array.isArray(second))
    throw new Error("expected two SSE snapshots");
  const firstRuns = first as RunSummary[];
  const secondRuns = second as RunSummary[];
  expect(secondRuns[0]?.status).toBe(firstRuns[0]?.status);
  expect(secondRuns[0]?.steps).toHaveLength(2);
  expect(firstRuns[0]?.steps).toHaveLength(1);
  // Identical snapshots produce no further events across several intervals.
  const settled = events.length;
  await new Promise((accept) => setTimeout(accept, 150));
  expect(events.length).toBe(settled);
  controller.abort();
});

test("missing or wrong tokens get 401 without leaking run data", async () => {
  const f = await httpFixture({ pauseStep: "scout" });
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  const token = (await readFile(httpTokenPath(f.dataRoot), "utf8")).trim();
  const c = await client(service);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(() => expect(f.model.calls.length).toBeGreaterThan(0));
  const attempts: Array<Record<string, string> | undefined> = [
    undefined,
    { Authorization: "Bearer not-the-token" },
    { Authorization: `Bearer ${token.slice(0, 8)}` },
    { Authorization: token },
  ];
  for (const headers of attempts) {
    const init: RequestInit = headers ? { headers } : {};
    const response = await fetch(`${base}/runs`, init);
    expect(response.status).toBe(401);
    expect(await payload(response)).toEqual({
      ok: false,
      error: "Unauthorized",
    });
    const stream = await fetch(`${base}/events`, init);
    expect(stream.status).toBe(401);
    expect(await payload(stream)).toEqual({ ok: false, error: "Unauthorized" });
  }
  // Loopback bind plus route and body hardening with a valid token.
  expect(service.http?.address.host).toBe("127.0.0.1");
  const unknownRoute = await c.get("/nope");
  expect(unknownRoute.status).toBe(404);
  const badRunId = await c.get("/runs/not%20a%20run");
  expect(badRunId.status).toBe(404);
  const malformed = await c.post("/runs", "{not json");
  expect(malformed.status).toBe(400);
  expect(await payload(malformed)).toEqual({
    ok: false,
    error: "Invalid JSON body",
  });
  const shapeless = await c.post("/runs", { spec: f.spec });
  expect(shapeless.status).toBe(400);
  expect((await payload(shapeless)).error).toContain("spec and profile");
  let failed = false;
  let oversized: Response | undefined;
  try {
    oversized = await c.post("/runs", "x".repeat(200_000));
  } catch {
    failed = true;
  }
  expect(failed || oversized?.status === 413).toBe(true);
});

test("diff endpoint projects per-file working, staged, and untracked changes", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      expect((await resultOf(status)).status).toBe("completed");
    },
    { timeout: 20_000 },
  );
  // The completed run leaves a working change; add one staged and one untracked file.
  await writeFile(join(f.spec.worktreePath, "notes.txt"), "staged note\n");
  await git(f.spec.worktreePath, "add", "notes.txt");
  await writeFile(join(f.spec.worktreePath, "untracked.txt"), "loose note\n");
  const response = await c.get(`/runs/${f.spec.runId}/diff`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; result: RunDiff };
  expect(body.ok).toBe(true);
  const diff = body.result;
  expect(diff.root).toBe(await realpath(f.spec.worktreePath));
  expect(diff.truncatedFiles).toBe(false);
  expect(diff.files.map((file) => file.path).sort()).toEqual([
    "notes.txt",
    "sum.js",
    "untracked.txt",
  ]);
  const entries = new Map(
    diff.diffs.map((entry) => [`${entry.mode}:${entry.path}`, entry]),
  );
  // Contract: exactly one entry per file and layer — staged-only files never
  // gain a working entry and working-only files never gain a staged one.
  expect(new Set(entries.keys())).toEqual(
    new Set(["working:sum.js", "staged:notes.txt", "working:untracked.txt"]),
  );
  expect(entries.get("working:sum.js")?.text).toContain(
    `-${baselineSource.trim()}`,
  );
  expect(entries.get("working:sum.js")?.text).toContain(
    `+${implementedSource.trim()}`,
  );
  expect(entries.get("staged:notes.txt")?.text).toContain("+staged note");
  expect(entries.get("working:untracked.txt")?.text).toContain(
    "Untracked file: untracked.txt",
  );
  expect(entries.get("working:untracked.txt")?.text).toContain("loose note");
  // A clean worktree projects an empty aggregate, not an error.
  await git(f.spec.worktreePath, "restore", "--staged", ".");
  await git(f.spec.worktreePath, "restore", ".");
  await git(f.spec.worktreePath, "clean", "-fdq");
  const clean = await c.get(`/runs/${f.spec.runId}/diff`);
  expect(clean.status).toBe(200);
  const emptied = ((await clean.json()) as { result: RunDiff }).result;
  expect(emptied.root).toBe(diff.root);
  expect(emptied.files).toEqual([]);
  expect(emptied.diffs).toEqual([]);
  expect(emptied.truncatedFiles).toBe(false);
});

/** Completes a fixture run and waits for the terminal status over HTTP. */
async function completedRun(
  f: Awaited<ReturnType<typeof httpFixture>>,
  c: HttpClient,
): Promise<void> {
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      expect((await resultOf(status)).status).toBe("completed");
    },
    { timeout: 20_000 },
  );
}

/** The staged/untracked setup shared by the diff endpoint regressions. */
async function mixedLayers(
  f: Awaited<ReturnType<typeof httpFixture>>,
): Promise<void> {
  await writeFile(join(f.spec.worktreePath, "notes.txt"), "staged note\n");
  await git(f.spec.worktreePath, "add", "notes.txt");
  await writeFile(join(f.spec.worktreePath, "untracked.txt"), "loose note\n");
}

async function diffResult(c: HttpClient, runId: string): Promise<RunDiff> {
  const response = await c.get(`/runs/${runId}/diff`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { ok: boolean; result: RunDiff }).result;
}

test("diff file endpoint projects one file and layer with the aggregate truncation semantics", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await completedRun(f, c);
  await mixedLayers(f);
  // A >64 KiB untracked file pins the shared truncation marker semantics.
  await writeFile(
    join(f.spec.worktreePath, "big.txt"),
    `${"x".repeat(64 * 1024 + 512)}\n`,
  );
  const aggregate = await diffResult(c, f.spec.runId);

  const single = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=sum.js&mode=working`,
  );
  expect(single.status).toBe(200);
  const view = ((await single.json()) as { result: RunDiffFile }).result;
  const entry = aggregate.diffs.find(
    (item) => item.path === "sum.js" && item.mode === "working",
  );
  expect(entry).toBeTruthy();
  // Deep equality with the aggregate entry; only the fresh observation time differs.
  expect(view).toEqual({
    root: aggregate.root,
    observedAt: expect.any(Number),
    path: "sum.js",
    mode: "working",
    text: entry?.text,
  });

  const staged = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=notes.txt&mode=staged`,
  );
  expect(staged.status).toBe(200);
  expect(
    ((await staged.json()) as { result: RunDiffFile }).result.text,
  ).toContain("+staged note");
  const untracked = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=untracked.txt&mode=working`,
  );
  expect(untracked.status).toBe(200);
  expect(
    ((await untracked.json()) as { result: RunDiffFile }).result.text,
  ).toContain("Untracked file: untracked.txt");

  // The oversized preview keeps the 64 KiB marker in both projections.
  const big = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=big.txt&mode=working`,
  );
  expect(big.status).toBe(200);
  const bigView = ((await big.json()) as { result: RunDiffFile }).result;
  const bigEntry = aggregate.diffs.find((item) => item.path === "big.txt");
  expect(bigView.text).toContain("… preview truncated (64 KiB)");
  expect(bigView.text).toBe(bigEntry?.text);

  // Layer contract: staged-only files have no working layer, untracked files
  // never have a staged one — both refuse with the same structured error.
  for (const query of [
    "path=notes.txt&mode=working",
    "path=untracked.txt&mode=staged",
  ]) {
    const layered = await c.get(`/runs/${f.spec.runId}/diff/file?${query}`);
    expect(layered.status).toBe(400);
    expect(await layered.json()).toEqual({
      ok: false,
      error: "Diff mode does not apply to this file",
    });
  }
  const unknownPath = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=nope.txt&mode=working`,
  );
  expect(unknownPath.status).toBe(400);
  expect(await unknownPath.json()).toEqual({
    ok: false,
    error: "Unknown diff file path",
  });
  const badMode = await c.get(
    `/runs/${f.spec.runId}/diff/file?path=sum.js&mode=both`,
  );
  expect(badMode.status).toBe(400);
  expect(await badMode.json()).toEqual({
    ok: false,
    error: "Invalid diff file mode",
  });
  for (const query of ["path=sum.js", ""]) {
    const missing = await c.get(`/runs/${f.spec.runId}/diff/file?${query}`);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "diff file query requires path and mode",
    });
  }
});

test("diff files endpoint pages the full changed-file index from the same snapshot", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await completedRun(f, c);
  await mixedLayers(f);
  const aggregate = await diffResult(c, f.spec.runId);
  expect(aggregate.files).toHaveLength(3);

  // The default page covers everything here and mirrors the aggregate list.
  const whole = await c.get(`/runs/${f.spec.runId}/diff/files`);
  expect(whole.status).toBe(200);
  const index = ((await whole.json()) as { result: RunDiffFilePage }).result;
  expect(index).toEqual({
    root: await realpath(f.spec.worktreePath),
    observedAt: expect.any(Number),
    total: 3,
    files: aggregate.files,
    nextAfter: null,
  });

  // Explicit limits split pages along the snapshot order; after is the path
  // of the previous page's last entry.
  const first = await c.get(`/runs/${f.spec.runId}/diff/files?limit=2`);
  expect(first.status).toBe(200);
  const pageOne = ((await first.json()) as { result: RunDiffFilePage }).result;
  expect(pageOne.total).toBe(3);
  expect(pageOne.files).toEqual(aggregate.files.slice(0, 2));
  expect(pageOne.nextAfter).toBe(aggregate.files[1]?.path);
  const second = await c.get(
    `/runs/${f.spec.runId}/diff/files?after=${pageOne.nextAfter}&limit=2`,
  );
  expect(second.status).toBe(200);
  const pageTwo = ((await second.json()) as { result: RunDiffFilePage }).result;
  expect(pageTwo.files).toEqual(aggregate.files.slice(2));
  expect(pageTwo.nextAfter).toBeNull();

  // A cursor at the last entry yields an explicit empty final page.
  const tail = await c.get(
    `/runs/${f.spec.runId}/diff/files?after=${aggregate.files[2]?.path}`,
  );
  expect(tail.status).toBe(200);
  const empty = ((await tail.json()) as { result: RunDiffFilePage }).result;
  expect(empty).toEqual({
    root: index.root,
    observedAt: expect.any(Number),
    total: 3,
    files: [],
    nextAfter: null,
  });

  // Stale cursors and invalid limits refuse with structured errors.
  const stale = await c.get(
    `/runs/${f.spec.runId}/diff/files?after=missing.txt`,
  );
  expect(stale.status).toBe(400);
  expect(await stale.json()).toEqual({
    ok: false,
    error: "Unknown diff files cursor",
  });
  // Tightened HTTP-layer literal rule: Number()'s loose parsing let these
  // forms through the daemon's 1-200 range check (5e1→50, 0x10→16); a raw "+5"
  // and "%205" both decode to " 5" (Number→5) and "%2B5" to "+5" (Number→5).
  // The empty string was already 400 pre-tightening (Number("")=0 fails the
  // range check), so it pins the literal rule, not a behavior change.
  for (const limit of [
    "0",
    "201",
    "abc",
    "2.5",
    "5e1",
    "0x10",
    "+5",
    "%205",
    "%2B5",
    "",
  ]) {
    const invalid = await c.get(
      `/runs/${f.spec.runId}/diff/files?limit=${limit}`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "Invalid diff files limit",
    });
  }
});

test("the paginated file index exposes changes beyond the aggregate 50-file cap", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await completedRun(f, c);
  const generated = Array.from(
    { length: 55 },
    (_, i) => `gen-${String(i).padStart(2, "0")}.txt`,
  );
  for (const path of generated)
    await writeFile(join(f.spec.worktreePath, path), `${path}\n`);
  // The aggregate stays capped and flags truncation as before.
  const aggregate = await diffResult(c, f.spec.runId);
  expect(aggregate.truncatedFiles).toBe(true);
  expect(aggregate.files).toHaveLength(50);

  const first = await c.get(`/runs/${f.spec.runId}/diff/files`);
  const pageOne = ((await first.json()) as { result: RunDiffFilePage }).result;
  expect(pageOne.total).toBe(56);
  expect(pageOne.files).toEqual(aggregate.files);
  expect(pageOne.nextAfter).toBeTruthy();
  const second = await c.get(
    `/runs/${f.spec.runId}/diff/files?after=${pageOne.nextAfter}&limit=200`,
  );
  const pageTwo = ((await second.json()) as { result: RunDiffFilePage }).result;
  expect(pageTwo.total).toBe(56);
  expect(pageTwo.files).toHaveLength(6);
  expect(pageTwo.nextAfter).toBeNull();
  const walked = [...pageOne.files, ...pageTwo.files];
  expect(new Set(walked.map((file) => file.path)).size).toBe(56);
  expect(new Set(walked.map((file) => file.path))).toEqual(
    new Set(["sum.js", ...generated]),
  );
});

test("evidence endpoint mirrors the read-only Run DB evidence projection", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await c.post("/runs", { spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await c.get(`/runs/${f.spec.runId}`);
      expect((await resultOf(status)).status).toBe("completed");
    },
    { timeout: 20_000 },
  );
  const response = await c.get(`/runs/${f.spec.runId}/evidence`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; result: Evidence[] };
  expect(body.ok).toBe(true);
  const database = new DatabaseSync(
    join(f.dataRoot, "runs", f.spec.runId, "agent.sqlite"),
    { readOnly: true },
  );
  try {
    const snapshot = FeatureStore.inspectDatabase(database);
    expect(snapshot?.run.evidence).toEqual(body.result);
  } finally {
    database.close();
  }
  expect(body.result.length).toBeGreaterThan(0);
  expect(body.result.some((item) => item.kind === "command")).toBe(true);
});

test("artifact endpoint gates on token first with no leakage", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  const token = (await readFile(httpTokenPath(f.dataRoot), "utf8")).trim();
  const path = `/runs/${f.spec.runId}/artifact?evidence=${randomUUID()}`;
  const attempts: Array<Record<string, string> | undefined> = [
    undefined,
    { Authorization: "Bearer not-the-token" },
    { Authorization: `Bearer ${token.slice(0, 8)}` },
    { Authorization: token },
  ];
  for (const headers of attempts) {
    const init: RequestInit = headers ? { headers } : {};
    const response = await fetch(`${base}${path}`, init);
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toBe(
      `${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`,
    );
    expect(text).not.toContain(token);
  }
});

test("artifact endpoint requires the evidence query and keeps unknown routes 404", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  // Missing query parameter: rejected at the HTTP layer like diff/file.
  const missing = await c.get(`/runs/${f.spec.runId}/artifact`);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({
    ok: false,
    error: "artifact query requires evidence",
  });
  // Unknown run ids keep the single 404 mapping.
  const unknown = await c.get(
    `/runs/missing-run/artifact?evidence=${randomUUID()}`,
  );
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ ok: false, error: "Unknown Run" });
  // Sub-routes and non-GET methods stay 404; the route adds no other verbs.
  expect((await c.get(`/runs/${f.spec.runId}/artifact/body`)).status).toBe(404);
  expect(
    (await c.post(`/runs/${f.spec.runId}/artifact?evidence=x`)).status,
  ).toBe(404);
});

test("artifact endpoint mirrors the socket body projection and decodes encoded ids", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const c = await client(service);
  await completedRun(f, c);
  const socket = new ServiceClient(serviceSocketPath(f.dataRoot));
  const evidence = await socket.request({
    method: "evidence",
    runId: f.spec.runId,
  });
  const entry = evidence.find((item) => item.kind === "artifact");
  expect(entry).toBeTruthy();
  if (!entry) throw new Error("fixture run has no artifact evidence");

  const response = await c.get(
    `/runs/${f.spec.runId}/artifact?evidence=${encodeURIComponent(entry.id)}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ok: boolean;
    result: RunArtifact;
  };
  expect(body.ok).toBe(true);
  expect(body.result).toEqual(
    await socket.request({
      method: "artifact",
      runId: f.spec.runId,
      evidenceId: entry.id,
    }),
  );
  expect(body.result.truncated).toBe(false);
  expect(body.result.byteLength).toBeGreaterThan(0);

  // A percent-encoded id form decodes to the same projection (UUIDs contain
  // hyphens, which encodeURIComponent leaves alone; %2D pins the decoding).
  const encoded = await c.get(
    `/runs/${f.spec.runId}/artifact?evidence=${entry.id.replaceAll("-", "%2D")}`,
  );
  expect(encoded.status).toBe(200);
  expect(((await encoded.json()) as { result: RunArtifact }).result).toEqual(
    body.result,
  );

  // A well-formed foreign evidence id is the structured 400, not a 404; an
  // empty value passes the HTTP layer check and is refused by the service.
  const foreign = await c.get(
    `/runs/${f.spec.runId}/artifact?evidence=${randomUUID()}`,
  );
  expect(foreign.status).toBe(400);
  expect(await foreign.json()).toEqual({
    ok: false,
    error: "Unknown evidence id",
  });
  const empty = await c.get(`/runs/${f.spec.runId}/artifact?evidence=`);
  expect(empty.status).toBe(400);
  expect(await empty.json()).toEqual({
    ok: false,
    error: "Invalid artifact evidence id",
  });
});

test("diff, evidence, artifact, and file-level endpoints gate on token, 404 unknown runs, and report pending runs", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  const readPaths = [
    "/runs/pending-run/diff",
    "/runs/pending-run/evidence",
    "/runs/pending-run/artifact?evidence=00000000-0000-0000-0000-000000000000",
    "/runs/pending-run/diff/file?path=sum.js&mode=working",
    "/runs/pending-run/diff/files",
  ];
  for (const path of readPaths) {
    const anonymous = await fetch(`${base}${path}`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      ok: false,
      error: "Unauthorized",
    });
  }
  const c = await client(service);
  for (const path of [
    "/runs/missing-run/diff",
    "/runs/missing-run/evidence",
    "/runs/missing-run/artifact?evidence=00000000-0000-0000-0000-000000000000",
    "/runs/missing-run/diff/file?path=sum.js&mode=working",
    "/runs/missing-run/diff/files",
  ]) {
    const unknown = await c.get(path);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, error: "Unknown Run" });
  }
  // A run persisted without initialization has neither worktree nor Run DB.
  await mkdir(join(f.dataRoot, "runs", "pending-run"), { recursive: true });
  await writeFile(
    join(f.dataRoot, "runs", "pending-run", "request.json"),
    JSON.stringify({ spec: { ...f.spec, runId: "pending-run" }, profile }),
  );
  const pending = await resultOf(await c.get("/runs/pending-run"));
  expect(pending.status).toBe("initialization_pending");
  expect(pending.workspace).toBe(null);
  for (const path of readPaths) {
    const response = await c.get(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Run initialization incomplete; explicit resume required",
    });
  }
});

test("diff-file and diff-files share the run id entrance guard over the socket", async () => {
  const f = await httpFixture();
  await f.open();
  const socket = new ServiceClient(serviceSocketPath(f.dataRoot));
  // The socket overloads are narrower than the runtime protocol; one valid
  // overload shape carries any method/runId pair verbatim.
  const rawRequest = (request: unknown) =>
    socket.request(request as { method: "status"; runId: string });
  for (const method of ["diff-file", "diff-files"] as const) {
    const extra =
      method === "diff-file" ? { path: "sum.js", mode: "working" } : {};
    for (const runId of ["runs/addition", "", "a".repeat(81), "点"]) {
      await expect(rawRequest({ method, runId, ...extra })).rejects.toThrow(
        "Invalid service method or run id",
      );
    }
    await expect(rawRequest({ method, runId: 123, ...extra })).rejects.toThrow(
      "Invalid service method or run id",
    );
    // Well-formed unknown ids keep the existing Unknown Run semantics.
    await expect(
      rawRequest({ method, runId: "missing-run", ...extra }),
    ).rejects.toThrow("Unknown Run");
  }
});

test("static workbench assets serve without a token and cannot escape webRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-http-static-"));
  roots.push(root);
  const dataRoot = join(root, "service");
  await mkdir(dataRoot);
  const webRoot = join(root, "web-dist");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  const indexHtml =
    "<!doctype html><html><title>loom workbench fixture</title></html>";
  await writeFile(join(webRoot, "index.html"), indexHtml);
  await writeFile(
    join(webRoot, "assets", "app.js"),
    "console.log('fixture asset')\n",
  );
  // A secret adjacent to webRoot (mirrors http-token sitting next to a dist).
  const secret = "secret-token-material";
  await writeFile(join(root, "http-token"), secret);
  // A symlink inside webRoot pointing outside must not be served either.
  await symlink(join(root, "http-token"), join(webRoot, "leak.txt"));
  const transport = {
    request: async (request: ServiceRequest): Promise<ServiceResult> => {
      if (request.method === "list") return [];
      throw new Error("unexpected action");
    },
  };
  const projection = await ServiceHttpProjection.open(transport, {
    dataRoot,
    webRoot,
    pollIntervalMs: 25,
  });
  projections.push(projection);
  const base = `http://127.0.0.1:${projection.address.port}`;

  // Index and assets are served without any token (same-origin workbench).
  const home = await fetch(`${base}/`);
  expect(home.status).toBe(200);
  expect(home.headers.get("content-type")).toContain("text/html");
  expect(await home.text()).toBe(indexHtml);
  const asset = await fetch(`${base}/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/javascript");
  expect(await asset.text()).toContain("fixture asset");
  const head = await fetch(`${base}/`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toContain("text/html");

  // Every traversal/encoding escape attempt stays 404 and leaks nothing.
  const token = (await readFile(httpTokenPath(dataRoot), "utf8")).trim();
  const c = httpClient(base, token);
  const escapes = [
    "/../http-token",
    "/..%2fhttp-token",
    "/%2e%2e/http-token",
    "/..%2F..%2Fhttp-token",
    "/assets%2f..%2f..%2fhttp-token",
    "/assets/..%2f..%2fhttp-token",
    "/..%5chttp-token",
    "/%2f%2fhttp-token",
    "/etc/passwd",
    "/leak.txt",
  ];
  for (const path of escapes) {
    const attempt = await c.get(path);
    expect(attempt.status, path).toBe(404);
    expect(await attempt.text(), path).not.toContain(secret);
  }
  // A leading "//" makes the URL spec parse the next segment as the authority,
  // so the request path collapses to "/" and serves index.html — no file
  // outside webRoot is reachable, and nothing beyond the public index shows.
  const authorityQuirk = await c.get("//http-token");
  expect(authorityQuirk.status).toBe(200);
  expect(await authorityQuirk.text()).toBe(indexHtml);
  // Missing files without a token keep the data-only 401 fall-through.
  const anonymous = await fetch(`${base}/missing.js`);
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ ok: false, error: "Unauthorized" });

  // Data endpoints stay token-gated while static serving is active.
  const unauthRuns = await fetch(`${base}/runs`);
  expect(unauthRuns.status).toBe(401);
  const unauthEvents = await fetch(`${base}/events`);
  expect(unauthEvents.status).toBe(401);
  const runs = await c.get("/runs");
  expect(runs.status).toBe(200);
  expect(await runs.json()).toEqual({ ok: true, result: [] });
});

test("closing the service or the projection alone removes the http-token file", async () => {
  const f = await httpFixture();
  const service = await f.open();
  await stat(httpTokenPath(f.dataRoot));
  await service.close();
  await expect(stat(httpTokenPath(f.dataRoot))).rejects.toThrow("ENOENT");
  const dataRoot = await mkdtemp(join(tmpdir(), "loom-http-token-"));
  roots.push(dataRoot);
  const projection = await ServiceHttpProjection.open(
    { request: async () => [] },
    { dataRoot, pollIntervalMs: 25 },
  );
  projections.push(projection);
  await projection.close();
  await expect(stat(httpTokenPath(dataRoot))).rejects.toThrow("ENOENT");
});

test("stalled or interrupted request bodies get explicit responses, not silent hangs", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "loom-http-stall-"));
  roots.push(dataRoot);
  const transport = {
    request: async (request: ServiceRequest): Promise<ServiceResult> => {
      if (request.method === "list") return [];
      throw new Error("unexpected action");
    },
  };
  const projection = await ServiceHttpProjection.open(transport, {
    dataRoot,
    pollIntervalMs: 25,
    bodyTimeoutMs: 300,
  });
  projections.push(projection);
  const token = (await readFile(httpTokenPath(dataRoot), "utf8")).trim();
  const port = projection.address.port;

  /** Raw socket sends headers plus a partial Content-Length body, then stalls. */
  const stall = (path: string) =>
    new Promise<{ received: string; closed: boolean }>((resolve) => {
      const socket = createConnection(port, "127.0.0.1");
      let received = "";
      let closed = false;
      // Nothing must take this long: the old implementation hung here silently.
      const cap = setTimeout(() => {
        socket.destroy();
        resolve({ received, closed });
      }, 3_000);
      socket.on("connect", () => {
        socket.write(
          `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 64\r\n\r\n{"spec":`,
        );
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => {
        closed = true;
        clearTimeout(cap);
        resolve({ received, closed });
      });
      socket.on("error", () => {});
    });
  for (const path of ["/runs", "/runs/addition/cancel"]) {
    const outcome = await stall(path);
    expect(outcome.received).toMatch(/HTTP\/1\.1 408/);
    expect(outcome.closed).toBe(true);
  }
  // A client interrupting mid-body must not wedge the projection either.
  const interrupted = createConnection(port, "127.0.0.1");
  await new Promise<void>((ready) => interrupted.once("connect", ready));
  interrupted.write(
    `POST /runs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: 64\r\n\r\n{"spec":`,
  );
  interrupted.destroy();
  const healthy = await fetch(`http://127.0.0.1:${port}/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(healthy.status).toBe(200);
  expect(await healthy.json()).toEqual({ ok: true, result: [] });
});

test("GET /connections is token-gated, mirrors the socket, and errors when disabled", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  // The token gate comes first: no or wrong token is 401 with no entries.
  for (const headers of [undefined, { Authorization: "Bearer wrong" }]) {
    const init: RequestInit = headers ? { headers } : {};
    const anonymous = await fetch(`http://127.0.0.1:${port}/connections`, init);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      ok: false,
      error: "Unauthorized",
    });
  }
  // Without --catalog the route exists but the capability is disabled: the
  // daemon's exact structured error surfaces with status 400.
  const c = await client(service);
  const disabled = await c.get("/connections");
  expect(disabled.status).toBe(400);
  expect(await disabled.json()).toEqual({
    ok: false,
    error:
      "Connection catalog is not enabled; start the service with --catalog DIR",
  });
  // Unknown sub-routes stay 404; the rest of the surface is unchanged.
  expect((await c.get("/connections/nope")).status).toBe(404);
  expect(await payload(await c.get("/runs"))).toEqual({ ok: true, result: [] });
  await service.close();

  // Enabled via --catalog: the HTTP result deep-equals the socket result and
  // the catalog's own sorted projection.
  const catalogDirectory = join(f.root, "catalog");
  const catalog = new ConnectionCatalog(catalogDirectory);
  await catalog.add(catalogZeta);
  await catalog.add(catalogAlpha);
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    http: true,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  const c2 = await client(enabled);
  const response = await c2.get("/connections");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; result: unknown };
  expect(body.ok).toBe(true);
  const socket = new ServiceClient(serviceSocketPath(f.dataRoot));
  expect(body.result).toEqual(await socket.request({ method: "connections" }));
  expect(body.result).toEqual([catalogAlpha, catalogZeta]);
});

test("static assets never shadow /connections or its subpaths", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-http-conn-static-"));
  roots.push(root);
  const transport = {
    request: async (request: ServiceRequest): Promise<ServiceResult> => {
      if (request.method === "list") return [];
      if (request.method === "connections") return [catalogAlpha];
      throw new Error("unexpected action");
    },
  };
  const open = async (webRoot: string) => {
    const dataRoot = join(
      root,
      `service-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dataRoot);
    const projection = await ServiceHttpProjection.open(transport, {
      dataRoot,
      webRoot,
      pollIntervalMs: 25,
    });
    projections.push(projection);
    const token = (await readFile(httpTokenPath(dataRoot), "utf8")).trim();
    return { base: `http://127.0.0.1:${projection.address.port}`, token };
  };

  // Shape 1: a literal "connections" file in webRoot — the exact data path
  // must keep its token gate and never serve the file.
  const fileRoot = join(root, "web-file");
  await mkdir(fileRoot);
  const secret = "static-connections-secret";
  await writeFile(
    join(fileRoot, "index.html"),
    "<!doctype html><title>x</title>",
  );
  await writeFile(join(fileRoot, "connections"), secret);
  const fileProjection = await open(fileRoot);
  const anonymousFile = await fetch(`${fileProjection.base}/connections`);
  expect(anonymousFile.status).toBe(401);
  expect(await anonymousFile.json()).toEqual({
    ok: false,
    error: "Unauthorized",
  });
  const c = httpClient(fileProjection.base, fileProjection.token);
  const data = await c.get("/connections");
  expect(data.status).toBe(200);
  const dataText = await data.text();
  expect(JSON.parse(dataText)).toEqual({ ok: true, result: [catalogAlpha] });
  expect(dataText).not.toContain(secret);

  // Shape 2: a connections/ directory with a servable file — the subpath
  // must fall through to the API layer (401 anonymous, 404 with token),
  // never to static serving.
  const dirRoot = join(root, "web-dir");
  await mkdir(join(dirRoot, "connections"), { recursive: true });
  await writeFile(join(dirRoot, "connections", "note.txt"), secret);
  const dirProjection = await open(dirRoot);
  const anonymousSub = await fetch(
    `${dirProjection.base}/connections/note.txt`,
  );
  expect(anonymousSub.status).toBe(401);
  expect(await anonymousSub.text()).not.toContain(secret);
  const c2 = httpClient(dirProjection.base, dirProjection.token);
  const sub = await c2.get("/connections/note.txt");
  expect(sub.status).toBe(404);
  expect(await sub.text()).not.toContain(secret);
});

/** Typed envelope reader for the new write endpoints' assertions. */
const bodyOf = (
  response: Response,
): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
  response.json() as Promise<{ ok: boolean; result?: unknown; error?: string }>;

test("POST /connections and DELETE /connections/:id manage the catalog behind the token gate", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  // The token gate comes first: no or wrong token is 401 with no catalog data.
  for (const headers of [undefined, { Authorization: "Bearer wrong" }]) {
    const init: RequestInit = headers ? { headers } : {};
    const post = await fetch(`${base}/connections`, {
      method: "POST",
      ...init,
    });
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({ ok: false, error: "Unauthorized" });
    const remove = await fetch(`${base}/connections/alpha`, {
      method: "DELETE",
      ...init,
    });
    expect(remove.status).toBe(401);
    expect(await remove.json()).toEqual({ ok: false, error: "Unauthorized" });
  }
  // Without --catalog the routes exist but the capability is disabled: the
  // daemon's exact structured error, 400 for both verbs like the read.
  const c = await client(service);
  const disabledAdd = await c.post("/connections", catalogAlpha);
  expect(disabledAdd.status).toBe(400);
  expect(await disabledAdd.json()).toEqual({
    ok: false,
    error:
      "Connection catalog is not enabled; start the service with --catalog DIR",
  });
  const disabledRemove = await c.del("/connections/alpha");
  expect(disabledRemove.status).toBe(400);
  expect(await disabledRemove.json()).toEqual({
    ok: false,
    error:
      "Connection catalog is not enabled; start the service with --catalog DIR",
  });
  await service.close();

  // Enabled via --catalog on a directory that does not exist yet: writes use
  // the CLI's on-demand owner-only bootstrap, not the read side's refusal.
  const catalogDirectory = join(f.root, "http-write-catalog");
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    http: true,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  const c2 = await client(enabled);
  const added = await c2.post("/connections", catalogAlpha);
  expect(added.status).toBe(200);
  expect(await added.json()).toEqual({
    ok: true,
    result: { id: "alpha", status: "added" },
  });
  // The on-disk document is exactly what the CLI write path persists…
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { alpha: catalogAlpha } });
  // …and GET /connections behavior is unchanged (same projection source).
  const listed = await c2.get("/connections");
  expect(listed.status).toBe(200);
  expect((await bodyOf(listed)).result).toEqual([catalogAlpha]);

  // Idempotent re-add and same-id conflict keep the socket semantics; the
  // structured code arrives prefixed in the 400 body.
  const unchanged = await c2.post("/connections", catalogAlpha);
  expect(unchanged.status).toBe(200);
  expect((await bodyOf(unchanged)).result).toEqual({
    id: "alpha",
    status: "unchanged",
  });
  const conflict = await c2.post("/connections", {
    ...catalogAlpha,
    modelId: "other",
  });
  expect(conflict.status).toBe(400);
  expect((await bodyOf(conflict)).error).toBe(
    'CONNECTION_CONFLICT: Connection "alpha" already exists with different settings; remove it first or use a new id.',
  );

  // Malformed bodies: broken JSON and non-object bodies are 400 at the HTTP
  // layer; credential or unknown fields are the service's prefixed
  // INVALID_PROFILE (fields are validated inside the daemon, like start).
  const invalidJson = await c2.post("/connections", "{not json");
  expect(invalidJson.status).toBe(400);
  expect(await invalidJson.json()).toEqual({
    ok: false,
    error: "Invalid JSON body",
  });
  for (const body of ['"alpha"', "[1]"]) {
    const shapeless = await c2.post("/connections", body);
    expect(shapeless.status).toBe(400);
    expect((await bodyOf(shapeless)).error).toBe(
      "Connection body requires a profile object",
    );
  }
  const secret = await c2.post("/connections", {
    ...catalogAlpha,
    apiKey: "sk-test",
  });
  expect(secret.status).toBe(400);
  expect((await bodyOf(secret)).error).toMatch(
    /^INVALID_PROFILE: Invalid provider profile: /,
  );

  // DELETE: unknown ids keep the prefixed structured error (400, not 404 —
  // only Unknown Run maps to 404).
  const unknown = await c2.del("/connections/zeta");
  expect(unknown.status).toBe(400);
  expect((await bodyOf(unknown)).error).toBe(
    "UNKNOWN_CONNECTION: Unknown connection id: zeta. Run connections list to inspect the catalog.",
  );

  // Arbitrary-shape ids the CLI can store — dots, spaces, Unicode, and a
  // slash that arrives percent-encoded — stay deletable: the id segment is
  // decoded, deliberately not pattern-checked like run ids.
  const catalog = new ConnectionCatalog(catalogDirectory);
  for (const id of ["weird id.点", "slash/id"])
    await catalog.add({ ...catalogZeta, id });
  for (const id of ["weird id.点", "slash/id"]) {
    const removed = await c2.del(`/connections/${encodeURIComponent(id)}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      ok: true,
      result: { id, status: "removed" },
    });
  }

  // Segment shape guard: an undecodable percent sequence is 400; sub-routes
  // and every other verb on /connections stay 404.
  const badEncoding = await c2.del("/connections/%");
  expect(badEncoding.status).toBe(400);
  expect(await badEncoding.json()).toEqual({
    ok: false,
    error: "Invalid connection id",
  });
  expect((await c2.del("/connections/alpha/extra")).status).toBe(404);
  expect((await c2.del("/connections")).status).toBe(404);
  expect((await c2.post("/connections/alpha")).status).toBe(404);

  // Final removal drops the entry on disk and in the unchanged read surface.
  const removed = await c2.del("/connections/alpha");
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({
    ok: true,
    result: { id: "alpha", status: "removed" },
  });
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: {} });
  const emptied = await c2.get("/connections");
  expect(emptied.status).toBe(200);
  expect((await bodyOf(emptied)).result).toEqual([]);
});

test("PUT /connections/:id updates entries behind the token gate", async () => {
  const f = await httpFixture();
  const service = await f.open();
  const port = service.http?.address.port;
  if (port === undefined) throw new Error("HTTP projection missing");
  const base = `http://127.0.0.1:${port}`;
  const put = (id: string, body: unknown, headers?: Record<string, string>) =>
    fetch(`${base}/connections/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  // The token gate comes first: no or wrong token is 401 with no catalog data.
  for (const authorization of [undefined, "Bearer wrong"]) {
    const anonymous = await put(
      "alpha",
      catalogAlpha,
      authorization ? { Authorization: authorization } : undefined,
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      ok: false,
      error: "Unauthorized",
    });
  }
  // Without --catalog the route exists but the capability is disabled: the
  // daemon's exact structured error, 400 like the read and the other verbs.
  const c = await client(service);
  const disabled = await put("alpha", catalogAlpha, c.headers);
  expect(disabled.status).toBe(400);
  expect(await disabled.json()).toEqual({
    ok: false,
    error:
      "Connection catalog is not enabled; start the service with --catalog DIR",
  });
  await service.close();

  // Enabled via --catalog on a directory that does not exist yet: writes use
  // the CLI's on-demand owner-only bootstrap, not the read side's refusal.
  const catalogDirectory = join(f.root, "http-update-catalog");
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    http: true,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  const c2 = await client(enabled);
  // PUTs go through the enabled service's own ephemeral port.
  const authorizedPut = (id: string, body: unknown) =>
    fetch(`${c2.base}/connections/${id}`, {
      method: "PUT",
      headers: { ...c2.headers, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  // Unknown id: the structured refusal, verbatim and 400 — PUT never upserts.
  const unknown = await authorizedPut("zeta", catalogZeta);
  expect(unknown.status).toBe(400);
  expect((await bodyOf(unknown)).error).toBe(
    "UNKNOWN_CONNECTION: Unknown connection id: zeta. Run connections list to inspect the catalog.",
  );
  // Bootstrap one entry, then exercise the update's own three outcomes.
  const added = await c2.post("/connections", catalogAlpha);
  expect(added.status).toBe(200);
  expect((await bodyOf(added)).result).toEqual({
    id: "alpha",
    status: "added",
  });
  const unchanged = await authorizedPut("alpha", catalogAlpha);
  expect(unchanged.status).toBe(200);
  expect((await bodyOf(unchanged)).result).toEqual({
    id: "alpha",
    status: "unchanged",
  });
  const updatedProfile = { ...catalogAlpha, modelId: "different" };
  const updated = await authorizedPut("alpha", updatedProfile);
  expect(updated.status).toBe(200);
  expect((await bodyOf(updated)).result).toEqual({
    id: "alpha",
    status: "updated",
  });
  // The on-disk document and the read projection carry the replaced entry.
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { alpha: updatedProfile } });
  const listed = await c2.get("/connections");
  expect((await bodyOf(listed)).result).toEqual([updatedProfile]);

  // The body must name the same entry the path does: a differing body id is
  // a structured 400, never an implicit rename or upsert.
  const mismatch = await authorizedPut("alpha", {
    ...catalogAlpha,
    id: "beta",
  });
  expect(mismatch.status).toBe(400);
  expect((await bodyOf(mismatch)).error).toBe(
    "Connection body id must match the path id",
  );
  // Malformed bodies: broken JSON and non-object bodies are 400 at the HTTP
  // layer; credential fields are the service's prefixed INVALID_PROFILE.
  const invalidJson = await authorizedPut("alpha", "{not json");
  expect(invalidJson.status).toBe(400);
  expect((await bodyOf(invalidJson)).error).toBe("Invalid JSON body");
  for (const body of ['"alpha"', "[1]"]) {
    const shapeless = await authorizedPut("alpha", body);
    expect(shapeless.status).toBe(400);
    expect((await bodyOf(shapeless)).error).toBe(
      "Connection body requires a profile object",
    );
  }
  const secret = await authorizedPut("alpha", {
    ...catalogAlpha,
    apiKey: "sk-test",
  });
  expect(secret.status).toBe(400);
  expect((await bodyOf(secret)).error).toMatch(
    /^INVALID_PROFILE: Invalid provider profile: /,
  );
  // The refused writes above changed nothing on disk.
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { alpha: updatedProfile } });

  // CLI-storable arbitrary-shape ids — dots, spaces, Unicode, and a slash
  // arriving percent-encoded — stay updatable through the same write path.
  const catalog = new ConnectionCatalog(catalogDirectory);
  for (const id of ["weird id.点", "slash/id"])
    await catalog.add({ ...catalogZeta, id });
  for (const id of ["weird id.点", "slash/id"]) {
    const outcome = await authorizedPut(encodeURIComponent(id), {
      ...catalogZeta,
      id,
      modelId: "edited",
    });
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toEqual({
      ok: true,
      result: { id, status: "updated" },
    });
  }
  // Segment shape and route guard: an undecodable percent sequence is 400;
  // sub-routes and every other verb on /connections stay 404.
  const badEncoding = await authorizedPut("%", catalogAlpha);
  expect(badEncoding.status).toBe(400);
  expect(await badEncoding.json()).toEqual({
    ok: false,
    error: "Invalid connection id",
  });
  expect((await authorizedPut("alpha/extra", catalogAlpha)).status).toBe(404);
  const rootPut = await fetch(`${c2.base}/connections`, {
    method: "PUT",
    headers: { ...c2.headers, "Content-Type": "application/json" },
    body: JSON.stringify(catalogAlpha),
  });
  expect(rootPut.status).toBe(404);
  expect((await c2.get("/connections/alpha")).status).toBe(404);
});

test("a real service process serves PUT updates the CLI sees on the same disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-conn-edit-http-"));
  roots.push(root);
  const dataRoot = join(root, "service");
  // Deliberately not pre-created: the write path bootstraps it owner-only,
  // exactly like the CLI add on a fresh directory.
  const catalogDirectory = join(root, "missing-catalog");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      serviceEntry,
      "--data-root",
      dataRoot,
      "--http",
      "--catalog",
      catalogDirectory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const waitExit = () =>
    exited ? Promise.resolve() : once(child, "exit").then(() => undefined);
  try {
    // The entry publishes the ephemeral loopback port and token file path.
    await vi.waitFor(() => expect(stdout).toContain("Loom service HTTP:"));
    const match = stdout.match(
      /Loom service HTTP: http:\/\/127\.0\.0\.1:(\d+) \(token file: (.+?)\)/,
    );
    if (!match) throw new Error(`service did not publish its HTTP address`);
    const base = `http://127.0.0.1:${match[1]}`;
    const token = (await readFile(match[2] ?? "", "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}` };

    // One POST bootstraps the entry in the missing directory (owner-only)…
    const added = await fetch(`${base}/connections`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(catalogAlpha),
    });
    expect(added.status).toBe(200);
    // …then one PUT replaces its settings under the same id.
    const updatedProfile = { ...catalogAlpha, modelId: "different" };
    const updated = await fetch(
      `${base}/connections/${encodeURIComponent("alpha")}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(updatedProfile),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      ok: true,
      result: { id: "alpha", status: "updated" },
    });
    expect((await stat(catalogDirectory)).mode & 0o777).toBe(0o700);

    // The real CLI in a separate process and a direct read both see the same
    // replaced document — three-way agreement over one storage.
    const listed = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cliEntry,
        "connections",
        "list",
        "--catalog",
        catalogDirectory,
      ],
      { timeout: 30_000 },
    );
    expect(
      (JSON.parse(listed.stdout) as { connections: unknown[] }).connections,
    ).toEqual([updatedProfile]);
    expect(
      JSON.parse(
        await readFile(join(catalogDirectory, "connections.json"), "utf8"),
      ),
    ).toEqual({ version: 1, connections: { alpha: updatedProfile } });

    // SIGTERM tears the projection down: token file and socket are removed.
    child.kill("SIGTERM");
    await waitExit();
    await expect(stat(httpTokenPath(dataRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(dataRoot, "loom.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The whole flow is the happy path: the entry wrote nothing to stderr.
    expect(stderr).toBe("");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await waitExit();
    }
  }
});

test("a real service process serves catalog writes the CLI sees on the same disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-conn-http-"));
  roots.push(root);
  const dataRoot = join(root, "service");
  // Deliberately not pre-created: the write path bootstraps it owner-only,
  // exactly like the CLI add on a fresh directory.
  const catalogDirectory = join(root, "missing-catalog");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      serviceEntry,
      "--data-root",
      dataRoot,
      "--http",
      "--catalog",
      catalogDirectory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const waitExit = () =>
    exited ? Promise.resolve() : once(child, "exit").then(() => undefined);
  try {
    // The entry publishes the ephemeral loopback port and token file path.
    await vi.waitFor(() => expect(stdout).toContain("Loom service HTTP:"));
    const match = stdout.match(
      /Loom service HTTP: http:\/\/127\.0\.0\.1:(\d+) \(token file: (.+?)\)/,
    );
    if (!match) throw new Error(`service did not publish its HTTP address`);
    const base = `http://127.0.0.1:${match[1]}`;
    const token = (await readFile(match[2] ?? "", "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}` };

    // HTTP write into the missing directory: one POST, owner-only storage.
    const added = await fetch(`${base}/connections`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(catalogAlpha),
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      ok: true,
      result: { id: "alpha", status: "added" },
    });
    expect((await stat(catalogDirectory)).mode & 0o777).toBe(0o700);

    // The real CLI in a separate process reads the same persisted document
    // through the same catalog path — cross-process one-storage proof.
    const listed = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cliEntry,
        "connections",
        "list",
        "--catalog",
        catalogDirectory,
      ],
      { timeout: 30_000 },
    );
    const projection = JSON.parse(listed.stdout) as {
      catalog: string;
      connections: unknown[];
    };
    expect(projection.catalog).toBe(join(catalogDirectory, "connections.json"));
    expect(projection.connections).toEqual([catalogAlpha]);
    // The direct read agrees with both processes.
    expect(
      JSON.parse(
        await readFile(join(catalogDirectory, "connections.json"), "utf8"),
      ),
    ).toEqual({ version: 1, connections: { alpha: catalogAlpha } });

    // HTTP remove makes the entry vanish for the CLI on the same disk.
    const removed = await fetch(
      `${base}/connections/${encodeURIComponent("alpha")}`,
      { method: "DELETE", headers },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      ok: true,
      result: { id: "alpha", status: "removed" },
    });
    const relisted = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        cliEntry,
        "connections",
        "list",
        "--catalog",
        catalogDirectory,
      ],
      { timeout: 30_000 },
    );
    expect(
      (JSON.parse(relisted.stdout) as { connections: unknown[] }).connections,
    ).toEqual([]);

    // SIGTERM tears the projection down: token file and socket are removed.
    child.kill("SIGTERM");
    await waitExit();
    await expect(stat(httpTokenPath(dataRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(dataRoot, "loom.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The whole flow is the happy path: the entry wrote nothing to stderr.
    expect(stderr).toBe("");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await waitExit();
    }
  }
}, 120_000);
