import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { loadProviderProfile } from "../src/providers/profile.js";

const directories: string[] = [];
async function fixtureDirectory() {
  const path = await mkdtemp(join(tmpdir(), "loom-profile-"));
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

test("loads a non-secret provider profile and preserves the credential reference", async () => {
  const directory = await fixtureDirectory();
  const path = join(directory, "local.json");
  await writeFile(
    path,
    JSON.stringify({
      id: "local",
      kind: "openai-compatible",
      protocol: "openai-completions",
      modelId: "fixture/model",
      baseUrl: "http://127.0.0.1:1234/v1",
      keyEnv: "LOOM_FIXTURE_KEY",
    }),
  );
  await expect(loadProviderProfile(path)).resolves.toEqual({
    id: "local",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture/model",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyEnv: "LOOM_FIXTURE_KEY",
  });
});

test.each([
  { apiKey: "secret" },
  { token: "secret" },
  {
    id: "bad",
    kind: "openai",
    protocol: "openai-responses",
    modelId: "m",
    extra: true,
  },
])(
  "rejects secret or unknown profile fields: $apiKey$token$extra",
  async (profile) => {
    const directory = await fixtureDirectory();
    const path = join(directory, "invalid.json");
    await writeFile(path, JSON.stringify(profile));
    await expect(loadProviderProfile(path)).rejects.toThrow("profile");
  },
);

test("profile CLI opens and reopens a real Runtime but rejects a same-name connection change", async () => {
  const directory = await fixtureDirectory();
  const path = join(directory, "local.json");
  const profile = {
    id: "local",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:1/v1",
  };
  const execute = promisify(execFile);
  const args = [
    "--import",
    "tsx",
    "src/cli/index.ts",
    "status",
    "--db",
    join(directory, "runtime.sqlite"),
    "--cwd",
    directory,
    "--profile",
    path,
  ];
  await writeFile(path, JSON.stringify(profile));
  const first = await execute(process.execPath, args);
  expect(JSON.parse(first.stdout).submissions).toBeDefined();
  await writeFile(
    path,
    JSON.stringify(Object.fromEntries(Object.entries(profile).reverse())),
  );
  const reopened = await execute(process.execPath, args);
  expect(JSON.parse(reopened.stdout).submissions).toBeDefined();
  await writeFile(path, JSON.stringify({ ...profile, modelId: "different" }));
  await expect(execute(process.execPath, args)).rejects.toMatchObject({
    code: 1,
  });
}, 15000);

test("malformed JSON errors do not echo credential contents", async () => {
  const directory = await fixtureDirectory();
  const path = join(directory, "invalid.json");
  await writeFile(path, '{"apiKey":"fixture-secret-never-echo",broken}');
  await expect(loadProviderProfile(path)).rejects.not.toThrow(
    "fixture-secret-never-echo",
  );
});

test("profile drives local model transport and persisted requestId deduplication through the CLI", async () => {
  const directory = await fixtureDirectory();
  let requests = 0;
  let receivedModel: unknown;
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    requests++;
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receivedModel = JSON.parse(Buffer.concat(chunks).toString()).model;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "profile-fixture-answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP fixture");
    const path = join(directory, "local.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "fixture",
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "profile-fixture",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      }),
    );
    const execute = promisify(execFile);
    const args = [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "run",
      "--db",
      join(directory, "runtime.sqlite"),
      "--cwd",
      directory,
      "--profile",
      path,
      "--prompt",
      "reply briefly",
      "--request-id",
      "one",
    ];
    const first = await execute(process.execPath, args, { timeout: 10000 });
    expect(first.stdout).toContain("profile-fixture-answer");
    const repeated = await execute(process.execPath, args, { timeout: 10000 });
    expect(repeated.stdout).toContain("profile-fixture-answer");
    expect(requests).toBe(1);
    expect(receivedModel).toBe("profile-fixture");
    expect(authorization).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 25000);
