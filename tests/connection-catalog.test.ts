import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  ConnectionCatalog,
  ConnectionCatalogError,
} from "../src/providers/catalog.js";
import type { ProviderProfile } from "../src/providers/index.js";

const directories: string[] = [];
async function fixtureDirectory() {
  const path = await mkdtemp(join(tmpdir(), "loom-connections-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const localProfile: ProviderProfile = {
  id: "local",
  kind: "openai-compatible",
  protocol: "openai-completions",
  modelId: "fixture",
  baseUrl: "http://127.0.0.1:1/v1",
  keyEnv: "LOOM_FIXTURE_KEY",
};

test("add, list and remove round-trip through an injected catalog directory", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  expect(await catalog.add(localProfile)).toBe("added");
  expect(await catalog.list()).toEqual([localProfile]);
  expect(await catalog.resolve("local")).toEqual(localProfile);
  await catalog.remove("local");
  expect(await catalog.list()).toEqual([]);
  await expect(catalog.resolve("local")).rejects.toMatchObject({
    code: "UNKNOWN_CONNECTION",
  });
  await expect(catalog.remove("local")).rejects.toMatchObject({
    code: "UNKNOWN_CONNECTION",
  });
});

test("re-adding identical settings is an idempotent confirmation; changed fields are rejected", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  const reordered: ProviderProfile = {
    keyEnv: "LOOM_FIXTURE_KEY",
    baseUrl: "http://127.0.0.1:1/v1",
    modelId: "fixture",
    protocol: "openai-completions",
    kind: "openai-compatible",
    id: "local",
  };
  expect(await catalog.add(reordered)).toBe("unchanged");
  await expect(
    catalog.add({ ...localProfile, modelId: "different" }),
  ).rejects.toMatchObject({ code: "CONNECTION_CONFLICT" });
  await expect(
    catalog.add({ ...localProfile, baseUrl: "http://127.0.0.1:2/v1" }),
  ).rejects.toBeInstanceOf(ConnectionCatalogError);
  expect(await catalog.list()).toEqual([localProfile]);
});

test.each([
  { apiKey: "secret" },
  { token: "secret" },
  { id: "bad", extra: true },
])("rejects secret or unknown fields: $apiKey$token$extra", async (entry) => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await expect(catalog.add({ ...localProfile, ...entry })).rejects.toThrow(
    "profile",
  );
  await expect(catalog.list()).resolves.toEqual([]);
  await expect(stat(catalog.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("stored file is owner-only, atomically replaced and contains only non-secret fields", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  const first = await stat(catalog.path);
  expect(first.mode & 0o077).toBe(0);
  expect((await stat(catalog.directory)).mode & 0o077).toBe(0);
  const serialized = await readFile(catalog.path, "utf8");
  expect(serialized).not.toMatch(/apiKey|token|Bearer|secret/i);
  const document = JSON.parse(serialized);
  expect(Object.keys(document)).toEqual(["version", "connections"]);
  const allowed = new Set([
    "id",
    "kind",
    "protocol",
    "modelId",
    "baseUrl",
    "keyEnv",
    "contextWindow",
    "maxTokens",
  ]);
  for (const profile of Object.values(
    document.connections as Record<string, Record<string, unknown>>,
  ))
    for (const field of Object.keys(profile))
      expect(allowed.has(field)).toBe(true);
  await catalog.add({ ...localProfile, id: "second" });
  const second = await stat(catalog.path);
  expect(second.ino).not.toBe(first.ino);
  expect(
    (await readdir(catalog.directory)).filter(
      (name) => name.includes(".tmp") || name.endsWith(".lock"),
    ),
  ).toEqual([]);
});

test("loose permissions or a symlinked catalog file are rejected", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  await chmod(catalog.path, 0o644);
  await expect(catalog.list()).rejects.toMatchObject({
    code: "UNSAFE_STORAGE",
  });
  await chmod(catalog.path, 0o600);
  await rm(catalog.path);
  const target = join(root, "elsewhere.json");
  await writeFile(target, JSON.stringify({ version: 1, connections: {} }));
  await symlink(target, catalog.path);
  await expect(catalog.resolve("local")).rejects.toMatchObject({
    code: "UNSAFE_STORAGE",
  });
});

test("listReadOnly fails closed on a missing directory; list() keeps its documented on-demand mkdir", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  const failure = await catalog.listReadOnly().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ConnectionCatalogError);
  expect(failure).toMatchObject({ code: "STORAGE_INVALID" });
  expect((failure as Error).message).toBe(
    `Connection catalog directory does not exist: ${catalog.directory}`,
  );
  // The read-only path must not recreate storage: ENOENT pins the structural
  // absence of any mkdir in the failure window.
  await expect(stat(catalog.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  // Contrast — the CLI-facing path keeps its intentional on-demand creation
  // of owner-only storage (the documented difference from the projection).
  expect(await catalog.list()).toEqual([]);
  const created = await stat(catalog.directory);
  expect(created.isDirectory()).toBe(true);
  expect(created.mode & 0o077).toBe(0);
});

test("listReadOnly projects the same entries and ordering as list()", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  await catalog.add({ ...localProfile, id: "another" });
  await catalog.add({ ...localProfile, id: "zzz" });
  const viaReadOnly = await catalog.listReadOnly();
  expect(viaReadOnly).toEqual(await catalog.list());
  expect(viaReadOnly.map((profile) => profile.id)).toEqual([
    "another",
    "local",
    "zzz",
  ]);
});

