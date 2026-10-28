import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ServiceClient } from "../service/client.js";
import { serviceSocketPath } from "../service/daemon.js";
import { runServiceDashboard } from "../tui/service-dashboard.js";

const { values } = parseArgs({
  options: {
    "data-root": { type: "string" },
    socket: { type: "string" },
    once: { type: "boolean" },
  },
});
if (Boolean(values["data-root"]) === Boolean(values.socket))
  throw new Error(
    "Usage: tsx src/cli/service-tui.ts --data-root PATH [--once], or --socket PATH [--once]",
  );
const socketPath = values.socket
  ? resolve(values.socket)
  : serviceSocketPath(values["data-root"] as string);
await runServiceDashboard({
  client: new ServiceClient(socketPath),
  once: values.once ?? false,
});
