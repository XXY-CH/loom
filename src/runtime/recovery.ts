import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export class RecoveryRequiredError extends Error {
  readonly code = "RECOVERY_REQUIRED";
  constructor(public readonly pendingOperationIds: string[]) {
    super("Interrupted operations require explicit reconciliation");
    this.name = "RecoveryRequiredError";
  }
}

/** No commands, credentials, outputs, or historic PIDs belong in this journal. */
export class OperationJournal {
  private readonly database: DatabaseSync;
  private readonly active = new Set<string>();

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'acknowledged')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        checkpointed INTEGER NOT NULL DEFAULT 0 CHECK (checkpointed IN (0, 1))
      );
      `);
      try {
        this.database.exec(
          "ALTER TABLE operations ADD COLUMN checkpointed INTEGER NOT NULL DEFAULT 0 CHECK (checkpointed IN (0, 1))",
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("duplicate column name")
        ) {
          throw error;
        }
      }
      // A Pi result commit and this journal live in separate databases. Without a
      // checkpoint, a prior process may have died between those commits.
      this.database
        .prepare(
          "UPDATE operations SET status = 'pending', finished_at = NULL WHERE status = 'settled' AND checkpointed = 0",
        )
        .run();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  start(): string {
    const id = randomUUID();
    // Autocommit must finish durably before the environment may spawn a process.
    this.database
      .prepare(
        "INSERT INTO operations (operation_id, status, started_at, finished_at) VALUES (?, 'pending', ?, NULL)",
      )
      .run(id, Date.now());
    this.active.add(id);
    return id;
  }

  settle(id: string): void {
    this.database
      .prepare(
        "UPDATE operations SET status = 'settled', finished_at = ? WHERE operation_id = ? AND status = 'pending'",
      )
      .run(Date.now(), id);
    this.active.delete(id);
  }

  abandon(id: string): void {
    this.active.delete(id);
  }

  pending(): string[] {
    const rows = this.database
      .prepare(
        "SELECT operation_id FROM operations WHERE status = 'pending' ORDER BY operation_id",
      )
      .all() as { operation_id: string }[];
    return rows
      .map((row) => row.operation_id)
      .filter((id) => !this.active.has(id));
  }

  get activeCount(): number {
    return this.active.size;
  }

  assertReconciled(): void {
    const pending = this.pending();
    if (pending.length) throw new RecoveryRequiredError(pending);
  }

  acknowledge(ids: string[]): void {
    const pending = this.pending();
    const supplied = [...ids].sort();
    if (
      !pending.length ||
      supplied.length !== pending.length ||
      supplied.some((id, index) => id !== pending[index])
    ) {
      throw new Error(
        "Recovery acknowledgment must match every pending operation exactly",
      );
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        "UPDATE operations SET status = 'acknowledged', finished_at = ? WHERE operation_id = ? AND status = 'pending'",
      );
      for (const id of pending) update.run(Date.now(), id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Call only after both Harness close and owned-environment cleanup succeed. */
  checkpoint(): void {
    this.database
      .prepare(
        "UPDATE operations SET checkpointed = 1 WHERE status = 'settled' AND checkpointed = 0",
      )
      .run();
  }

  close(): void {
    this.database.close();
  }
}
