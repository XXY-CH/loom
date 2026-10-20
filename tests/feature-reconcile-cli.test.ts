import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { FeatureRunner } from "../src/workflow/feature.js";
import { createFeatureFixture, featureModel } from "./feature-fixture.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

test("feature CLI reconciles only matching reviewed intent without dispatching model work", async () => {
  const fixture = await createFeatureFixture();
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(500);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP fixture");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const connectionIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        kind: "openai-compatible",
        protocol: "openai-completions",
        modelId: "feature-fixture",
        baseUrl: endpoint,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const specPath = join(fixture.root, "spec.json");
  const common = [
    "feature",
    "--spec",
    specPath,
    "--db",
    fixture.dbPath,
    "--model",
    "feature-fixture",
    "--endpoint",
    endpoint,
    "--protocol",
    "completions",
  ];
  const launch = async (...args: string[]) => {
    try {
      const result = await execute(
        process.execPath,
        ["--import", "tsx", cli, ...common, ...args],
        { timeout: 10000 },
      );
      return { code: 0, ...result };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
  };
  let runner: FeatureRunner | undefined;
  try {
    await writeFile(specPath, JSON.stringify(fixture.spec));
    const model = featureModel({ malformedReview: true });
    const localProvider = model.runtime.models.getProvider(
      model.runtime.model.provider,
    );
    if (!localProvider) throw new Error("Missing local fixture provider");
    const providerId = `loom:${connectionIdentity}`;
    model.runtime.models.setProvider({
      ...localProvider,
      id: providerId,
      getModels: () =>
        localProvider
          .getModels()
          .map((entry) => ({ ...entry, provider: providerId })),
    });
    runner = await FeatureRunner.open({
      spec: fixture.spec,
      runtime: {
        ...model.runtime,
        dbPath: fixture.dbPath,
        connectionIdentity,
        model: { ...model.runtime.model, provider: providerId },
      },
    });
    await expect(runner.run()).rejects.toThrow();
    const pending = await runner.store.read();
    expect(pending.state.operation).toMatchObject({ stepId: "review" });
    await runner.close();
    runner = undefined;

    const inspected = await launch("--inspect");
    expect(inspected.code, inspected.stderr).toBe(0);
    const before = JSON.parse(inspected.stdout);
    expect(before.currentWorkspace.workspaceId).toBeTruthy();
    const reconcile = (operationId: string, workspace: unknown) =>
      launch(
        "--reconcile",
        "--operation-id",
        operationId,
        "--expected-workspace",
        JSON.stringify(workspace),
        "--confirm-effects-reviewed",
      );
    expect(
      (await reconcile("wrong-operation", before.currentWorkspace)).code,
    ).toBe(1);
    expect(
      (
        await reconcile(before.operation.id, {
          ...before.currentWorkspace,
          fingerprint: "0".repeat(64),
        })
      ).code,
    ).toBe(1);
    const accepted = await reconcile(
      before.operation.id,
      before.currentWorkspace,
    );
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      status: "reconciled",
      runStatus: "ready",
      operation: null,
      blockedReason: null,
    });
    const after = await launch("--inspect");
    expect(after.code, after.stderr).toBe(0);
    const audited = JSON.parse(after.stdout);
    expect(audited.reconciliations).toHaveLength(1);
    expect(audited.operation).toBeNull();
    expect(
      audited.steps.find((step: { step: string }) => step.step === "review")
        .status,
    ).toBe("pending");
    expect(audited.artifacts).toEqual(before.artifacts);
    expect(
      (await reconcile(before.operation.id, before.currentWorkspace)).code,
    ).toBe(1);
    expect(requests).toBe(0);
  } finally {
    await runner?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 25000);
