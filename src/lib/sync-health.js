import fs from "node:fs";
import path from "node:path";

export function getSyncHealthPath() {
  return path.resolve(process.cwd(), process.env.SYNC_HEALTH_PATH ?? "./sync-health.json");
}

export function writeSyncHealth(summary, filePath = getSyncHealthPath(), logger = null) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(summary)}\n`, "utf8");
  } catch (error) {
    logger?.warn(`Failed to write sync health to ${filePath}`, error);
  }
}

export function readSyncHealth(filePath = getSyncHealthPath()) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
