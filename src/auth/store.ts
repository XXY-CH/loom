import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { createModels } from "@earendil-works/pi-ai/models";

export type CredentialStore = NonNullable<
  NonNullable<Parameters<typeof createModels>[0]>["credentials"]
>;
export type Credential = NonNullable<
  Awaited<ReturnType<CredentialStore["read"]>>
>;
export type OAuthCredential = Extract<Credential, { type: "oauth" }>;

interface AuthDocument {
  version: 1;
  hostId: string;
  credentials: Record<string, Credential>;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Share queues across store instances referring to the same path in this process.
const queues = new Map<string, Promise<unknown>>();

/** Private file fallback. Cross-process mutations fail closed while another owner holds the lock. */
export class FileCredentialStore implements CredentialStore {
  readonly directory: string;
  readonly path: string;

  constructor(directory = join(homedir(), ".loom", "auth")) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "credentials-v1.json");
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
      throw new AuthError(
        "UNSAFE_STORAGE",
        "Auth storage must be owner-only and must not be a symlink.",
      );
    }
  }

  private async load(): Promise<AuthDocument | undefined> {
    await this.ensureDirectory();
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
      const data = document as AuthDocument;
      if (
        data.version !== 1 ||
        !/^[0-9a-f-]{36}$/i.test(data.hostId) ||
        !data.credentials ||
        typeof data.credentials !== "object" ||
        Array.isArray(data.credentials)
      )
        throw new Error();
      for (const credential of Object.values(data.credentials)) {
        if (
          !credential ||
          typeof credential !== "object" ||
          !["api_key", "oauth"].includes(credential.type)
        )
          throw new Error();
        if (
          credential.type === "oauth" &&
          (typeof credential.access !== "string" ||
            typeof credential.refresh !== "string" ||
            !Number.isFinite(credential.expires))
        )
          throw new Error();
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        "STORAGE_INVALID",
        "Auth storage could not be read; existing data was preserved.",
      );
    }
  }

  private async save(document: AuthDocument) {
    const temporary = join(this.directory, `.credentials-${randomUUID()}.tmp`);
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
        await file.writeFile(JSON.stringify(document));
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
    operation: (document: AuthDocument) => Promise<T>,
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
          throw new AuthError(
            "AUTH_BUSY",
            "Auth storage is locked; retry after the other auth operation finishes. A crashed owner requires manual lock removal.",
          );
        }
        try {
          const document = (await this.load()) ?? {
            version: 1,
            hostId: randomUUID(),
            credentials: {},
          };
          const result = await operation(document);
          await this.save(document);
          return result;
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

  async getHostId(): Promise<string> {
    return this.mutate(async (document) => document.hostId);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const document = await this.load();
    return document && Object.hasOwn(document.credentials, providerId)
      ? document.credentials[providerId]
      : undefined;
  }

  async list() {
    const document = await this.load();
    return Object.entries(document?.credentials ?? {}).map(
      ([providerId, credential]) => ({ providerId, type: credential.type }),
    );
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    return this.mutate(async (document) => {
      const current = Object.hasOwn(document.credentials, providerId)
        ? document.credentials[providerId]
        : undefined;
      const credential = await fn(current);
      if (credential !== undefined)
        Object.defineProperty(document.credentials, providerId, {
          value: credential,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return credential ?? current;
    });
  }

  async delete(providerId: string) {
    await this.mutate(async (document) => {
      delete document.credentials[providerId];
    });
  }
}
