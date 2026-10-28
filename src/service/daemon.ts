import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { ModelBudget, type ModelBudgetSummary } from "../runtime/budget.js";
import type { RuntimeOptions } from "../runtime/session.js";
import type { GitFile, GitSnapshot } from "../tui/types.js";
import { FeatureRunner } from "../workflow/feature.js";
import {
  type FeatureSpec,
  type FeatureState,
  FeatureStore,
  validateFeatureSpec,
} from "../workflow/feature-store.js";
import type { Evidence, WorkflowRun } from "../workflow/index.js";
import { readGitDiff, readGitSnapshot } from "../workspace/git.js";
import { RunCatalog, type RunSummary } from "./catalog.js";
import {
  acquireDatabaseLease,
  type DatabaseLease,
  DatabaseOwnershipError,
} from "./database-lease.js";
import { ServiceHttpProjection } from "./http.js";

/** One file/layer pairing; the text keeps git.ts' embedded 64 KiB truncation marker. */
export type RunDiffEntry = {
  path: string;
  originalPath?: string;
  mode: "working" | "staged";
  text: string;
};
/** Bounded single-response projection of a run worktree: file list plus per-file diffs. */
export type RunDiff = {
  root: string;
  observedAt: number;
  files: GitFile[];
  diffs: RunDiffEntry[];
  truncatedFiles: boolean;
};
/** Single file/layer view; text shares the aggregate's readGitDiff 64 KiB truncation. */
export type RunDiffFile = {
  root: string;
  observedAt: number;
  path: string;
  originalPath?: string;
  mode: "working" | "staged";
  text: string;
};
/** One page of the full changed-file index; same readGitSnapshot source and order. */
export type RunDiffFilePage = {
  root: string;
  observedAt: number;
  total: number;
  files: GitFile[];
  nextAfter: string | null;
};
/** Persisted artifact body behind one evidence entry, capped for one response. */
export type RunArtifact = {
  text: string;
  truncated: boolean;
  byteLength: number;
};
/** One explicit budget ledger reconciliation: the before/after summaries the
 * CLI offline entry prints, projected over the wire. `database` is the
 * canonical Run DB path whose sidecar ledger was reconciled. */
export type BudgetReconciliation = {
  database: string;
  before: ModelBudgetSummary | null;
  after: ModelBudgetSummary | null;
};
export type ServiceRequest =
  | { method: "start"; spec: FeatureSpec; profile: ProviderProfile }
  | { method: "list" }
  | { method: "connections" }
  | { method: "connections-add"; profile: ProviderProfile }
  | { method: "connections-update"; profile: ProviderProfile }
  | { method: "connections-remove"; id: string }
  | { method: "status" | "cancel" | "resume"; runId: string }
  | { method: "reconcile-budget"; runId: string }
  | { method: "diff" | "evidence"; runId: string }
  | { method: "artifact"; runId: string; evidenceId: string }
  | {
      method: "diff-file";
      runId: string;
      path: string;
      mode: "working" | "staged";
    }
  | { method: "diff-files"; runId: string; after?: string; limit?: number };
/** One connection-catalog write outcome; the CLI subcommands print the same
 * {id, status} shape and the workbench renders the status verbatim. */
export type ConnectionWriteResult = {
  id: string;
  status: "added" | "unchanged" | "updated" | "removed";
};
export type ServiceResult =
  | RunSummary
  | RunSummary[]
  | ProviderProfile[]
  | ConnectionWriteResult
  | RunDiff
  | RunDiffFile
  | RunDiffFilePage
  | Evidence[]
  | RunArtifact
  | BudgetReconciliation;
export type RuntimeFactory = (
  profile: ProviderProfile,
) => Omit<RuntimeOptions, "cwd" | "dbPath">;
type StartRequest = { spec: FeatureSpec; profile: ProviderProfile };
type OwnedRun = { runner: FeatureRunner; active: Promise<unknown> | null };
export const serviceSocketPath = (dataRoot: string) =>
  join(resolve(dataRoot), "loom.sock");
