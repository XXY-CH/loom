import { expect, test } from "vitest";
import { summarizeUsage } from "../src/runtime/usage.js";

test("aggregates a synthetic multi-model ledger and weights cache ratio by prompt tokens", () => {
  const summary = summarizeUsage({
    models: {
      "fixture/root": {
        input: 500,
        output: 10,
        cacheRead: 1500,
        cacheWrite: 0,
        totalTokens: 2010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      "fixture/worker": {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 100,
        totalTokens: 220,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    tools: {},
  });

  expect(summary.models["fixture/root"]?.cacheReadPromptRatio).toBe(0.75);
  expect(summary.total).toEqual({
    input: 600,
    output: 30,
    cacheRead: 1500,
    cacheWrite: 100,
    cacheReadPromptRatio: 1500 / 2200,
  });
});

test("returns null when the ledger has no prompt-token denominator", () => {
  expect(summarizeUsage({ models: {}, tools: {} })).toEqual({
    models: {},
    total: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheReadPromptRatio: null,
    },
  });
});