test("listReadOnly keeps rejecting loose or symlinked storage", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  await chmod(catalog.directory, 0o755);
  await expect(catalog.listReadOnly()).rejects.toMatchObject({
    code: "UNSAFE_STORAGE",
  });
  await chmod(catalog.directory, 0o700);
  await chmod(catalog.path, 0o644);
  await expect(catalog.listReadOnly()).rejects.toMatchObject({
    code: "UNSAFE_STORAGE",
  });
  await chmod(catalog.path, 0o600);
  await rm(catalog.directory, { recursive: true });
  const target = join(root, "elsewhere");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await symlink(target, catalog.directory);
  await expect(catalog.listReadOnly()).rejects.toMatchObject({
    code: "UNSAFE_STORAGE",
  });
});

test("a concurrent catalog owner fails closed instead of overwriting", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await mkdir(catalog.directory, { recursive: true, mode: 0o700 });
  await mkdir(`${catalog.path}.lock`);
  await expect(catalog.add(localProfile)).rejects.toMatchObject({
    code: "CATALOG_BUSY",
  });
});

test("update is an explicit replace: unknown ids are never upserted, identical settings are a zero-write unchanged", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  // Unknown ids fail with the exact structured error — never a silent create.
  await expect(catalog.update(localProfile)).rejects.toThrow(
    "Unknown connection id: local. Run connections list to inspect the catalog.",
  );
  await expect(catalog.update(localProfile)).rejects.toMatchObject({
    code: "UNKNOWN_CONNECTION",
  });
  await catalog.add(localProfile);
  // Identical canonical settings: idempotent confirmation with zero writes —
  // the file keeps its inode and mtime because no save ran at all.
  const before = await stat(catalog.path);
  expect(await catalog.update(localProfile)).toBe("unchanged");
  const reordered: ProviderProfile = {
    keyEnv: "LOOM_FIXTURE_KEY",
    baseUrl: "http://127.0.0.1:1/v1",
    modelId: "fixture",
    protocol: "openai-completions",
    kind: "openai-compatible",
    id: "local",
  };
  expect(await catalog.update(reordered)).toBe("unchanged");
  const afterUnchanged = await stat(catalog.path);
  expect(afterUnchanged.ino).toBe(before.ino);
  expect(afterUnchanged.mtimeMs).toBe(before.mtimeMs);
  // Changed fields replace the entry under the same id…
  expect(await catalog.update({ ...localProfile, modelId: "different" })).toBe(
    "updated",
  );
  expect(await catalog.list()).toEqual([
    { ...localProfile, modelId: "different" },
  ]);
  // …and a direct read of the persisted document agrees.
  expect(JSON.parse(await readFile(catalog.path, "utf8"))).toEqual({
    version: 1,
    connections: { local: { ...localProfile, modelId: "different" } },
  });
});

