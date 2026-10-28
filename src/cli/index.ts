import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConnectionCatalog,
  ConnectionCatalogError,
} from "../providers/catalog.js";
import { connectionIdentity } from "../providers/identity.js";
import {
  createProviderModels,
  ProviderConfigError,
  type ProviderProfile,
} from "../providers/index.js";
import { loadProviderProfile } from "../providers/profile.js";
import { ModelBudget } from "../runtime/budget.js";
import { RecoveryRequiredError, RuntimeSession } from "../runtime/session.js";
import {
  acquireDatabaseLease,
  DatabaseOwnershipError,
} from "../service/database-lease.js";
import { runDashboard } from "../tui/controller.js";
import { FeatureRunner } from "../workflow/feature.js";
import {
  type FeatureSpec,
  FeatureStore,
  validateFeatureSpec,
} from "../workflow/feature-store.js";
import { fingerprintWorkspace } from "../workspace/evidence.js";
import { superviseFeatureObserver } from "./feature-observer.js";
import { CliUsageError, help, parseOptions } from "./options.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    process.stdout.write(help);
    return;
  }
  if (options.command === "connections") {
    const catalog = new ConnectionCatalog(options.catalog || undefined);
    if (options.action === "add") {
      const profile = await loadProviderProfile(options.profile as string);
      const status = await catalog.add(profile);
      process.stdout.write(`${JSON.stringify({ id: profile.id, status })}\n`);
    } else if (options.action === "edit") {
      // Explicit same-id replacement; the profile file defines the entry id,
      // and an unknown id is UNKNOWN_CONNECTION — never an upsert.
      const profile = await loadProviderProfile(options.profile as string);
      const status = await catalog.update(profile);
      process.stdout.write(`${JSON.stringify({ id: profile.id, status })}\n`);
    } else if (options.action === "remove") {
      const id = options.id as string;
      await catalog.remove(id);
      process.stdout.write(`${JSON.stringify({ id, status: "removed" })}\n`);
    } else {
      const connections = await catalog.list();
      process.stdout.write(
        `${JSON.stringify({
          catalog: catalog.path,
          connections,
        })}\n`,
      );
    }
    return;
  }
  if (options.command === "tui" && !options.db) {
    await runDashboard({ cwd: options.cwd, once: options.once ?? false });
    return;
  }
  // Offline human reconciliation of unsettled model budget calls. It resolves
  // no connection, reads no spec, and dispatches no model work; the database
  // lease alone decides whether another Loom runtime still holds the ledger.
  if (
    (options.command === "feature" || options.command === "debug") &&
    options["reconcile-budget"]
  ) {
    await access(options.db);
    const lease = await acquireDatabaseLease(options.db);
    let budget: ModelBudget | undefined;
    try {
      const ledger = `${lease.databasePath}.budget.sqlite`;
      if (!existsSync(ledger))
        throw new Error("No persisted model budget ledger for this database");
      budget = new ModelBudget(ledger);
      const before = budget.summary();
      budget.reconcile();
      const after = budget.summary();
      process.stdout.write(
        `${JSON.stringify({ database: lease.databasePath, before, after })}\n`,
      );
      process.stdout.write(
        "Budget reconciliation unblocks future dispatch; it does not count tokens for the reconciled calls and does not prove they never reached the endpoint.\n",
      );
    } finally {
      try {
        budget?.close();
      } finally {
        lease.release();
      }
    }
    return;
  }
  // The catalog is resolved in this client into a ProviderProfile object; no file is materialized.
  const loadedProfile = options.profile
    ? await loadProviderProfile(options.profile)
    : options["profile-id"]
      ? await new ConnectionCatalog(options.catalog || undefined).resolve(
          options["profile-id"],
        )
      : undefined;
  const connection =
    loadedProfile ??
    ({
      kind:
        options.provider === "anthropic"
          ? "anthropic"
          : options.endpoint
            ? "openai-compatible"
            : "openai",
      protocol:
        options.provider === "anthropic"
          ? "anthropic-messages"
          : options.protocol === "responses"
            ? "openai-responses"
            : "openai-completions",
      modelId: options.model,
      ...(options.endpoint ? { baseUrl: options.endpoint } : {}),
      ...(options["key-env"] ? { keyEnv: options["key-env"] } : {}),
    } as const);
  // Bind the persisted provider ID to nonsecret connection settings.
  const id = createHash("sha256")
    .update(
      JSON.stringify(
        loadedProfile
          ? {
              id: loadedProfile.id,
              kind: loadedProfile.kind,
              protocol: loadedProfile.protocol,
              modelId: loadedProfile.modelId,
              baseUrl: loadedProfile.baseUrl,
              keyEnv: loadedProfile.keyEnv,
              contextWindow: loadedProfile.contextWindow,
              maxTokens: loadedProfile.maxTokens,
            }
          : connection,
      ),
    )
    .digest("hex")
    .slice(0, 24);
  const profile: ProviderProfile = loadedProfile ?? { id, ...connection };
  const provider = createProviderModels(profile);
  // The persisted connection identity is the shared derivation over the
  // connection semantics (id excluded, full SHA-256 hex), so a CLI reopen
  // matches a service-started Run using the same connection. `profile.id`
  // above keeps its own 24hex derivation: it labels the Pi provider session
  // (`loom:<id>`), which is not part of the connection identity.
  const runConnectionIdentity = connectionIdentity(profile);
  if (options.command === "feature" || options.command === "debug") {
    const spec = JSON.parse(
      await readFile(options.spec as string, "utf8"),
    ) as FeatureSpec;
    if (options.command === "debug" && spec.workflow !== "debug")
      throw new CliUsageError("debug requires a spec with workflow: debug");
    validateFeatureSpec(spec);
    if (options.inspect) {
      await access(options.db);
      await access(spec.worktreePath);
      const lease = await acquireDatabaseLease(options.db);
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(lease.databasePath, { readOnly: true });
        const snapshot = FeatureStore.inspectDatabase(database);
        if (!snapshot) throw new Error("No persisted feature Run to inspect");
        const { state, run } = snapshot;
        process.stdout.write(
          `${JSON.stringify({
            runId: run.id,
            status: run.status,
            revision: run.revision,
            workspace: run.workspace,
            currentWorkspace: await fingerprintWorkspace(state.workspace),
            reconciliations: state.reconciliations ?? [],
            steps: run.steps.map(
              ({ id: step, role, status, attempt, failure }) => ({
                step,
                role,
                status,
                attempt,
                failure,
              }),
            ),
            operation: state.operation,
            blockedReason: state.blockedReason,
            artifacts: state.artifacts.map(({ id, stepId }) => ({
              id,
              stepId,
            })),
            evidence: run.evidence.map(
              ({ id, stepId, kind, valid, workspace }) => ({
                id,
                stepId,
                kind,
                valid,
                workspace,
              }),
            ),
          })}\n`,
        );
      } finally {
        try {
          database?.close();
        } finally {
          lease.release();
        }
      }
      return;
    }
    if (options.tui && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new CliUsageError("feature --tui requires an interactive terminal");
    const feature = await FeatureRunner.open({
      spec,
      runtime: {
        dbPath: options.db,
        connectionIdentity: runConnectionIdentity,
        ...provider,
      },
    });
    if (options.reconcile) {
      try {
        await feature.reconcile({
          operationId: options.operationIds?.[0] as string,
          expectedWorkspace: JSON.parse(
            options["expected-workspace"] as string,
          ),
          effectsReviewed: true,
        });
        const { state, run } = await feature.store.read();
        process.stdout.write(
          `${JSON.stringify({ runId: run.id, status: "reconciled", runStatus: run.status, operation: state.operation, blockedReason: state.blockedReason })}\n`,
        );
      } finally {
        await feature.close();
      }
      return;
    }
    let interrupted = false;
    let featureActive = true;
    let cancellation: Promise<void> | undefined;
    const onSignal = () => {
      if (!featureActive) return;
      interrupted = true;
      process.exitCode = 130;
      cancellation ??= feature.cancel().catch(() => {
        process.stderr.write(
          "Cancellation failed; inspect persisted feature state.\n",
        );
      });
    };
    const runFeature = async () => {
      try {
        await feature.run();
      } finally {
        featureActive = false;
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let failed = false;
    try {
      try {
        if (options.tui) {
          const observer = new AbortController();
          const dashboard = runDashboard({
            cwd: spec.worktreePath,
            runtime: feature.runtime,
            readOnly: true,
            signal: observer.signal,
            onInterrupt: onSignal,
          });
          await superviseFeatureObserver(runFeature, dashboard, onSignal, () =>
            observer.abort(),
          );
        } else await runFeature();
      } catch {
        failed = true;
      }
      await cancellation;
      const { state, run } = await feature.store.read();
      const status = state.blockedReason
        ? "blocked"
        : failed && !interrupted
          ? "error"
          : run.status;
      process.stdout.write(
        `${JSON.stringify({
          runId: run.id,
          status,
          steps: run.steps.map(({ id: step, status }) => ({ step, status })),
          usage: await feature.runtime.usageSummary(),
        })}\n`,
      );
      if (status !== "completed") process.exitCode = interrupted ? 130 : 1;
    } finally {
      await cancellation;
      await feature.close();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    return;
  }
  const runtime = await RuntimeSession.open({
    dbPath: options.db,
    cwd: options.cwd,
    connectionIdentity: runConnectionIdentity,
    ...provider,
  });
  if (options.command === "tui") {
    try {
      await runDashboard({
        cwd: options.cwd,
        runtime,
        once: options.once ?? false,
        ...(options.prompt
          ? {
              prompt: options.prompt,
              requestId: options["request-id"] as string,
            }
          : {}),
      });
    } finally {
      await runtime.close();
    }
    return;
  }
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    process.exitCode = 130;
    // Cancel the durable work, rather than only cancelling its waiter.
    void runtime.cancel().catch(() => {
      process.stderr.write(
        "Cancellation failed; inspect persisted state before resuming.\n",
      );
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (options.command === "run") {
      const submission = await runtime.submit({
        content: options.prompt as string,
        requestId: options["request-id"] as string,
      });
      process.stdout.write(`Submission: ${submission.id}\n`);
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      process.stdout.write(`Status: ${settled.status}\n`);
      const answer = await runtime.answer(settled);
      if (answer) process.stdout.write(`${answer}\n`);
      if (settled.status !== "done") process.exitCode = interrupted ? 130 : 1;
    } else if (options.command === "status") {
      const entries = await runtime.entries();
      const submissions = await runtime.submissionCounts();
      const recovery = await runtime.recoveryStatus();
      process.stdout.write(
        `${JSON.stringify({ entries: entries.length, submissions, recovery, usage: await runtime.usageSummary() })}\n`,
      );
    } else if (options.command === "ack-recovery") {
      await runtime.acknowledgeRecovery(options.operationIds as string[]);
      process.stdout.write(
        `${JSON.stringify({ recovery: await runtime.recoveryStatus() })}\n`,
      );
      process.stdout.write(
        "Effects review acknowledged. This does not cancel, roll back, or establish that an old shell has stopped.\n",
      );
    } else {
      await runtime.resume();
      await runtime.waitUntilIdle();
      const submissions = await runtime.submissionCounts();
      process.stdout.write(`${JSON.stringify({ submissions })}\n`);
      if (
        submissions.unanswered > 0 ||
        submissions.queued > 0 ||
        submissions.placed > 0
      ) {
        process.stderr.write(
          "Runtime has unanswered or unfinished submissions.\n",
        );
        process.exitCode = interrupted ? 130 : 1;
      }
    }
  } finally {
    await runtime.close();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch((error: unknown) => {
  // Provider failures may include request headers or server-echoed secrets.
  if (error instanceof RecoveryRequiredError) {
    process.stderr.write(
      `RECOVERY_REQUIRED: ${JSON.stringify({ pendingOperationIds: error.pendingOperationIds })}\n`,
    );
    process.stderr.write(
      "Inspect persisted state and manually review shell effects before ack-recovery --operation-id IDS --confirm-effects-reviewed. Acknowledgement does not cancel or roll back an operation.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    error instanceof ProviderConfigError ||
      error instanceof DatabaseOwnershipError ||
      error instanceof ConnectionCatalogError ||
      error instanceof CliUsageError
      ? `${error.code}: ${error.message}\n`
      : "Loom operation failed. Check configuration, credentials and persisted state.\n",
  );
  process.exitCode = 1;
});
