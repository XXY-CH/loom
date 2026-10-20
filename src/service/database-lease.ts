import { closeSync, openSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseLease {
  readonly databasePath: string;
  readonly lockPath: string;
  release(): void;
}

export class DatabaseOwnershipError extends Error {
  readonly code = "DATABASE_IN_USE";

  constructor(databasePath: string, cause: unknown) {
    super(
      `Database is already owned by another Loom runtime: ${databasePath}`,
      {
        cause,
      },
    );
    this.name = "DatabaseOwnershipError";
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === 5
  );
}

async function canonicalDatabasePath(databasePath: string): Promise<string> {
  if (databasePath === ":memory:") {
    throw new Error("Loom requires a persistent database path");
  }
  const absolutePath = resolve(databasePath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    // A dangling symlink acquires a different canonical name after Pi creates
    // its target. Refuse it instead of granting two leases for that future DB.
    const entry = await lstat(absolutePath).catch((failure: unknown) => {
      if (
        failure instanceof Error &&
        "code" in failure &&
        failure.code === "ENOENT"
      ) {
        return undefined;
      }
      throw failure;
    });
    if (entry?.isSymbolicLink()) {
      throw new Error("Database path must not be a dangling symbolic link");
    }
    canonicalPath = join(
      await realpath(dirname(absolutePath)),
      basename(absolutePath),
    );
  }
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        "Database must be a regular file without hard-link aliases",
      );
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  return canonicalPath;
}

/**
 * Hold an OS-backed SQLite write lock for the whole runtime lifetime.
 * The persistent sidecar MUST NOT be removed, replaced, or used as a Pi database.
 * All Loom openers must acquire this lease before opening the main database.
 * Process death releases the lock automatically; no PID or stale-lock deletion
 * is involved. SQLite locking requires a local filesystem with working locks.
 * Database files and their path aliases must not be replaced during a lease.
 */
export async function acquireDatabaseLease(
  databasePath: string,
): Promise<DatabaseLease> {
  const canonicalPath = await canonicalDatabasePath(databasePath);
  const lockPath = `${canonicalPath}.loom-lease.sqlite`;
  // Keep a stable inode, including after release. Set private permissions on
  // creation without truncating an existing sidecar owned by another process.
  closeSync(openSync(lockPath, "a", 0o600));
  const database = new DatabaseSync(lockPath);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) {
      throw new DatabaseOwnershipError(canonicalPath, error);
    }
    throw error;
  }
  let released = false;
  return {
    databasePath: canonicalPath,
    lockPath,
    release() {
      if (released) return;
      // Closing the connection releases only this connection's OS locks.
      database.close();
      released = true;
    },
  };
}
