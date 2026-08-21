import assert from "node:assert/strict";
import test from "node:test";
import { CoreEvents } from "../src/core/core-events.js";
import { MAX_RELAY_CONTENT_LENGTH, MAX_RELAY_QUEUE_LENGTH } from "../src/lib/relay-limits.js";
import { StatusSyncService } from "../src/services/status-sync-service.js";

function createRelayService() {
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    game: { type: "factorio", chatCommandTemplate: "DISCORD<{author}>: {content}" },
    autoStop: null
  };
  const queues = new Map();
  const notices = [];
  let messageHandler = null;

  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60 },
      servers: [server]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage(handler) { messageHandler = handler; },
      onInteraction() {},
      onReaction() {}
    },
    eventBus: {
      async emit(name, payload) {
        if (name === CoreEvents.SERVER_NOTICE) notices.push(payload);
        return [];
      }
    },
    pterodactylClient: {
      async getServerResources() { return { currentState: "offline", cpuPercent: 0, memoryBytes: 0 }; },
      isConsoleSessionReady() { return false; }
    },
    stateStore: {
      getRelayQueue(serverId) { return queues.get(serverId) ?? []; },
      setRelayQueue(serverId, entries) {
        if (entries.length) queues.set(serverId, entries);
        else queues.delete(serverId);
      },
      getServerRuntimeState() { return {}; },
      setServerRuntimeState() {}
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });

  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return true; },
    async handleChatCommand() {},
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

  return {
    service,
    server,
    notices,
    queue: () => queues.get("factory-id") ?? [],
    send: (content) => messageHandler({ channelId: "factory-channel", authorName: "Louis", content }),
    async start() { await service.start(); },
    async stop() { await service.stop(); }
  };
}

async function fill(harness, count, prefix = "msg") {
  for (let index = 0; index < count; index += 1) {
    await harness.send(`${prefix}-${index}`);
  }
}

test("the relay queue is capped, dropping the oldest messages first", async () => {
  const harness = createRelayService();
  await harness.start();
  try {
    await fill(harness, MAX_RELAY_QUEUE_LENGTH + 5);

    const queue = harness.queue();
    assert.equal(queue.length, MAX_RELAY_QUEUE_LENGTH);
    // The five oldest were dropped, so the queue starts at msg-5 and ends at the newest.
    assert.equal(queue[0].content, "msg-5");
    assert.equal(queue.at(-1).content, `msg-${MAX_RELAY_QUEUE_LENGTH + 4}`);
  } finally {
    await harness.stop();
  }
});

test("a full queue reports overflow once per episode, not once per dropped message", async () => {
  const harness = createRelayService();
  await harness.start();
  try {
    await fill(harness, MAX_RELAY_QUEUE_LENGTH + 20);

    const overflows = harness.notices.filter((notice) => notice.kind === "relay-queue-overflow");
    assert.equal(overflows.length, 1);
    assert.equal(overflows[0].limit, MAX_RELAY_QUEUE_LENGTH);
    assert.equal(overflows[0].server, harness.server);
  } finally {
    await harness.stop();
  }
});

test("overflow reporting re-arms once the queue has room again", async () => {
  const harness = createRelayService();
  await harness.start();
  try {
    await fill(harness, MAX_RELAY_QUEUE_LENGTH + 1, "first");
    assert.equal(harness.notices.filter((n) => n.kind === "relay-queue-overflow").length, 1);

    // Drain the queue the way a successful flush would, then overflow it again.
    harness.service.stateStore.setRelayQueue("factory-id", []);
    harness.service.relayOverflowNotified.delete("factory-id");
    await fill(harness, MAX_RELAY_QUEUE_LENGTH + 1, "second");

    assert.equal(harness.notices.filter((n) => n.kind === "relay-queue-overflow").length, 2);
  } finally {
    await harness.stop();
  }
});

test("queued relay content is truncated so runtime state stays bounded", async () => {
  const harness = createRelayService();
  await harness.start();
  try {
    await harness.send("x".repeat(MAX_RELAY_CONTENT_LENGTH * 3));

    const [entry] = harness.queue();
    assert.equal(entry.content.length, MAX_RELAY_CONTENT_LENGTH);
    assert.ok(entry.content.endsWith("…"), "expected an ellipsis marker on truncated content");
  } finally {
    await harness.stop();
  }
});

test("messages within the limit are queued unchanged", async () => {
  const harness = createRelayService();
  await harness.start();
  try {
    await harness.send("a normal message");
    assert.deepEqual(harness.queue().map((entry) => entry.content), ["a normal message"]);
  } finally {
    await harness.stop();
  }
});
