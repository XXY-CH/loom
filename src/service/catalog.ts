import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectBudget, type ModelBudgetSummary } from "../runtime/budget.js";
import {
  type FeatureSpec,
  FeatureStore,
  validateFeatureSpec,
} from "../workflow/feature-store.js";
import type { WorkflowRun } from "../workflow/index.js";

export interface RunSummary {
  runId: string;
  goal: string;
  status: WorkflowRun["status"] | "initialization_pending";
  active: boolean;
  operationId: string | null;
  blockedReason: string | null;
  workspace: (WorkflowRun["workspace"] & { path: string }) | null;
  steps: WorkflowRun["steps"];
  budget: { maxCalls: number; maxTokens: number } | null;
  usage: ModelBudgetSummary | null;
}

/** Rebuildable projection. Run databases, never these rows, determine workflow state. */
export class RunCatalog {
  private readonly database: DatabaseSync;
  constructor(readonly dataRoot: string) {
    this.database = new DatabaseSync(join(dataRoot, "catalog.sqlite"));
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, summary TEXT NOT NULL)",
    );
  }

  async rebuild(): Promise<RunSummary[]> {
    const entries = await readdir(join(this.dataRoot, "runs"), {
      withFileTypes: true,
    });
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(entry.name)
      )
        continue;
      const path = join(this.dataRoot, "runs", entry.name, "agent.sqlite");
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          summaries.push(await this.pendingSummary(entry.name, path));
          continue;
        }
        throw error;
      }
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const snapshot = FeatureStore.inspectDatabase(database);
        if (!snapshot) {
          summaries.push(await this.pendingSummary(entry.name, path));
          continue;
        }
        if (snapshot.run.id !== entry.name)
          throw new Error("Run directory identity differs from persisted Run");
        summaries.push({
          runId: snapshot.run.id,
          goal: snapshot.run.goal,
          status: snapshot.run.status,
          active: false,
          operationId: snapshot.state.operation?.id ?? null,
          blockedReason: snapshot.state.blockedReason,
          workspace: {
            ...snapshot.run.workspace,
            path: snapshot.state.workspace.path,
          },
          steps: snapshot.run.steps,
          budget: snapshot.state.spec.budget ?? null,
          usage: inspectBudget(path),
        });
      } finally {
        database.close();
      }
    }
    this.database.exec("BEGIN");
    try {
      this.database.exec("DELETE FROM runs");
      const insert = this.database.prepare(
        "INSERT INTO runs(id, summary) VALUES (?, ?)",
      );
      for (const summary of summaries)
        insert.run(summary.runId, JSON.stringify(summary));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return summaries.sort((a, b) => a.runId.localeCompare(b.runId));
  }

  private async pendingSummary(
    runId: string,
    path: string,
  ): Promise<RunSummary> {
    const request = JSON.parse(
      await readFile(
        join(this.dataRoot, "runs", runId, "request.json"),
        "utf8",
      ),
    ) as { spec: FeatureSpec };
    validateFeatureSpec(request.spec);
    if (request.spec.runId !== runId)
      throw new Error("Run request identity differs");
    return {
      runId,
      goal: request.spec.goal,
      status: "initialization_pending",
      active: false,
      operationId: null,
      blockedReason: "Run initialization incomplete; explicit resume required",
      workspace: null,
      steps: [],
      budget: request.spec.budget ?? null,
      usage: inspectBudget(path),
    };
  }

  close(): void {
    this.database.close();
  }
}
