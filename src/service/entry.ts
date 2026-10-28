import { parseArgs } from "node:util";
import { LoomService, serviceSocketPath } from "./daemon.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    http: { type: "boolean" },
    // Same name as the CLI flag but different semantics: for the service it is
    // a standalone opt-in that enables the read-only GET /connections
    // projection; the CLI only accepts --catalog paired with --profile-id.
    catalog: { type: "string" },
  },
});
if (!values["data-root"])
  throw new Error(
    "Usage: npm run service -- --data-root PATH [--http] [--catalog DIR]",
  );
const service = await LoomService.open({
  dataRoot: values["data-root"],
  ...(values.http ? { http: true } : {}),
  ...(values.catalog ? { connectionCatalogDirectory: values.catalog } : {}),
});
process.stdout.write(
  `Loom service listening: ${serviceSocketPath(values["data-root"])}\n`,
);
if (service.http) {
  const { port } = service.http.address;
  // Publish the ephemeral loopback port and token file path, never the token value.
  process.stdout.write(
    `Loom service HTTP: http://127.0.0.1:${port} (token file: ${service.http.tokenPath})\n`,
  );
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void service.close().catch(() => {
    stopping = false;
    process.stderr.write(
      "Service close failed; retry shutdown or inspect persisted Runs.\n",
    );
    process.exitCode = 1;
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
