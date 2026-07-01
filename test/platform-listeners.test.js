import assert from "node:assert/strict";
import test from "node:test";
import { CoreEventBus, CoreEvents } from "../src/core/core-events.js";
import { DiscordPlatformListener } from "../src/platforms/discord-platform-listener.js";
import { KookPlatformListener } from "../src/platforms/kook-platform-listener.js";
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
      displayTimeZone: "UTC"
    },
    kook: {
      statusChannelId: "kook-status",
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
      async upsertStatusPanel(channelId, panel) {
        calls.push({ method: "upsertStatusPanel", channelId, panel });
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

  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: [snapshot] });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "auto-stop-warning", server, stopAt: new Date() });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "server-offline", server, currentState: "offline" });
  await eventBus.emit(CoreEvents.GAME_CHAT_RELAY, { server, authorName: "Player", content: "hello" });
  await eventBus.emit(CoreEvents.SERVER_NOTICE, {
    kind: "satisfactory-player-count",
    server,
    changedPlayers: 2,
    action: "joined",
    playerCount: 2,
    maxPlayers: 8
  });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE_DELETE, { server, messageId: "old-message" });
  listener.stop();

  assert.equal(calls[0].method, "upsertStatusPanel");
  assert.equal(calls[0].channelId, "discord-status");
  assert.match(calls[0].panel.embeds[0].toJSON().fields[1].value, /Offline/);
  assert.deepEqual(calls[1].options.reactions, [CANCEL_AUTO_STOP_REACTION]);
  assert.equal(calls[1].options.preferEdit, true);
  assert.deepEqual(calls[1].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "auto-stop-warning",
    state: null
  });
  assert.deepEqual(calls[2].options.reactions, [RESTART_SERVER_REACTION]);
  assert.deepEqual(calls[2].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "server-offline",
    state: "offline"
  });
  assert.deepEqual(calls[3], { method: "sendMessage", channelId: "discord-server", content: "**Player**: hello" });
  assert.deepEqual(calls[4], { method: "sendMessage", channelId: "discord-server", content: "2 players joined **Factory**. (2/8)" });
  assert.deepEqual(calls[5], { method: "deleteMessage", channelId: "discord-server", messageId: "old-message" });
});

test("KOOK platform listener renders status, action, chat, and notices", async () => {
  const eventBus = new CoreEventBus();
  const calls = [];
  const listener = new KookPlatformListener({
    eventBus,
    config: createConfig(),
    logger: { warn() {} },
    kookBridge: {
      async upsertStatusPanel(channelId, panel) {
        calls.push({ method: "upsertStatusPanel", channelId, panel });
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

  await eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots: [snapshot] });
  await eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, { kind: "server-offline", server, currentState: "offline" });
  await eventBus.emit(CoreEvents.GAME_CHAT_RELAY, { server, authorName: "Player", content: "hello" });
  await eventBus.emit(CoreEvents.SERVER_NOTICE, {
    kind: "satisfactory-player-count",
    server,
    changedPlayers: 2,
    action: "joined",
    playerCount: 2,
    maxPlayers: 8
  });
  listener.stop();

  assert.equal(calls[0].method, "upsertStatusPanel");
  assert.equal(calls[0].channelId, "kook-status");
  assert.match(calls[0].panel.content, /服务器时间/);
  assert.equal(calls[1].method, "replaceActionMessage");
  assert.equal(calls[1].channelId, "kook-server");
  assert.match(calls[1].payload.content, /服务器离线/);
  assert.equal(calls[1].options.preferEdit, true);
  assert.deepEqual(calls[1].options.meta, {
    serverId: "factory-id",
    serverName: "Factory",
    kind: "server-offline",
    state: "offline"
  });
  assert.deepEqual(calls[2], { method: "sendMessage", channelId: "kook-server", content: "**Player**: hello" });
  assert.deepEqual(calls[3], { method: "sendMessage", channelId: "kook-server", content: "2 名玩家加入 **Factory**。(2/8)" });
});
