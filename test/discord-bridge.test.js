import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { DiscordBridge } from "../src/services/discord-bridge.js";

function createBridge({ actionMessage = null } = {}) {
  const calls = [];
  const state = { actionMessage };
  const message = {
    id: actionMessage?.messageId ?? "old-action",
    reactions: {
      async removeAll() {
        calls.push({ method: "removeAll" });
      }
    },
    async react(reaction) {
      calls.push({ method: "react", reaction });
    }
  };
  const channel = {
    type: ChannelType.GuildText,
    messages: {
      async edit(messageId, payload) {
        calls.push({ method: "edit", messageId, payload });
        return { ...message, id: messageId };
      },
      async delete(messageId) {
        calls.push({ method: "delete", messageId });
      }
    },
    async send(payload) {
      calls.push({ method: "send", payload });
      return { ...message, id: "new-action" };
    }
  };
  const bridge = new DiscordBridge({
    token: "token",
    guildId: "guild",
    stateStore: {
      getActionMessage() {
        return state.actionMessage;
      },
      setActionMessage(channelId, entry) {
        state.actionMessage = entry;
        calls.push({ method: "setActionMessage", channelId, entry });
      }
    },
    logger: { info() {}, warn() {}, error() {} }
  });

  bridge.client = {
    channels: {
      async fetch(channelId) {
        calls.push({ method: "fetchChannel", channelId });
        return channel;
      }
    }
  };

  return { bridge, calls, state };
}

test("Discord action message edits safe adjacent server transitions", async () => {
  const { bridge, calls, state } = createBridge({
    actionMessage: {
      messageId: "old-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-starting-state",
      state: "starting"
    }
  });

  await bridge.replaceActionMessage(
    "discord-server",
    { embeds: ["online"] },
    {
      reactions: [],
      preferEdit: true,
      meta: {
        serverId: "factory-id",
        serverName: "Factory",
        kind: "server-online",
        state: "running"
      }
    }
  );

  assert.deepEqual(calls.map((call) => call.method), ["fetchChannel", "edit", "removeAll", "setActionMessage"]);
  assert.equal(calls[1].messageId, "old-action");
  assert.equal(state.actionMessage.messageId, "old-action");
  assert.equal(state.actionMessage.kind, "server-online");
});

test("Discord action message sends new messages for unrelated transitions", async () => {
  const { bridge, calls, state } = createBridge({
    actionMessage: {
      messageId: "old-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-online",
      state: "running"
    }
  });

  await bridge.replaceActionMessage(
    "discord-server",
    { embeds: ["offline"] },
    {
      reactions: ["restart"],
      preferEdit: true,
      meta: {
        serverId: "factory-id",
        serverName: "Factory",
        kind: "server-offline",
        state: "offline"
      }
    }
  );

  assert.deepEqual(calls.map((call) => call.method), [
    "fetchChannel",
    "delete",
    "send",
    "setActionMessage",
    "react"
  ]);
  assert.equal(state.actionMessage.messageId, "new-action");
  assert.equal(state.actionMessage.kind, "server-offline");
});

test("Discord action message edits very recent online messages into stopped messages", async () => {
  const { bridge, calls, state } = createBridge({
    actionMessage: {
      messageId: "old-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-online",
      state: "running",
      updatedAt: Date.now() - 1000
    }
  });

  await bridge.replaceActionMessage(
    "discord-server",
    { embeds: ["stopped"] },
    {
      reactions: ["restart"],
      preferEdit: true,
      meta: {
        serverId: "factory-id",
        serverName: "Factory",
        kind: "manual-stopped",
        state: "offline"
      }
    }
  );

  assert.deepEqual(calls.map((call) => call.method), ["fetchChannel", "edit", "removeAll", "react", "setActionMessage"]);
  assert.equal(state.actionMessage.messageId, "old-action");
  assert.equal(state.actionMessage.kind, "manual-stopped");
});

test("Discord action message keeps old online messages historical", async () => {
  const { bridge, calls, state } = createBridge({
    actionMessage: {
      messageId: "old-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-online",
      state: "running",
      updatedAt: Date.now() - 10 * 60 * 1000
    }
  });

  await bridge.replaceActionMessage(
    "discord-server",
    { embeds: ["stopped"] },
    {
      reactions: ["restart"],
      preferEdit: true,
      meta: {
        serverId: "factory-id",
        serverName: "Factory",
        kind: "manual-stopped",
        state: "offline"
      }
    }
  );

  assert.deepEqual(calls.map((call) => call.method), [
    "fetchChannel",
    "delete",
    "send",
    "setActionMessage",
    "react"
  ]);
  assert.equal(state.actionMessage.messageId, "new-action");
  assert.equal(state.actionMessage.kind, "manual-stopped");
});
