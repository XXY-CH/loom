import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectionCatalog } from "../src/providers/catalog.js";
import { ServiceClient } from "../src/service/client.js";
import {
  LoomService,
  projectArtifactBody,
  type RunArtifact,
  resolveArtifactBody,
  serviceSocketPath,
} from "../src/service/daemon.js";
import { FeatureRunner } from "../src/workflow/feature.js";
import { FeatureStore } from "../src/workflow/feature-store.js";
import type { Evidence } from "../src/workflow/index.js";
import {
  createFeatureFixture,
  featureModel,
  implementedSource,
} from "./feature-fixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const roots: string[] = [];
const services: LoomService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
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
async function fixture(behavior: Parameters<typeof featureModel>[0] = {}) {
  const f = await createFeatureFixture();
  roots.push(f.root);
  const model = featureModel(behavior);
  const dataRoot = join(f.root, "service");
  const open = async () => {
    const service = await LoomService.open({
      dataRoot,
      runtimeFactory: () => model.runtime,
    });
    services.push(service);
    return service;
  };
  return {
    ...f,
    model,
    dataRoot,
    open,
    client: new ServiceClient(serviceSocketPath(dataRoot)),
  };
}

test("socket owner is exclusive and start is idempotent while disconnected clients do not stop work", async () => {
  const f = await fixture();
  await f.open();
  expect((await stat(serviceSocketPath(f.dataRoot))).mode & 0o777).toBe(0o600);
  await expect(f.open()).rejects.toThrow("owned");
  const [one, two] = await Promise.all([
    f.client.request({ method: "start", spec: f.spec, profile }),
    f.client.request({ method: "start", spec: f.spec, profile }),
  ]);
  expect(one.runId).toBe(f.spec.runId);
  expect(two.runId).toBe(f.spec.runId);
  await vi.waitFor(
    async () =>
      expect(
        (await f.client.request({ method: "status", runId: f.spec.runId }))
          .status,
      ).toBe("completed"),
    { timeout: 20_000 },
  );
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
  expect(
    f.model.calls.filter((c) => c.step === "implement" && !c.afterTool),
  ).toHaveLength(1);
  const listing = await f.client.request({ method: "list" });
  expect(listing).toHaveLength(1);
  expect(listing[0]?.budget).toEqual({ maxCalls: 64, maxTokens: 1_000_000 });
  await expect(
    f.client.request({
      method: "start",
      spec: { ...f.spec, goal: "changed" },
      profile,
    }),
  ).rejects.toThrow("differs");
});

test("catalog rebuild and explicit resume never replay a completed run", async () => {
  const f = await fixture();
  const first = await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(
    async () =>
      expect(
        (await f.client.request({ method: "status", runId: f.spec.runId }))
          .status,
      ).toBe("completed"),
    { timeout: 20_000 },
  );
  await first.close();
  const count = f.model.calls.length;
  await rm(join(f.dataRoot, "catalog.sqlite"));
  await f.open();
  expect((await f.client.request({ method: "list" }))[0]?.status).toBe(
    "completed",
  );
  await f.client.request({ method: "resume", runId: f.spec.runId });
  expect(f.model.calls).toHaveLength(count);
});

test("cancel settles a paused fixture and survives service restart", async () => {
  const f = await fixture({ pauseStep: "scout" });
  const first = await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(() => expect(f.model.calls.length).toBeGreaterThan(0));
  expect(
    (await f.client.request({ method: "cancel", runId: f.spec.runId })).status,
  ).toBe("cancelled");
  await first.close();
  await f.open();
  expect(
    (await f.client.request({ method: "status", runId: f.spec.runId })).status,
  ).toBe("cancelled");
  await expect(
    f.client.request({ method: "resume", runId: f.spec.runId }),
  ).rejects.toThrow("cancelled");
});

test("real driver failure after a write survives restart and cannot be resumed or implemented again", async () => {
  const f = await fixture({
    onCall: (step, _context, afterTool) => {
      if (step === "implement" && afterTool)
        throw new Error("local fixture disconnect after write");
    },
  });
  const first = await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await f.client.request({
        method: "status",
        runId: f.spec.runId,
      });
      expect(status.active).toBe(false);
      expect(status.operationId).toBeTruthy();
    },
    { timeout: 20_000 },
  );
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
  const count = f.model.calls.length;
  await first.close();
  await f.open();
  expect(
    (await f.client.request({ method: "status", runId: f.spec.runId }))
      .operationId,
  ).toBeTruthy();
  await expect(
    f.client.request({ method: "resume", runId: f.spec.runId }),
  ).rejects.toThrow("reconciliation");
  expect(f.model.calls).toHaveLength(count);
});

