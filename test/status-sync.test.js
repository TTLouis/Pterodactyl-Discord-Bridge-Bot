import assert from "node:assert/strict";
import test from "node:test";
import { CoreEvents } from "../src/core/core-events.js";
import { StatusSyncService } from "../src/services/status-sync-service.js";

function createService({ servers, getServerResources }) {
  const panels = [];
  const panelEvents = [];
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60 },
      servers
    },
    discordBridge: { setSlashCommands() {}, onMessage() {}, onInteraction() {}, onReaction() {} },
    eventBus: {
      async emit(name, payload) {
        if (name === CoreEvents.STATUS_PANEL_UPDATED) {
          panels.push(payload.snapshots);
          panelEvents.push(payload);
        }
        return [];
      }
    },
    pterodactylClient: {
      getServerResources,
      isConsoleSessionReady() { return false; },
      subscribeToConsole() { return () => {}; }
    },
    stateStore: {
      getRelayQueue() { return []; },
      setRelayQueue() {},
      getServerRuntimeState() { return {}; },
      setServerRuntimeState() {}
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });

  for (const server of servers.filter((server) => !server.archived)) {
    service.adapters.set(server.pterodactylServerId, {
      supportsConsoleSubscription() { return false; },
      async fetchSnapshot(resources) {
        return {
          name: server.name,
          currentState: resources.currentState,
          simplifiedStatus: "Offline",
          playerCount: 0,
          onlinePlayers: []
        };
      }
    });
  }

  return { service, panels, panelEvents };
}

function makeServer(name) {
  return {
    name,
    discordChannelId: `${name}-channel`,
    pterodactylServerId: `${name}-id`,
    game: { type: "factorio", chatCommandTemplate: "/shout {content}" },
    autoStop: null
  };
}

test("archived servers are excluded from polling and published only to the archive panel", async () => {
  const polled = [];
  const active = makeServer("active");
  const archived = { ...makeServer("archived"), archived: true, archiveNote: "Season ended" };
  const { service, panels, panelEvents } = createService({
    servers: [active, archived],
    async getServerResources(serverId) {
      polled.push(serverId);
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });

  await service.syncOnce({ force: true });

  assert.deepEqual(polled, ["active-id"]);
  assert.equal(service.adapters.has("archived-id"), false);
  assert.deepEqual(panels[0].map((item) => item.name), ["active"]);
  assert.deepEqual(panelEvents[0].archivedServers.map((item) => item.name), ["archived"]);
});

test("config reload starts and stops adapters when archived state changes", async () => {
  const server = makeServer("alpha");
  const { service } = createService({ servers: [server], async getServerResources() { return {}; } });
  let stopped = 0;
  service.adapters.set("alpha-id", { stop() { stopped += 1; } });

  server.archived = true;
  service.onConfigReloaded();
  assert.equal(stopped, 1);
  assert.equal(service.adapters.has("alpha-id"), false);

  server.archived = false;
  service.onConfigReloaded();
  assert.equal(service.adapters.has("alpha-id"), true);
  await service.stop();
});

test("concurrent syncOnce callers coalesce into a single poll", async () => {
  let release = null;
  const calls = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = createService({
    servers: [makeServer("alpha")],
    async getServerResources(serverId) {
      calls.push(serverId);
      await gate;
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });

  const first = service.syncOnce({ force: true });
  const second = service.syncOnce({ force: true });
  const third = service.syncOnce({ force: true });
  release();
  await Promise.all([first, second, third]);
  // Let the single coalesced follow-up run drain.
  await new Promise((resolve) => setImmediate(resolve));

  // One in-flight poll plus at most one queued follow-up, never three.
  assert.ok(calls.length <= 2, `expected at most 2 polls, saw ${calls.length}`);
});

test("a sync requested mid-flight still runs afterwards", async () => {
  let release = null;
  const calls = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = createService({
    servers: [makeServer("alpha")],
    async getServerResources(serverId) {
      calls.push(serverId);
      if (calls.length === 1) await gate;
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });

  const inFlight = service.syncOnce({ force: true });
  service.syncOnce({ force: true, reason: "manual" });
  release();
  await inFlight;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2, "the request made mid-flight should still produce a poll");
});

test("one unreachable server does not stop the others from being polled", async () => {
  const polled = [];
  const { service, panels } = createService({
    servers: [makeServer("alpha"), makeServer("beta"), makeServer("gamma")],
    async getServerResources(serverId) {
      polled.push(serverId);
      if (serverId === "beta-id") throw new Error("panel unreachable");
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });

  await service.syncOnce({ force: true });

  assert.deepEqual(polled.sort(), ["alpha-id", "beta-id", "gamma-id"]);
  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0].map((snapshot) => snapshot.name), ["alpha", "gamma"]);
});

test("snapshot order follows configuration order, not response order", async () => {
  const delays = { "alpha-id": 20, "beta-id": 0, "gamma-id": 10 };
  const { service, panels } = createService({
    servers: [makeServer("alpha"), makeServer("beta"), makeServer("gamma")],
    async getServerResources(serverId) {
      await new Promise((resolve) => setTimeout(resolve, delays[serverId]));
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });

  await service.syncOnce({ force: true });

  assert.deepEqual(panels[0].map((snapshot) => snapshot.name), ["alpha", "beta", "gamma"]);
});

test("the heartbeat is written after every completed poll loop", async () => {
  const beats = [];
  const { service } = createService({
    servers: [makeServer("alpha")],
    async getServerResources() { return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 }; }
  });
  service.onSyncCompleted = () => beats.push(Date.now());

  await service.syncOnce({ force: true });
  await service.syncOnce({ force: true });

  assert.equal(beats.length, 2);
});

test("the heartbeat still fires when every server fails", async () => {
  const summaries = [];
  const { service } = createService({
    servers: [makeServer("alpha"), makeServer("beta")],
    async getServerResources() { throw new Error("panel unreachable"); }
  });
  service.onSyncCompleted = (summary) => summaries.push(summary);

  await service.syncOnce({ force: true });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].degraded, true);
  assert.deepEqual(summaries[0].failedServers, ["alpha", "beta"]);
});
