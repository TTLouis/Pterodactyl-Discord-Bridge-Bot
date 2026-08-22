import assert from "node:assert/strict";
import test from "node:test";
import { CoreEventBus, CoreEvents } from "../src/core/core-events.js";
import { DiscordPlatformListener } from "../src/platforms/discord-platform-listener.js";
import { KookPlatformListener } from "../src/platforms/kook-platform-listener.js";
import { buildKookActionMessageForEvent } from "../src/lib/kook-card-formatters.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "../src/services/auto-stop-service.js";

const snapshot = {
  name: "Factory",
  description: "Main server",
  publicAddress: "play.example.com",
  publicPort: 34197,
  currentState: "offline",
  simplifiedStatus: "Offline",
  playerCount: 0,
  maxPlayers: 32,
  onlinePlayers: [],
  cpuPercent: 0,
  memoryBytes: 0,
  gameDurationMs: 3600000
};

const server = {
  name: "Factory",
  discordChannelId: "discord-server",
  kookChannelId: "kook-server",
  pterodactylServerId: "factory-id"
};

function createConfig() {
  return {
    discord: {
      statusChannelId: "discord-status",
      logChannelId: "discord-log",
      displayTimeZone: "UTC"
    },
    kook: {
      statusChannelId: "kook-status",
      logChannelId: "kook-log",
      displayTimeZone: "Asia/Shanghai"
    },
    servers: [server]
  };
}

test("Discord platform listener renders status, action, chat, and notices", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new DiscordPlatformListener({
    eventBus,
    config: createConfig(),
    discordBridge: {
      async upsertStatusPanel(channelId, panel, options) {
        calls.push({ method: "upsertStatusPanel", channelId, panel, options });
      },
      async replaceActionMessage(channelId, payload, options) {
        calls.push({ method: "replaceActionMessage", channelId, payload, options });
        return { id: "discord-action" };
      },
      async deleteMessage(channelId, messageId) {
        calls.push({ method: "deleteMessage", channelId, messageId });
      },
      async sendMessage(channelId, content) {
        calls.push({ method: "sendMessage", channelId, content });
        return { id: "discord-message" };
      }
    }
  });
  listener.start();

  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: [snapshot], archivedServers: [] });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "auto-stop-warning", server, stopAt: new Date() });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "server-offline", server, currentState: "offline" });
  await eventBus.emit(CoreEvents.GAME_CHAT_RELAY, { server, authorName: "Player", content: "hello" });
  await eventBus.emit(CoreEvents.GROUP_CHAT_RELAY, { server, sourcePlatform: "kook", authorName: "Kai", content: "from kook" });
  await eventBus.emit(CoreEvents.SERVER_NOTICE, {
    kind: "satisfactory-player-count",
    server,
    changedPlayers: 2,
    action: "joined",
    playerCount: 2,
    maxPlayers: 8
  });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE_DELETE, { server, messageId: "old-message" });
  await eventBus.emit(CoreEvents.GROUP_CHAT_RELAY, { server, sourcePlatform: "discord", authorName: "Local", content: "skip" });
  listener.stop();

  assert.equal(calls[0].method, "upsertStatusPanel");
  assert.equal(calls[0].channelId, "discord-status");
  assert.equal(calls[0].panel.embeds[0].toJSON().title, "Archived Servers");
  assert.deepEqual(calls[0].panel.embeds[0].toJSON().description, "No archived servers.");
  assert.deepEqual(calls[0].options, { panelKey: "archive" });
  assert.equal(calls[1].method, "upsertStatusPanel");
  assert.deepEqual(calls[1].options, { panelKey: "live" });
  assert.match(calls[1].panel.embeds[0].toJSON().fields[1].value, /Offline/);
  assert.deepEqual(calls[2].options.reactions, [CANCEL_AUTO_STOP_REACTION]);
  assert.equal(calls[2].options.preferEdit, true);
  assert.deepEqual(calls[2].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "auto-stop-warning",
    state: null
  });
  assert.deepEqual(calls[3].options.reactions, [RESTART_SERVER_REACTION]);
  assert.deepEqual(calls[3].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "server-offline",
    state: "offline"
  });
  assert.deepEqual(calls[4], { method: "sendMessage", channelId: "discord-server", content: "**Player**: hello" });
  assert.deepEqual(calls[5], { method: "sendMessage", channelId: "discord-server", content: "[KOOK] **Kai**: from kook" });
  assert.deepEqual(calls[6], { method: "sendMessage", channelId: "discord-server", content: "2 players joined **Factory**. (2/8)" });
  assert.deepEqual(calls[7], { method: "deleteMessage", channelId: "discord-server", messageId: "old-message" });
  assert.equal(calls.length, 8);
});