test("failed initialization remains visible and explicit resume can safely retry", async () => {
  const f = await fixture();
  let fail = true;
  const service = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => {
      if (fail) throw new Error("fixture unavailable");
      return f.model.runtime;
    },
  });
  services.push(service);
  await expect(
    f.client.request({ method: "start", spec: f.spec, profile }),
  ).rejects.toThrow("initialization failed");
  expect((await f.client.request({ method: "list" }))[0]?.status).toBe(
    "initialization_pending",
  );
  fail = false;
  await f.client.request({ method: "resume", runId: f.spec.runId });
  await vi.waitFor(
    async () =>
      expect(
        (await f.client.request({ method: "status", runId: f.spec.runId }))
          .status,
      ).toBe("completed"),
    { timeout: 20_000 },
  );
});

test("process death leaves a real write and unknown intent observable without replay", async () => {
  const f = await fixture();
  const specPath = join(f.root, "service-spec.json");
  await writeFile(specPath, JSON.stringify(f.spec));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./service-worker.ts", import.meta.url).pathname,
      f.dataRoot,
      specPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    await vi.waitFor(() => expect(output).toContain("write-persisted"), {
      timeout: 20_000,
    });
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  expect(await readFile(join(f.spec.worktreePath, "sum.js"), "utf8")).toBe(
    implementedSource,
  );
  await f.open();
  const status = await f.client.request({
    method: "status",
    runId: f.spec.runId,
  });
  expect(status.operationId).toBeTruthy();
  expect(status.usage?.pending).toBe(1);
  await expect(
    f.client.request({ method: "resume", runId: f.spec.runId }),
  ).rejects.toThrow("reconciliation");
  expect(f.model.calls).toHaveLength(0);
});

test("service close can be retried after runner teardown failure", async () => {
  const f = await fixture({ pauseStep: "scout" });
  const service = await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(() => expect(f.model.calls.length).toBeGreaterThan(0));
  const close = vi.spyOn(FeatureRunner.prototype, "close");
  close.mockRejectedValueOnce(new Error("fixture teardown failure"));
  try {
    await expect(service.close()).rejects.toThrow("fixture teardown failure");
  } finally {
    close.mockRestore();
  }
  await service.close();
  await f.open();
  expect(
    (await f.client.request({ method: "status", runId: f.spec.runId })).status,
  ).toBe("cancelled");
});

test("duplicate acceptance binds debug commands, provider configuration and budget", async () => {
  const f = await fixture();
  let fail = true;
  const service = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => {
      if (fail) throw new Error("fixture-init-secret-marker");
      return f.model.runtime;
    },
  });
  services.push(service);
  const spec = {
    ...f.spec,
    workflow: "debug" as const,
    reproduce: [process.execPath, "-e", "process.exit(1)"],
    hypothesis: [process.execPath, "-e", "process.exit(0)"],
  };
  await expect(
    f.client.request({ method: "start", spec, profile }),
  ).rejects.toThrow("Run initialization failed");
  for (const changed of [
    {
      spec: { ...spec, reproduce: [process.execPath, "-e", "process.exit(2)"] },
      profile,
    },
    {
      spec: {
        ...spec,
        hypothesis: [process.execPath, "-e", "process.exit(3)"],
      },
      profile,
    },
    { spec, profile: { ...profile, modelId: "other" } },
    { spec, profile: { ...profile, baseUrl: "http://other.invalid" } },
    { spec: { ...spec, budget: { maxCalls: 2, maxTokens: 2 } }, profile },
  ])
    await expect(
      f.client.request({ method: "start", ...changed }),
    ).rejects.toThrow("differs");
  fail = false;
});

test("catalog refuses corrupted Run databases rather than projecting a fresh Run", async () => {
  const f = await fixture();
  const first = await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(
    async () =>
      expect(
        (await f.client.request({ method: "status", runId: f.spec.runId }))
          .status,
      ).toBe("completed"),
    { timeout: 20_000 },
  );
  await first.close();
  await writeFile(
    join(f.dataRoot, "runs", f.spec.runId, "agent.sqlite"),
    "corrupt fixture database",
  );
  await expect(f.open()).rejects.toThrow();
});

