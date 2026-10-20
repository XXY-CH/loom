import { parseArgs } from "node:util";

export const help = `Loom · local agent workbench

Usage:
  npm run dev -- tui --cwd PATH [--once]
  npm run dev -- tui --cwd PATH --db PATH --model ID [--prompt TEXT --request-id ID]
  npm run dev -- run --db PATH --cwd PATH --model ID --prompt TEXT --request-id ID
  npm run dev -- feature --spec PATH --db PATH --model ID [--tui|--inspect]
  npm run dev -- feature --spec PATH --db PATH --model ID --reconcile --operation-id ID --expected-workspace JSON --confirm-effects-reviewed
  npm run dev -- status --db PATH --cwd PATH --model ID
  npm run dev -- resume --db PATH --cwd PATH --model ID
  npm run dev -- ack-recovery --db PATH --cwd PATH --model ID --operation-id IDS --confirm-effects-reviewed

Connection flags: --provider openai|anthropic --endpoint URL --protocol responses|completions|messages --key-env NAME
Default connection: OpenAI Responses, OPENAI_API_KEY. Anthropic uses ANTHROPIC_API_KEY.
Custom endpoints may omit authentication by omitting --key-env.
feature reads a JSON FeatureSpec; its worktreePath determines the runtime cwd.
--inspect prints persisted feature state without dispatching workflow work.
--reconcile requires reviewing effects and stopping any surviving processes.
Reconciliation only authorizes a retry; it does not prove success or roll back effects.
Use status to inspect pending operation IDs after an interrupted shell operation.
ack-recovery requires manual review of effects and accepts comma-separated operation IDs.
Acknowledgement is not cancellation or rollback and does not establish that an old shell has stopped.
Coding tools can read/write files and execute commands; cwd is not a sandbox.
Use a disposable fixture directory for the spike. Databases contain transcripts.
`;

export class CliUsageError extends Error {
  readonly code = "INVALID_ARGUMENTS";
}

export function parseOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      once: { type: "boolean" },
      db: { type: "string" },
      cwd: { type: "string" },
      spec: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      "request-id": { type: "string" },
      endpoint: { type: "string" },
      provider: { type: "string", default: "openai" },
      protocol: { type: "string" },
      "key-env": { type: "string" },
      "operation-id": { type: "string" },
      "confirm-effects-reviewed": { type: "boolean" },
      tui: { type: "boolean" },
      inspect: { type: "boolean" },
      reconcile: { type: "boolean" },
      "expected-workspace": { type: "string" },
    },
  });
  if (values.help || args.length === 0) return undefined;
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["tui", "run", "feature", "status", "resume", "ack-recovery"].includes(
      command ?? "",
    )
  ) {
    throw new CliUsageError(
      "Expected one command: tui, run, feature, status, resume, or ack-recovery",
    );
  }
  if (command === "tui") {
    if (!values.cwd) throw new CliUsageError("tui requires --cwd");
    if (Boolean(values.db) !== Boolean(values.model))
      throw new CliUsageError(
        "Runtime attachment requires both --db and --model",
      );
    if (values.prompt && (!values.db || !values["request-id"] || values.once))
      throw new CliUsageError(
        "TUI prompt requires --db, --model and --request-id without --once",
      );
  } else if (values.once) throw new CliUsageError("--once requires tui");
  if (values.reconcile && command !== "feature")
    throw new CliUsageError("--reconcile requires feature");
  if (
    values["expected-workspace"] !== undefined &&
    !(command === "feature" && values.reconcile)
  )
    throw new CliUsageError(
      "--expected-workspace requires feature --reconcile",
    );
  if (values.reconcile && (values.inspect || values.tui))
    throw new CliUsageError(
      "--reconcile cannot be combined with --inspect or --tui",
    );
  if (values.tui && command !== "feature")
    throw new CliUsageError("--tui requires feature");
  if (values.inspect && command !== "feature")
    throw new CliUsageError("--inspect requires feature");
  if (values.inspect && values.tui)
    throw new CliUsageError("--inspect cannot be combined with --tui");
  if (values.inspect && values.once)
    throw new CliUsageError("--inspect cannot be combined with --once");
  if (values.spec !== undefined && command !== "feature") {
    throw new CliUsageError("--spec requires feature");
  }
  if (command === "feature" && (!values.spec || !values.db || !values.model)) {
    throw new CliUsageError("feature requires --spec, --db and --model");
  }
  if (
    command !== "tui" &&
    command !== "feature" &&
    (!values.db || !values.cwd || !values.model)
  ) {
    throw new CliUsageError("--db, --cwd and --model are required");
  }
  if (command === "run" && (!values.prompt || !values["request-id"])) {
    throw new CliUsageError("run requires --prompt and a stable --request-id");
  }
  if (values.provider !== "openai" && values.provider !== "anthropic") {
    throw new CliUsageError("--provider must be openai or anthropic");
  }
  values.protocol ??=
    values.provider === "anthropic" ? "messages" : "responses";
  if (
    values.protocol !== "responses" &&
    values.protocol !== "completions" &&
    values.protocol !== "messages"
  ) {
    throw new CliUsageError(
      "--protocol must be responses, completions, or messages",
    );
  }
  if (values.provider === "anthropic" && values.protocol !== "messages") {
    throw new CliUsageError("Anthropic requires --protocol messages");
  }
  if (values.provider === "openai" && values.protocol === "messages") {
    throw new CliUsageError("OpenAI does not support --protocol messages");
  }
  const operationIds = values["operation-id"]
    ?.split(",")
    .map((id) => id.trim());
  if (command === "feature" && values.reconcile) {
    if (operationIds?.length !== 1 || !operationIds[0])
      throw new CliUsageError(
        "feature --reconcile requires exactly one --operation-id",
      );
    if (!values["confirm-effects-reviewed"])
      throw new CliUsageError(
        "feature --reconcile requires --confirm-effects-reviewed",
      );
    try {
      const workspace: unknown = JSON.parse(values["expected-workspace"] ?? "");
      if (
        !workspace ||
        typeof workspace !== "object" ||
        Array.isArray(workspace) ||
        !("workspaceId" in workspace) ||
        typeof workspace.workspaceId !== "string" ||
        !workspace.workspaceId.trim() ||
        !("head" in workspace) ||
        typeof workspace.head !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.head) ||
        !("fingerprint" in workspace) ||
        typeof workspace.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(workspace.fingerprint)
      )
        throw new Error("Invalid identity");
    } catch {
      throw new CliUsageError(
        "--expected-workspace requires JSON with workspaceId, full HEAD and SHA-256 fingerprint",
      );
    }
  } else if (command === "ack-recovery") {
    if (!operationIds?.length || operationIds.some((id) => !id)) {
      throw new CliUsageError(
        "ack-recovery requires --operation-id with pending operation IDs",
      );
    }
    if (!values["confirm-effects-reviewed"]) {
      throw new CliUsageError(
        "ack-recovery requires --confirm-effects-reviewed after manual review of shell effects",
      );
    }
  } else if (operationIds || values["confirm-effects-reviewed"]) {
    throw new CliUsageError(
      "Recovery acknowledgement flags require ack-recovery",
    );
  }
  return {
    ...values,
    command,
    db: values.db ?? "",
    cwd: values.cwd as string,
    model: values.model ?? "",
    protocol: values.protocol,
    provider: values.provider,
    operationIds,
  };
}
