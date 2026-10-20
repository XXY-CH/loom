import type { AgentEvent } from "@earendil-works/pi-durable";
import type { ActivityItem } from "./types.js";

// Mask known credentials and common inline assignments before terminal projection.
export function redact(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH/i.test(name) &&
      value &&
      value.length >= 8
    )
      result = result.replaceAll(value, "[redacted]");
  }
  return result
    .replace(
      /(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s;,"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1[redacted]",
    );
}

/** Bounded visible projection, rebuilt from Pi's snapshot after reconnect/overflow. */
export class ActivityProjection {
  items: ActivityItem[] = [];
  status = "paused · viewer";
  private serial = 0;
  private add(
    label: string,
    detail: string,
    state: ActivityItem["state"],
    id = `event-${++this.serial}`,
  ) {
    this.items.push({
      id,
      label: redact(label),
      detail: redact(detail).slice(-2000),
      state,
    });
    this.items = this.items.slice(-100);
  }
  apply(events: readonly AgentEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          this.items = [];
          this.status = event.run ? "running · restored" : "paused · viewer";
          for (const entry of event.entries.slice(-15))
            this.add(
              entry.kind,
              entry.model
                ?.flatMap((message) =>
                  message.role === "assistant" || message.role === "user"
                    ? typeof message.content === "string"
                      ? [message.content]
                      : message.content.flatMap((part) =>
                          part.type === "text" ? [part.text] : [],
                        )
                    : [],
                )
                .join("\n") || "Persisted transcript entry",
              "info",
              JSON.stringify(entry.id),
            );
          for (const tool of event.tools)
            this.add(
              tool.name,
              tool.output
                ? redact(tool.output).slice(-2000)
                : "Restored from Pi live snapshot",
              tool.status === "done" ? "info" : "running",
              tool.callId,
            );
          break;
        case "run_start":
          this.status = "running";
          this.add("Run started", "Pi admitted durable input", "running");
          break;
        case "run_end":
          this.status = "idle · inspect result";
          this.add("Run idle", "Idle is not workflow acceptance", "info");
          break;
        case "turn_start":
          this.add(
            "Model generating",
            "Waiting for model response",
            "running",
            "generation",
          );
          break;
        case "message_update": {
          const text = event.changes
            .flatMap((change) =>
              change.type === "text_delta" ? [change.delta] : [],
            )
            .join("");
          if (text) {
            const item = this.items.findLast(
              (item) => item.id === "generation",
            );
            if (item)
              item.detail = redact(
                (item.detail === "Waiting for model response"
                  ? ""
                  : item.detail) + text,
              ).slice(-2000);
          }
          break;
        }
        case "message_end": {
          const item = this.items.findLast((item) => item.id === "generation");
          if (item) {
            item.state = "done";
            item.label = "Model response committed";
            const text = event.entry.model
              ?.flatMap((message) =>
                message.role === "assistant"
                  ? message.content.flatMap((part) =>
                      part.type === "text" ? [part.text] : [],
                    )
                  : [],
              )
              .join("\n");
            if (text) item.detail = redact(text).slice(-2000);
          }
          break;
        }
        case "tool_execution_start":
          this.add(
            event.toolName,
            typeof event.args.command === "string"
              ? event.args.command
              : typeof event.args.path === "string"
                ? event.args.path
                : "Structured tool call",
            "running",
            event.toolCallId,
          );
          break;
        case "tool_execution_update": {
          const item = this.items.findLast(
            (item) => item.id === event.toolCallId,
          );
          if (item && event.output) {
            item.output = redact(
              "set" in event.output
                ? event.output.set
                : (item.output ?? "").slice(event.output.trimStart ?? 0) +
                    (event.output.append ?? ""),
            ).slice(-2000);
          }
          break;
        }
        case "tool_execution_end": {
          const item = this.items.findLast(
            (item) => item.id === event.toolCallId,
          );
          const failed =
            (!event.entry && !event.result) ||
            event.result?.isError ||
            event.entry?.model?.some(
              (message) => message.role === "toolResult" && message.isError,
            );
          if (item) {
            item.state = failed ? "error" : "info";
            item.label += failed
              ? " · failed / interrupted"
              : " · returned (inspect evidence)";
          }
          break;
        }
        case "task_failed":
          this.status = "task failed";
          this.add("Task failed", "Inspect persisted runtime state", "error");
          break;
        case "submission":
          if (event.record.status === "unanswered") {
            this.status = "unanswered";
            this.add(
              "Input unanswered",
              "Inspect runtime state before retrying",
              "error",
            );
          }
          break;
      }
    }
  }
}