const DEFAULT_BUDGET = { maxCalls: 64, maxTokens: 1_000_000 };
/** Caps the aggregate diff response; per-file views and the full paginated index live behind diff-file/diff-files. */
const MAX_DIFF_FILES = 50;
/** diff-files paging: default page size and its inclusive upper bound. */
const DEFAULT_DIFF_FILES_LIMIT = 50;
const MAX_DIFF_FILES_LIMIT = 200;
/** Read-side cap for one artifact body; mirrors git.ts PREVIEW_BYTES and its
 * truncation marker wording. Write-side caps differ by producer (worker
 * reports are refused above 64 KiB, command and deliver records may legally
 * reach 1 MiB), so this projection is the only uniform bound and
 * truncated:true is a reachable state, not a dead defensive branch. */
const ARTIFACT_PREVIEW_BYTES = 64 * 1024;
const ARTIFACT_TRUNCATION_MARKER = "\n… preview truncated (64 KiB)";

/** Caps one persisted artifact body for a single response; byteLength keeps
 * the full stored size so truncated views can state what was cut. */
export function projectArtifactBody(body: string): RunArtifact {
  const byteLength = Buffer.byteLength(body, "utf8");
  if (byteLength <= ARTIFACT_PREVIEW_BYTES)
    return { text: body, truncated: false, byteLength };
  return {
    text: `${Buffer.from(body, "utf8").subarray(0, ARTIFACT_PREVIEW_BYTES).toString("utf8")}${ARTIFACT_TRUNCATION_MARKER}`,
    truncated: true,
    byteLength,
  };
}

/**
 * Resolves the persisted body behind one evidence entry. The writer only ever
 * emits `pi:feature/<operationId>` references whose operation id is also the
 * evidence id (feature.ts records both in one store update), so foreign
 * prefixes, ids that do not match the evidence entry, and references without
 * a persisted body are structured refusals — never guesses.
 */
export function resolveArtifactBody(
  evidence: Evidence[],
  artifacts: Array<{ id: string; body: string }>,
  evidenceId: string,
): string {
  if (typeof evidenceId !== "string" || evidenceId.length === 0)
    throw new Error("Invalid artifact evidence id");
  const entry = evidence.find((item) => item.id === evidenceId);
  if (!entry) throw new Error("Unknown evidence id");
  if (!entry.artifactRef.startsWith("pi:feature/"))
    throw new Error("Unsupported artifact reference");
  const referenced = entry.artifactRef.slice("pi:feature/".length);
  if (referenced !== entry.id)
    throw new Error("Artifact reference does not match evidence id");
  const artifact = artifacts.find((item) => item.id === referenced);
  if (!artifact) throw new Error("Artifact body missing from Run state");
  return artifact.body;
}
const profileFields = new Set([
  "id",
  "kind",
  "protocol",
  "modelId",
  "baseUrl",
  "keyEnv",
  "contextWindow",
  "maxTokens",
]);

