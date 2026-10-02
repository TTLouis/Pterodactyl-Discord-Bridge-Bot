import assert from "node:assert/strict";
import test from "node:test";
import { CoreEvents } from "../src/core/core-events.js";
import { AutoStopService } from "../src/services/auto-stop-service.js";
import { StatusSyncService } from "../src/services/status-sync-service.js";

function createService({ servers, getServerResources, nativeAdapters = false }) {
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

  for (const server of servers.filter((server) => !server.archived && !nativeAdapters)) {
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

test("active unpublished imports are polled but omitted from shared panels", async () => {
  const polled = [];
  const visible = makeServer("visible");
  const hidden = { ...makeServer("hidden"), published: false };
  const { service, panels, panelEvents } = createService({
    servers: [visible, hidden],
    async getServerResources(serverId) {
      polled.push(serverId);
      return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 };
    }
  });
  await service.syncOnce({ force: true });
  assert.deepEqual(polled, ["visible-id", "hidden-id"]);
  assert.deepEqual(panels[0].map((snapshot) => snapshot.name), ["visible"]);
  assert.deepEqual(panelEvents[0].archivedServers, []);
});

test("forced sync passes a live-player refresh request to adapters", async () => {
  const server = makeServer("factorio");
  const { service } = createService({
    servers: [server],
    async getServerResources() {
      return { currentState: "running", cpuPercent: 0, memoryBytes: 0 };
    }
  });
  let snapshotOptions = null;
  service.adapters.set(server.pterodactylServerId, {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources, options) {
      snapshotOptions = options;
      return {
        name: server.name,
        currentState: resources.currentState,
        simplifiedStatus: "Online",
        playerCount: 0,
        onlinePlayers: []
      };
    }
  });

  await service.syncOnce({ force: true, reason: "manual" });

  assert.deepEqual(snapshotOptions, { forcePlayerRefresh: true });
});

test("scheduled forced sync refreshes live player lists at the configured cadence", async () => {
  const server = makeServer("factorio");
  const { service } = createService({
    servers: [server],
    async getServerResources() {
      return { currentState: "running", cpuPercent: 0, memoryBytes: 0 };
    }
  });
  let snapshotOptions = null;
  service.adapters.set(server.pterodactylServerId, {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources, options) {
      snapshotOptions = options;
      return {
        name: server.name,
        currentState: resources.currentState,
        simplifiedStatus: "Online",
        playerCount: 1,
        onlinePlayers: ["Ada"]
      };
    }
  });

  await service.syncOnce({ force: true });

  assert.deepEqual(snapshotOptions, { forcePlayerRefresh: true });
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
  assert.deepEqual(panels[0].map((snapshot) => snapshot.name), ["alpha", "beta", "gamma"]);
  assert.equal(panels[0][1].simplifiedStatus, "Unavailable");
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


test("inactive, deleted, and unavailable records never poll, and deleted visibility is independent", async () => {
  const records = [
    { ...makeServer("inactive"), active: false },
    { ...makeServer("deleted"), deleted: true },
    { ...makeServer("archived"), archived: true },
    { ...makeServer("unavailable"), unavailable: true, active: false }
  ];
  const { service, panels, panelEvents } = createService({
    servers: records,
    async getServerResources() { assert.fail("retained records must not poll"); }
  });
  service.config.publicDisplay = { archived: "hidden", deleted: "marked" };
  await service.syncOnce({ force: true });
  assert.deepEqual(panelEvents[0].archivedServers.map((server) => server.name), ["deleted"]);
  assert.deepEqual(panels[0].map((server) => server.name), ["unavailable"]);
  assert.equal(panels[0][0].stale, true);
  service.config.publicDisplay = { archived: "marked", deleted: "hidden" };
  await service.syncOnce({ force: true });
  assert.deepEqual(panelEvents[1].archivedServers.map((server) => server.name), ["archived"]);
});

test("lost panel access retains stale data, closes sockets, and requires reactivation", async () => {
  const server = makeServer("alpha");
  let unavailable = false;
  let polls = 0;
  let closed = 0;
  const { service, panels } = createService({
    servers: [server],
    async getServerResources() {
      polls += 1;
      if (unavailable) throw new Error("404");
      return { currentState: "running" };
    }
  });
  const marked = [];
  service.onServerUnavailable = (record, diagnostics) => marked.push([record.name, diagnostics.reason]);
  service.pterodactylClient.subscribeToConsole = () => () => { closed += 1; };
  await service.syncOnce({ force: true });
  unavailable = true;
  await service.syncOnce({ force: true });
  assert.equal(server.unavailable, true);
  assert.equal(closed, 1);
  assert.equal(service.adapters.has("alpha-id"), false);
  assert.equal(marked.length, 1);
  assert.equal(panels[1][0].stale, true);
  assert.equal(panels[1][0].lastSeenAt, panels[0][0].lastSeenAt);
  unavailable = false;
  await service.syncOnce({ force: true });
  assert.equal(polls, 2, "recovered access must not resume monitoring automatically");
});

test("changing game or channels closes and replaces the old adapter", async () => {
  const server = makeServer("alpha");
  const { service } = createService({ servers: [server], async getServerResources() { return {}; } });
  let stopped = 0;
  let unsubscribed = 0;
  const old = { stop() { stopped += 1; } };
  service.adapters.set("alpha-id", old);
  service.consoleUnsubscribers.set("alpha-id", () => { unsubscribed += 1; });
  server.discordChannelId = "new-channel";
  service.onConfigReloaded();
  assert.equal(stopped, 1);
  assert.equal(unsubscribed, 1);
  assert.notEqual(service.adapters.get("alpha-id"), old);
  server.active = false;
  service.onConfigReloaded();
  assert.equal(service.adapters.has("alpha-id"), false);
  await service.stop();
});

test("disabling monitoring during an in-flight poll discards its result", async () => {
  const server = makeServer("alpha");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, panels } = createService({
    servers: [server],
    async getServerResources() { await gate; return { currentState: "running" }; }
  });
  const pending = service.syncOnce({ force: true });
  server.active = false;
  service.onConfigReloaded();
  release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(panels.at(-1), []);
  assert.equal(service.serverPlayerCounts.size, 0);
});


