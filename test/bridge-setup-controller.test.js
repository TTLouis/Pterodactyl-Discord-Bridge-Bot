import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentConfigStore } from "../src/lib/persistent-config-store.js";
import { ChannelType, MessageFlags, OverwriteType, PermissionFlagsBits, PermissionOverwrites } from "discord.js";
import { BRIDGE_SETUP_COMMAND, BridgeSetupController, canRunBridgeSetup } from "../src/services/bridge-setup-controller.js";
import { DiscordInputController } from "../src/services/discord-input-controller.js";

function fixture({ owner = false, admin = true, storedChannelId = null, storedCategoryId = null, adminRoleId = null, failCategorySave = false, failSave = false, failRead = false } = {}) {
  const calls = [];
  let savedChannelId = storedChannelId;
  let savedCategoryId = storedCategoryId;
  const channel = {
    id: "created-channel",
    type: ChannelType.GuildText,
    parentId: storedCategoryId,
    permissionOverwrites: { async set(overwrites) { calls.push({ method: "privacy", overwrites }); } },
    async setParent(id, options) { calls.push({ method: "move", id, options }); this.parentId = id; },
    async delete() { calls.push({ method: "delete" }); }
  };
  const category = { id: "bridge-category", name: "Pterodactyl Bridge", type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([["guild", { deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]) },
    async delete() { calls.push({ method: "delete-category" }); } };
  const guild = {
    id: "guild",
    ownerId: owner ? "caller" : "owner",
    roles: { async fetch(id) { return { id, managed: false, guild: { id: "guild" } }; } },
    channels: {
      async fetch(id, options) { calls.push({ method: "fetch", id, ...(options ? { options } : {}) }); return id === "bridge-category" ? category : id ? channel : new Map(); },
      async create(options) {
        calls.push({ method: options.type === ChannelType.GuildCategory ? "create-category" : "create", options });
        if (options.type === ChannelType.GuildCategory) return category;
        channel.parentId = options.parent; return channel;
      }
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
    document: { settings: { discord: { bridgeAdminRoleId: adminRoleId } } },
    getCategoryId() { return savedCategoryId; },
    setCategoryId(guildId, id) {
      calls.push({ method: "save-category", guildId, id });
      if (failCategorySave) throw new Error("category write failed");
      savedCategoryId = id;
    },
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
    logger: { error() {}, warn() {} }
  });
  return { controller, interaction, calls, channel, getSavedChannelId: () => savedChannelId };
}

test("setup command allows configured roles to invoke it while runtime checks protect setup", () => {
  assert.equal(BRIDGE_SETUP_COMMAND.name, "bridge");
  assert.equal(BRIDGE_SETUP_COMMAND.default_member_permissions, null);
  assert.equal(BRIDGE_SETUP_COMMAND.options[0].name, "setup");
});

test("non-administrators cannot create the channel", async () => {
  const { controller, interaction, calls } = fixture({ admin: false });
  await controller.handleInteraction(interaction);
  assert.deepEqual(calls, [{
    method: "reply",
    payload: { content: "Only the guild owner, an administrator, or the configured administration role in a claimed guild can set up this bridge.", flags: MessageFlags.Ephemeral }
  }]);
});

test("guild owner can create a private admin channel and persist its ID", async () => {
  const { controller, interaction, calls, getSavedChannelId } = fixture({ owner: true, admin: false });
  await controller.handleInteraction(interaction);

  const creation = calls.find((call) => call.method === "create").options;
  assert.equal(creation.name, "bridge-admin");
  assert.equal(creation.type, ChannelType.GuildText);
  assert.deepEqual(creation.permissionOverwrites[0], { id: "guild", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(creation.permissionOverwrites.map((item) => item.id), ["guild", "bot"]);
  assert.deepEqual(creation.permissionOverwrites.map((item) => item.type), [OverwriteType.Role, OverwriteType.Member]);
  assert.equal(PermissionOverwrites.resolve(creation.permissionOverwrites[1]).type, OverwriteType.Member);
  assert.equal(creation.permissionOverwrites[1].allow.includes(PermissionFlagsBits.ManageChannels), true);
  assert.equal(getSavedChannelId(), "created-channel");
  assert.equal(calls.at(-1).content, "Created bridge administration channel: <#created-channel>");
});

test("administrator setup grants only the bot explicit member access and reuses the saved channel", async () => {
  const { controller, interaction, calls, getSavedChannelId } = fixture();
  await controller.handleInteraction(interaction);
  assert.deepEqual(calls.find((call) => call.method === "create").options.permissionOverwrites.map((item) => item.id), ["guild", "bot"]);
  assert.equal(getSavedChannelId(), "created-channel");
  await controller.handleInteraction(interaction);
  assert.equal(calls.filter((call) => call.method === "create").length, 1);
  assert.equal(calls.filter((call) => call.method === "fetch").length, 4);
  assert.equal(calls.filter((call) => call.method === "create-category").length, 1);
});

test("a saved channel is reused after a controller restart", async () => {
  const { controller, interaction, calls } = fixture({ storedChannelId: "created-channel", storedCategoryId: "bridge-category" });
  await controller.handleInteraction(interaction);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.equal(calls.at(-1).content, "Bridge administration channel: <#created-channel>");
});

test("a missing saved channel is recreated once beneath the saved private category", async () => {
  const f = fixture({ storedChannelId: "deleted-channel", storedCategoryId: "bridge-category" });
  const original = f.interaction.guild.channels.fetch;
  f.interaction.guild.channels.fetch = async (id, options) => {
    if (id === "deleted-channel") { assert.equal(options.force, true); return null; }
    return original(id, options);
  };
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
  assert.equal(f.calls.some((call) => call.method === "create-category"), false);
  assert.equal(f.calls.find((call) => call.method === "create").options.parent, "bridge-category");
  assert.equal(f.getSavedChannelId(), "created-channel");
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
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

test("empty installation claims and persists the first administrator guild before creating setup channel", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-claim-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = { configPath: path.join(directory, "config.json"), secretsPath: path.join(directory, "secrets.json") };
  const store = new PersistentConfigStore(paths); store.load(); store.initialize();
  const f = fixture(); f.controller.guildId = null; f.controller.configStore = store;
  f.controller.discordBridge.claimGuild = async (guildId) => {
    assert.equal(store.getGuildId(), guildId, "persistent claim must precede command registration");
    f.calls.push({ method: "claim", guildId });
  };
  await f.controller.handleInteraction(f.interaction);
  assert.equal(store.getGuildId(), "guild");
  assert.equal(f.calls.filter((call) => call.method === "claim").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
  const restarted = new PersistentConfigStore(paths); assert.equal(restarted.load(), true);
  assert.equal(restarted.getGuildId(), "guild");
  assert.equal(restarted.getAdminChannelId("guild"), "created-channel");
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
  f.interaction.guildId = "other";
  await f.controller.handleInteraction(f.interaction);
  assert.match(f.calls.at(-1).payload.content, /Only the guild owner/);
  assert.equal(store.getGuildId(), "guild");
});

test("unclaimed setup rejects ordinary members without persisting a guild", async () => {
  const f = fixture({ admin: false }); f.controller.guildId = null;
  let claims = 0;
  f.controller.configStore.claimGuild = () => { claims++; };
  await f.controller.handleInteraction(f.interaction);
  assert.equal(claims, 0);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
});

test("setup persists a private category before creating its private administration child", async () => {
  const f = fixture(); await f.controller.handleInteraction(f.interaction);
  const category = f.calls.find((call) => call.method === "create-category").options;
  assert.equal(category.name, "Pterodactyl Bridge"); assert.equal(category.type, ChannelType.GuildCategory);
  assert.deepEqual(category.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  const child = f.calls.find((call) => call.method === "create").options;
  assert.equal(child.parent, "bridge-category");
  assert.ok(f.calls.findIndex((call) => call.method === "save-category") < f.calls.findIndex((call) => call.method === "create"));
  assert.deepEqual(child.permissionOverwrites.map((entry) => entry.id), ["guild", "bot"]);
});

test("category save failure removes the new category and creates no child", async () => {
  const f = fixture({ failCategorySave: true }); await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.equal(f.calls.filter((call) => call.method === "delete-category").length, 1);
  assert.match(f.calls.at(-1).content, /Bridge setup failed/);
});

test("missing saved category fails closed without creating any fallback channel", async () => {
  const f = fixture({ storedCategoryId: "missing-category" });
  const original = f.interaction.guild.channels.fetch;
  f.interaction.guild.channels.fetch = async (id) => id === "missing-category" ? null : original(id);
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create" || call.method === "create-category"), false);
  assert.match(f.calls.at(-1).content, /Bridge setup failed/);
});

test("legacy saved administration channel moves with explicit private permissions and no inherited grants", async () => {
  const f = fixture({ storedChannelId: "created-channel" });
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.equal(f.calls.filter((call) => call.method === "create-category").length, 1);
  assert.deepEqual(f.calls.find((call) => call.method === "move"), { method: "move", id: "bridge-category", options: { lockPermissions: false } });
  assert.deepEqual(f.calls.find((call) => call.method === "privacy").overwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(f.calls.filter((call) => call.method === "move").length, 1);
});

test("failed saved administration move blocks setup callbacks and never creates a replacement channel", async () => {
  const f = fixture({ storedChannelId: "created-channel" });
  let callbacks = 0; f.controller.onSetup = async () => { callbacks++; };
  f.channel.setParent = async () => { throw new Error("missing Manage Channels"); };
  await f.controller.handleInteraction(f.interaction);
  assert.equal(callbacks, 0);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.equal(f.calls.some((call) => call.method === "privacy"), true);
  assert.match(f.calls.at(-1).content, /Bridge setup failed/);
});

test("configured administration role gets view and command access on a claimed installation", async () => {
  const f = fixture({ admin: false, adminRoleId: "admin-role" });
  f.interaction.member = { roles: { cache: new Map([["admin-role", {}]]) } };
  await f.controller.handleInteraction(f.interaction);
  const creation = f.calls.find((call) => call.method === "create").options;
  assert.deepEqual(creation.permissionOverwrites.map((entry) => entry.id), ["guild", "bot", "admin-role"]);
  assert.equal(creation.permissionOverwrites[2].type, OverwriteType.Role);
  assert.equal(creation.permissionOverwrites[2].allow.includes(PermissionFlagsBits.ViewChannel), true);
});

test("role membership alone cannot claim an unclaimed installation", async () => {
  const f = fixture({ admin: false, adminRoleId: "admin-role" });
  f.controller.guildId = null; f.interaction.member = { roles: ["admin-role"] };
  let claims = 0; f.controller.configStore.claimGuild = () => { claims++; };
  await f.controller.handleInteraction(f.interaction);
  assert.equal(claims, 0);
  assert.equal(f.calls.some((call) => call.method === "create" || call.method === "create-category"), false);
});

test("role authorization handles cached and API member roles and denies ordinary members", () => {
  const f = fixture({ admin: false });
  f.interaction.member = { roles: ["admin-role"] };
  assert.equal(canRunBridgeSetup(f.interaction, "admin-role"), true);
  assert.equal(canRunBridgeSetup(f.interaction), false);
  f.interaction.member = { roles: { cache: new Map([["admin-role", {}]]) } };
  assert.equal(canRunBridgeSetup(f.interaction, "admin-role"), true);
  assert.equal(canRunBridgeSetup(f.interaction, "other-role"), false);
});

test("every setup repairs saved admin channel permissions without inheriting category access", async () => {
  const f = fixture({ storedChannelId: "created-channel", storedCategoryId: "bridge-category", adminRoleId: "admin-role" });
  await f.controller.handleInteraction(f.interaction);
  await f.controller.handleInteraction(f.interaction);
  const repairs = f.calls.filter((call) => call.method === "privacy");
  assert.equal(repairs.length, 2);
  for (const repair of repairs) assert.deepEqual(repair.overwrites.map((entry) => entry.id), ["guild", "bot", "admin-role"]);
  assert.equal(f.calls.some((call) => call.method === "move"), false);
});

test("invalid administration role fails before any category/channel permission or creation writes", async () => {
  for (const role of [null, { id: "admin-role", managed: true }, { id: "admin-role", guild: { id: "other" } }]) {
    const f = fixture({ adminRoleId: "admin-role", storedChannelId: "created-channel" });
    f.interaction.guild.roles.fetch = async () => role;
    await f.controller.handleInteraction(f.interaction);
    assert.equal(f.calls.some((call) => ["privacy", "create", "create-category", "move", "save-category"].includes(call.method)), false);
    assert.match(f.calls.at(-1).content, /Bridge setup failed/);
  }
});

test("everyone role cannot grant ordinary members administration access", () => {
  const f = fixture({ admin: false }); f.interaction.member = { roles: { cache: new Map([["guild", {}]]) } };
  assert.equal(canRunBridgeSetup(f.interaction, "guild"), false);
});

test("Discord Unknown Channel permits recreation while permission and transport errors fail closed", async () => {
  for (const code of [10003, 50001, 50013, "ECONNRESET"]) {
    const f = fixture({ storedChannelId: "deleted-channel", storedCategoryId: "bridge-category" });
    const original = f.interaction.guild.channels.fetch;
    f.interaction.guild.channels.fetch = async (id, options) => {
      if (id === "deleted-channel") { assert.equal(options.force, true); throw Object.assign(new Error("fetch failed"), { code }); }
      return original(id, options);
    };
    await f.controller.handleInteraction(f.interaction);
    assert.equal(f.calls.filter((call) => call.method === "create").length, code === 10003 ? 1 : 0);
    assert.equal(f.getSavedChannelId(), code === 10003 ? "created-channel" : "deleted-channel");
    if (code !== 10003) assert.match(f.calls.at(-1).content, /Bridge setup failed/);
  }
});

test("saved admin binding with wrong channel type never creates a duplicate", async () => {
  const f = fixture({ storedChannelId: "created-channel", storedCategoryId: "bridge-category" });
  f.channel.type = ChannelType.GuildVoice;
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create" || call.method === "create-category"), false);
  assert.match(f.calls.at(-1).content, /unexpected type/);
});

test("a healthy saved administration channel always bypasses the Discord cache", async () => {
  const f = fixture({ storedChannelId: "created-channel", storedCategoryId: "bridge-category" });
  await f.controller.handleInteraction(f.interaction);
  assert.deepEqual(f.calls.find((call) => call.method === "fetch" && call.id === "created-channel").options, { force: true });
  assert.equal(f.calls.some((call) => call.method === "create"), false);
});

test("a missing saved admin binding retains the orphan guard and private category prerequisite", async () => {
  const f = fixture({ storedChannelId: "deleted-channel", storedCategoryId: "bridge-category" });
  f.interaction.guild.channels.fetch = async (id) => id ? null : new Map([["orphan", {
    id: "orphan", type: ChannelType.GuildText, topic: "Private administration for the Pterodactyl bridge"
  }]]);
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.equal(f.getSavedChannelId(), "deleted-channel");
  assert.match(f.calls.at(-1).content, /unsaved bridge administration channel/);
});

test("failed replacement persistence deletes only the replacement and retains the saved missing binding", async () => {
  const f = fixture({ storedChannelId: "deleted-channel", storedCategoryId: "bridge-category", failSave: true });
  const original = f.interaction.guild.channels.fetch;
  f.interaction.guild.channels.fetch = async (id, options) => id === "deleted-channel" ? null : original(id, options);
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "delete").length, 1);
  assert.equal(f.calls.some((call) => call.method === "delete-category"), false);
  assert.equal(f.getSavedChannelId(), "deleted-channel");
});

test("deleted saved administration channel cannot recover into a missing private category", async () => {
  const f = fixture({ storedChannelId: "deleted-channel", storedCategoryId: "bridge-category" });
  const original = f.interaction.guild.channels.fetch;
  f.interaction.guild.channels.fetch = async (id, options) => ["deleted-channel", "bridge-category"].includes(id) ? null : original(id, options);
  await f.controller.handleInteraction(f.interaction);
  assert.equal(f.calls.some((call) => call.method === "create" || call.method === "create-category"), false);
  assert.equal(f.getSavedChannelId(), "deleted-channel");
  assert.match(f.calls.at(-1).content, /Bridge setup failed/);
});
