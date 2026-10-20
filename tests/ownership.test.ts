import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import {
  link,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDatabaseLease,
  type DatabaseLease,
  DatabaseOwnershipError,
} from "../src/service/database-lease.js";

const children = new Set<ChildProcess>();
const leases: DatabaseLease[] = [];
const folders: string[] = [];

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "loom-ownership-"));
  folders.push(folder);
  return { folder, databasePath: join(folder, "agent.sqlite") };
}

function child(databasePath: string) {
  const process = fork(
    fileURLToPath(new URL("./ownership-child.ts", import.meta.url)),
    [databasePath],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.add(process);
  const result = once(process, "message", {
    signal: AbortSignal.timeout(10_000),
  });
  const exited = once(process, "exit");
  return { process, result, exited };
}

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  for (const process of children) {
    if (process.exitCode === null && process.signalCode === null) {
      const exited = once(process, "exit");
      process.kill("SIGKILL");
      await exited;
    }
  }
  children.clear();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("database ownership", () => {
  it("rejects a second opener in the same process and keeps release owner-scoped", async () => {
    const { databasePath } = await fixture();
    const first = await acquireDatabaseLease(databasePath);
    leases.push(first);
    await expect(acquireDatabaseLease(databasePath)).rejects.toBeInstanceOf(
      DatabaseOwnershipError,
    );
    first.release();
    const second = await acquireDatabaseLease(databasePath);
    leases.push(second);
    first.release();
    await expect(acquireDatabaseLease(databasePath)).rejects.toBeInstanceOf(
      DatabaseOwnershipError,
    );
  });

  it("rejects another process and permits acquisition after SIGKILL without stale deletion", async () => {
    const { databasePath } = await fixture();
    const owner = child(databasePath);
    expect((await owner.result)[0]).toMatchObject({ type: "acquired" });
    const contender = child(databasePath);
    expect((await contender.result)[0]).toMatchObject({
      type: "error",
      code: "DATABASE_IN_USE",
    });
    await contender.exited;
    owner.process.kill("SIGKILL");
    await owner.exited;
    const replacement = child(databasePath);
    expect((await replacement.result)[0]).toMatchObject({ type: "acquired" });
    replacement.process.send("release");
    await replacement.exited;
    leases.push(await acquireDatabaseLease(databasePath));
  });

  it("canonicalizes symlinked parents and existing database aliases", async () => {
    const { folder, databasePath } = await fixture();
    const alias = `${folder}-alias`;
    folders.push(alias);
    await symlink(folder, alias, "dir");
    const owner = await acquireDatabaseLease(databasePath);
    leases.push(owner);
    expect(owner.databasePath).toBe(
      join(await realpath(folder), "agent.sqlite"),
    );
    await expect(
      acquireDatabaseLease(join(alias, "agent.sqlite")),
    ).rejects.toBeInstanceOf(DatabaseOwnershipError);
    await writeFile(databasePath, "");
    const fileAlias = join(folder, "alias.sqlite");
    await symlink(databasePath, fileAlias);
    await expect(acquireDatabaseLease(fileAlias)).rejects.toBeInstanceOf(
      DatabaseOwnershipError,
    );
  });

  it("rejects hard-link aliases instead of granting independent sidecar ownership", async () => {
    const { folder, databasePath } = await fixture();
    await writeFile(databasePath, "");
    const alias = join(folder, "alias.sqlite");
    await link(databasePath, alias);
    await expect(acquireDatabaseLease(alias)).rejects.toThrow(
      "hard-link aliases",
    );
  });

  it("rejects dangling aliases whose target would otherwise get a separate lease", async () => {
    const { folder, databasePath } = await fixture();
    const alias = join(folder, "alias.sqlite");
    await symlink(databasePath, alias);
    await expect(acquireDatabaseLease(alias)).rejects.toThrow(
      "dangling symbolic link",
    );
  });
});
