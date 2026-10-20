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
