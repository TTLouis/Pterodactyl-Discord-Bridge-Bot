import fs from "node:fs";
import path from "node:path";

/**
 * How stale the heartbeat may get before the process counts as wedged.
 *
 * The slowest poll interval is 60s, so five minutes is several missed cycles.
 */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function getHeartbeatPath() {
  return path.resolve(process.cwd(), process.env.HEARTBEAT_PATH ?? "./heartbeat");
}

/**
 * Touched after every completed poll loop so a container healthcheck can tell a
 * live bot from a wedged one.
 *
 * This reports loop liveness, not panel reachability: a loop where every server
 * failed still means the bot is running and polling, which is what a restart
 * would and would not fix respectively.
 */
export function writeHeartbeat(filePath = getHeartbeatPath(), logger = null) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${new Date().toISOString()}\n`, "utf8");
  } catch (error) {
    logger?.warn(`Failed to write heartbeat to ${filePath}`, error);
  }
}

export function readHeartbeatAgeMs(filePath = getHeartbeatPath()) {
  return Date.now() - fs.statSync(filePath).mtimeMs;
}
