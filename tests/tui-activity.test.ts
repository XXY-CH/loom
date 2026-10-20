import { expect, test } from "vitest";
import { ActivityProjection, redact } from "../src/tui/activity.js";

test("projects actual tool intent and live output without treating return as workflow pass", () => {
  const view = new ActivityProjection();
  view.apply([
    { type: "run_start", inputs: [] },
    {
      type: "tool_execution_start",
      toolCallId: "one",
      toolName: "bash",
      args: { command: "npm test" },
    },
  ]);
  expect(view.status).toBe("running");
  expect(view.items.at(-1)).toMatchObject({
    detail: "npm test",
    state: "running",
  });
  view.apply([
    {
      type: "tool_execution_update",
      toolCallId: "one",
      toolName: "bash",
      output: { set: "first\n" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "one",
      toolName: "bash",
      output: { append: "second\n", trimStart: 0 },
    },
  ]);
  expect(view.items.at(-1)?.output).toBe("first\nsecond\n");
  view.apply([
    { type: "tool_execution_end", toolCallId: "one", toolName: "bash" },
  ]);
  expect(view.items.at(-1)?.state).toBe("error");
  view.apply([{ type: "run_end", inputs: [] }]);
  expect(view.items.at(-1)?.detail).toContain("not workflow acceptance");
});
test("visible activity stays bounded and masks known environment credentials", () => {
  const old = process.env.LOOM_TEST_TOKEN;
  process.env.LOOM_TEST_TOKEN = "private-fixture-credential";
  try {
    const view = new ActivityProjection();
    for (let i = 0; i < 120; i++)
      view.apply([
        {
          type: "tool_execution_start",
          toolCallId: String(i),
          toolName: "bash",
          args: {
            command: "TOKEN=unknown-value echo private-fixture-credential",
          },
        },
      ]);
    expect(view.items).toHaveLength(100);
    expect(JSON.stringify(view.items)).not.toContain(
      "private-fixture-credential",
    );
    expect(JSON.stringify(view.items)).not.toContain("unknown-value");
    expect(redact("password='two words'")).toBe("password=[redacted]");
    expect(redact("Authorization: Bearer opaque-fixture-token")).toBe(
      "Authorization: [redacted]",
    );
    expect(redact("authorization=Basic opaque-fixture-token")).toBe(
      "authorization=[redacted]",
    );
  } finally {
    if (old === undefined) delete process.env.LOOM_TEST_TOKEN;
    else process.env.LOOM_TEST_TOKEN = old;
  }
});