function normalizeRequest(
  spec: FeatureSpec,
  profile: ProviderProfile,
): StartRequest {
  validateFeatureSpec(spec);
  if (
    !profile ||
    typeof profile !== "object" ||
    Object.keys(profile).some((key) => !profileFields.has(key))
  )
    throw new Error("Invalid provider profile; credentials must use keyEnv");
  // Validate the public profile without reading credentials. Actual resolution is only on explicit dispatch.
  const keyEnv =
    profile.keyEnv ??
    (profile.kind === "openai"
      ? "OPENAI_API_KEY"
      : profile.kind === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : undefined);
  createProviderModels(
    profile,
    keyEnv ? { [keyEnv]: "validation-placeholder" } : {},
  );
  const normalizedSpec = {
    runId: spec.runId,
    goal: spec.goal,
    baseCommit: spec.baseCommit,
    ...(spec.workflow ? { workflow: spec.workflow } : {}),
    ...(spec.targeted ? { targeted: spec.targeted } : {}),
    ...(spec.reproduce ? { reproduce: spec.reproduce } : {}),
    ...(spec.hypothesis ? { hypothesis: spec.hypothesis } : {}),
    regression: spec.regression,
    repositoryPath: resolve(spec.repositoryPath),
    worktreePath: resolve(spec.worktreePath),
    budget: spec.budget ?? { ...DEFAULT_BUDGET },
  };
  return JSON.parse(
    JSON.stringify({ spec: normalizedSpec, profile }),
  ) as StartRequest;
}
function identity(value: StartRequest): string {
  // Input field order is not part of request identity.
  const { spec, profile } = value;
  return JSON.stringify({
    spec: {
      runId: spec.runId,
      goal: spec.goal,
      repositoryPath: spec.repositoryPath,
      baseCommit: spec.baseCommit,
      worktreePath: spec.worktreePath,
      targeted: spec.targeted,
      reproduce: spec.reproduce,
      hypothesis: spec.hypothesis,
      regression: spec.regression,
      workflow: spec.workflow ?? "feature",
      budget: spec.budget,
    },
    profile: Object.fromEntries(
      [...profileFields].map((key) => [
        key,
        profile[key as keyof ProviderProfile],
      ]),
    ),
  });
}

/** Layer contract shared by the aggregate and single-file projections: untracked files only ever have a working layer. */
function diffModes(file: GitFile): Array<"working" | "staged"> {
  if (file.index === "?") return ["working"];
  const modes: Array<"working" | "staged"> = [];
  if (![".", "?", " "].includes(file.index)) modes.push("staged");
  if (![".", "?", " "].includes(file.working)) modes.push("working");
  return modes;
}

/** The socket/HTTP error channel serializes strings only, so structured
 * catalog/profile error codes (CONNECTION_CONFLICT, UNKNOWN_CONNECTION,
 * CATALOG_BUSY, STORAGE_INVALID, UNSAFE_STORAGE, INVALID_PROFILE) are
 * prefixed into the wire message — the same wiring reconcileBudget uses for
 * DatabaseOwnershipError, so HTTP clients and the workbench can branch on and
 * display the code verbatim. */
function prefixedCatalogError(error: unknown): Error {
  if (
    error instanceof ConnectionCatalogError ||
    error instanceof ProviderConfigError
  )
    return new Error(`${error.code}: ${error.message}`);
  return error instanceof Error
    ? error
    : new Error("Connection catalog write failed");
}

/** Single local host owner. Startup only projects persisted state; dispatch is always explicit. */
export class LoomService {
  private readonly runs = new Map<string, OwnedRun>();
  private readonly admissions = new Map<string, Promise<unknown>>();
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private httpProjection: ServiceHttpProjection | undefined;
  private closing: Promise<void> | undefined;
  private stopping = false;
  private closed = false;
  private constructor(
    readonly dataRoot: string,
    private readonly catalog: RunCatalog,
    private readonly lease: DatabaseLease,
    private readonly runtimeFactory: RuntimeFactory,
    /** Client-side connection catalog directory projected via the
     * `connections` read method and the
     * `connections-add`/`connections-update`/`connections-remove` write
     * methods; undefined keeps all of them disabled. Stored raw: validation is
     * per-request so a bad directory never blocks startup. */
    private readonly connectionCatalogDirectory: string | undefined,
  ) {}

  /** Present only when opened with `http: true`; the socket path stays primary. */
  get http(): ServiceHttpProjection | undefined {
    return this.httpProjection;
  }