test("KOOK platform listener renders status, action, chat, and notices", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new KookPlatformListener({
    eventBus,
    config: createConfig(),
    logger: { warn() {} },
    kookBridge: {
      async upsertStatusPanel(channelId, panel, options) {
        calls.push({ method: "upsertStatusPanel", channelId, panel, options });
      },
      async replaceActionMessage(channelId, payload, options) {
        calls.push({ method: "replaceActionMessage", channelId, payload, options });
      },
      async sendMessage(channelId, content) {
        calls.push({ method: "sendMessage", channelId, content });
      }
    }
  });
  listener.start();

  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: [snapshot], archivedServers: [] });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "server-offline", server, currentState: "offline" });
  await eventBus.emit(CoreEvents.GAME_CHAT_RELAY, { server, authorName: "Player", content: "hello" });
  await eventBus.emit(CoreEvents.GROUP_CHAT_RELAY, { server, sourcePlatform: "discord", authorName: "Louis", content: "from discord" });
  await eventBus.emit(CoreEvents.SERVER_NOTICE, {
    kind: "satisfactory-player-count",
    server,
    changedPlayers: 2,
    action: "joined",
    playerCount: 2,
    maxPlayers: 8
  });
  await eventBus.emit(CoreEvents.GROUP_CHAT_RELAY, { server, sourcePlatform: "kook", authorName: "Local", content: "skip" });
  listener.stop();

  assert.equal(calls[0].method, "upsertStatusPanel");
  assert.equal(calls[0].channelId, "kook-status");
  assert.match(calls[0].panel.content, /已归档服务器/);
  assert.deepEqual(calls[0].options, { panelKey: "archive" });
  assert.match(calls[1].panel.content, /服务器时间/);
  assert.deepEqual(calls[1].options, { panelKey: "live" });
  assert.equal(calls[2].method, "replaceActionMessage");
  assert.equal(calls[2].channelId, "kook-server");
  assert.match(calls[2].payload.content, /服务器离线/);
  assert.equal(calls[2].options.preferEdit, true);
  assert.deepEqual(calls[2].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "server-offline",
    state: "offline"
  });
  assert.deepEqual(calls[3], { method: "sendMessage", channelId: "kook-server", content: "**Player**: hello" });
  assert.deepEqual(calls[4], { method: "sendMessage", channelId: "kook-server", content: "[Discord] **Louis**: from discord" });
  assert.deepEqual(calls[5], { method: "sendMessage", channelId: "kook-server", content: "2 名玩家加入 **Factory**。(2/8)" });
  assert.equal(calls.length, 6);
});

test("KOOK action cards identify panel-originated starts", () => {
  const card = buildKookActionMessageForEvent({
    kind: "server-online",
    server,
    startInfo: { source: "pterodactyl-panel" }
  });

  assert.match(card.content, /Pterodactyl 面板/);
});

test("archive-only panel updates do not edit the live Discord status message", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new DiscordPlatformListener({
    eventBus,
    config: createConfig(),
    discordBridge: {
      async upsertStatusPanel(channelId, panel, options) {
        calls.push({ channelId, panel, options });
      }
    }
  });
  listener.start();
  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, {
    snapshots: [],
    archivedServers: [{ name: "Factory Season 1", archiveNote: "World preserved" }],
    livePanelChanged: false,
    archivePanelChanged: true
  });
  listener.stop();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { panelKey: "archive" });
  assert.match(calls[0].panel.embeds[0].toJSON().description, /Factory Season 1.*World preserved/);
});

test("relay queue expiry notices are sent only to the Discord log channel", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new DiscordPlatformListener({
    eventBus,
    config: createConfig(),
    discordBridge: {
      async sendMessage(channelId, content) {
        calls.push({ channelId, content });
      }
    }
  });
  listener.start();
  await eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-queue-expired", server, expiredCount: 3 });
  listener.stop();

  assert.deepEqual(calls, [{
    channelId: "discord-log",
    content: "3 queued relay messages for **Factory** expired after 24 hours."
  }]);
});

