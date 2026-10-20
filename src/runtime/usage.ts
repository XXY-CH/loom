import type { UsageState } from "@earendil-works/pi-durable";

export interface RuntimeUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadPromptRatio: number | null;
}

export interface RuntimeUsageSummary {
  models: Record<string, RuntimeUsageTotals>;
  total: RuntimeUsageTotals;
}

function summarize(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): RuntimeUsageTotals {
  const prompt = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheReadPromptRatio: prompt > 0 ? cacheRead / prompt : null,
  };
}

export function summarizeUsage(state: UsageState): RuntimeUsageSummary {
  const models: Record<string, RuntimeUsageTotals> = {};
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const [model, usage] of Object.entries(state.models)) {
    models[model] = summarize(
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
    );
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
  }
  return { models, total: summarize(input, output, cacheRead, cacheWrite) };
}
