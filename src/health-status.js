import { getSyncHealthPath, readSyncHealth } from "./lib/sync-health.js";

try {
  console.log(JSON.stringify(readSyncHealth(getSyncHealthPath())));
} catch (error) {
  console.error(`Could not read sync health: ${error.message}`);
  process.exitCode = 1;
}
