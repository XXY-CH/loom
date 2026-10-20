import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  ExecutionError,
  FileError,
  type Result,
} from "@earendil-works/pi-durable/env";
import { ManagedExecutionEnv } from "./managed-env.js";

/** File-tool boundary for feature workers, not a sandbox against concurrent host filesystem changes. */
export class FeatureExecutionEnv extends ManagedExecutionEnv {
  private async checkedPath(path: string): Promise<string> {
    const target = resolve(this.cwd, path);
    const rel = relative(this.cwd, target);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.split(sep).some((part) => part.toLowerCase() === ".git")
    )
      throw new FileError(
        "permission_denied",
        "Feature file tools require a workspace path outside .git",
      );
    let cursor = this.cwd;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink())
          throw new FileError(
            "permission_denied",
            "Feature file tools do not follow symlinks",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return target;
  }

  private async guarded<T>(
    path: string,
    run: (path: string) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    try {
      return await run(await this.checkedPath(path));
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof FileError
            ? error
            : new FileError("unknown", "Feature path inspection failed"),
      };
    }
  }

  override absolutePath(path: string, context: Context) {
    return this.guarded(path, (target) => super.absolutePath(target, context));
  }

  override writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ) {
    return this.guarded(path, (target) =>
      super.writeFile(target, content, context),
    );
  }

  override readTextFile(path: string, context: Context) {
    return this.guarded(path, (target) => super.readTextFile(target, context));
  }

  override openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ) {
    return this.guarded(path, (target) =>
      super.openBinaryReader(target, { ...options, noFollow: true }, context),
    );
  }

  override exec(): ReturnType<ManagedExecutionEnv["exec"]> {
    return Promise.resolve({
      ok: false,
      error: new ExecutionError(
        "shell_unavailable",
        "Feature workers cannot execute shell commands",
      ),
    });
  }
}