test("cancel on completed Run is a no-op without reopening Runtime or changing acceptance", async () => {
  const f = await fixture();
  await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(
    async () => {
      const status = await f.client.request({
        method: "status",
        runId: f.spec.runId,
      });
      expect(status.status).toBe("completed");
      expect(status.active).toBe(false);
    },
    { timeout: 20_000 },
  );
  const calls = f.model.calls.length;
  expect(
    (await f.client.request({ method: "cancel", runId: f.spec.runId })).status,
  ).toBe("completed");
  expect(
    (await f.client.request({ method: "status", runId: f.spec.runId })).status,
  ).toBe("completed");
  expect(f.model.calls).toHaveLength(calls);
});

test("malformed run ids fail the request guard before any storage access", async () => {
  const f = await fixture();
  await f.open();
  const malformed = [
    "",
    "runs/addition",
    "addition/../other",
    "../escape",
    "/absolute",
    "-leading",
    "with space",
    "点",
    "a".repeat(81),
  ];
  // The socket overloads are narrower than the runtime protocol; one valid
  // overload shape carries any method/runId pair verbatim.
  const rawRequest = (request: unknown) =>
    f.client.request(request as { method: "status"; runId: string });
  for (const method of [
    "diff",
    "evidence",
    "artifact",
    "status",
    "cancel",
    "resume",
  ] as const) {
    for (const runId of malformed) {
      await expect(rawRequest({ method, runId })).rejects.toThrow(
        "Invalid service method or run id",
      );
    }
    // Non-string and missing ids are rejected by the same entrance guard.
    await expect(rawRequest({ method, runId: 123 })).rejects.toThrow(
      "Invalid service method or run id",
    );
    await expect(rawRequest({ method })).rejects.toThrow(
      "Invalid service method or run id",
    );
  }
  // Well-formed unknown ids keep the existing Unknown Run semantics.
  for (const method of ["diff", "evidence", "status", "resume"] as const)
    await expect(rawRequest({ method, runId: "missing-run" })).rejects.toThrow(
      "Unknown Run",
    );
  await expect(
    rawRequest({
      method: "artifact",
      runId: "missing-run",
      evidenceId: "00000000-0000-0000-0000-000000000000",
    }),
  ).rejects.toThrow("Unknown Run");
  await expect(
    f.client.request({ method: "cancel", runId: "missing-run" }),
  ).rejects.toThrow("Unknown Run");
});

