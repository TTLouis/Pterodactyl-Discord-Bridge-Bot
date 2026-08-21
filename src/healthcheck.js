import { getHeartbeatPath, HEARTBEAT_STALE_MS, readHeartbeatAgeMs } from "./lib/heartbeat.js";

// Container healthcheck entry point: exits non-zero when the poll loop has not
// completed a pass recently. Kept as a module rather than an inline `node -e`
// so the staleness threshold has exactly one definition.
const heartbeatPath = getHeartbeatPath();

try {
  const ageMs = readHeartbeatAgeMs(heartbeatPath);
  if (ageMs > HEARTBEAT_STALE_MS) {
    console.error(`Heartbeat at ${heartbeatPath} is ${Math.round(ageMs / 1000)}s old; the sync loop looks stalled.`);
    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  console.error(`Could not read heartbeat at ${heartbeatPath}: ${error.message}`);
  process.exit(1);
}
