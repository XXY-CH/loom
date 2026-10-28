import { expect, test } from "vitest";
import { help, parseOptions } from "../src/cli/options.js";

const feature = [
  "feature",
  "--spec",
  "run.json",
  "--db",
  "feature.sqlite",
  "--model",
  "fixture",
];
const workspace = JSON.stringify({
  workspaceId: "worktree-1",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
});
const reconcile = [
  ...feature,
  "--reconcile",
  "--operation-id",
  "operation-1",
  "--expected-workspace",
  workspace,
  "--confirm-effects-reviewed",
];

test("debug exposes the same durable inspection and reconciliation controls", () => {
  for (const flags of [[], ["--inspect"], ["--tui"]]) {
    expect(
      parseOptions(["debug", ...feature.slice(1), ...flags]),
    ).toMatchObject({
      command: "debug",
      spec: "run.json",
    });
  }
  expect(parseOptions(["debug", ...reconcile.slice(1)])).toMatchObject({
    command: "debug",
    reconcile: true,
    operationIds: ["operation-1"],
  });
});

test("feature reconciliation requires one operation, a valid workspace identity and review confirmation", () => {
  expect(parseOptions(reconcile)).toMatchObject({
    reconcile: true,
    operationIds: ["operation-1"],
    "expected-workspace": workspace,
  });
  for (const flag of [
    "--operation-id",
    "--expected-workspace",
    "--confirm-effects-reviewed",
  ]) {
    const args = [...reconcile];
    args.splice(
      args.indexOf(flag),
      flag === "--confirm-effects-reviewed" ? 1 : 2,
    );
    expect(() => parseOptions(args)).toThrow();
  }
  for (const id of ["", "one,two", "one,"]) {
    const args = [...reconcile];
    args[args.indexOf("--operation-id") + 1] = id;
    expect(() => parseOptions(args)).toThrow("one --operation-id");
  }
});

test.each([
  "null",
  "[]",
  "{}",
  "not-json",
  JSON.stringify({ workspaceId: "w", head: "bad", fingerprint: "bad" }),
])("feature reconciliation rejects invalid workspace identity %s", (value) => {
  const args = [...reconcile];
  args[args.indexOf("--expected-workspace") + 1] = value;
  expect(() => parseOptions(args)).toThrow("--expected-workspace");
});

test("reconciliation flags are feature-only and require reconciliation mode", () => {
  for (const flag of ["--tui", "--inspect"])
    expect(() => parseOptions([...reconcile, flag])).toThrow(
      "--reconcile cannot",
    );
  expect(() =>
    parseOptions([...feature, "--expected-workspace", workspace]),
  ).toThrow("--expected-workspace requires feature --reconcile");
  for (const command of ["status", "ack-recovery"]) {
    const common = [command, "--cwd", ".", "--db", "db", "--model", "fixture"];
    expect(() => parseOptions([...common, "--reconcile"])).toThrow(
      "--reconcile requires feature",
    );
    expect(() =>
      parseOptions([...common, "--expected-workspace", workspace]),
    ).toThrow("--expected-workspace requires feature --reconcile");
  }
});

test("feature accepts an explicit spec without requiring a duplicated cwd", () => {
  expect(parseOptions(feature)).toMatchObject({
    command: "feature",
    spec: "run.json",
    db: "feature.sqlite",
    model: "fixture",
    protocol: "responses",
  });
  expect(help).toContain("feature --spec PATH --db PATH --model ID");
});

test("feature can request its in-process read-only observer", () => {
  expect(parseOptions([...feature, "--tui"])).toMatchObject({
    command: "feature",
    tui: true,
  });
  expect(() =>
    parseOptions(["run", "--db", "x", "--cwd", ".", "--model", "m", "--tui"]),
  ).toThrow("--tui requires feature");
});

test("feature can request a mutually exclusive persisted-state inspection", () => {
  expect(parseOptions([...feature, "--inspect"])).toMatchObject({
    command: "feature",
    inspect: true,
  });
  expect(() => parseOptions([...feature, "--inspect", "--tui"])).toThrow(
    "--inspect cannot be combined with --tui",
  );
});

