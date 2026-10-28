import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

export interface ModelBudgetLimits {
  maxCalls: number;
  maxTokens: number;
}
export interface ModelBudgetSummary {
  limits: ModelBudgetLimits;
  calls: number;
  tokens: number;
  pending: number;
  /** Calls a human marked reconciled: they no longer block dispatch and never
   * receive fabricated token counts; their call counts stay. */
  reconciled: number;
}

// Ledgers created before reconciliation existed have no `reconciled` column.
// The read-only projection below must tolerate them without writing, so the
// marker detection and both summary shapes live here, shared by writer and
// reader instead of an unconditional column reference.
const SUMMARY_WITH_MARKER = `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens),0) AS tokens,
  COALESCE(SUM(CASE WHEN tokens IS NULL AND COALESCE(reconciled,0)=0 THEN 1 ELSE 0 END),0) AS pending,
  COALESCE(SUM(reconciled),0) AS reconciled FROM calls`;
const SUMMARY_WITHOUT_MARKER = `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens),0) AS tokens,
  COUNT(*)-COUNT(tokens) AS pending, 0 AS reconciled FROM calls`;

function hasReconciliationMarker(database: DatabaseSync): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM pragma_table_info('calls') WHERE name='reconciled'",
      )
      .get() !== undefined
  );
}

function summarize(database: DatabaseSync): {
  calls: number;
  tokens: number;
  pending: number;
  reconciled: number;
} {
  return database
    .prepare(
      hasReconciliationMarker(database)
        ? SUMMARY_WITH_MARKER
        : SUMMARY_WITHOUT_MARKER,
    )
    .get() as {
    calls: number;
    tokens: number;
    pending: number;
    reconciled: number;
  };
}

/** A reservation is durable before provider dispatch, independent of Pi's result commit. */
export class ModelBudget {
  private readonly database: DatabaseSync;
  private readonly limits: ModelBudgetLimits | null;

  constructor(path: string, limits?: ModelBudgetLimits) {
    if (
      limits &&
      ![limits.maxCalls, limits.maxTokens].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("Model budget limits must be positive safe integers");
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), limits TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, tokens INTEGER);`);
      // Writer-side migration: reopening an older ledger adds the durable
      // reconciliation marker. Existing rows keep NULL ("not reconciled"),
      // which both summary shapes count as pending.
      if (!hasReconciliationMarker(this.database))
        this.database.exec("ALTER TABLE calls ADD COLUMN reconciled INTEGER");
      const previous = this.database
        .prepare("SELECT limits FROM configuration WHERE id=1")
        .get() as { limits: string } | undefined;
      if (previous) {
        this.limits = JSON.parse(previous.limits) as ModelBudgetLimits | null;
        if (
          limits &&
          (limits.maxCalls !== this.limits?.maxCalls ||
            limits.maxTokens !== this.limits?.maxTokens)
        )
          throw new Error(
            "Model budget configuration differs from persisted runtime",
          );
      } else {
        this.limits = limits
          ? { maxCalls: limits.maxCalls, maxTokens: limits.maxTokens }
          : null;
        this.database
          .prepare("INSERT INTO configuration VALUES(1, ?)")
          .run(JSON.stringify(this.limits));
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  summary(): ModelBudgetSummary | null {
    if (!this.limits) return null;
    return { limits: { ...this.limits }, ...summarize(this.database) };
  }

  /**
   * Marks every unsettled call as human-reconciled. Reconciliation is an
   * explicit authorization, never an outcome: the calls stop blocking
   * dispatch, keep their call counts, and never receive token numbers —
   * an unreported call may still have reached the endpoint.
   */
  reconcile(): void {
    if (!this.limits) throw new Error("Model budget is not configured");
    const result = this.database
      .prepare(
        "UPDATE calls SET reconciled=1 WHERE tokens IS NULL AND COALESCE(reconciled,0)=0",
      )
      .run();
    if (!result.changes)
      throw new Error("Model budget has no unsettled call to reconcile");
  }

  reserve(): number {
    const state = this.summary();
    if (!state) throw new Error("Model budget is not configured");
    // One live request can exceed the reported-token limit. Do not compound that
    // uncertainty with concurrent dispatch, or replay an unknown call after restart.
    if (state.pending)
      throw new Error("Model budget has an unsettled call; dispatch blocked");
    if (
      state.calls >= state.limits.maxCalls ||
      state.tokens >= state.limits.maxTokens
    )
      throw new Error("Model budget exhausted");
    return Number(
      this.database.prepare("INSERT INTO calls(tokens) VALUES(NULL)").run()
        .lastInsertRowid,
    );
  }

  settle(id: number, message: AssistantMessage): void {
    if (
      message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      message.stopReason === "deferred"
    )
      return;
    const values = [
      message.usage.input,
      message.usage.output,
      message.usage.cacheRead,
      message.usage.cacheWrite,
    ];
    if (!values.every((value) => Number.isSafeInteger(value) && value >= 0))
      return;
    const tokens = values.reduce((total, value) => total + value, 0);
    if (!Number.isSafeInteger(tokens)) return;
    // Reconciled rows must never gain a fabricated token count, so a late
    // settle for them structurally matches zero rows.
    this.database
      .prepare(
        "UPDATE calls SET tokens=? WHERE id=? AND tokens IS NULL AND COALESCE(reconciled,0)=0",
      )
      .run(tokens, id);
  }

  wrap(models: Models): Models {
    if (!this.limits) return models;
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    const completeMethods = new Set([
      "complete",
      "completeSimple",
      "fetchDeferred",
    ]);
    return new Proxy(models, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (
          typeof property !== "string" ||
          (!streamMethods.has(property) && !completeMethods.has(property))
        )
          return value.bind(target);
        return (...args: unknown[]) => {
          const id = this.reserve();
          // A throw/rejection keeps the reservation unknown: it may have reached
          // the endpoint. No automatic release or retry can assume zero cost.
          const result: unknown = Reflect.apply(value, target, args);
          if (completeMethods.has(property))
            return Promise.resolve(result as Promise<AssistantMessage>).then(
              (message) => {
                this.settle(id, message);
                return message;
              },
            );
          const stream = result as ReturnType<Models["streamSimple"]>;
          const settle = (message: AssistantMessage) => {
            this.settle(id, message);
            return message;
          };
          return new Proxy(stream, {
            get(target, key) {
              if (key === "result") return () => stream.result().then(settle);
              const member: unknown = Reflect.get(target, key, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
        };
      },
    });
  }

  close(): void {
    this.database.close();
  }
}

/** Offline observation only: never creates a ledger or changes its configuration. */
export function inspectBudget(
  runtimeDatabasePath: string,
): ModelBudgetSummary | null {
  const path = `${runtimeDatabasePath}.budget.sqlite`;
  if (!existsSync(path)) return null;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT limits FROM configuration WHERE id=1")
      .get() as { limits: string } | undefined;
    const limits = row
      ? (JSON.parse(row.limits) as ModelBudgetLimits | null)
      : null;
    if (!limits) return null;
    // Old-format ledgers (pre-reconciliation schema) read through the
    // without-marker shape: no column is added and the file is never written.
    return { limits, ...summarize(database) };
  } finally {
    database.close();
  }
}
