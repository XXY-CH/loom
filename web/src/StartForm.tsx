import { useEffect, useState } from "react";
import type { WorkbenchApi } from "./api.js";
import type { FeatureSpec, ProviderProfile, RunSummary } from "./types.js";

/**
 * Assembles a FeatureSpec and a non-sensitive ProviderProfile (credentials stay
 * in the keyEnv-referenced server-side environment) and dispatches them through
 * the existing POST /runs pass-through. Local checks only cover empty required
 * fields, the runId pattern and numeric fields; every other rule (spec shape,
 * profile field set, idempotency) is validated server-side and its structured
 * error is shown verbatim.
 *
 * When the service exposes its connection catalog (started with --catalog),
 * the entries load into a selector that prefills every profile field; the
 * fields stay editable and a load failure or empty list simply keeps the
 * manual entry path. The selector only fills form state — the dispatched body
 * is always assembled from the (possibly edited) fields. Under the same
 * --catalog opt-in the form also manages the catalog itself: "Save profile to
 * catalog" POSTs the profile exactly as assembled from the fields (one
 * request, no confirm step — an identical re-add is the catalog's idempotent
 * "unchanged" acknowledgement), "Update selected connection" PUTs the same
 * assembled profile once to the selected entry's id (the selector prefills
 * every field, so this is the same-id edit path; an edited id field no longer
 * matches the path id and the server rejects the update — a hint says so and
 * the structured error still shows verbatim), and each listed entry has a
 * remove button behind an explicit confirm step (zero requests before
 * confirm, mirroring the reconcile-budget button). All three refresh the
 * selector list on success and show structured errors (CONNECTION_CONFLICT/
 * UNKNOWN_CONNECTION/CATALOG_BUSY/INVALID_PROFILE/not-enabled, code-prefixed
 * by the service) verbatim.
 */

/** Argv contract: one argument per line; blank lines are dropped, inner
 * spaces within a line are preserved as part of the argument. */