test("observation-only reloads retain adapters and rebind their configuration", async () => {
  const server = makeServer("alpha");
  const { service } = createService({ servers: [server], async getServerResources() { return {}; } });
  let rebound;
  const adapter = service.adapters.get("alpha-id");
  adapter.onConfigReloaded = (next) => { rebound = next; };
  const next = { ...server, lastSuccessAt: "2026-09-30T12:00:00Z" };
  service.config.servers = [next];
  service.onConfigReloaded();
  assert.equal(service.adapters.get("alpha-id"), adapter);
  assert.equal(rebound, next);
  await service.stop();
});


test("pause and removal reset idle deadlines while monitored settings changes preserve them", async () => {
  for (const flags of [{ active: false }, { archived: true }, { deleted: true }, { unavailable: true }]) {
    const server = makeServer("alpha");
    const { service } = createService({ servers: [server], async getServerResources() { return {}; } });
    const cleared = [];
    service.stateStore.clearAutoStopState = (id) => cleared.push(id);
    server.description = "updated description";
    service.onConfigReloaded();
    assert.deepEqual(cleared, [], "a settings change must preserve continuous idle tracking");
    Object.assign(server, flags);
    service.onConfigReloaded();
    assert.deepEqual(cleared, ["alpha-id"]);
  }
  const { service } = createService({ servers: [makeServer("removed")], async getServerResources() { return {}; } });
  const cleared = [];
  service.stateStore.clearAutoStopState = (id) => cleared.push(id);
  service.config.servers = [];
  service.onConfigReloaded();
  assert.deepEqual(cleared, ["removed-id"]);
});

test("panel failure and explicit reactivation start a fresh idle window without stopping immediately", async () => {
  const server = { ...makeServer("alpha"), autoStop: { enabled: true, emptyTimeoutHours: 1, warningMinutesBefore: 5 } };
  let panelFailed = true;
  const { service } = createService({
    servers: [server],
    async getServerResources() {
      if (panelFailed) throw new Error("panel unavailable");
      return { currentState: "running" };
    }
  });
  const state = { lastNonEmptyAt: Date.now() - 3 * 3600 * 1000, warningSentAt: Date.now() - 30 * 60 * 1000 };
  service.stateStore.getAutoStopState = () => state;
  service.stateStore.clearAutoStopState = () => { for (const key of Object.keys(state)) delete state[key]; };
  service.stateStore.setAutoStopState = (id, values) => Object.assign(state, values);
  const power = [];
  service.pterodactylClient.setPowerState = async (...args) => power.push(args);
  service.autoStopService = new AutoStopService({
    config: service.config, pterodactylClient: service.pterodactylClient,
    stateStore: service.stateStore, eventBus: service.eventBus, logger: service.logger
  });
  const adapter = service.adapters.get("alpha-id");
  await service.syncOnce({ force: true });
  assert.deepEqual(state, {});
  panelFailed = false;
  server.unavailable = false;
  service.onConfigReloaded();
  service.adapters.set("alpha-id", adapter);
  const beforeRecovery = Date.now();
  await service.syncOnce({ force: true });
  assert.ok(state.lastNonEmptyAt >= beforeRecovery);
  assert.deepEqual(power, [], "the pre-outage idle deadline must not stop the reactivated server");
});

test("disabled records loaded at startup clear saved idle tracking without resetting active records", () => {
  const cleared = [];
  new StatusSyncService({
    config: { discord: {}, servers: [
      { ...makeServer("paused"), active: false }, makeServer("continuous")
    ] },
    stateStore: { clearAutoStopState: (id) => cleared.push(id) },
    discordBridge: {}, pterodactylClient: {}, eventBus: {}, autoStopService: {}, logger: {}
  });
  assert.deepEqual(cleared, ["paused-id"]);
});


