import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { OperationJournal } from "./recovery.js";

/** Tracks only processes started by this environment in this process lifetime. */
export class ManagedExecutionEnv extends NodeExecutionEnv {
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    cwd: string,
    private readonly journal: OperationJournal,
    private readonly afterOperationSettledForTest?: () => Promise<void>,
  ) {
    super({ cwd });
  }

  override exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.stopping)
      return Promise.resolve({
        ok: false,
        error: new ExecutionError("aborted", "Environment is stopping"),
      });
    this.journal.assertReconciled();
    const id = this.journal.start();
    const execution = super
      .exec(command, options, withAbortSignal(this.controller.signal, context))
      .then(async (result) => {
        this.journal.settle(id);
        await this.afterOperationSettledForTest?.();
        return result;
      })
      .finally(() => {
        this.journal.abandon(id);
        this.inFlight.delete(execution);
      });
    this.inFlight.add(execution);
    return execution;
  }

  override async cleanup(context: Context): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    // NodeExecutionEnv knows the current owned process groups; never reuse stored PIDs.
    await super.cleanup(context);
    await Promise.allSettled([...this.inFlight]);
  }
}
