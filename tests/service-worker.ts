import { readFile } from "node:fs/promises";
import { LoomService } from "../src/service/daemon.js";
import type { FeatureSpec } from "../src/workflow/feature-store.js";
import { featureModel } from "./feature-fixture.js";

const [dataRoot, specPath] = process.argv.slice(2);
if (!dataRoot || !specPath) throw new Error("Expected dataRoot and specPath");
const spec = JSON.parse(await readFile(specPath, "utf8")) as FeatureSpec;
const model = featureModel({
  pauseAfterWrite: true,
  onCall: (step, _context, afterTool) => {
    if (step === "implement" && afterTool)
      process.stdout.write("write-persisted\n");
  },
});
const service = await LoomService.open({
  dataRoot,
  runtimeFactory: () => model.runtime,
});
await service.request({
  method: "start",
  spec,
  profile: {
    id: "fixture",
    kind: "openai-compatible",
    protocol: "openai-completions",
    modelId: "feature-fixture",
    baseUrl: "http://invalid.test",
  },
});
