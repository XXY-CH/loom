import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import type { RuntimeSession } from "../runtime/session.js";
import { redact } from "../tui/activity.js";
import type { ActivityItem } from "../tui/types.js";

type Runtime = Pick<
  RuntimeSession,
  | "submit"
  | "submissionCounts"
  | "recoveryStatus"
  | "resume"
  | "cancel"
  | "workflowStatus"
>;

/** A host withdrawal is not a claim that Pi cancellation succeeded. */
export class InputWithdrawnError extends Error {
  constructor() {
    super("Input cancelled at host; draft retained; inspect /status");
  }
}

type PendingInput = {
  item: ActivityItem;
  cancelled: boolean;
  finished: boolean;
  stopped: Promise<void>;
  stop: () => void;
};

/** Host interaction only. Pi owns admission, queue boundaries and settlement. */
export class InteractionController {
  readonly items: ActivityItem[] = [];
  private pending = 0;
  private admission: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly inputs = new Set<PendingInput>();
  private fenced = false;
  private cancelling: Promise<void> | undefined;
  private cancellationWork: Promise<void> | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly changed: () => void,
  ) {}

  get pendingCount(): number {
    return this.pending;
  }

  private notify(): void {
    if (!this.disposed) {
      try {
        this.changed();
      } catch {
        /* UI failures must not alter durable admission. */
      }
    }
  }

  private add(
    label: string,
    detail: string,
    state: ActivityItem["state"],
  ): ActivityItem {
    const item = {
      id: randomUUID(),
      label: redact(label).slice(0, 100),
      detail: redact(detail).slice(0, 2000),
      state,
    };
    this.items.push(item);
    if (this.items.length > 100) this.items.splice(0, this.items.length - 100);
    this.notify();
    return item;
  }

  private reject(message: string): never {
    this.add("Input rejected", message, "error");
    throw new Error(message);
  }

  async send(content: string, requestId: string = randomUUID()): Promise<void> {
    if (this.disposed) this.reject("Interaction host is detached");
    if (!content.trim()) this.reject("Input must not be blank");
    const input = content.trim();
    if (input.startsWith("/") && !input.startsWith("//")) {
      await this.command(input);
      return;
    }
    if (this.fenced)
      this.reject(
        "Cancellation is unresolved; retry /cancel before sending input",
      );
    if (!requestId.trim()) this.reject("Request ID must not be blank");
    if (this.pending >= 16)
      this.reject(
        "16 requests are outstanding; wait for settlement before sending more",
      );
    this.pending++;
    const literal = input.startsWith("//") ? input.slice(1) : content;
    const item = this.add(
      "Waiting for admission",
      `Request ${requestId}\n${literal}`,
      "running",
    );
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const pending: PendingInput = {
      item,
      cancelled: false,
      finished: false,
      stopped,
      stop,
    };
    this.inputs.add(pending);
    // Cancellation fences this entire line, including the underlying in-flight submit.
    // Releasing only a waiter would let a late durable admission restart Pi.

    const admitted = this.admission.then(async () => {
      if (pending.cancelled) return;
      let submission: Submission;
      try {
        submission = await this.runtime.submit({ content: literal, requestId });
      } catch {
        if (pending.cancelled) return;
        this.finish(pending);
        item.label = "Admission failed";
        item.state = "error";
        item.detail =
          "Input was not confirmed admitted; preserve the draft and retry with the same request ID";
        this.notify();
        throw new Error("Input admission failed; draft preserved");
      }
      if (pending.cancelled) return;
      item.label = "Admitted · awaiting settlement";
      item.detail = redact(
        `Request ${requestId}\nSubmission ${submission.id}\nPi owns queued/follow-up delivery; this does not imply immediate steering.\n${literal}`,
      ).slice(0, 2000);
      this.notify();
      void this.settle(submission, pending);
    });
    this.admission = admitted.catch(() => {});
    await Promise.race([admitted, stopped]);
    if (pending.cancelled) throw new InputWithdrawnError();
  }

  private finish(input: PendingInput): void {
    if (input.finished) return;
    input.finished = true;
    this.inputs.delete(input);
    this.pending--;
  }

  private async settle(
    submission: Submission,
    input: PendingInput,
  ): Promise<void> {
    const { item } = input;
    try {
      const settled = await Promise.race([
        submission.wait(BACKGROUND_CONTEXT),
        input.stopped.then(() => undefined),
      ]);
      if (input.cancelled || !settled) return;
      item.label =
        settled.status === "done" ? "Submission done" : "Submission unanswered";
      item.state = settled.status === "done" ? "done" : "error";
      // A settled model submission is not workflow acceptance.
      item.detail = `${item.detail.slice(0, 1900)}\nStatus: ${settled.status}; inspect workflow evidence separately`;
    } catch {
      if (input.cancelled) return;
      item.label = "Settlement observation unavailable";
      item.state = "error";
      item.detail = `${item.detail.slice(0, 1900)}\nRead /status before retrying; durable work may remain`;
    } finally {
      this.finish(input);
      this.notify();
    }
  }

  private cancelInputs(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    // Linearization point: reject new input/resume and withdraw every earlier host request.
    this.fenced = true;
    for (const input of this.inputs) {
      input.cancelled = true;
      input.item.label = "Host input withdrawn";
      input.item.state = "error";
      input.item.detail = `${input.item.detail.slice(0, 1700)}\nHost observation cancelled; Runtime cancellation must still succeed. Inspect /status; edit a retained draft to send a new request.`;
      input.stop();
      this.finish(input);
    }
    this.notify();
    // Retain timed-out work: a retry must observe the same barrier, never bypass it.
    const work =
      this.cancellationWork ?? this.admission.then(() => this.runtime.cancel());
    this.cancellationWork = work;
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
        if (this.cancellationWork === work) this.cancellationWork = undefined;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Cancellation deadline exceeded")),
        2000,
      );
    });
    this.cancelling = Promise.race([work, deadline])
      .then(
        () => {
          this.cancellationWork = undefined;
          this.fenced = false;
        },
        () => {
          if (settled) this.cancellationWork = undefined;
          // Failure/timeout never asserts cancellation and never reopens admission.
          throw new Error(
            "Cancellation failed or timed out; input remains fenced; retry /cancel",
          );
        },
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.cancelling = undefined;
      });
    return this.cancelling;
  }

  private async command(command: string): Promise<void> {
    if (
      !["/help", "/status", "/workflow", "/resume", "/cancel"].includes(command)
    )
      this.reject("Unknown command; use /help or // for literal text");
    try {
      switch (command) {
        case "/help":
          this.add(
            "Commands",
            "/help /status /workflow /resume /cancel\nUse // to send a literal leading slash. New input uses Pi's durable follow-up queue.",
            "info",
          );
          return;
        case "/status": {
          const [counts, recovery] = await Promise.all([
            this.runtime.submissionCounts(),
            this.runtime.recoveryStatus(),
          ]);
          this.add(
            "Runtime status",
            `queued=${counts.queued} placed=${counts.placed} done=${counts.done} unanswered=${counts.unanswered}\nHost outstanding=${this.pending}\nPending recovery operations=${recovery.pendingOperationIds.length}`,
            "info",
          );
          return;
        }
        case "/workflow": {
          const run = await this.runtime.workflowStatus();
          this.add(
            "Workflow status",
            run
              ? `Run ${run.id}: ${run.status}\n${run.steps.map((step) => `${step.id}: ${step.status}${step.inputQuestion ? ` · question: ${step.inputQuestion}` : ""}`).join("\n")}`
              : "No workflow Run is recorded in this Harness",
            "info",
          );
          return;
        }
        case "/resume":
          if (this.fenced) throw new Error("Cancellation unresolved");
          this.runtime.resume();
          this.add(
            "Runtime resumed",
            "Pi scheduling enabled; workflow acceptance remains evidence-gated",
            "info",
          );
          return;
        case "/cancel":
          await this.cancelInputs();
          this.add(
            "Runtime cancellation returned",
            "Inspect /status for durable submission outcomes",
            "info",
          );
          return;
      }
    } catch {
      this.reject(
        this.fenced
          ? "Control command failed; Cancellation unresolved; input remains fenced; retry /cancel"
          : "Control command failed; inspect runtime state before retrying",
      );
    }
  }

  /** Detach UI callbacks only; the caller owns Runtime cancellation and close. */
  dispose(): void {
    this.disposed = true;
  }
}