test("unknown player counts never reach idle automation and reset the idle window until reliable recovery", async () => {
  const server = makeServer("alpha");
  const { service, panels } = createService({
    servers: [server], async getServerResources() { return { currentState: "running" }; }
  });
  const idleCalls = [];
  const cleared = [];
  let reliable = false;
  service.stateStore.clearAutoStopState = (id) => cleared.push(id);
  service.autoStopService.onRunningSnapshot = async (_server, count) => idleCalls.push(count);
  service.adapters.set("alpha-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot() {
      return { name: "alpha", currentState: "running", simplifiedStatus: "Online", playerCount: 0,
        playerCountReliable: reliable, onlinePlayers: [] };
    }
  });
  await service.syncOnce({ force: true });
  assert.deepEqual(idleCalls, []);
  assert.deepEqual(cleared, ["alpha-id"]);
  reliable = true;
  await service.syncOnce();
  assert.deepEqual(idleCalls, [0]);
  assert.equal(panels.length, 2, "reliability changes must refresh the visible panel even when count stays zero");
});


test("transient panel outage retries status while actions pause, then recovers", async () => {
  const server = makeServer("retry"); let down = false; let polls = 0; let permanent = 0;
  const { service, panels } = createService({ servers: [server], async getServerResources() { polls++; if (down) throw Object.assign(new Error("504"), { retryable: true }); return { currentState: "offline" }; } });
  service.onServerUnavailable = () => permanent++;
  await service.syncOnce({ force: true }); down = true; await service.syncOnce({ force: true });
  assert.equal(server.accessUncertain, true); assert.notEqual(server.unavailable, true); assert.equal(permanent, 0);
  assert.equal(panels.at(-1)[0].retrying, true); assert.equal(panels.at(-1)[0].stale, true);
  const { isServerActionsEnabled, isServerRelayEnabled } = await import("../src/lib/server-lifecycle.js");
  assert.equal(isServerActionsEnabled(server), false); assert.equal(isServerRelayEnabled(server), false);
  down = false; await service.syncOnce();
  assert.equal(polls, 3); assert.equal(server.accessUncertain, false); assert.equal(isServerActionsEnabled(server), true);
  assert.notEqual(panels.at(-1)[0].stale, true);
});

test("console player refresh waits for ready and repaints after successful recovery", async () => {
  const server = makeServer("alpha");
  const { service, panels } = createService({servers:[server], async getServerResources() {
    return {currentState:"running",cpuPercent:0,memoryBytes:0};
  }});
  let callbacks;
  let playerQueries = 0;
  let reliable = false;
  service.pterodactylClient.subscribeToConsole = (_id, handlers) => {
    callbacks = handlers;
    return () => {};
  };
  service.adapters.set(server.pterodactylServerId, {
    supportsConsoleSubscription() { return true; },
    shouldRefreshOnlinePlayersOnConsoleConnect() { return true; },
    async refreshOnlinePlayers() { playerQueries++; reliable = true; },
    async fetchSnapshot() { return {name:server.name,currentState:"running",playerCount:1,
      playerCountReliable:reliable,onlinePlayers:reliable?["Alice"]:[]}; }
  });
  try {
    await service.syncOnce();
    callbacks.onConnected?.();
    assert.equal(playerQueries, 0, "authentication alone must not issue a command");
    callbacks.onReady();
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(playerQueries, 1);
    assert.equal(panels.at(-1)[0].playerCountReliable, true);
    assert.deepEqual(panels.at(-1)[0].onlinePlayers, ["Alice"]);
  } finally { await service.stop(); }
});

test("Source runtime adapter publishes console player snapshots", async () => {
  const server = { ...makeServer("Source"), game: { type: "source", chatCommandTemplate: 'say "{content}"' } };
  const { service, panels } = createService({ servers: [server], nativeAdapters: true,
    getServerResources: async () => ({ currentState: "running", uptimeMs: 1000 }) });
  service.pterodactylClient.runCommand = async (id, command) => {
    assert.equal(id, server.pterodactylServerId);
    assert.equal(command, "status");
    return ['players : 1 humans, 0 bots (24 max)', '# 7 "Alice" [U:1:123] 00:15 49 0 active'];
  };
  await service.syncOnce();
  assert.equal(panels.at(-1)[0].playerCountReliable, true);
  assert.deepEqual(panels.at(-1)[0].onlinePlayers, ["Alice"]);
  service.stop();
});

test("saved custom display order keeps unavailable status entries in their chosen position", async () => {
  const normal = makeServer("normal"), waiting = { ...makeServer("waiting"), unavailable: true, active: false };
  const { service, panels } = createService({ servers: [waiting, normal], async getServerResources() { return { currentState: "offline" }; } });
  service.config.discord.serverDisplayOrder = [waiting.pterodactylServerId, normal.pterodactylServerId];
  await service.syncOnce({ force: true });
  assert.deepEqual(panels[0].map(snapshot => snapshot.name), ["waiting", "normal"]);
});
