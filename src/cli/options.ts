import { parseArgs } from "node:util";

export const help = `Loom · local agent workbench

Usage:
  npm run dev -- connections list --catalog DIR
  npm run dev -- connections add --profile PATH --catalog DIR
  npm run dev -- connections edit --profile PATH --catalog DIR
  npm run dev -- connections remove --id ID --catalog DIR
  npm run dev -- tui --cwd PATH [--once]
  npm run dev -- tui --cwd PATH --db PATH --model ID [--prompt TEXT --request-id ID]
  npm run dev -- run --db PATH --cwd PATH --model ID --prompt TEXT --request-id ID
  npm run dev -- feature --spec PATH --db PATH --model ID [or --profile PATH | --profile-id ID] [--tui|--inspect]
  npm run dev -- debug --spec PATH --db PATH [or --profile PATH | --profile-id ID] [--tui|--inspect]
  npm run dev -- feature --spec PATH --db PATH --model ID --reconcile --operation-id ID --expected-workspace JSON --confirm-effects-reviewed
  npm run dev -- feature --db PATH --reconcile-budget
  npm run dev -- status --db PATH --cwd PATH --model ID
  npm run dev -- resume --db PATH --cwd PATH --model ID
  npm run dev -- ack-recovery --db PATH --cwd PATH --model ID --operation-id IDS --confirm-effects-reviewed

Connection flags: --provider openai|anthropic --endpoint URL --protocol responses|completions|messages --key-env NAME, --profile PATH, or --profile-id ID
Default connection: OpenAI Responses, OPENAI_API_KEY. Anthropic uses ANTHROPIC_API_KEY.
Custom endpoints may omit authentication by omitting --key-env.
--profile-id selects an explicit catalog entry; unknown ids error instead of falling back.
The connection catalog defaults to ~/.loom/connections.json (owner-only); override its directory with --catalog DIR.
feature reads a JSON FeatureSpec; its worktreePath determines the runtime cwd.
--inspect prints persisted feature state without dispatching workflow work.
--reconcile requires reviewing effects and stopping any surviving processes.
Reconciliation only authorizes a retry; it does not prove success or roll back effects.
--reconcile-budget is the offline counterpart for unsettled model budget calls: it needs only --db,
requires the run's database lease to be free (a runtime or service still holding the run refuses),
marks the unsettled calls as human-reconciled, unblocks future dispatch without counting tokens for
them, and does not adopt them as succeeded. It takes no connection flags (--model, --profile,
--profile-id, --provider, --endpoint, --protocol, --key-env, --catalog): the persisted ledger,
not a connection, identifies the database.
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
      profile: { type: "string" },
      "profile-id": { type: "string" },
      catalog: { type: "string" },
      id: { type: "string" },
      prompt: { type: "string" },
      "request-id": { type: "string" },
      endpoint: { type: "string" },
      provider: { type: "string" },
      protocol: { type: "string" },
      "key-env": { type: "string" },
      "operation-id": { type: "string" },
      "confirm-effects-reviewed": { type: "boolean" },
      tui: { type: "boolean" },
      inspect: { type: "boolean" },
      reconcile: { type: "boolean" },
      "reconcile-budget": { type: "boolean" },
      "expected-workspace": { type: "string" },
    },
  });
  if (values.help || args.length === 0) return undefined;
  const command = positionals[0];
  if (command === "connections") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["list", "add", "edit", "remove"].includes(action ?? "")
    )
      throw new CliUsageError(
        "connections requires one action: list, add, edit, or remove",
      );
    if (values["profile-id"] !== undefined)
      throw new CliUsageError(
        "--profile-id selects a runtime connection; connections manages the catalog",
      );
    if (
      [
        values.provider,
        values.endpoint,
        values.protocol,
        values["key-env"],
        values.model,
      ].some((value) => value !== undefined)
    )
      throw new CliUsageError(
        "connections manages catalog entries without runtime connection flags",
      );
    const runtimeFlag = (
      [
        ["--db", values.db],
        ["--cwd", values.cwd],
        ["--spec", values.spec],
        ["--prompt", values.prompt],
        ["--request-id", values["request-id"]],
        ["--operation-id", values["operation-id"]],
        ["--confirm-effects-reviewed", values["confirm-effects-reviewed"]],
        ["--tui", values.tui],
        ["--inspect", values.inspect],
        ["--reconcile", values.reconcile],
        ["--reconcile-budget", values["reconcile-budget"]],
        ["--expected-workspace", values["expected-workspace"]],
        ["--once", values.once],
      ] as const
    ).find(([, value]) => value !== undefined);
    if (runtimeFlag)
      throw new CliUsageError(
        `${runtimeFlag[0]} is a runtime flag; connections manages the catalog`,
      );
    if ((action === "add" || action === "edit") && values.id !== undefined)
      throw new CliUsageError(
        `connections ${action} takes no --id; the profile file defines the entry id`,
      );
    if (action === "remove" && values.profile !== undefined)
      throw new CliUsageError(
        "connections remove takes no --profile; it selects an entry by --id",
      );
    if (action === "add" && !values.profile)
      throw new CliUsageError(
        "connections add requires --profile PATH to a non-secret profile JSON file",
      );
    if (action === "edit" && !values.profile)
      throw new CliUsageError(
        "connections edit requires --profile PATH to a non-secret profile JSON file",
      );
    if (action === "remove" && !values.id)
      throw new CliUsageError("connections remove requires --id");
    if (
      action === "list" &&
      (values.profile !== undefined || values.id !== undefined)
    )
      throw new CliUsageError("connections list takes no --profile or --id");
    return {
      ...values,
      command,
      action,
      db: "",
      cwd: "",
      model: "",
      protocol: undefined,
      provider: undefined,
      catalog: values.catalog ?? "",
      operationIds: undefined,
    };
  }
  if (
    positionals.length !== 1 ||
    ![
      "tui",
      "run",
      "feature",
      "debug",
      "status",
      "resume",
      "ack-recovery",
    ].includes(command ?? "")
  ) {
    throw new CliUsageError(
      "Expected one command: tui, run, feature, debug, status, resume, ack-recovery, or connections",
    );
  }
  if (values.id !== undefined)
    throw new CliUsageError(
      "--id only names a catalog entry for connections remove",
    );
  if (values.catalog !== undefined && values["profile-id"] === undefined)
    throw new CliUsageError(
      "--catalog only overrides the directory for --profile-id selection",
    );
  const selected = values.model || values.profile || values["profile-id"];
  const workflowCommand = command === "feature" || command === "debug";
  if (command === "tui") {
    if (!values.cwd) throw new CliUsageError("tui requires --cwd");
    if (Boolean(values.db) !== Boolean(selected))
      throw new CliUsageError(
        "Runtime attachment requires both --db and --model, --profile or --profile-id",
      );
    if (values.prompt && (!values.db || !values["request-id"] || values.once))
      throw new CliUsageError(
        "TUI prompt requires --db, --model and --request-id without --once",
      );
  } else if (values.once) throw new CliUsageError("--once requires tui");
  if (values.reconcile && !workflowCommand)
    throw new CliUsageError("--reconcile requires feature");
  if (values["reconcile-budget"]) {
    if (!workflowCommand)
      throw new CliUsageError("--reconcile-budget requires feature");
    if (values.spec !== undefined)
      throw new CliUsageError(
        "--reconcile-budget inspects the persisted budget ledger offline; it takes no --spec",
      );
    if (values.reconcile || values.inspect || values.tui)
      throw new CliUsageError(
        "--reconcile-budget cannot be combined with --reconcile, --inspect or --tui",
      );
    // --catalog is deliberately absent: without --profile-id it is rejected
    // above by the shared pair constraint, and with --profile-id the
    // --profile-id entry here rejects first — a dedicated entry could never
    // fire (dead branch removed; the rejection behavior is unchanged).
    const connectionFlag = (
      [
        ["--model", values.model],
        ["--profile", values.profile],
        ["--profile-id", values["profile-id"]],
        ["--provider", values.provider],
        ["--endpoint", values.endpoint],
        ["--protocol", values.protocol],
        ["--key-env", values["key-env"]],
      ] as const
    ).find(([, value]) => value !== undefined);
    if (connectionFlag)
      throw new CliUsageError(
        `${connectionFlag[0]} is a connection flag; --reconcile-budget inspects the persisted ledger offline without a connection`,
      );
    if (!values.db) throw new CliUsageError("--reconcile-budget requires --db");
  }
  if (
    values["expected-workspace"] !== undefined &&
    !(workflowCommand && values.reconcile)
  )
    throw new CliUsageError(
      "--expected-workspace requires feature --reconcile",
    );
  if (values.reconcile && (values.inspect || values.tui))
    throw new CliUsageError(
      "--reconcile cannot be combined with --inspect or --tui",
    );
  if (values.tui && !workflowCommand)
    throw new CliUsageError("--tui requires feature");
  if (values.inspect && !workflowCommand)
    throw new CliUsageError("--inspect requires feature");
  if (values.inspect && values.tui)
    throw new CliUsageError("--inspect cannot be combined with --tui");
  if (values.inspect && values.once)
    throw new CliUsageError("--inspect cannot be combined with --once");
  if (values.spec !== undefined && !workflowCommand) {
    throw new CliUsageError("--spec requires feature");
  }
  if (
    workflowCommand &&
    !values["reconcile-budget"] &&
    (!values.spec || !values.db || !selected)
  ) {
    throw new CliUsageError(
      "feature requires --spec, --db and --model, --profile or --profile-id",
    );
  }
  if (
    command !== "tui" &&
    !workflowCommand &&
    (!values.db || !values.cwd || !selected)
  ) {
    throw new CliUsageError(
      "--db, --cwd and --model, --profile or --profile-id are required",
    );
  }
  if (command === "run" && (!values.prompt || !values["request-id"])) {
    throw new CliUsageError("run requires --prompt and a stable --request-id");
  }
  const connectionFlags = [
    values.provider,
    values.endpoint,
    values.protocol,
    values["key-env"],
    values.model,
  ];
  if (values.profile !== undefined && values["profile-id"] !== undefined)
    throw new CliUsageError("--profile cannot be combined with --profile-id");
  if (
    values.profile !== undefined &&
    connectionFlags.some((value) => value !== undefined)
  )
    throw new CliUsageError(
      "--profile cannot be combined with connection flags",
    );
  if (
    values["profile-id"] !== undefined &&
    connectionFlags.some((value) => value !== undefined)
  )
    throw new CliUsageError(
      "--profile-id cannot be combined with connection flags",
    );
  values.provider ??= "openai";
  if (values.provider !== "openai" && values.provider !== "anthropic")
    throw new CliUsageError("--provider must be openai or anthropic");
  if (!values.profile && !values["profile-id"]) {
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
  }
  const operationIds = values["operation-id"]
    ?.split(",")
    .map((id) => id.trim());
  if (workflowCommand && values.reconcile) {
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
    action: undefined,
    db: values.db ?? "",
    cwd: values.cwd as string,
    model: values.model ?? "",
    protocol: values.protocol,
    provider: values.provider,
    catalog: values.catalog ?? "",
    operationIds,
  };
}