test("feature preserves existing provider connection flags", () => {
  expect(
    parseOptions([
      ...feature,
      "--cwd",
      "ignored-by-feature",
      "--endpoint",
      "http://127.0.0.1:9999/v1",
      "--protocol",
      "completions",
      "--key-env",
      "LOOM_FIXTURE_KEY",
    ]),
  ).toMatchObject({
    endpoint: "http://127.0.0.1:9999/v1",
    protocol: "completions",
    "key-env": "LOOM_FIXTURE_KEY",
    model: "fixture",
  });
});

test("feature accepts a profile without repeating connection flags", () => {
  const args = [
    "feature",
    "--spec",
    "run.json",
    "--db",
    "feature.sqlite",
    "--profile",
    "local.json",
  ];
  expect(parseOptions(args)).toMatchObject({
    profile: "local.json",
    model: "",
  });
  expect(() => parseOptions([...args, "--model", "override"])).toThrow(
    "cannot be combined with connection flags",
  );
});

test("profile help documents the non-secret file contract", () => {
  expect(help).toContain("--profile PATH");
  expect(() =>
    parseOptions([
      "feature",
      "--spec",
      "run.json",
      "--db",
      "feature.sqlite",
      "--profile",
      "local.json",
      "--provider",
      "anthropic",
    ]),
  ).toThrow("cannot be combined");
});

test("provider selection is explicit and Anthropic defaults to Messages", () => {
  expect(parseOptions([...feature, "--provider", "anthropic"])).toMatchObject({
    provider: "anthropic",
    protocol: "messages",
  });
  expect(() => parseOptions([...feature, "--provider", "invalid"])).toThrow(
    "--provider must be",
  );
  expect(() =>
    parseOptions([
      ...feature,
      "--provider",
      "anthropic",
      "--protocol",
      "responses",
    ]),
  ).toThrow("Anthropic requires");
  expect(() =>
    parseOptions([...feature, "--provider=anthropic", "--protocol=responses"]),
  ).toThrow("Anthropic requires");
});

test.each(["--spec", "--db", "--model"])(
  "feature rejects a missing %s",
  (flag) => {
    const args = [...feature];
    args.splice(args.indexOf(flag), 2);
    expect(() => parseOptions(args)).toThrow(
      "feature requires --spec, --db and --model",
    );
  },
);

test.each(["run", "status", "resume", "ack-recovery", "tui"])(
  "%s rejects --spec",
  (command) => {
    expect(() =>
      parseOptions([
        command,
        "--spec",
        "run.json",
        "--db",
        "runtime.sqlite",
        "--cwd",
        ".",
        "--model",
        "fixture",
      ]),
    ).toThrow("--spec requires feature");
  },
);

test("feature rejects incompatible execution and recovery flags", () => {
  expect(() => parseOptions([...feature, "--once"])).toThrow(
    "--once requires tui",
  );
  expect(() => parseOptions([...feature, "--protocol", "invalid"])).toThrow(
    "--protocol must be",
  );
  expect(() => parseOptions([...feature, "--operation-id", "old"])).toThrow(
    "require ack-recovery",
  );
  expect(() =>
    parseOptions([...feature, "--confirm-effects-reviewed"]),
  ).toThrow("require ack-recovery");
});

test("existing runtime commands continue requiring cwd and run request identity", () => {
  for (const command of ["run", "status", "resume", "ack-recovery"]) {
    expect(() =>
      parseOptions([command, "--db", "db", "--model", "fixture"]),
    ).toThrow("--cwd");
  }
  expect(() =>
    parseOptions([
      "run",
      "--db",
      "db",
      "--model",
      "fixture",
      "--cwd",
      ".",
      "--prompt",
      "goal",
    ]),
  ).toThrow("--request-id");
  expect(parseOptions(["tui", "--cwd", "."]))?.toMatchObject({
    command: "tui",
    db: "",
  });
});

test("TUI accepts a profile for Runtime attachment and rejects an unattached profile", () => {
  expect(
    parseOptions([
      "tui",
      "--cwd",
      ".",
      "--db",
      "runtime.sqlite",
      "--profile",
      "local.json",
    ]),
  ).toMatchObject({ profile: "local.json" });
  expect(() =>
    parseOptions(["tui", "--cwd", ".", "--profile", "local.json"]),
  ).toThrow("Runtime attachment");
});