test("connections is a read-only catalog projection with structured disabled and invalid shapes", async () => {
  const f = await fixture();
  // Disabled (service opened without --catalog): structured error produced in
  // the daemon layer; the rest of the request surface is untouched.
  const disabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
  });
  services.push(disabled);
  await expect(f.client.request({ method: "connections" })).rejects.toThrow(
    "Connection catalog is not enabled; start the service with --catalog DIR",
  );
  expect(await f.client.request({ method: "list" })).toEqual([]);
  // Only the exact method name reaches the handler; anything else keeps the
  // entrance guard (the connections method joins list, not the runId set).
  const rawRequest = (request: unknown) =>
    f.client.request(request as { method: "status"; runId: string });
  for (const method of ["connection", "Connections", "connections/list"]) {
    await expect(rawRequest({ method })).rejects.toThrow(
      "Invalid service method or run id",
    );
  }
  await disabled.close();

  // Enabled: entries project in ConnectionCatalog.list() order — same source,
  // same sort — and the read leaves no lock or temporary files behind.
  const catalogDirectory = join(f.root, "catalog");
  const catalog = new ConnectionCatalog(catalogDirectory);
  await catalog.add(catalogZeta);
  await catalog.add(catalogAlpha);
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  const projected = await f.client.request({ method: "connections" });
  expect(projected).toEqual([catalogAlpha, catalogZeta]);
  expect(projected).toEqual(await catalog.list());
  expect((await readdir(catalogDirectory)).sort()).toEqual([
    "connections.json",
  ]);
  await enabled.close();

  // A missing directory is a structured error and is never created: unlike
  // the CLI connections list, a read-only projection must not mkdir storage.
  const missing = join(f.root, "missing-catalog");
  const sparse = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: missing,
  });
  services.push(sparse);
  await expect(f.client.request({ method: "connections" })).rejects.toThrow(
    `Connection catalog directory does not exist: ${missing}`,
  );
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  await sparse.close();

  // Relative (relative to process.cwd()) and ".."-containing --catalog
  // spellings: both stat pre-check messages report the resolve()'d absolute
  // path — spelled exactly as the catalog's own loadReadOnly race message
  // would (the expected strings below come from ConnectionCatalog.directory,
  // the same source that message uses) — so one fault shows one path
  // whatever form the flag was given.
  await mkdir(join(f.root, "nested"), { recursive: true, mode: 0o700 });
  const catalogAsFile = join(f.root, "catalog-as-file");
  await writeFile(catalogAsFile, "not a directory", { mode: 0o600 });
  for (const spelled of [
    relative(process.cwd(), join(f.root, "missing-relative-catalog")),
    `${f.root}/nested/../missing-dotdot-catalog`,
  ]) {
    const service = await LoomService.open({
      dataRoot: f.dataRoot,
      runtimeFactory: () => f.model.runtime,
      connectionCatalogDirectory: spelled,
    });
    services.push(service);
    await expect(f.client.request({ method: "connections" })).rejects.toThrow(
      `Connection catalog directory does not exist: ${new ConnectionCatalog(spelled).directory}`,
    );
    await service.close();
  }
  for (const spelled of [
    relative(process.cwd(), catalogAsFile),
    `${f.root}/nested/../catalog-as-file`,
  ]) {
    const service = await LoomService.open({
      dataRoot: f.dataRoot,
      runtimeFactory: () => f.model.runtime,
      connectionCatalogDirectory: spelled,
    });
    services.push(service);
    await expect(f.client.request({ method: "connections" })).rejects.toThrow(
      `Connection catalog path is not a directory: ${new ConnectionCatalog(spelled).directory}`,
    );
    await service.close();
  }

  // Existing but corrupted storage: STORAGE_INVALID passes through verbatim.
  // open() stays lazy — an invalid catalog never blocks service startup and
  // unrelated methods keep working.
  const corrupted = join(f.root, "corrupted-catalog");
  await mkdir(corrupted, { recursive: true, mode: 0o700 });
  await writeFile(join(corrupted, "connections.json"), "not json", {
    mode: 0o600,
  });
  const invalid = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: corrupted,
  });
  services.push(invalid);
  await expect(f.client.request({ method: "connections" })).rejects.toThrow(
    "Connection catalog could not be read; existing data was preserved",
  );
  expect(await f.client.request({ method: "list" })).toEqual([]);
  await invalid.close();

  // Loose directory permissions: UNSAFE_STORAGE passes through verbatim.
  await chmod(catalogDirectory, 0o755);
  const unsafe = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(unsafe);
  await expect(f.client.request({ method: "connections" })).rejects.toThrow(
    "Connection catalog storage must be owner-only and must not be a symlink",
  );
  await unsafe.close();

  // Race window between the daemon's stat pre-check and the catalog read: an
  // external process deleting the directory right there cannot be replayed
  // for real, so the read method the daemon uses is wrapped to delete the
  // already-prechecked directory just before delegating. When listReadOnly is
  // absent (the pre-fix catalog), the seam falls back to list() — the path the
  // old daemon used — so a stash run shows the old behavior (mkdir-recreate
  // plus an empty list) failing this assertion instead.
  const raceDirectory = join(f.root, "race-catalog");
  const raceCatalog = new ConnectionCatalog(raceDirectory);
  await raceCatalog.add(catalogAlpha);
  const race = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: raceDirectory,
  });
  services.push(race);
  const readMethod: "listReadOnly" | "list" =
    "listReadOnly" in ConnectionCatalog.prototype ? "listReadOnly" : "list";
  const original = ConnectionCatalog.prototype[readMethod];
  const spy = vi
    .spyOn(ConnectionCatalog.prototype, readMethod)
    .mockImplementation(async function (this: ConnectionCatalog) {
      await rm(raceDirectory, { recursive: true, force: true });
      return original.call(this);
    });
  try {
    await expect(f.client.request({ method: "connections" })).rejects.toThrow(
      `Connection catalog directory does not exist: ${raceCatalog.directory}`,
    );
    // Structurally no mkdir on the read path: the deleted directory stays
    // deleted instead of coming back as fresh empty storage.
    await expect(stat(raceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    spy.mockRestore();
  }
  await race.close();
});

