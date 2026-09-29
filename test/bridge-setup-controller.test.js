import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { BRIDGE_SETUP_COMMAND, BridgeSetupController } from "../src/services/bridge-setup-controller.js";
import { DiscordInputController } from "../src/services/discord-input-controller.js";

function fixture({ owner = false, admin = true, storedChannelId = null, failSave = false, failRead = false } = {}) {
  const calls = [];
  let savedChannelId = storedChannelId;
  const channel = {
    id: "created-channel",
    type: ChannelType.GuildText,
    async delete() { calls.push({ method: "delete" }); }
  };
  const guild = {
    id: "guild",
    ownerId: owner ? "caller" : "owner",
    channels: {
      async fetch(id) { calls.push({ method: "fetch", id }); return id ? channel : new Map(); },
      async create(options) { calls.push({ method: "create", options }); return channel; }
    }
  };
  const interaction = {
    commandName: "bridge",
    options: { getSubcommand: () => "setup" },
    guildId: "guild",
    guild,
    user: { id: "caller" },
    client: { user: { id: "bot" } },
    memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
    deferred: false,
    replied: false,
    async deferReply(payload) { calls.push({ method: "deferReply", payload }); this.deferred = true; },
    async editReply(content) { calls.push({ method: "editReply", content }); },
    async reply(payload) { calls.push({ method: "reply", payload }); this.replied = true; }
  };
  const configStore = {
    getAdminChannelId() {
      if (failRead) throw new Error("unavailable");
      return savedChannelId;
    },
    setAdminChannelId(guildId, id) {
      calls.push({ method: "save", guildId, id });
      if (failSave) throw new Error("write failed");
      savedChannelId = id;
    }
  };
  const controller = new BridgeSetupController({
    discordBridge: { onInteraction() {} },
    configStore,
    guildId: "guild",
    logger: { error() {} }
  });
  return { controller, interaction, calls, channel, getSavedChannelId: () => savedChannelId };
}

test("setup command is administrator-only by default and includes setup subcommand", () => {
  assert.equal(BRIDGE_SETUP_COMMAND.name, "bridge");
  assert.equal(BRIDGE_SETUP_COMMAND.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.equal(BRIDGE_SETUP_COMMAND.options[0].name, "setup");
});

test("non-administrators cannot create the channel", async () => {
  const { controller, interaction, calls } = fixture({ admin: false });
  await controller.handleInteraction(interaction);
  assert.deepEqual(calls, [{
    method: "reply",
    payload: { content: "Only the guild owner or an administrator can set up this bridge.", flags: MessageFlags.Ephemeral }
  }]);
});

test("guild owner can create a private admin channel and persist its ID", async () => {
  const { controller, interaction, calls, getSavedChannelId } = fixture({ owner: true, admin: false });
  await controller.handleInteraction(interaction);

  const creation = calls.find((call) => call.method === "create").options;
  assert.equal(creation.name, "bridge-admin");
  assert.equal(creation.type, ChannelType.GuildText);
  assert.deepEqual(creation.permissionOverwrites[0], { id: "guild", deny: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(creation.permissionOverwrites.map((item) => item.id), ["guild", "bot", "caller"]);
  assert.equal(creation.permissionOverwrites[1].allow.includes(PermissionFlagsBits.ManageChannels), true);
  assert.equal(getSavedChannelId(), "created-channel");
  assert.equal(calls.at(-1).content, "Created bridge administration channel: <#created-channel>");
});

test("administrator setup grants access to the owner and reuses the saved channel", async () => {
  const { controller, interaction, calls, getSavedChannelId } = fixture();
  await controller.handleInteraction(interaction);
  assert.deepEqual(calls.find((call) => call.method === "create").options.permissionOverwrites.map((item) => item.id), ["guild", "bot", "caller", "owner"]);
  assert.equal(getSavedChannelId(), "created-channel");
  await controller.handleInteraction(interaction);
  assert.equal(calls.filter((call) => call.method === "create").length, 1);
  assert.equal(calls.filter((call) => call.method === "fetch").length, 2);
});

test("a saved channel is reused after a controller restart", async () => {
  const { controller, interaction, calls } = fixture({ storedChannelId: "created-channel" });
  await controller.handleInteraction(interaction);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.equal(calls.at(-1).content, "Bridge administration channel: <#created-channel>");
});

test("a missing saved channel does not trigger a duplicate creation", async () => {
  const { controller, interaction, calls } = fixture({ storedChannelId: "deleted-channel" });
  interaction.guild.channels.fetch = async () => null;
  await controller.handleInteraction(interaction);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.match(calls.at(-1).content, /saved bridge administration channel is unavailable/);
});

test("an unsaved bot-managed channel prevents duplicate creation", async () => {
  const { controller, interaction, calls } = fixture();
  interaction.guild.channels.fetch = async () => new Map([["orphan", {
    type: ChannelType.GuildText,
    topic: "Private administration for the Pterodactyl bridge"
  }]]);
  await controller.handleInteraction(interaction);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.match(calls.at(-1).content, /unsaved bridge administration channel/);
});

test("unavailable store blocks creation and save failure removes the new channel", async () => {
  const unavailable = fixture({ failRead: true });
  await unavailable.controller.handleInteraction(unavailable.interaction);
  assert.equal(unavailable.calls.some((call) => call.method === "create"), false);
  assert.match(unavailable.calls.at(-1).content, /Bridge setup failed/);

  const failedSave = fixture({ failSave: true });
  await failedSave.controller.handleInteraction(failedSave.interaction);
  assert.deepEqual(failedSave.calls.filter((call) => call.method === "delete"), [{ method: "delete" }]);
  assert.match(failedSave.calls.at(-1).content, /Bridge setup failed/);
});

test("ordinary command handler ignores bridge setup", async () => {
  let handler = null;
  const controller = new DiscordInputController({
    config: { discord: {}, servers: [] },
    discordBridge: {
      setSlashCommands() {},
      onInteraction(callback) { handler = callback; },
      onReaction() {}
    },
    autoStopService: {},
    syncService: {},
    logger: { error() {} }
  });
  controller.start();
  const interaction = { commandName: "bridge", async reply() { throw new Error("should not reply"); } };
  await handler(interaction);
});
