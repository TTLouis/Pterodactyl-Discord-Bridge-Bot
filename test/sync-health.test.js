import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSyncHealth, writeSyncHealth } from "../src/lib/sync-health.js";

test("sync health persists the latest poll summary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sync-health-"));
  const filePath = path.join(directory, "sync-health.json");
  const summary = {
    completedAt: "2026-09-04T00:00:00.000Z",
    durationMs: 123,
    configuredServerCount: 2,
    successfulServerCount: 0,
    failedServers: ["Alpha", "Beta"],
    degraded: true
  };

  try {
    writeSyncHealth(summary, filePath);
    assert.deepEqual(readSyncHealth(filePath), summary);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
