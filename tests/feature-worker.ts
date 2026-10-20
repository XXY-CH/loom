import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FeatureRunner } from "../src/workflow/feature.js";
import type { FeatureSpec } from "../src/workflow/feature-store.js";
import { featureModel } from "./feature-fixture.js";

const configPath = process.argv[2];
const mode = process.argv[3];
if (!configPath) throw new Error("Expected local fixture configuration");
const config = JSON.parse(await readFile(configPath, "utf8")) as {
  root: string;
  spec: FeatureSpec;
  dbPath: string;
};
const model = featureModel({
  pauseAfterWrite: mode === "implement-write",
  onCall: (step, _context, afterTool) => {
    if (mode === "implement-write" && step === "implement" && afterTool)
      writeFileSync(
        join(config.root, "worker-ready"),
        "implementation tool returned",
      );
  },
});
const runner = await FeatureRunner.open({
  spec: config.spec,
  runtime: { ...model.runtime, dbPath: config.dbPath },
});
// Keep the process alive while the deliberately silent local model is pending.
const keepAlive = setInterval(() => {}, 1000);
try {
  await runner.run();
  throw new Error("Crash fixture unexpectedly completed");
} catch (error) {
  writeFileSync(join(config.root, "worker-failed"), String(error));
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
  await runner.close();
}