test("connections-add and connections-remove share the CLI catalog write path with prefixed codes", async () => {
  const f = await fixture();
  // Not enabled (service opened without --catalog): both writes answer with
  // the read side's exact structured not-enabled error from the daemon layer.
  const disabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
  });
  services.push(disabled);
  for (const request of [
    { method: "connections-add", profile: catalogAlpha },
    { method: "connections-remove", id: "alpha" },
  ] as unknown as { method: "connections-add"; profile: typeof catalogAlpha }[])
    await expect(f.client.request(request)).rejects.toThrow(
      "Connection catalog is not enabled; start the service with --catalog DIR",
    );
  expect(await f.client.request({ method: "list" })).toEqual([]);
  await disabled.close();

  // Enabled with a MISSING directory: the write path is the CLI's, so the
  // catalog's mutate() bootstraps owner-only storage on demand instead of the
  // read side's structured "does not exist" error — the documented,
  // intentional read/write fork (a service-side stat pre-check here would
  // silently diverge from `connections add`).
  const catalogDirectory = join(f.root, "write-catalog");
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  expect(
    await f.client.request({
      method: "connections-add",
      profile: catalogAlpha,
    }),
  ).toEqual({ id: "alpha", status: "added" });
  const directoryInfo = await stat(catalogDirectory);
  expect(directoryInfo.isDirectory()).toBe(true);
  expect(directoryInfo.mode & 0o777).toBe(0o700);
  // The persisted document carries exactly the validated non-secret entry,
  // owner-only like the CLI path writes it…
  const document = JSON.parse(
    await readFile(join(catalogDirectory, "connections.json"), "utf8"),
  );
  expect(document).toEqual({
    version: 1,
    connections: { alpha: catalogAlpha },
  });
  expect(
    (await stat(join(catalogDirectory, "connections.json"))).mode & 0o777,
  ).toBe(0o600);
  // …and the read projection plus a direct CLI-path listing agree with it.
  expect(await f.client.request({ method: "connections" })).toEqual([
    catalogAlpha,
  ]);
  expect(await new ConnectionCatalog(catalogDirectory).list()).toEqual([
    catalogAlpha,
  ]);

  // Idempotent re-add: identical settings are an unchanged acknowledgement.
  expect(
    await f.client.request({
      method: "connections-add",
      profile: catalogAlpha,
    }),
  ).toEqual({ id: "alpha", status: "unchanged" });

  // Same id with different settings: the structured ConnectionCatalogError
  // code is prefixed into the wire message (the error channel carries
  // strings only), mirroring reconcile-budget's DATABASE_IN_USE wiring.
  await expect(
    f.client.request({
      method: "connections-add",
      profile: { ...catalogAlpha, modelId: "other" },
    }),
  ).rejects.toThrow(
    'CONNECTION_CONFLICT: Connection "alpha" already exists with different settings; remove it first or use a new id.',
  );

  // Malformed profiles — unknown fields, plain credential fields — are
  // refused before any write with the prefixed INVALID_PROFILE code.
  for (const bad of [
    { ...catalogAlpha, apiKey: "sk-test" },
    { ...catalogAlpha, extra: 1 },
  ]) {
    await expect(
      f.client.request({
        method: "connections-add",
        profile: bad as unknown as typeof catalogAlpha,
      }),
    ).rejects.toThrow(/^INVALID_PROFILE: Invalid provider profile: /);
  }
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { alpha: catalogAlpha } });

  // remove: unknown ids carry UNKNOWN_CONNECTION; a live lock directory (the
  // state a crashed catalog owner leaves behind) fails closed with
  // CATALOG_BUSY instead of overwriting.
  await expect(
    f.client.request({ method: "connections-remove", id: "zeta" }),
  ).rejects.toThrow(
    "UNKNOWN_CONNECTION: Unknown connection id: zeta. Run connections list to inspect the catalog.",
  );
  await mkdir(join(catalogDirectory, "connections.json.lock"), {
    mode: 0o700,
  });
  await expect(
    f.client.request({ method: "connections-add", profile: catalogZeta }),
  ).rejects.toThrow(/^CATALOG_BUSY: Connection catalog is locked;/);
  await rm(join(catalogDirectory, "connections.json.lock"), {
    recursive: true,
  });

  // Raw socket shape guard: ids must be non-empty strings, checked before any
  // storage access; the write methods never touch the runId whitelist.
  const rawRequest = (request: unknown) =>
    f.client.request(request as { method: "connections-remove"; id: string });
  for (const id of ["", 123, undefined])
    await expect(
      rawRequest({ method: "connections-remove", id }),
    ).rejects.toThrow("Invalid connection id");

  // Arbitrary-shape ids — dots, spaces, Unicode; parseProviderProfile has no
  // id pattern, so these are exactly the entries the CLI can store —
  // round-trip over the socket through the same write path.
  const weird = { ...catalogZeta, id: "weird id.点" };
  expect(
    await f.client.request({ method: "connections-add", profile: weird }),
  ).toEqual({ id: "weird id.点", status: "added" });
  expect(
    (await f.client.request({ method: "connections" })).map(
      (entry) => entry.id,
    ),
  ).toEqual(["alpha", "weird id.点"]);

  // Successful removal drops the entry on disk and in the projection.
  expect(
    await f.client.request({ method: "connections-remove", id: "alpha" }),
  ).toEqual({ id: "alpha", status: "removed" });
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { "weird id.点": weird } });
  expect(await f.client.request({ method: "connections" })).toEqual([weird]);
  await enabled.close();
});