function parseArgv(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** "" means "omit the field"; anything else must parse as a positive integer. */
function parsePositiveInt(raw: string): number | "empty" | "invalid" {
  if (raw.trim() === "") return "empty";
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : "invalid";
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const PROVIDER_KINDS = [
  "openai-compatible",
  "openai",
  "anthropic",
] as ProviderProfile["kind"][];
const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as ProviderProfile["protocol"][];

export function StartForm({
  api,
  onCancel,
}: {
  api: WorkbenchApi;
  onCancel: () => void;
}) {
  const [workflow, setWorkflow] = useState<"feature" | "debug">("feature");
  const [runId, setRunId] = useState("");
  const [goal, setGoal] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [baseCommit, setBaseCommit] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [budgetCalls, setBudgetCalls] = useState("");
  const [budgetTokens, setBudgetTokens] = useState("");
  const [targeted, setTargeted] = useState("");
  const [reproduce, setReproduce] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [regression, setRegression] = useState("");
  const [profileId, setProfileId] = useState("");
  const [kind, setKind] =
    useState<ProviderProfile["kind"]>("openai-compatible");
  const [protocol, setProtocol] =
    useState<ProviderProfile["protocol"]>("openai-completions");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyEnv, setKeyEnv] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [profileMaxTokens, setProfileMaxTokens] = useState("");
  const [connections, setConnections] = useState<ProviderProfile[] | null>(
    null,
  );
  // True only after a successful catalog read: writes need --catalog too, so
  // the management UI stays hidden when the probe answered the not-enabled
  // (or any failed) response.
  const [catalogEnabled, setCatalogEnabled] = useState(false);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  const [removingConnection, setRemovingConnection] = useState<string | null>(
    null,
  );
  // The catalog entry the selector last prefilled from, or null while the
  // fields have not been loaded from an entry. "Update selected connection"
  // PUTs to this id; a refresh that no longer lists it clears the selection.
  const [selectedConnection, setSelectedConnection] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunSummary | null>(null);
  const [pending, setPending] = useState(false);

  // One catalog probe per form; a failed or malformed response keeps the
  // manual path (null -> loading, [] -> no selector, entries -> selector).
  useEffect(() => {
    let stopped = false;
    api.listConnections().then(
      (list) => {
        if (!stopped) {
          setConnections(Array.isArray(list) ? list : []);
          setCatalogEnabled(true);
        }
      },
      () => {
        if (!stopped) setConnections([]);
      },
    );
    return () => {
      stopped = true;
    };
  }, [api]);

  /** Prefills every profile field from a catalog entry; fields stay editable. */
  const applyConnection = (id: string) => {
    const entry = connections?.find((item) => item.id === id);
    if (!entry) return;
    setSelectedConnection(id);
    setProfileId(entry.id);
    setKind(entry.kind);
    setProtocol(entry.protocol);
    setModelId(entry.modelId);
    setBaseUrl(entry.baseUrl ?? "");
    setKeyEnv(entry.keyEnv ?? "");
    setContextWindow(
      entry.contextWindow === undefined ? "" : String(entry.contextWindow),
    );
    setProfileMaxTokens(
      entry.maxTokens === undefined ? "" : String(entry.maxTokens),
    );
  };

  /** Profile-field checks shared by dispatch and catalog save (same messages
   * and order as before the extraction). */
  const profileProblems = (): string[] => {
    const local: string[] = [];
    if (!profileId.trim()) local.push("Profile id is required.");
    if (!modelId.trim()) local.push("Profile modelId is required.");
    if (
      parsePositiveInt(contextWindow) === "invalid" ||
      parsePositiveInt(profileMaxTokens) === "invalid"
    )
      local.push(
        "Profile contextWindow and maxTokens must be positive integers.",
      );
    return local;
  };

  /** Assembles the non-sensitive profile from the current fields; blank
   * optional fields are omitted. The same assembly feeds POST /runs and the
   * catalog save, so what is dispatched is exactly what is stored. */
  const assembleProfile = (): ProviderProfile => {
    const context = parsePositiveInt(contextWindow);
    const profileTokenLimit = parsePositiveInt(profileMaxTokens);
    return {
      id: profileId.trim(),
      kind,
      protocol,
      modelId: modelId.trim(),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(keyEnv.trim() ? { keyEnv: keyEnv.trim() } : {}),
      ...(context !== "empty" && context !== "invalid"
        ? { contextWindow: context }
        : {}),
      ...(profileTokenLimit !== "empty" && profileTokenLimit !== "invalid"
        ? { maxTokens: profileTokenLimit }
        : {}),
    };
  };

  /** Re-reads the selector list after a write; a failing refresh keeps the
   * last list (it is not a write failure and never blocks the form). An entry
   * removed since the last read also drops the selection, so "Update selected"
   * never targets an id the catalog no longer lists. */
  const refreshConnections = async () => {
    try {
      const list = await api.listConnections();
      const entries = Array.isArray(list) ? list : [];
      setConnections(entries);
      setCatalogEnabled(true);
      setSelectedConnection((current) =>
        current !== null && !entries.some((entry) => entry.id === current)
          ? null
          : current,
      );
    } catch {
      /* keep the last observed list */
    }
  };

  const addToCatalog = async () => {
    const local = profileProblems();
    if (local.length > 0) {
      setCatalogError(local.join(" "));
      setCatalogStatus(null);
      return;
    }
    setCatalogPending(true);
    setCatalogError(null);
    setCatalogStatus(null);
    try {
      const outcome = await api.addConnection(assembleProfile());
      setCatalogStatus(
        `Connection "${outcome.id}" ${outcome.status} in the catalog.`,
      );
      await refreshConnections();
    } catch (cause) {
      setCatalogError(
        cause instanceof Error
          ? cause.message
          : "Connection catalog write failed",
      );
    } finally {
      setCatalogPending(false);
    }
  };

  const updateToCatalog = async () => {
    if (selectedConnection === null) return;
    const local = profileProblems();
    if (local.length > 0) {
      setCatalogError(local.join(" "));
      setCatalogStatus(null);
      return;
    }
    setCatalogPending(true);
    setCatalogError(null);
    setCatalogStatus(null);
    try {
      // One PUT of the assembled profile to the selected entry's id. The
      // selector prefilled every field, so an unchanged id keeps body.id equal
      // to the path id; an edited id makes them differ and the server's
      // structured 400 shows verbatim below.
      const outcome = await api.updateConnection(
        selectedConnection,
        assembleProfile(),
      );
      setCatalogStatus(
        `Connection "${outcome.id}" ${outcome.status} in the catalog.`,
      );
      await refreshConnections();
    } catch (cause) {
      setCatalogError(
        cause instanceof Error
          ? cause.message
          : "Connection catalog update failed",
      );
    } finally {
      setCatalogPending(false);
    }
  };

  const removeFromCatalog = async (id: string) => {
    setCatalogPending(true);
    setCatalogError(null);
    setCatalogStatus(null);
    try {
      const outcome = await api.removeConnection(id);
      setCatalogStatus(
        `Connection "${outcome.id}" ${outcome.status} from the catalog.`,
      );
      setRemovingConnection(null);
      await refreshConnections();
    } catch (cause) {
      setCatalogError(
        cause instanceof Error
          ? cause.message
          : "Connection catalog removal failed",
      );
    } finally {
      setCatalogPending(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const local: string[] = [];
    if (!runId.trim()) local.push("runId is required.");
    else if (!RUN_ID_PATTERN.test(runId.trim()))
      local.push(
        "runId must start with a letter or digit and use only letters, digits, '_' and '-'.",
      );
    if (!goal.trim()) local.push("goal is required.");
    for (const [name, value] of [
      ["repositoryPath", repositoryPath],
      ["baseCommit", baseCommit],
      ["worktreePath", worktreePath],
    ] as const)
      if (!value.trim()) local.push(`${name} is required.`);
    const argvFields =
      workflow === "feature"
        ? ([["targeted", targeted]] as const)
        : ([
            ["reproduce", reproduce],
            ["hypothesis", hypothesis],
          ] as const);
    const argv = new Map<string, string[]>();
    for (const [name, raw] of [...argvFields, ["regression", regression]]) {
      const parsed = parseArgv(raw);
      if (parsed.length === 0) local.push(`${name} needs at least one line.`);
      argv.set(name, parsed);
    }
    const calls = parsePositiveInt(budgetCalls);
    const tokens = parsePositiveInt(budgetTokens);
    let budget: FeatureSpec["budget"] | undefined;
    if (calls === "invalid" || tokens === "invalid")
      local.push("budget fields must be positive integers.");
    else if (calls === "empty" && tokens === "empty") budget = undefined;
    else if (calls === "empty" || tokens === "empty")
      local.push("budget requires both maxCalls and maxTokens, or neither.");
    else budget = { maxCalls: calls, maxTokens: tokens };
    local.push(...profileProblems());
    if (local.length > 0) {
      setError(local.join(" "));
      setResult(null);
      return;
    }
    const spec: FeatureSpec = {
      runId: runId.trim(),
      goal,
      repositoryPath: repositoryPath.trim(),
      baseCommit: baseCommit.trim(),
      worktreePath: worktreePath.trim(),
      workflow,
      ...(workflow === "feature"
        ? { targeted: argv.get("targeted") ?? [] }
        : {
            reproduce: argv.get("reproduce") ?? [],
            hypothesis: argv.get("hypothesis") ?? [],
          }),
      regression: argv.get("regression") ?? [],
      ...(budget ? { budget } : {}),
    };
    const profile = assembleProfile();
    setPending(true);
    setError(null);
    setResult(null);
    try {
      // A duplicate start with the same body returns the same RunSummary as
      // an idempotent acknowledgement; it renders as success either way.
      setResult(await api.start(spec, profile));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Start request failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="start-form" onSubmit={(event) => void submit(event)}>
      <h2>Start a run</h2>
      <p className="hint">
        Dispatches through the service&apos;s POST /runs pass-through. Argv
        fields take one command argument per line; blank lines are dropped.
        Credentials are never entered here: the profile only names a keyEnv
        environment variable resolved on the service side.
      </p>
      <fieldset>
        <legend>Workflow</legend>
        <label>
          <input
            type="radio"
            name="workflow"
            value="feature"
            checked={workflow === "feature"}
            onChange={() => setWorkflow("feature")}
          />{" "}
          feature
        </label>
        <label>
          <input
            type="radio"
            name="workflow"
            value="debug"
            checked={workflow === "debug"}
            onChange={() => setWorkflow("debug")}
          />{" "}
          debug
        </label>
      </fieldset>
      <label>
        runId
        <input
          name="runId"
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
          placeholder="addition"
        />
      </label>
      <label>
        goal
        <textarea
          name="goal"
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Make sum.js add two numbers."
        />
      </label>
      <label>
        repositoryPath
        <input
          name="repositoryPath"
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          placeholder="/absolute/project"
        />
      </label>
      <label>
        baseCommit
        <input
          name="baseCommit"
          value={baseCommit}
          onChange={(event) => setBaseCommit(event.target.value)}
          placeholder="full commit SHA"
        />
      </label>
      <label>
        worktreePath
        <input
          name="worktreePath"
          value={worktreePath}
          onChange={(event) => setWorktreePath(event.target.value)}
          placeholder="/absolute/worktree"
        />
      </label>
      <div className="start-form-row">
        <label>
          budget maxCalls (optional)
          <input
            name="budgetCalls"
            inputMode="numeric"
            value={budgetCalls}
            onChange={(event) => setBudgetCalls(event.target.value)}
            placeholder="64"
          />
        </label>
        <label>
          budget maxTokens (optional)
          <input
            name="budgetTokens"
            inputMode="numeric"
            value={budgetTokens}
            onChange={(event) => setBudgetTokens(event.target.value)}
            placeholder="1000000"
          />
        </label>
      </div>
      {workflow === "feature" ? (
        <label>
          targeted
          <textarea
            name="targeted"
            rows={3}
            value={targeted}
            onChange={(event) => setTargeted(event.target.value)}
            placeholder={"node\n-e\nconsole.log(1)"}
          />
        </label>
      ) : (
        <>
          <label>
            reproduce
            <textarea
              name="reproduce"
              rows={3}
              value={reproduce}
              onChange={(event) => setReproduce(event.target.value)}
              placeholder={"npm\ntest\n--\nbug.test.ts"}
            />
          </label>
          <label>
            hypothesis
            <textarea
              name="hypothesis"
              rows={3}
              value={hypothesis}
              onChange={(event) => setHypothesis(event.target.value)}
              placeholder={"node\nscripts/check-cause.js"}
            />
          </label>
        </>
      )}
      <label>
        regression
        <textarea
          name="regression"
          rows={3}
          value={regression}
          onChange={(event) => setRegression(event.target.value)}
          placeholder={"npm\ntest"}
        />
      </label>
      <fieldset>
        <legend>Provider profile (non-sensitive)</legend>
        {connections !== null && connections.length > 0 ? (
          <div className="connection-selector">
            <label>
              Connection (from the catalog)
              <select
                name="connection"
                value=""
                onChange={(event) => applyConnection(event.target.value)}
              >
                <option value="">Select a connection…</option>
                {connections.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id} ({entry.modelId})
                  </option>
                ))}
              </select>
            </label>
            {selectedConnection !== null &&
            profileId.trim() !== selectedConnection ? (
              <p className="hint" data-testid="connection-id-mismatch">
                Profile id differs from the selected connection; an update would
                be rejected. Save it as a new id, or remove and re-add the entry
                instead.
              </p>
            ) : null}
            {catalogEnabled ? (
              <ul
                className="connection-entries"
                data-testid="connection-entries"
              >
                {connections.map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.id}</span>
                    {removingConnection === entry.id ? (
                      <>
                        <button
                          type="button"
                          disabled={catalogPending}
                          onClick={() => void removeFromCatalog(entry.id)}
                          data-testid={`confirm-remove-connection`}
                        >
                          Confirm remove
                        </button>
                        <button
                          type="button"
                          disabled={catalogPending}
                          onClick={() => setRemovingConnection(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={catalogPending}
                        onClick={() => {
                          setRemovingConnection(entry.id);
                          setCatalogError(null);
                          setCatalogStatus(null);
                        }}
                      >
                        Remove {entry.id}…
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {connections !== null && connections.length === 0 ? (
          <p className="hint" data-testid="connection-status">
            No catalog connections available; fill the profile manually.
          </p>
        ) : null}
        <label>
          Profile id
          <input
            name="profileId"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            placeholder="my-connection"
          />
        </label>
        <label>
          Profile kind
          <select
            name="kind"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as ProviderProfile["kind"])
            }
          >
            {PROVIDER_KINDS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Profile protocol
          <select
            name="protocol"
            value={protocol}
            onChange={(event) =>
              setProtocol(event.target.value as ProviderProfile["protocol"])
            }
          >
            {PROVIDER_PROTOCOLS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Profile modelId
          <input
            name="modelId"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="feature-fixture"
          />
        </label>
        <label>
          Profile baseUrl (optional; required for openai-compatible)
          <input
            name="baseUrl"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:8000"
          />
        </label>
        <label>
          Profile keyEnv (optional)
          <input
            name="keyEnv"
            value={keyEnv}
            onChange={(event) => setKeyEnv(event.target.value)}
            placeholder="MY_PROVIDER_API_KEY"
          />
        </label>
        <div className="start-form-row">
          <label>
            Profile contextWindow (optional)
            <input
              name="contextWindow"
              inputMode="numeric"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              placeholder="32768"
            />
          </label>
          <label>
            Profile maxTokens (optional)
            <input
              name="profileMaxTokens"
              inputMode="numeric"
              value={profileMaxTokens}
              onChange={(event) => setProfileMaxTokens(event.target.value)}
              placeholder="4096"
            />
          </label>
        </div>
        {catalogEnabled ? (
          <div className="run-actions">
            <button
              type="button"
              disabled={catalogPending}
              onClick={() => void addToCatalog()}
            >
              {catalogPending ? "Saving…" : "Save profile to catalog"}
            </button>
            <button
              type="button"
              disabled={catalogPending || selectedConnection === null}
              onClick={() => void updateToCatalog()}
            >
              {catalogPending ? "Updating…" : "Update selected connection"}
            </button>
          </div>
        ) : null}
      </fieldset>
      {catalogError ? (
        <p role="alert" data-testid="catalog-error">
          {catalogError}
        </p>
      ) : null}
      {catalogStatus ? (
        <p data-testid="catalog-status">{catalogStatus}</p>
      ) : null}
      <div className="run-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Starting…" : "Start"}
        </button>
        <button type="button" onClick={onCancel}>
          Close
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="start-error">
          {error}
        </p>
      ) : null}
      {result ? (
        <p data-testid="start-result">
          Run {result.runId}: {result.status}
          {result.blockedReason ? ` (${result.blockedReason})` : ""} — select it
          in the list to inspect progress.
        </p>
      ) : null}
    </form>
  );
}
