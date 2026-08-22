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
    // Relay queue writes are debounced; flush before reading from another instance.
    store.flush();

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

function withTempStore(run, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  const filePath = path.join(directory, "runtime-state.json");
  try {
    return run({ filePath, directory, makeStore: () => new StateStore(filePath, options) });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("relay queue writes are debounced and flushed on demand", () => {
  withTempStore(({ filePath, makeStore }) => {
    const store = makeStore();
    store.load();
    store.setRelayQueue("factory-id", [{ content: "queued", enqueuedAt: 1 }]);

    // Nothing on disk yet: the write is still pending.
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).relayQueue, {});

    store.flush();
    assert.deepEqual(
      JSON.parse(fs.readFileSync(filePath, "utf8")).relayQueue,
      { "factory-id": [{ content: "queued", enqueuedAt: 1 }] }
    );
  });
});

test("an immediate save supersedes a pending debounced write", () => {
  withTempStore(({ filePath, makeStore }) => {
    const store = makeStore();
    store.load();
    store.setRelayQueue("factory-id", [{ content: "queued", enqueuedAt: 1 }]);
    store.setAutoStopState("factory-id", { stoppedByBot: true });

    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(onDisk.autoStop, { "factory-id": { stoppedByBot: true } });
    assert.deepEqual(onDisk.relayQueue, { "factory-id": [{ content: "queued", enqueuedAt: 1 }] });
  });
});

test("flush is a no-op when nothing is pending", () => {
  withTempStore(({ makeStore }) => {
    const store = makeStore();
    store.load();
    assert.doesNotThrow(() => store.flush());
  });
});

test("state is written atomically, leaving no temp file behind", () => {
  withTempStore(({ filePath, directory, makeStore }) => {
    const store = makeStore();
    store.load();
    store.setAutoStopState("factory-id", { stoppedByBot: true });

    assert.equal(fs.existsSync(`${filePath}.tmp`), false);
    assert.deepEqual(fs.readdirSync(directory), ["runtime-state.json"]);
  });
});

test("a truncated state file is quarantined and replaced with defaults", () => {
  withTempStore(({ filePath, directory, makeStore }) => {
    fs.writeFileSync(filePath, '{"autoStop": {"factory-id": {"stopp', "utf8");
    const errors = [];
    const store = new StateStore(filePath, { logger: { error: (m) => errors.push(m) } });

    assert.doesNotThrow(() => store.load());
    assert.deepEqual(store.getAutoStopState("factory-id"), {});
    assert.deepEqual(store.getRelayQueue("factory-id"), []);

    const quarantined = fs.readdirSync(directory).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /was unreadable and has been reset/);
  });
});

test("a structurally invalid state file is treated as corrupt", () => {
  for (const contents of ["null", '"a string"', "[1, 2, 3]"]) {
    withTempStore(({ filePath, makeStore }) => {
      fs.writeFileSync(filePath, contents, "utf8");
      const store = makeStore();
      assert.doesNotThrow(() => store.load(), `should tolerate ${contents}`);
      assert.deepEqual(store.getStatusMessageIds("channel"), []);
      assert.deepEqual(store.getAutoStopState("server"), {});
    });
  }
});

test("a readable state file is preserved as-is", () => {
  withTempStore(({ filePath, directory, makeStore }) => {
    fs.writeFileSync(filePath, JSON.stringify({ autoStop: { "factory-id": { stoppedByBot: true } } }), "utf8");
    const store = makeStore();
    store.load();

    assert.deepEqual(store.getAutoStopState("factory-id"), { stoppedByBot: true });
    assert.equal(fs.readdirSync(directory).some((name) => name.includes(".corrupt-")), false);
  });
});

test("archive status message IDs are independent from the live panel", () => {
  withTempStore(({ makeStore }) => {
    const store = makeStore();
    store.load();
    store.setStatusMessageIds("status", ["live-message"]);
    store.setStatusMessageIds("status", ["archive-message"], "archive");

    assert.deepEqual(store.getStatusMessageIds("status"), ["live-message"]);
    assert.deepEqual(store.getStatusMessageIds("status", "archive"), ["archive-message"]);
  });
});