test("relay queue overflow notices are sent only to the Discord log channel", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new DiscordPlatformListener({
    eventBus,
    config: createConfig(),
    discordBridge: {
      async sendMessage(channelId, content) {
        calls.push({ channelId, content });
      }
    }
  });
  listener.start();
  await eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-queue-overflow", server, limit: 100 });
  listener.stop();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channelId, "discord-log");
  assert.match(calls[0].content, /Relay queue for \*\*Factory\*\* is full at 100 messages/);
});

test("KOOK routes relay queue notices to its log channel, matching Discord", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new KookPlatformListener({
    eventBus,
    config: createConfig(),
    logger: { warn() {}, error() {}, info() {} },
    kookBridge: {
      async sendMessage(channelId, content) {
        calls.push({ channelId, content });
      }
    }
  });
  listener.start();
  await eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-queue-expired", server, expiredCount: 3 });
  await eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-queue-overflow", server, limit: 100 });
  listener.stop();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.channelId), ["kook-log", "kook-log"]);
  assert.match(calls[0].content, /3 条排队转发消息/);
  assert.match(calls[1].content, /上限 100 条/);
});

test("player-facing notices still go to the server channel on both platforms", async () => {
  const eventBus = new CoreEventBus();
  const discordCalls = [];
  const kookCalls = [];
  const config = createConfig();
  const discord = new DiscordPlatformListener({
    eventBus,
    config,
    discordBridge: { async sendMessage(channelId, content) { discordCalls.push({ channelId, content }); } }
  });
  const kook = new KookPlatformListener({
    eventBus,
    config,
    logger: { warn() {}, error() {}, info() {} },
    kookBridge: { async sendMessage(channelId, content) { kookCalls.push({ channelId, content }); } }
  });
  discord.start();
  kook.start();
  await eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-failed", server, message: "console offline" });
  discord.stop();
  kook.stop();

  assert.deepEqual(discordCalls.map((call) => call.channelId), ["discord-server"]);
  assert.deepEqual(kookCalls.map((call) => call.channelId), ["kook-server"]);
});

function makeSnapshots(count) {
  return Array.from({ length: count }, (_value, index) => ({ ...snapshot, name: `Server ${index + 1}` }));
}

test("Discord warns once when more servers are configured than the panel can show", async () => {
  const eventBus = new CoreEventBus();
  const warnings = [];
  const listener = new DiscordPlatformListener({
    eventBus,
    config: createConfig(),
    logger: { warn(message, meta) { warnings.push({ message, meta }); }, error() {}, info() {} },
    discordBridge: { async upsertStatusPanel() {} }
  });
  listener.start();
  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: makeSnapshots(12) });
  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: makeSnapshots(12) });
  listener.stop();

  assert.equal(warnings.length, 1, "should warn once, not on every refresh");
  assert.equal(warnings[0].meta.shown, 10);
  assert.deepEqual(warnings[0].meta.omitted, ["Server 11", "Server 12"]);
});

test("KOOK warns about its tighter card limit", async () => {
  const eventBus = new CoreEventBus();
  const warnings = [];
  const listener = new KookPlatformListener({
    eventBus,
    config: createConfig(),
    logger: { warn(message, meta) { warnings.push({ message, meta }); }, error() {}, info() {} },
    kookBridge: { async upsertStatusPanel() {} }
  });
  listener.start();
  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: makeSnapshots(6) });
  listener.stop();

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.shown, 4, "KOOK shows fewer servers than Discord");
  assert.deepEqual(warnings[0].meta.omitted, ["Server 5", "Server 6"]);
});

test("neither platform warns while every server fits", async () => {
  const eventBus = new CoreEventBus();
  const warnings = [];
  const logger = { warn(message, meta) { warnings.push({ message, meta }); }, error() {}, info() {} };
  const discord = new DiscordPlatformListener({
    eventBus, config: createConfig(), logger, discordBridge: { async upsertStatusPanel() {} }
  });
  const kook = new KookPlatformListener({
    eventBus, config: createConfig(), logger, kookBridge: { async upsertStatusPanel() {} }
  });
  discord.start();
  kook.start();
  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: makeSnapshots(4) });
  discord.stop();
  kook.stop();

  assert.deepEqual(warnings, []);
});