test("update refuses non-secret rule violations and a concurrent owner", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  const secret = { apiKey: "fixture-secret" };
  await expect(catalog.update({ ...localProfile, ...secret })).rejects.toThrow(
    "profile",
  );
  await expect(stat(catalog.path)).rejects.toMatchObject({ code: "ENOENT" });
  await catalog.add(localProfile);
  await mkdir(`${catalog.path}.lock`);
  await expect(
    catalog.update({ ...localProfile, modelId: "different" }),
  ).rejects.toMatchObject({ code: "CATALOG_BUSY" });
  await rm(`${catalog.path}.lock`, { recursive: true, force: true });
});

test("add's conflict is resolved by an explicit update, and a post-update re-add is idempotent", async () => {
  const root = await fixtureDirectory();
  const catalog = new ConnectionCatalog(join(root, "catalog"));
  await catalog.add(localProfile);
  const changed = { ...localProfile, modelId: "different" };
  // add keeps refusing a same-id change (semantics and message unchanged)…
  await expect(catalog.add(changed)).rejects.toMatchObject({
    code: "CONNECTION_CONFLICT",
  });
  // …while the explicit update replaces the settings under the same id.
  expect(await catalog.update(changed)).toBe("updated");
  // The catalog now holds the changed settings, so re-adding them is the
  // idempotent unchanged acknowledgement — and the old shape conflicts.
  expect(await catalog.add(changed)).toBe("unchanged");
  await expect(catalog.add(localProfile)).rejects.toMatchObject({
    code: "CONNECTION_CONFLICT",
  });
  expect(await catalog.list()).toEqual([changed]);
});

