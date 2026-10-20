import { acquireDatabaseLease } from "../src/service/database-lease.js";

try {
  const databasePath = process.argv[2];
  if (!databasePath) throw new Error("Missing database path");
  const lease = await acquireDatabaseLease(databasePath);
  process.send?.({ type: "acquired", databasePath: lease.databasePath });
  process.on("message", (message) => {
    if (message === "release") {
      lease.release();
      process.disconnect();
    }
  });
} catch (error) {
  process.send?.({
    type: "error",
    code: error instanceof Error && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : "Unknown error",
  });
  process.disconnect();
}