test("--profile-id selects one catalog connection without implicit fallbacks", () => {
  const base = ["status", "--db", "runtime.sqlite", "--cwd", "."];
  expect(
    parseOptions([...base, "--profile-id", "local", "--catalog", "DIR"]),
  ).toMatchObject({ command: "status", "profile-id": "local", catalog: "DIR" });
  expect(
    parseOptions([
      "feature",
      "--spec",
      "run.json",
      "--db",
      "feature.sqlite",
      "--profile-id",
      "local",
    ]),
  ).toMatchObject({ command: "feature", "profile-id": "local" });
  expect(
    parseOptions([
      "tui",
      "--cwd",
      ".",
      "--db",
      "runtime.sqlite",
      "--profile-id",
      "local",
    ]),
  ).toMatchObject({ "profile-id": "local" });
  expect(() =>
    parseOptions(["tui", "--cwd", ".", "--profile-id", "local"]),
  ).toThrow("Runtime attachment");
  for (const flags of [
    ["--model", "override"],
    ["--profile", "local.json"],
    ["--provider", "anthropic"],
    ["--endpoint", "http://127.0.0.1:9/v1"],
    ["--protocol", "completions"],
    ["--key-env", "LOOM_FIXTURE_KEY"],
  ]) {
    expect(() =>
      parseOptions([...base, "--profile-id", "local", ...flags]),
    ).toThrow("cannot be combined");
  }
  expect(() =>
    parseOptions(["run", "--db", "db", "--cwd", ".", "--profile-id", "local"]),
  ).toThrow("--request-id");
  expect(help).toContain("--profile-id ID");
});

test("--id and --catalog are reserved for catalog selection and require it", () => {
  for (const command of [
    "tui",
    "run",
    "feature",
    "debug",
    "status",
    "resume",
    "ack-recovery",
  ])
    expect(() => parseOptions([command, "--id", "local"])).toThrow(
      "--id only names a catalog entry for connections remove",
    );
  for (const args of [
    ["status", "--db", "runtime.sqlite", "--cwd", ".", "--model", "fixture"],
    [
      "run",
      "--db",
      "runtime.sqlite",
      "--cwd",
      ".",
      "--model",
      "fixture",
      "--prompt",
      "goal",
      "--request-id",
      "one",
    ],
    [
      "feature",
      "--spec",
      "run.json",
      "--db",
      "feature.sqlite",
      "--profile",
      "local.json",
    ],
    ["tui", "--cwd", "."],
  ])
    expect(() => parseOptions([...args, "--catalog", "DIR"])).toThrow(
      "--catalog only overrides the directory for --profile-id selection",
    );
});

test("connections actions manage the catalog without runtime connection flags", () => {
  expect(
    parseOptions(["connections", "list", "--catalog", "DIR"]),
  ).toMatchObject({ command: "connections", action: "list", catalog: "DIR" });
  expect(
    parseOptions(["connections", "add", "--profile", "local.json"]),
  ).toMatchObject({ action: "add", profile: "local.json" });
  expect(
    parseOptions(["connections", "remove", "--id", "local"]),
  ).toMatchObject({ action: "remove", id: "local" });
  for (const args of [
    ["connections"],
    ["connections", "prune"],
    ["connections", "list", "extra"],
  ])
    expect(() => parseOptions(args)).toThrow(
      "connections requires one action: list, add, edit, or remove",
    );
  expect(() => parseOptions(["connections", "add"])).toThrow(
    "connections add requires --profile",
  );
  expect(() => parseOptions(["connections", "remove"])).toThrow(
    "connections remove requires --id",
  );
  expect(() =>
    parseOptions(["connections", "list", "--profile", "local.json"]),
  ).toThrow("connections list takes no --profile or --id");
  expect(() =>
    parseOptions([
      "connections",
      "add",
      "--profile",
      "local.json",
      "--model",
      "fixture",
    ]),
  ).toThrow("without runtime connection flags");
  expect(() =>
    parseOptions(["connections", "list", "--profile-id", "local"]),
  ).toThrow("--profile-id selects a runtime connection");
  expect(help).toContain("connections add --profile PATH");
});