test("connections edit updates entries across real CLI processes", async () => {
  const root = await fixtureDirectory();
  const catalogDirectory = join(root, "catalog");
  const profilePath = join(root, "local.json");
  await writeFile(profilePath, JSON.stringify(localProfile));
  const execute = promisify(execFile);
  const cli = (args: string[]) =>
    execute(
      process.execPath,
      ["--import", "tsx", "src/cli/index.ts", ...args],
      {
        timeout: 20000,
      },
    );
  await cli([
    "connections",
    "add",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]);
  await writeFile(
    profilePath,
    JSON.stringify({ ...localProfile, modelId: "different" }),
  );
  const changed = { ...localProfile, modelId: "different" };
  const updated = await cli([
    "connections",
    "edit",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(updated.stdout)).toEqual({
    id: "local",
    status: "updated",
  });
  // Re-editing identical settings is the idempotent confirmation.
  const unchanged = await cli([
    "connections",
    "edit",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(unchanged.stdout)).toEqual({
    id: "local",
    status: "unchanged",
  });
  // The CLI listing and a direct read of connections.json agree with the edit.
  const listed = await cli([
    "connections",
    "list",
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(listed.stdout).connections).toEqual([changed]);
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { local: changed } });
  // An unknown id is the explicit refusal — never an upsert.
  await writeFile(
    profilePath,
    JSON.stringify({ ...localProfile, id: "missing" }),
  );
  const unknown = await cli([
    "connections",
    "edit",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]).catch((error) => error);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("UNKNOWN_CONNECTION");
  expect(
    JSON.parse(
      await readFile(join(catalogDirectory, "connections.json"), "utf8"),
    ),
  ).toEqual({ version: 1, connections: { local: changed } });
}, 30000);

test("connections add/list/remove manage the catalog across real CLI processes", async () => {
  const root = await fixtureDirectory();
  const catalogDirectory = join(root, "catalog");
  const profilePath = join(root, "local.json");
  await writeFile(profilePath, JSON.stringify(localProfile));
  const execute = promisify(execFile);
  const cli = (args: string[]) =>
    execute(
      process.execPath,
      ["--import", "tsx", "src/cli/index.ts", ...args],
      {
        timeout: 20000,
      },
    );
  const added = await cli([
    "connections",
    "add",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(added.stdout)).toEqual({ id: "local", status: "added" });
  await writeFile(
    profilePath,
    JSON.stringify(Object.fromEntries(Object.entries(localProfile).reverse())),
  );
  const reordered = await cli([
    "connections",
    "add",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(reordered.stdout)).toEqual({
    id: "local",
    status: "unchanged",
  });
  const listed = await cli([
    "connections",
    "list",
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(listed.stdout).connections).toEqual([localProfile]);
  await writeFile(
    profilePath,
    JSON.stringify({ ...localProfile, modelId: "different" }),
  );
  const conflict = await cli([
    "connections",
    "add",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]).catch((error) => error);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("CONNECTION_CONFLICT");
  await writeFile(
    profilePath,
    JSON.stringify({ ...localProfile, id: "leaky", apiKey: "fixture-secret" }),
  );
  const rejected = await cli([
    "connections",
    "add",
    "--profile",
    profilePath,
    "--catalog",
    catalogDirectory,
  ]).catch((error) => error);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("INVALID_PROFILE");
  expect(
    await readFile(join(catalogDirectory, "connections.json"), "utf8"),
  ).not.toContain("fixture-secret");
  const removed = await cli([
    "connections",
    "remove",
    "--id",
    "local",
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(removed.stdout)).toEqual({
    id: "local",
    status: "removed",
  });
  const empty = await cli([
    "connections",
    "list",
    "--catalog",
    catalogDirectory,
  ]);
  expect(JSON.parse(empty.stdout).connections).toEqual([]);
}, 30000);

test("--profile-id resolves the catalog client-side for a keyless localhost completion roundtrip", async () => {
  const root = await fixtureDirectory();
  const catalogDirectory = join(root, "catalog");
  let requests = 0;
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    requests++;
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "catalog-fixture-answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP fixture");
    const profilePath = join(root, "local.json");
    const profile = {
      id: "fixture",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "catalog-fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    await writeFile(profilePath, JSON.stringify(profile));
    const execute = promisify(execFile);
    const cli = (args: string[]) =>
      execute(
        process.execPath,
        ["--import", "tsx", "src/cli/index.ts", ...args],
        {
          timeout: 20000,
        },
      );
    await cli([
      "connections",
      "add",
      "--profile",
      profilePath,
      "--catalog",
      catalogDirectory,
    ]);
    const common = [
      "--db",
      join(root, "runtime.sqlite"),
      "--cwd",
      root,
      "--profile-id",
      "fixture",
      "--catalog",
      catalogDirectory,
    ];
    const first = await cli([
      "run",
      ...common,
      "--prompt",
      "reply briefly",
      "--request-id",
      "one",
    ]);
    expect(first.stdout).toContain("catalog-fixture-answer");
    // A separate process re-reads the catalog from disk and deduplicates the request id.
    const repeated = await cli([
      "run",
      ...common,
      "--prompt",
      "reply briefly",
      "--request-id",
      "one",
    ]);
    expect(repeated.stdout).toContain("catalog-fixture-answer");
    expect(requests).toBe(1);
    expect(authorization).toBeUndefined();
    const status = await cli(["status", ...common]);
    expect(JSON.parse(status.stdout).submissions).toBeDefined();
    // The same settings selected through the profile file keep the identity
    // stable: the full persisted status projection must be deeply equal, and a
    // different identity would have failed the runtime open instead.
    const viaFile = await cli([
      "status",
      "--db",
      join(root, "runtime.sqlite"),
      "--cwd",
      root,
      "--profile",
      profilePath,
    ]);
    expect(JSON.parse(viaFile.stdout)).toEqual(JSON.parse(status.stdout));
    await cli([
      "connections",
      "remove",
      "--id",
      "fixture",
      "--catalog",
      catalogDirectory,
    ]);
    const unknown = await cli([
      "run",
      ...common,
      "--prompt",
      "x",
      "--request-id",
      "two",
    ]).catch((error) => error);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(
      "UNKNOWN_CONNECTION: Unknown connection id: fixture",
    );
    expect(unknown.stderr).not.toContain("OPENAI_API_KEY");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 40000);
