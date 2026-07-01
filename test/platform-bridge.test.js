import assert from "node:assert/strict";
import test from "node:test";
import { PlatformBridge } from "../src/services/platform-bridge.js";

function createBridge() {
  const discordCalls = [];
  const kookCalls = [];
  const bridge = new PlatformBridge({
    config: {
      discord: {
        statusChannelId: "discord-status"
      },
      kook: {
        statusChannelId: "kook-status",
        displayTimeZone: "Asia/Shanghai"
      },
      servers: [{
        name: "Factory",
        discordChannelId: "discord-server",
        kookChannelId: "kook-server"
      }]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {},
      async start() {},
      async stop() {},
      async sendMessage(channelId, content) {
        discordCalls.push({ method: "sendMessage", channelId, content });
        return { id: "discord-message" };
      },
      async replaceActionMessage(channelId, payload, options) {
        discordCalls.push({ method: "replaceActionMessage", channelId, payload, options });
        return { id: "discord-action" };
      },
      async deleteMessage(channelId, messageId) {
        discordCalls.push({ method: "deleteMessage", channelId, messageId });
      },
      async upsertStatusPanel(channelId, panel) {
        discordCalls.push({ method: "upsertStatusPanel", channelId, panel });
      }
    },
    kookBridge: {
      async start() {},
      async stop() {},
      async sendMessage(channelId, content) {
        kookCalls.push({ method: "sendMessage", channelId, content });
      },
      async replaceActionMessage(channelId, payload) {
        kookCalls.push({ method: "replaceActionMessage", channelId, payload });
      },
      async upsertStatusPanel(channelId, panel) {
        kookCalls.push({ method: "upsertStatusPanel", channelId, panel });
      }
    },
    logger: {
      warn() {}
    }
  });

  return { bridge, discordCalls, kookCalls };
}

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

test("status panel updates are mirrored to the configured KOOK status channel", async () => {
  const { bridge, discordCalls, kookCalls } = createBridge();

  await bridge.upsertStatusPanel(
    "discord-status",
    { content: "discord status", embeds: [] },
    { snapshots: [snapshot] }
  );

  assert.deepEqual(discordCalls.map((call) => call.method), ["upsertStatusPanel"]);
  assert.equal(kookCalls.length, 1);
  assert.equal(kookCalls[0].method, "upsertStatusPanel");
  assert.equal(kookCalls[0].channelId, "kook-status");
  assert.equal(kookCalls[0].panel.type, 10);
  assert.match(kookCalls[0].panel.content, /服务器时间/);
});

test("server channel messages mirror to KOOK, but unmapped channels do not", async () => {
  const { bridge, kookCalls } = createBridge();

  await bridge.sendMessage("discord-server", "**Player**: hello");
  await bridge.sendMessage("discord-log", "startup log");

  assert.deepEqual(kookCalls, [{
    method: "sendMessage",
    channelId: "kook-server",
    content: "**Player**: hello"
  }]);
});

test("action messages are mirrored as localized KOOK cards without KOOK reactions", async () => {
  const { bridge, kookCalls } = createBridge();

  await bridge.replaceActionMessage("discord-server", {
    embeds: [{
      color: 0xef4444,
      title: "🔴 Server offline: Factory",
      description: "Server is offline.\n\nReact 🟢 to restart the server."
    }]
  }, {
    reactions: ["🟢"]
  });

  assert.equal(kookCalls.length, 1);
  assert.equal(kookCalls[0].method, "replaceActionMessage");
  assert.equal(kookCalls[0].channelId, "kook-server");
  assert.match(kookCalls[0].payload.content, /服务器离线/);
  assert.match(kookCalls[0].payload.content, /Discord 操作/);
});
