import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderProfile } from "./index.js";
import { parseProviderProfile } from "./profile.js";

interface ConnectionDocument {
  version: 1;
  connections: Record<string, ProviderProfile>;
}

export class ConnectionCatalogError extends Error {
  constructor(
    public readonly code:
      | "UNKNOWN_CONNECTION"
      | "CONNECTION_CONFLICT"
      | "UNSAFE_STORAGE"
      | "STORAGE_INVALID"
      | "CATALOG_BUSY",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionCatalogError";
  }
}

/** Field-order-insensitive identity of the non-secret connection settings. */
function canonical(profile: ProviderProfile): string {
  return JSON.stringify([
    profile.id,
    profile.kind,
    profile.protocol,
    profile.modelId,
    profile.baseUrl ?? null,
    profile.keyEnv ?? null,
    profile.contextWindow ?? null,
    profile.maxTokens ?? null,
  ]);
}

/** Shared id-sorted projection of a loaded document (list/listReadOnly order). */
function sortedEntries(
  document: ConnectionDocument | undefined,
): ProviderProfile[] {
  return Object.values(document?.connections ?? {}).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

// Share queues across catalog instances referring to the same path in this process.
const queues = new Map<string, Promise<unknown>>();

/** Marker an operation returns when the document is unchanged: the shared
 * mutate() then skips the atomic save entirely (a true zero-write no-op). Only
 * update() returns it today; add()/remove() operations never do, so their
 * write behavior — including add's idempotent "unchanged" re-save — is
 * unchanged. */
class Unchanged<T> {
  constructor(readonly value: T) {}
}

/**
 * Local catalog of validated non-secret connection profiles.
 * Credentials stay in the keyEnv-referenced environment; this file never stores them.
 */
export class ConnectionCatalog {
  readonly directory: string;
  readonly path: string;

  constructor(directory = join(homedir(), ".loom")) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "connections.json");
  }

  private async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkPrivate(this.directory, true);
  }

  private async checkPrivate(path: string, directory = false) {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new ConnectionCatalogError(
        "UNSAFE_STORAGE",
        "Connection catalog storage must be owner-only and must not be a symlink.",
      );
    }
  }

  private async load(): Promise<ConnectionDocument | undefined> {
    await this.ensureDirectory();
    return this.readDocument();
  }

  /**
   * Read-only load for projections that must never create storage: the
   * directory is validated in place (checkPrivate) and a missing one is a
   * structured STORAGE_INVALID "does not exist" error instead of recursive
   * creation. This path is structurally mkdir-free, so a directory deleted
   * after the caller's own existence check still fails closed.
   */
  private async loadReadOnly(): Promise<ConnectionDocument | undefined> {
    try {
      await this.checkPrivate(this.directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ConnectionCatalogError(
          "STORAGE_INVALID",
          `Connection catalog directory does not exist: ${this.directory}`,
        );
      throw error;
    }
    return this.readDocument();
  }

  private async readDocument(): Promise<ConnectionDocument | undefined> {
    try {
      await this.checkPrivate(this.path);
      const file = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let document: unknown;
      try {
        document = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      if (!document || typeof document !== "object") throw new Error();
      const data = document as ConnectionDocument;
      if (
        data.version !== 1 ||
        !data.connections ||
        typeof data.connections !== "object" ||
        Array.isArray(data.connections)
      )
        throw new Error();
      for (const [id, profile] of Object.entries(data.connections)) {
        const parsed = parseProviderProfile(profile);
        if (parsed.id !== id) throw new Error();
        data.connections[id] = parsed;
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ConnectionCatalogError) throw error;
      throw new ConnectionCatalogError(
        "STORAGE_INVALID",
        "Connection catalog could not be read; existing data was preserved.",
      );
    }
  }

  private async save(document: ConnectionDocument) {
    const temporary = join(this.directory, `.connections-${randomUUID()}.tmp`);
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(document, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async mutate<T>(
    operation: (
      document: ConnectionDocument,
    ) => Promise<T | Unchanged<T>> | T | Unchanged<T>,
  ): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        await this.ensureDirectory();
        const lock = `${this.path}.lock`;
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch {
          throw new ConnectionCatalogError(
            "CATALOG_BUSY",
            "Connection catalog is locked; retry after the other catalog operation finishes. A crashed owner requires manual lock removal.",
          );
        }
        try {
          const document = (await this.load()) ?? {
            version: 1,
            connections: {},
          };
          const result = await operation(document);
          if (!(result instanceof Unchanged)) await this.save(document);
          return result instanceof Unchanged ? result.value : result;
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      });
    queues.set(this.path, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(this.path) === pending) queues.delete(this.path);
    }
  }

  /**
   * Persist a validated non-secret profile. Re-adding the identical settings is an
   * idempotent confirmation; the same id with different fields is rejected.
   */
  async add(profile: ProviderProfile): Promise<"added" | "unchanged"> {
    const parsed = parseProviderProfile(profile);
    return this.mutate((document) => {
      const existing = document.connections[parsed.id];
      if (existing) {
        if (canonical(existing) === canonical(parsed)) return "unchanged";
        throw new ConnectionCatalogError(
          "CONNECTION_CONFLICT",
          `Connection "${parsed.id}" already exists with different settings; remove it first or use a new id.`,
        );
      }
      document.connections[parsed.id] = parsed;
      return "added";
    });
  }

  /**
   * Replace one entry's fields under its own id — the explicit edit path.
   * Never an upsert: an unknown id is UNKNOWN_CONNECTION, never a create.
   * Identical canonical settings are an idempotent "unchanged" with zero
   * writes; different settings replace the entry and return "updated". This
   * does not touch add's same-id refusal: `add` keeps rejecting changed
   * settings for an existing id, so an implicit edit still requires this
   * explicit call.
   */
  async update(profile: ProviderProfile): Promise<"updated" | "unchanged"> {
    const parsed = parseProviderProfile(profile);
    return this.mutate((document) => {
      const existing = document.connections[parsed.id];
      if (!existing)
        throw new ConnectionCatalogError(
          "UNKNOWN_CONNECTION",
          `Unknown connection id: ${parsed.id}. Run connections list to inspect the catalog.`,
        );
      if (canonical(existing) === canonical(parsed))
        return new Unchanged("unchanged");
      document.connections[parsed.id] = parsed;
      return "updated";
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((document) => {
      if (!Object.hasOwn(document.connections, id))
        throw new ConnectionCatalogError(
          "UNKNOWN_CONNECTION",
          `Unknown connection id: ${id}. Run connections list to inspect the catalog.`,
        );
      delete document.connections[id];
    });
  }

  /** Explicit lookup only; an unknown id never falls back to defaults. */
  async resolve(id: string): Promise<ProviderProfile> {
    const document = await this.load();
    const profile = document?.connections[id];
    if (!profile)
      throw new ConnectionCatalogError(
        "UNKNOWN_CONNECTION",
        `Unknown connection id: ${id}. Run connections list to inspect the catalog.`,
      );
    return profile;
  }

  async list(): Promise<ProviderProfile[]> {
    const document = await this.load();
    return sortedEntries(document);
  }

  /**
   * Read-only listing with no directory creation: for read-only projections
   * (the service connections endpoint). Same validated entries and ordering
   * as list(); only the storage bootstrap differs — missing storage is a
   * structured error, never a mkdir.
   */
  async listReadOnly(): Promise<ProviderProfile[]> {
    const document = await this.loadReadOnly();
    return sortedEntries(document);
  }
}