test("connections edit parses like add: profile required, no --id, runtime flags still rejected", () => {
  expect(
    parseOptions([
      "connections",
      "edit",
      "--profile",
      "local.json",
      "--catalog",
      "DIR",
    ]),
  ).toMatchObject({
    command: "connections",
    action: "edit",
    profile: "local.json",
    catalog: "DIR",
  });
  expect(() => parseOptions(["connections", "edit"])).toThrow(
    "connections edit requires --profile",
  );
  expect(() => parseOptions(["connections", "edit", "--id", "x"])).toThrow(
    "connections edit takes no --id; the profile file defines the entry id",
  );
  expect(() =>
    parseOptions([
      "connections",
      "edit",
      "--profile",
      "local.json",
      "--db",
      "runtime.sqlite",
    ]),
  ).toThrow("--db is a runtime flag; connections manages the catalog");
  expect(help).toContain("connections edit --profile PATH");
});

test.each([
  ["--db", "runtime.sqlite"],
  ["--cwd", "."],
  ["--spec", "run.json"],
  ["--prompt", "goal"],
  ["--request-id", "one"],
  ["--operation-id", "operation-1"],
  ["--confirm-effects-reviewed", undefined],
  ["--tui", undefined],
  ["--inspect", undefined],
  ["--reconcile", undefined],
  ["--expected-workspace", workspace],
  ["--once", undefined],
])("connections rejects the runtime flag %s", (flag, value) => {
  const args = ["connections", "list"];
  args.push(flag);
  if (value !== undefined) args.push(value);
  expect(() => parseOptions(args)).toThrow(
    "is a runtime flag; connections manages the catalog",
  );
});

test.each([
  ["--model", "fixture"],
  ["--profile", "local.json"],
  ["--profile-id", "local"],
  ["--provider", "anthropic"],
  ["--endpoint", "http://127.0.0.1:9/v1/"],
  ["--protocol", "completions"],
  ["--key-env", "LOOM_FIXTURE_KEY"],
  ["--catalog", "DIR", "--profile-id", "local"],
])(
  "feature and debug reject the connection flag %s with --reconcile-budget",
  (flag, ...rest) => {
    for (const command of ["feature", "debug"])
      expect(() =>
        parseOptions([
          command,
          "--db",
          "feature.sqlite",
          "--reconcile-budget",
          flag,
          ...rest,
        ]),
      ).toThrow("is a connection flag; --reconcile-budget");
  },
);

test("--reconcile-budget without any connection flag still parses", () => {
  expect(
    parseOptions(["feature", "--db", "feature.sqlite", "--reconcile-budget"]),
  ).toMatchObject({ command: "feature", "reconcile-budget": true });
  expect(help).toContain("It takes no connection flags");
  // Bare --catalog never reaches the reconcile-budget flag list: the shared
  // upstream pair constraint (catalog requires --profile-id) rejects it first,
  // and paired with --profile-id the --profile-id entry rejects first — the
  // dead dedicated entry was removed with zero behavior change.
  expect(() =>
    parseOptions([
      "feature",
      "--db",
      "feature.sqlite",
      "--reconcile-budget",
      "--catalog",
      "DIR",
    ]),
  ).toThrow(
    "--catalog only overrides the directory for --profile-id selection",
  );
});

test("connections actions reject each other's selectors", () => {
  expect(() =>
    parseOptions([
      "connections",
      "add",
      "--profile",
      "local.json",
      "--id",
      "x",
    ]),
  ).toThrow("connections add takes no --id");
  expect(() => parseOptions(["connections", "add", "--id", "x"])).toThrow(
    "connections add takes no --id",
  );
  expect(() =>
    parseOptions(["connections", "remove", "--id", "local", "--profile", "p"]),
  ).toThrow("connections remove takes no --profile");
});

test("help documents profile selection for the debug example", () => {
  const debugLine = help
    .split("\n")
    .find((line) => line.includes("debug --spec"));
  expect(debugLine).toContain("--profile-id");
});