  static async open(options: {
    dataRoot: string;
    runtimeFactory?: RuntimeFactory;
    http?: boolean;
    connectionCatalogDirectory?: string;
  }): Promise<LoomService> {
    const dataRoot = resolve(options.dataRoot);
    await mkdir(join(dataRoot, "runs"), { recursive: true, mode: 0o700 });
    await chmod(dataRoot, 0o700);
    const lease = await acquireDatabaseLease(join(dataRoot, "service-owner"));
    let service: LoomService | undefined;
    try {
      const catalog = new RunCatalog(dataRoot);
      service = new LoomService(
        dataRoot,
        catalog,
        lease,
        options.runtimeFactory ??
          ((profile) => ({
            ...createProviderModels(profile),
            connectionIdentity: connectionIdentity(profile),
          })),
        options.connectionCatalogDirectory,
      );
      await catalog.rebuild();
      await service.listen();
      if (options.http) {
        try {
          service.httpProjection = await ServiceHttpProjection.open(service, {
            dataRoot,
          });
        } catch (error) {
          await service.close().catch(() => {});
          throw error;
        }
      }
      return service;
    } catch (error) {
      service?.catalog.close();
      lease.release();
      throw error;
    }
  }

  private async listen(): Promise<void> {
    const path = serviceSocketPath(this.dataRoot);
    await rm(path, { force: true });
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      let body = "";
      socket.on("data", (chunk) => {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 128 * 1024) {
          socket.destroy();
          return;
        }
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        socket.removeAllListeners("data");
        let request: ServiceRequest;
        try {
          request = JSON.parse(body.slice(0, newline));
        } catch {
          socket.end(
            `${JSON.stringify({ ok: false, error: "Invalid service request JSON" })}\n`,
          );
          return;
        }
        void this.request(request).then(
          (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
          (error: unknown) =>
            socket.end(
              `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Service request failed" })}\n`,
            ),
        );
      });
    });
    this.server = server;
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        accept();
      });
    });
    await chmod(path, 0o600);
  }

  private databasePath(runId: string) {
    return join(this.dataRoot, "runs", runId, "agent.sqlite");
  }
  private async storedRequest(runId: string): Promise<StartRequest> {
    const value = JSON.parse(
      await readFile(
        join(this.dataRoot, "runs", runId, "request.json"),
        "utf8",
      ),
    ) as StartRequest;
    const request = normalizeRequest(value.spec, value.profile);
    if (request.spec.runId !== runId)
      throw new Error("Run request identity differs");
    return request;
  }
  private serial<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.admissions.get(runId) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.admissions.set(runId, next);
    void next
      .finally(() => {
        if (this.admissions.get(runId) === next) this.admissions.delete(runId);
      })
      .catch(() => {});
    return next;
  }

  async request(request: ServiceRequest): Promise<ServiceResult> {
    if (this.stopping) throw new Error("Service is stopping");
    if (!request || typeof request !== "object")
      throw new Error("Invalid service request");
    if (request.method === "list") return this.list();
    if (request.method === "connections") return this.connections();
    if (request.method === "connections-add")
      return this.connectionsAdd(request.profile);
    if (request.method === "connections-update")
      return this.connectionsUpdate(request.profile);
    if (request.method === "connections-remove")
      return this.connectionsRemove(request.id);
    if (request.method === "start") {
      const normalized = normalizeRequest(request.spec, request.profile);
      return this.serial(normalized.spec.runId, async () => {
        const directory = join(this.dataRoot, "runs", normalized.spec.runId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, "request.json");
        try {
          await writeFile(path, JSON.stringify(normalized), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (
            identity(await this.storedRequest(normalized.spec.runId)) !==
            identity(normalized)
          )
            throw new Error("Run request differs from persisted configuration");
          // Duplicate start acknowledges acceptance, never resumes interrupted work.
          return this.status(normalized.spec.runId);
        }
        try {
          await this.dispatch(normalized);
        } catch {
          throw new Error(
            "Run initialization failed; inspect local configuration and persisted state",
          );
        }
        return this.status(normalized.spec.runId);
      });
    }
    // Every remaining method carries a runId; shape-check it at the entrance
    // before any storage access, so malformed ids can never reach the
    // worktree or Run DB paths. Read-only methods and the one budget-ledger
    // write join the same guard unchanged; the id pattern itself is never
    // relaxed.
    if (
      ![
        "status",
        "cancel",
        "resume",
        "reconcile-budget",
        "diff",
        "evidence",
        "artifact",
        "diff-file",
        "diff-files",
      ].includes(request.method) ||
      !("runId" in request) ||
      typeof request.runId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(request.runId)
    )
      throw new Error("Invalid service method or run id");
    if (request.method === "diff") return this.diff(request.runId);
    if (request.method === "evidence") return this.evidence(request.runId);
    if (request.method === "artifact") return this.artifact(request);
    if (request.method === "diff-file") return this.diffFile(request);
    if (request.method === "diff-files") return this.diffFiles(request);
    if (request.method === "status") return this.status(request.runId);
    // Explicit human action, never queued or retried: while this service (or
    // any CLI process) dispatches the run, the lease inside reconcileBudget
    // fails the request closed instead of waiting for the run to end.
    if (request.method === "reconcile-budget")
      return this.serial(request.runId, () =>
        this.reconcileBudget(request.runId),
      );
    return this.serial(request.runId, async () => {
      if (request.method === "cancel") {
        const status = await this.status(request.runId);
        if (status.status === "completed" || status.status === "cancelled")
          return status;
        const current = await this.owned(
          await this.storedRequest(request.runId),
        );
        await current.runner.cancel();
        await this.finish(request.runId, current);
      } else {
        const status = await this.status(request.runId);
        if (status.status === "cancelled")
          throw new Error("Cannot resume cancelled Run");
        if (
          status.status !== "initialization_pending" &&
          (status.operationId || status.blockedReason)
        )
          throw new Error(
            "Unknown or blocked operation requires reconciliation before resume",
          );
        if (status.status !== "completed" && !status.active)
          await this.dispatch(await this.storedRequest(request.runId));
      }
      return this.status(request.runId);
    });
  }

  private async owned(request: StartRequest): Promise<OwnedRun> {
    const existing = this.runs.get(request.spec.runId);
    if (existing) return existing;
    let runner: FeatureRunner;
    try {
      runner = await FeatureRunner.open({
        spec: request.spec,
        runtime: {
          ...this.runtimeFactory(request.profile),
          dbPath: this.databasePath(request.spec.runId),
          ...(request.spec.budget ? { budget: request.spec.budget } : {}),
        },
      });
    } catch {
      throw new Error(
        "Run initialization failed; inspect local configuration and persisted state",
      );
    }
    const owned = { runner, active: null };
    this.runs.set(request.spec.runId, owned);
    return owned;
  }
  private async dispatch(request: StartRequest): Promise<void> {
    const owned = await this.owned(request);
    if (owned.active) return;
    owned.active = owned.runner.run();
    void owned.active
      .catch(() => {})
      .finally(() => this.finish(request.spec.runId, owned))
      .catch(() => {});
  }
  private async finish(runId: string, owned: OwnedRun): Promise<void> {
    if (owned.active) await owned.active.catch(() => {});
    await owned.runner.close();
    if (this.runs.get(runId) === owned) this.runs.delete(runId);
  }
  private async list(): Promise<RunSummary[]> {
    const rows = await this.catalog.rebuild();
    for (const row of rows) {
      const owned = this.runs.get(row.runId);
      row.active = Boolean(owned?.active);
    }
    return rows;
  }

  /**
   * Read-only projection of the client-side connection catalog (same machine,
   * same user). Evaluated lazily per request — open() never validates the
   * directory, so an invalid path cannot block service startup — and a read
   * never creates or writes catalog storage: a missing directory is a
   * structured error, unlike the CLI `connections list`, which mkdirs
   * owner-only storage on demand. The stat pre-check keeps the documented
   * "does not exist"/"not a directory" messages — spelled with the same
   * resolve()'d absolute path the catalog's own loadReadOnly race message
   * uses, so one fault shows one path spelling whatever form --catalog was
   * given (relative or containing "..") — and the read itself goes through
   * the catalog's structurally mkdir-free listReadOnly(), so even a directory
   * deleted between the pre-check and the read fails closed with the same
   * "does not exist" structured error (STORAGE_INVALID) instead of being
   * recreated. Existing-but-invalid storage keeps the catalog's own
   * STORAGE_INVALID/UNSAFE_STORAGE messages, passed through as structured
   * service errors. Management (add/remove) goes through the write methods
   * below — same opt-in, same catalog write path as the CLI.
   */
  private connectionCatalog(): ConnectionCatalog {
    const directory = this.connectionCatalogDirectory;
    if (directory === undefined)
      throw new Error(
        "Connection catalog is not enabled; start the service with --catalog DIR",
      );
    return new ConnectionCatalog(directory);
  }

  private async connections(): Promise<ProviderProfile[]> {
    const catalog = this.connectionCatalog();
    const absolute = catalog.directory;
    const info = await stat(absolute).catch(() => null);
    if (info === null)
      throw new Error(
        `Connection catalog directory does not exist: ${absolute}`,
      );
    if (!info.isDirectory())
      throw new Error(
        `Connection catalog path is not a directory: ${absolute}`,
      );
    // listReadOnly() re-uses the catalog's owner-only/O_NOFOLLOW checks and
    // its validated non-secret ProviderProfile entries (parseProviderProfile)
    // while making "a read never mkdirs" structural rather than a property of
    // the pre-check's timing.
    return catalog.listReadOnly();
  }

  /**
   * Catalog writes under the same --catalog opt-in as the read projection:
   * the identical ConnectionCatalog.add/update/remove paths the CLI
   * subcommands use (recursive owner-only mkdir on demand — the read side's
   * structural no-mkdir guarantee is intentionally not shared with writes —
   * cross-instance lock, atomic save, idempotent add, explicit update,
   * same-id change refusal on add, parseProviderProfile's non-secret
   * construction). The socket/HTTP error channel carries strings only, so
   * structured ConnectionCatalogError and ProviderConfigError codes are
   * prefixed into the wire message the same way reconcileBudget prefixes
   * DatabaseOwnershipError.
   */
  private async connectionsAdd(
    profile: ProviderProfile,
  ): Promise<ConnectionWriteResult> {
    const catalog = this.connectionCatalog();
    try {
      const status = await catalog.add(profile);
      return { id: profile.id, status };
    } catch (error) {
      throw prefixedCatalogError(error);
    }
  }

  /** The explicit edit path: replace one entry's fields under its own id via
   * the identical ConnectionCatalog.update the CLI `connections edit`
   * subcommand uses — unknown ids are UNKNOWN_CONNECTION (never an upsert),
   * identical canonical settings are an idempotent zero-write "unchanged",
   * different settings replace the entry. add's same-id refusal is untouched:
   * connections-add keeps rejecting changed settings for an existing id. */
  private async connectionsUpdate(
    profile: ProviderProfile,
  ): Promise<ConnectionWriteResult> {
    const catalog = this.connectionCatalog();
    try {
      const status = await catalog.update(profile);
      return { id: profile.id, status };
    } catch (error) {
      throw prefixedCatalogError(error);
    }
  }

  private async connectionsRemove(id: string): Promise<ConnectionWriteResult> {
    // parseProviderProfile accepts any non-empty string id, so CLI-created
    // entries with dots, spaces, or Unicode ids stay removable here; the same
    // minimal shape check guards raw socket JSON.
    if (typeof id !== "string" || id.length === 0)
      throw new Error("Invalid connection id");
    const catalog = this.connectionCatalog();
    try {
      await catalog.remove(id);
      return { id, status: "removed" };
    } catch (error) {
      throw prefixedCatalogError(error);
    }
  }

  /**
   * Explicit human reconciliation of unsettled budget calls — the same
   * acquireDatabaseLease → `<db>.budget.sqlite` → before/reconcile/after →
   * release template as the CLI offline entry, with identical semantics (no
   * token fabrication, call counts kept, dispatch unblocked). The lease, not
   * process membership, is the only ownership judge: a dispatching run (this
   * service's own runner or an external CLI process holding the run) fails
   * closed with the structured ownership error, whose code is prefixed into
   * the wire message because the socket/HTTP error channel carries strings
   * only. The only write is the per-run budget ledger; the Run DB itself
   * stays untouched by this path.
   */
  private async reconcileBudget(runId: string): Promise<BudgetReconciliation> {
    await this.status(runId);
    const databasePath = this.databasePath(runId);
    try {
      await stat(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("No persisted model budget ledger for this database");
      throw error;
    }
    let lease: DatabaseLease | undefined;
    let budget: ModelBudget | undefined;
    try {
      lease = await acquireDatabaseLease(databasePath);
      const ledger = `${lease.databasePath}.budget.sqlite`;
      if (!existsSync(ledger))
        throw new Error("No persisted model budget ledger for this database");
      budget = new ModelBudget(ledger);
      const before = budget.summary();
      budget.reconcile();
      const after = budget.summary();
      return { database: lease.databasePath, before, after };
    } catch (error) {
      if (error instanceof DatabaseOwnershipError)
        throw new Error(`${error.code}: ${error.message}`);
      throw error;
    } finally {
      try {
        budget?.close();
      } finally {
        lease?.release();
      }
    }
  }
  private async status(runId: string): Promise<RunSummary> {
    const row = (await this.list()).find((item) => item.runId === runId);
    if (!row) throw new Error("Unknown Run");
    return row;
  }

  /** Shared snapshot access for the diff projections; pending runs have no worktree yet. */
  private async diffSnapshot(
    runId: string,
  ): Promise<{ worktree: string; snapshot: GitSnapshot }> {
    const status = await this.status(runId);
    const worktree = status.workspace?.path;
    if (!worktree)
      throw new Error(
        "Run initialization incomplete; explicit resume required",
      );
    return { worktree, snapshot: await readGitSnapshot(worktree) };
  }

  /** Read-only worktree projection; no staging, committing, or ownership is implied. */
  private async diff(runId: string): Promise<RunDiff> {
    const { worktree, snapshot } = await this.diffSnapshot(runId);
    const files = snapshot.files.slice(0, MAX_DIFF_FILES);
    const diffs: RunDiffEntry[] = [];
    for (const file of files) {
      // One entry per file and layer, mirroring the TUI's staged/working split.
      for (const mode of diffModes(file))
        diffs.push({
          path: file.path,
          ...(file.originalPath ? { originalPath: file.originalPath } : {}),
          mode,
          // Each call keeps git.ts' 64 KiB preview cap and truncation marker.
          text: await readGitDiff(worktree, file, mode),
        });
    }
    return {
      root: snapshot.root,
      observedAt: snapshot.observedAt,
      files,
      diffs,
      truncatedFiles: snapshot.files.length > MAX_DIFF_FILES,
    };
  }

  /** Read-only single file/layer diff; identical text semantics as the aggregate entry. */
  private async diffFile(
    request: Extract<ServiceRequest, { method: "diff-file" }>,
  ): Promise<RunDiffFile> {
    // Raw socket JSON can carry anything; validate before any storage access.
    if (request.mode !== "working" && request.mode !== "staged")
      throw new Error("Invalid diff file mode");
    const { worktree, snapshot } = await this.diffSnapshot(request.runId);
    const file = snapshot.files.find((item) => item.path === request.path);
    if (!file) throw new Error("Unknown diff file path");
    if (!diffModes(file).includes(request.mode))
      throw new Error("Diff mode does not apply to this file");
    return {
      root: snapshot.root,
      observedAt: snapshot.observedAt,
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      mode: request.mode,
      text: await readGitDiff(worktree, file, request.mode),
    };
  }

  /** Read-only paginated index over the full changed-file list; visibility only. */
  private async diffFiles(
    request: Extract<ServiceRequest, { method: "diff-files" }>,
  ): Promise<RunDiffFilePage> {
    const { limit, after } = request;
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIFF_FILES_LIMIT)
    )
      throw new Error("Invalid diff files limit");
    const { snapshot } = await this.diffSnapshot(request.runId);
    const size = limit ?? DEFAULT_DIFF_FILES_LIMIT;
    let start = 0;
    if (after !== undefined) {
      // Path cursor in snapshot order; a stale cursor forces a fresh first page.
      const cursor = snapshot.files.findIndex((file) => file.path === after);
      if (cursor < 0) throw new Error("Unknown diff files cursor");
      start = cursor + 1;
    }
    const end = start + size;
    const files = snapshot.files.slice(start, end);
    // Cursor = this page's last entry; null once no further page exists.
    const last = files[files.length - 1];
    return {
      root: snapshot.root,
      observedAt: snapshot.observedAt,
      total: snapshot.files.length,
      files,
      nextAfter: end < snapshot.files.length ? (last?.path ?? null) : null,
    };
  }

  /** Shared read-only Run DB snapshot for the evidence projections; the
   * artifact body view reads the same snapshot as the evidence list, so both
   * always agree on one persisted state. */
  private async runSnapshot(
    runId: string,
  ): Promise<{ state: FeatureState; run: WorkflowRun }> {
    await this.status(runId);
    const path = this.databasePath(runId);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          "Run initialization incomplete; explicit resume required",
        );
      throw error;
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const snapshot = FeatureStore.inspectDatabase(database);
      if (!snapshot)
        throw new Error(
          "Run initialization incomplete; explicit resume required",
        );
      if (snapshot.run.id !== runId)
        throw new Error("Run directory identity differs from persisted Run");
      return snapshot;
    } finally {
      database.close();
    }
  }

  /** Read-only Evidence projection straight from the Run DB; no writes, no credentials. */
  private async evidence(runId: string): Promise<Evidence[]> {
    return (await this.runSnapshot(runId)).run.evidence;
  }

  /** Read-only artifact body projection from the same snapshot as evidence();
   * only pi:feature/<evidence id> references with a persisted body resolve. */
  private async artifact(
    request: Extract<ServiceRequest, { method: "artifact" }>,
  ): Promise<RunArtifact> {
    const snapshot = await this.runSnapshot(request.runId);
    return projectArtifactBody(
      resolveArtifactBody(
        snapshot.run.evidence,
        snapshot.state.artifacts,
        request.evidenceId,
      ),
    );
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.stopping = true;
    this.closing ??= (async () => {
      // Close the HTTP projection first so no new actions arrive mid-shutdown.
      const http = this.httpProjection;
      this.httpProjection = undefined;
      await http?.close();
      const serverClosed = this.server?.listening
        ? new Promise<void>((accept, reject) =>
            this.server?.close((error) => (error ? reject(error) : accept())),
          )
        : Promise.resolve();
      for (const socket of this.sockets) socket.destroy();
      await Promise.allSettled([...this.admissions.values()]);
      for (const [runId, owned] of this.runs) {
        const snapshot = await owned.runner.store.read();
        if (snapshot.run.status === "completed")
          await owned.active?.catch(() => {});
        await owned.runner.close();
        this.runs.delete(runId);
      }
      await serverClosed;
      await rm(serviceSocketPath(this.dataRoot), { force: true });
      this.catalog.close();
      this.lease.release();
      this.closed = true;
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
