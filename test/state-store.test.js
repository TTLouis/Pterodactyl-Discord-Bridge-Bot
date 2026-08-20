import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/lib/state-store.js";

test("relay queues persist across StateStore instances", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  const filePath = path.join(directory, "runtime-state.json");
  try {
    const store = new StateStore(filePath);
    store.load();
    store.setRelayQueue("factory-id", [{
      sourcePlatform: "discord",
      authorName: "Louis",
      authorColor: "#ff0000",
      content: "hello",
      enqueuedAt: 123
    }]);

    const reloaded = new StateStore(filePath);
    reloaded.load();
    assert.deepEqual(reloaded.getRelayQueue("factory-id"), [{
      sourcePlatform: "discord",
      authorName: "Louis",
      authorColor: "#ff0000",
      content: "hello",
      enqueuedAt: 123
    }]);

    reloaded.setRelayQueue("factory-id", []);
    assert.deepEqual(reloaded.getRelayQueue("factory-id"), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
