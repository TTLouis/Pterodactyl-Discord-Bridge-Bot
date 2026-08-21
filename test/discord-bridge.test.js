import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType } from "discord.js";
import { DiscordBridge } from "../src/services/discord-bridge.js";

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createBridge({ actionMessage = null, beforeSend = null } = {}) {
  const calls = [];
  const state = { actionMessage };
  let nextMessageNumber = 1;
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
    isTextBased() { return true; },
    isDMBased() { return false; },
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
      if (beforeSend) {
        await beforeSend();
      }
      return { ...message, id: `new-action-${nextMessageNumber++}` };
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

test("Discord inbound messages include the highest colored role", async () => {
  const bridge = new DiscordBridge({
    token: "token",
    guildId: "guild",
    stateStore: {},
    logger: { info() {}, warn() {}, error() {} }
  });
  const client = new EventEmitter();
  client.login = async () => {};
  client.destroy = async () => {};
  bridge.client = client;

  const messages = [];
  bridge.onMessage((message) => messages.push(message));
  await bridge.start();
  client.emit("messageCreate", {
    author: { bot: false, username: "louis" },
    guild: { id: "guild" },
    member: {
      displayName: "Louis",
      roles: { highest: { color: 0x12ab34, hexColor: "#12ab34" } }
    },
    channelId: "channel",
    content: "hello"
  });

  assert.deepEqual(messages, [{
    authorName: "Louis",
    authorColor: "#12ab34",
    channelId: "channel",
    content: "hello"
  }]);
  await bridge.stop();
});

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
  assert.equal(state.actionMessage.messageId, "new-action-1");
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
  assert.equal(state.actionMessage.messageId, "new-action-1");
  assert.equal(state.actionMessage.kind, "manual-stopped");
});

test("Discord action message serializes duplicate stopped replacements for one channel", async () => {
  const sendGate = createDeferred();
  let sendCount = 0;
  const { bridge, calls, state } = createBridge({
    actionMessage: {
      messageId: "old-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-online",
      state: "running"
    },
    beforeSend: async () => {
      sendCount += 1;
      if (sendCount === 1) {
        await sendGate.promise;
      }
    }
  });
  const options = {
    reactions: ["restart"],
    preferEdit: true,
    meta: {
      serverId: "factory-id",
      serverName: "Factory",
      kind: "manual-stopped",
      state: "offline"
    }
  };

  const first = bridge.replaceActionMessage("discord-server", { embeds: ["stopped"] }, options);
  const second = bridge.replaceActionMessage("discord-server", { embeds: ["stopped"] }, options);
  await Promise.resolve();
  sendGate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(calls.map((call) => call.method), [
    "fetchChannel",
    "delete",
    "send",
    "setActionMessage",
    "react",
    "fetchChannel",
    "edit",
    "removeAll",
    "react",
    "setActionMessage"
  ]);
  assert.equal(state.actionMessage.messageId, "new-action-1");
  assert.equal(state.actionMessage.kind, "manual-stopped");
});

test("reactions outside configured server channels are ignored without API calls", async () => {
  const memberFetches = [];
  const bridge = new DiscordBridge({
    token: "token",
    guildId: "guild",
    stateStore: {},
    logger: { info() {}, warn() {}, error() {} },
    isWatchedChannel: (channelId) => channelId === "factory-channel"
  });
  const client = new EventEmitter();
  client.login = async () => {};
  client.destroy = async () => {};
  bridge.client = client;

  const reactions = [];
  bridge.onReaction((payload) => reactions.push(payload));
  await bridge.start();

  const makeReaction = (channelId) => ({
    partial: false,
    emoji: { name: "🟢" },
    message: {
      id: "message-1",
      channelId,
      guild: {
        id: "guild",
        members: {
          async fetch(userId) {
            memberFetches.push({ channelId, userId });
            return { displayName: "Louis" };
          }
        }
      }
    },
    users: { async remove() {} }
  });
  const user = { partial: false, bot: false, id: "user-1", username: "louis" };

  client.emit("messageReactionAdd", makeReaction("some-other-channel"), user);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reactions, [], "unwatched channel should not reach handlers");
  assert.deepEqual(memberFetches, [], "unwatched channel should not cost a member fetch");

  client.emit("messageReactionAdd", makeReaction("factory-channel"), user);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].channelId, "factory-channel");
  assert.deepEqual(memberFetches, [{ channelId: "factory-channel", userId: "user-1" }]);

  await bridge.stop();
});