test("connections-update is the explicit edit path with prefixed codes", async () => {
  const f = await fixture();
  // Not enabled: the exact structured not-enabled error, same daemon layer
  // as the read and the other write methods.
  const disabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
  });
  services.push(disabled);
  await expect(
    f.client.request({ method: "connections-update", profile: catalogAlpha }),
  ).rejects.toThrow(
    "Connection catalog is not enabled; start the service with --catalog DIR",
  );
  expect(await f.client.request({ method: "list" })).toEqual([]);
  await disabled.close();

  // Enabled on a missing directory: the write path is the CLI's (on-demand
  // owner-only bootstrap), and an unknown id is the structured refusal —
  // never an upsert.
  const catalogDirectory = join(f.root, "update-catalog");
  const enabled = await LoomService.open({
    dataRoot: f.dataRoot,
    runtimeFactory: () => f.model.runtime,
    connectionCatalogDirectory: catalogDirectory,
  });
  services.push(enabled);
  await expect(
    f.client.request({ method: "connections-update", profile: catalogAlpha }),
  ).rejects.toThrow(
    "UNKNOWN_CONNECTION: Unknown connection id: alpha. Run connections list to inspect the catalog.",
  );
  expect(
    await f.client.request({
      method: "connections-add",
      profile: catalogAlpha,
    }),
  ).toEqual({ id: "alpha", status: "added" });
  // Identical canonical settings: idempotent zero-write acknowledgement.
  expect(
    await f.client.request({
      method: "connections-update",
      profile: catalogAlpha,
    }),
  ).toEqual({ id: "alpha", status: "unchanged" });
  // Changed settings replace the entry: the read projection, a direct
  // CLI-path listing, and the persisted document agree three ways.
  const changed = { ...catalogAlpha, modelId: "different" };
  expect(
    await f.client.request({ method: "connections-update", profile: changed }),
  ).toEqual({ id: "alpha", status: "updated" });
  expect(await f.client.request({ method: "connections" })).toEqual([changed]);
  expect(await new ConnectionCatalog(catalogDirectory).list()).toEqual([
    changed,
  ]);
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { alpha: changed } });
  // Credential fields are refused before any write with the prefixed code…
  const secret = { apiKey: "sk-test" };
  await expect(
    f.client.request({
      method: "connections-update",
      profile: { ...catalogAlpha, ...secret } as unknown as typeof catalogAlpha,
    }),
  ).rejects.toThrow(/^INVALID_PROFILE: Invalid provider profile: /);
  // …and add's same-id refusal keeps its exact wording beside the new path.
  await expect(
    f.client.request({
      method: "connections-add",
      profile: { ...catalogAlpha, modelId: "other" },
    }),
  ).rejects.toThrow(
    'CONNECTION_CONFLICT: Connection "alpha" already exists with different settings; remove it first or use a new id.',
  );
  // A live lock directory (a crashed catalog owner) fails the update closed.
  await mkdir(join(catalogDirectory, "connections.json.lock"), {
    mode: 0o700,
  });
  await expect(
    f.client.request({ method: "connections-update", profile: changed }),
  ).rejects.toThrow(/^CATALOG_BUSY: Connection catalog is locked;/);
  await rm(join(catalogDirectory, "connections.json.lock"), {
    recursive: true,
  });
  await enabled.close();
});

/** Completes a fixture run over the socket and waits for the terminal status. */
async function completedFixtureRun(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  await f.open();
  await f.client.request({ method: "start", spec: f.spec, profile });
  await vi.waitFor(
    async () =>
      expect(
        (await f.client.request({ method: "status", runId: f.spec.runId }))
          .status,
      ).toBe("completed"),
    { timeout: 20_000 },
  );
}

