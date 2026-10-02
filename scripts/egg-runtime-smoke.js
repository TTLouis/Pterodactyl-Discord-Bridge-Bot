// Isolated image rehearsal: real bootstrap/shutdown, mocked external services.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { main } from "/app/src/index.js";
import { StateStore } from "/app/src/lib/state-store.js";
import { readSyncHealth } from "/app/src/lib/sync-health.js";

class DiscordMock {
  constructor() {
    this.client = new EventEmitter();
    this.client.user = { id: "smoke-bot" };
    this.client.guilds = { cache: new Map() };
    this.client.isReady = () => true;
  }
  onMessage() {} onInteraction() {} onReaction() {} setSlashCommands() {}
  async start() { this.client.emit("clientReady"); }
  async stop() {}
}
let stateStore;
class SlowStateStore extends StateStore {
  constructor(...args) { super(...args); this.saveDebounceMs = 60_000; stateStore = this; }
}
class ListenerMock { start() {} stop() {} }
const context = await main({ services: {
  DiscordBridge: DiscordMock, DiscordPlatformListener: ListenerMock, StateStore: SlowStateStore
} });
await context.ready;
assert.equal(readSyncHealth(process.env.SYNC_HEALTH_PATH).mode, process.env.SMOKE_MODE);
assert.equal(context.runtime.config.setupMode, process.env.SMOKE_MODE === "setup");
// Queue a write too delayed to land before SIGINT; shutdown must flush it.
stateStore.state.serverRuntime["signal-smoke"] = { mode: process.env.SMOKE_MODE };
stateStore.saveSoon();
console.log("Runtime smoke waiting for SIGINT");
setInterval(() => {}, 1000);