/** Read-only Run DB snapshot of a completed fixture run, for expected values. */
async function inspectRunDatabase(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<NonNullable<ReturnType<typeof FeatureStore.inspectDatabase>>> {
  const database = new DatabaseSync(
    join(f.dataRoot, "runs", f.spec.runId, "agent.sqlite"),
    { readOnly: true },
  );
  try {
    const snapshot = FeatureStore.inspectDatabase(database);
    if (!snapshot) throw new Error("fixture run database missing snapshot");
    return snapshot;
  } finally {
    database.close();
  }
}

test("artifact method projects every evidence body from the same Run DB snapshot", async () => {
  const f = await fixture();
  await completedFixtureRun(f);
  const evidence = await f.client.request({
    method: "evidence",
    runId: f.spec.runId,
  });
  expect(evidence.length).toBeGreaterThan(0);
  const snapshot = await inspectRunDatabase(f);
  // Every recorded kind (artifact, command, review) stores a body under its
  // operation id; each projects with the stored text and exact byte length.
  for (const item of evidence) {
    const stored = snapshot.state.artifacts.find((a) => a.id === item.id);
    expect(stored, item.kind).toBeTruthy();
    if (!stored) throw new Error(`missing stored artifact for ${item.kind}`);
    const projected = await f.client.request({
      method: "artifact",
      runId: f.spec.runId,
      evidenceId: item.id,
    });
    expect(projected).toEqual({
      text: stored.body,
      truncated: false,
      byteLength: Buffer.byteLength(stored.body, "utf8"),
    } satisfies RunArtifact);
  }
  // The evidence list and the body view agree on one snapshot: every id the
  // list exposes resolves, and a well-formed foreign id is a structured error.
  await expect(
    f.client.request({
      method: "artifact",
      runId: f.spec.runId,
      evidenceId: randomUUID(),
    }),
  ).rejects.toThrow("Unknown evidence id");
});

test("artifact method truncates oversized command bodies at the 64 KiB read-side cap", async () => {
  const f = await fixture();
  // A >64 KiB stdout on a passing regression command: command evidence bodies
  // are only capped at 1 MiB by the writer, so the read-side cap is the only
  // uniform bound and truncated:true is a genuinely reachable state here.
  // The stdout tail carries a sentinel assembled at run time from pieces, so
  // the joined sentinel appears nowhere in the stored envelope except beyond
  // the 64 KiB cap — its absence proves the beyond-the-cap bytes are really
  // omitted and can never be vacuously true.
  const sentinel = "loom-truncation-sentinel";
  f.spec.regression = [
    process.execPath,
    "-e",
    "process.stdout.write('x'.repeat(70_000)+['loom','-truncation','-sentinel'].join(''))",
  ];
  await completedFixtureRun(f);
  const evidence = await f.client.request({
    method: "evidence",
    runId: f.spec.runId,
  });
  const command = evidence.find(
    (item) => item.kind === "command" && item.stepId === "regression",
  );
  expect(command).toBeTruthy();
  const projected = await f.client.request({
    method: "artifact",
    runId: f.spec.runId,
    evidenceId: command?.id ?? "",
  });
  expect(projected.truncated).toBe(true);
  expect(projected.text.endsWith("\n… preview truncated (64 KiB)")).toBe(true);
  // byteLength keeps the full stored size, larger than the capped text.
  const snapshot = await inspectRunDatabase(f);
  const stored = snapshot.state.artifacts.find((a) => a.id === command?.id);
  const body = stored?.body ?? "";
  expect(Buffer.byteLength(body, "utf8")).toBe(projected.byteLength);
  expect(projected.byteLength).toBeGreaterThan(64 * 1024);
  // The projected text is byte-exactly the first 64 KiB of the stored body —
  // sliced byte-wise, mirroring the projection's Buffer subarray — plus the
  // marker; the sentinel past the cap never leaks into the projection.
  expect(projected.text).toBe(
    `${Buffer.from(body, "utf8")
      .subarray(0, 64 * 1024)
      .toString("utf8")}\n… preview truncated (64 KiB)`,
  );
  expect(projected.text).not.toContain(sentinel);
});

test("artifact on a pending run reports the same incomplete initialization as evidence", async () => {
  const f = await fixture();
  await f.open();
  await mkdir(join(f.dataRoot, "runs", "pending-run"), { recursive: true });
  await writeFile(
    join(f.dataRoot, "runs", "pending-run", "request.json"),
    JSON.stringify({ spec: { ...f.spec, runId: "pending-run" }, profile }),
  );
  const status = await f.client.request({
    method: "status",
    runId: "pending-run",
  });
  expect(status.status).toBe("initialization_pending");
  const evidenceId = "00000000-0000-0000-0000-000000000000";
  // Missing Run DB file: the structured message matches evidence() verbatim.
  for (const method of ["evidence", "artifact"] as const) {
    await expect(
      f.client.request({
        method,
        runId: "pending-run",
        ...(method === "artifact" ? { evidenceId } : {}),
      } as { method: "evidence"; runId: string }),
    ).rejects.toThrow(
      "Run initialization incomplete; explicit resume required",
    );
  }
  // An existing but schema-less database file is not the documented pending
  // state; both read methods fail on it with the identical message (the same
  // shared snapshot path), never with divergent or silently empty results.
  const pending = new DatabaseSync(
    join(f.dataRoot, "runs", "pending-run", "agent.sqlite"),
  );
  pending.close();
  const evidenceError = await f.client
    .request({ method: "evidence", runId: "pending-run" })
    .then(
      () => null,
      (error: Error) => error.message,
    );
  expect(evidenceError).toBeTruthy();
  await expect(
    f.client.request({ method: "artifact", runId: "pending-run", evidenceId }),
  ).rejects.toThrow(evidenceError ?? "");
});

test("projectArtifactBody pins the 64 KiB defensive cap, marker, and boundary", () => {
  const small = "hello";
  expect(projectArtifactBody(small)).toEqual({
    text: "hello",
    truncated: false,
    byteLength: 5,
  });
  // Exactly at the cap: not truncated.
  const exact = "x".repeat(64 * 1024);
  expect(projectArtifactBody(exact)).toEqual({
    text: exact,
    truncated: false,
    byteLength: 64 * 1024,
  });
  // One byte over: capped text, git.ts marker wording, full size kept.
  const big = `${"x".repeat(64 * 1024)}tail`;
  expect(projectArtifactBody(big)).toEqual({
    text: `${"x".repeat(64 * 1024)}\n… preview truncated (64 KiB)`,
    truncated: true,
    byteLength: 64 * 1024 + 4,
  });
  // Multibyte content cuts at the byte boundary like git.ts file previews.
  const multibyte = "汉".repeat(21_846); // 3 bytes per char = 65538 bytes
  const cut = projectArtifactBody(multibyte);
  expect(cut.truncated).toBe(true);
  expect(cut.byteLength).toBe(65_538);
  expect(cut.text.endsWith("\n… preview truncated (64 KiB)")).toBe(true);
});

test("resolveArtifactBody refuses foreign prefixes, mismatched ids, and missing bodies", () => {
  const artifacts = [{ id: "op-1", body: "body-1" }];
  const base = {
    stepId: "implement",
    attempt: 1,
    planVersion: 1,
    workspace: {
      workspaceId: "fixture-workspace",
      head: "fixture-head",
      fingerprint: "fixture-fingerprint",
    },
    valid: true,
    recordedAt: 1,
  };
  const evidence: Evidence[] = [
    {
      ...base,
      id: "op-1",
      artifactRef: "pi:feature/op-1",
      kind: "artifact",
      producerId: "implementer",
    },
    {
      ...base,
      id: "op-2",
      artifactRef: "sum.js",
      kind: "artifact",
      producerId: "implementer",
    },
    {
      ...base,
      id: "op-3",
      artifactRef: "pi:feature/other",
      kind: "artifact",
      producerId: "implementer",
    },
    {
      ...base,
      id: "op-4",
      artifactRef: "pi:feature/op-4",
      kind: "artifact",
      producerId: "implementer",
    },
  ];
  expect(resolveArtifactBody(evidence, artifacts, "op-1")).toBe("body-1");
  // The writer records the artifact and its evidence in one store update
  // (feature.ts pushes {id,stepId,body} and evidence with the same operation
  // id), so these states cannot occur in a genuine Run DB; the resolver seam
  // pins the structured refusals the socket method passes through.
  expect(() => resolveArtifactBody(evidence, artifacts, "")).toThrow(
    "Invalid artifact evidence id",
  );
  expect(() =>
    resolveArtifactBody(evidence, artifacts, 123 as unknown as string),
  ).toThrow("Invalid artifact evidence id");
  expect(() => resolveArtifactBody(evidence, artifacts, "missing")).toThrow(
    "Unknown evidence id",
  );
  expect(() => resolveArtifactBody(evidence, artifacts, "op-2")).toThrow(
    "Unsupported artifact reference",
  );
  expect(() => resolveArtifactBody(evidence, artifacts, "op-3")).toThrow(
    "Artifact reference does not match evidence id",
  );
  expect(() => resolveArtifactBody(evidence, artifacts, "op-4")).toThrow(
    "Artifact body missing from Run state",
  );
});
