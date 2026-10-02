import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";
import { PersistentConfigStore } from "../src/lib/persistent-config-store.js";
import { loadConfig, normalizeServer } from "../src/lib/config.js";
import { GuidedAdminController, buildServerSetupCard } from "../src/services/guided-admin-controller.js";
import { isServerRelayEnabled } from "../src/lib/server-lifecycle.js";
import { CoreEvents } from "../src/core/core-events.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-guided-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = { configPath: path.join(directory, "config.json"), secretsPath: path.join(directory, "secrets.json") };
  const store = new PersistentConfigStore(paths); store.load(); store.initialize(); store.claimGuild("guild");
  store.setAdminChannelId("guild", "admin"); store.setConnectionKey("private-panel-key", "https://panel.example");
  store.updateSettings({ discord: { statusChannelId: "status" } });
  const config = loadConfig({ requireRuntimeTokens: false, rawConfig: store.getRuntimeConfig(), managed: true }).config;
  const messages = new Map(), calls = [], replies = [], channels = new Map();
  let sequence = 0;
  function channel(id) {
    const result = { id, type: ChannelType.GuildText, parentId: "unrelated-category", permissionsFor: () => ({ has: () => true }),
      permissionOverwrites: { cache: new Map(), async edit(_role, options) { calls.push(["permissions", id, options]); } },
      messages: { async delete(messageId) { messages.delete(messageId); calls.push(["delete-message", messageId]); }, async edit(messageId, payload) {
        if (!messages.has(messageId)) throw Object.assign(new Error("Unknown message"), { code: 10008 });
        messages.set(messageId, payload); calls.push(["edit", messageId]);
      } },
      async send(payload) { const messageId = `message-${++sequence}`; messages.set(messageId, payload); calls.push(["send", messageId]); return { id: messageId }; },
      async edit(options) { this.parentId = options.parent; this.permissionOverwrites.cache = new Map(options.permissionOverwrites.map(o => [o.id, o])); calls.push(["channel-edit", id]); },
      async delete() { calls.push(["delete", id]); channels.delete(id); }
    };
    channels.set(id, result); return result;
  }
  channel("admin"); channel("status"); channel("retained"); channel("existing");
  channels.set("category", { id: "category", type: ChannelType.GuildCategory, permissionOverwrites: { cache: new Map([["guild", { deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]) } });
  store.setCategoryId("guild", "category");
  const guild = { id: "guild", ownerId: "owner", roles: { everyone: { id: "guild" } }, members: { me: { permissions: { has: () => true } } },
    channels: { async fetch(id) { return channels.get(id) ?? null; }, async create(options) { calls.push(["create", options]); return channel(`created-${++sequence}`); } } };
  let accessible = [{ identifier: "server", uuid: "server-uuid", name: "My server" }];
  const client = { apiKey: "private-panel-key", websocketCredentialCache: new Map(),
    async listAccessibleServers() { calls.push(["discovery"]); if (accessible instanceof Error) throw accessible; return accessible; },
    async getServerResources(id) {
      calls.push(["resources", id]);
      if (accessible instanceof Error || !accessible.some(s => [s.identifier, s.uuid, s.legacyIdentifier].includes(id))) throw new Error("Access denied");
      return { currentState: "offline" };
    },
    async getServerDefaultAllocation() { return { ip: "127.0.0.1", port: 25565 }; } };
  const syncService = { onConfigReloaded() { calls.push(["runtime"]); }, async syncOnce() { calls.push(["poll"]); } };
  async function reconcile() {
    const next = loadConfig({ requireRuntimeTokens: false, rawConfig: store.getRuntimeConfig(), managed: true }).config;
    Object.assign(config, next); calls.push(["reconcile"]);
  }
  const options = { configStore: store, config, pterodactylClient: client, syncService, guildId: "guild", reconcile,
    discordBridge: { onInteraction() {}, client: { guilds: { cache: new Map([["guild", guild]]) } } }, logger: { info() {}, error(message) { calls.push(["error", message]); } } };
  const controller = new GuidedAdminController(options);
  class Interaction {
    #modalKind;
    constructor(customId, { admin = true, userId = "caller", guildId = "guild", channelId = "admin", modal = false, values = [], roles = [] } = {}) {
      Object.assign(this, { customId, guildId, channelId, guild, user: { id: userId }, client: { user: { id: "bot" } }, values,
        member: { roles }, memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.Administrator }, deferred: false, replied: false });
      this.#modalKind = modal;
    }
    isChatInputCommand() { return false; } isButton() { return !this.#modalKind; }
    isModalSubmit() { return this.#modalKind; } isAutocomplete() { return false; }
    async deferReply(payload) { if (this.deferred || this.replied) throw new Error("Duplicate interaction acknowledgment"); this.deferred = true; replies.push(payload); }
    async reply(payload) { this.replied = true; replies.push(payload); }
    async editReply(payload) { replies.push(payload); }
    async showModal(payload) { replies.push({ modal: payload }); }
  }
  const interaction = (action, settings) => new Interaction(action, settings);
  function add(changes = {}) {
    store.addManagedServer({ name: "My server", pterodactylServerId: "server", pterodactylUuid: "server-uuid",
      active: false, published: false, archived: false, discordChannelId: null, game: { type: "minecraft" }, ...changes });
    config.servers = store.getManagedServers().map(normalizeServer);
  }
  return { controller, options, config, store, paths, guild, calls, replies, messages, channels, interaction, add, reconcile,
    setAccessible(value) { accessible = value; } };
}

async function archiveServer(f, { stop = false } = {}) {
  const alreadyArchived = f.store.getManagedServers()[0].archived;
  await f.controller.handleInteraction(f.interaction("bridge:card:server:archive"));
  if (!alreadyArchived) {
    const choices = f.replies.at(-1).components[0].components;
    const choice = choices.find(c => c.data.custom_id.includes(stop ? "archive-confirm-stop-" : "archive-confirm-keep-"));
    await f.controller.handleInteraction(f.interaction(choice.data.custom_id));
  }
}

test("guided controls reject other guilds, ordinary members, and unsaved channels", async (t) => {
  const f = fixture(t); f.add();
  for (const settings of [{ guildId: "other" }, { admin: false }, { channelId: "elsewhere" }]) {
    await f.controller.handleInteraction(f.interaction("bridge:card:server:disable", settings));
    assert.match(f.replies.at(-1).content, /guild owner or an administrator/);
    assert.equal(f.replies.at(-1).flags, MessageFlags.Ephemeral);
  }
  assert.deepEqual(f.store.document.audit, []);
  assert.equal(f.calls.some(([method]) => method === "reconcile"), false);
});

test("guided import delegates through Proxy without breaking class-bound Discord methods", async (t) => {
  const f = fixture(t);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:import", { values: ["minecraft"] }));
  assert.equal(f.store.getManagedServers().length, 1);
  assert.equal(f.store.getManagedServers()[0].active, false);
  assert.match(f.replies.find((reply) => reply.content)?.content, /Saved My server/);
  assert.equal(f.store.document.audit.at(-1).action, "server.import-request");
});

test("saved cards update after restart and only missing messages are recreated", async (t) => {
  const f = fixture(t); f.add();
  await f.controller.refreshCards(f.guild);
  const firstId = f.store.getCardMessageId("server");
  const restartedStore = new PersistentConfigStore(f.paths); assert.equal(restartedStore.load(), true);
  const restarted = new GuidedAdminController({ ...f.options, configStore: restartedStore });
  await restarted.refreshCards(f.guild);
  assert.equal(f.calls.filter(([method]) => method === "send").length, 2);
  assert.equal(restartedStore.getCardMessageId("server"), firstId);
  f.messages.delete(firstId);
  await restarted.refreshCards(f.guild);
  assert.notEqual(restartedStore.getCardMessageId("server"), firstId);
  assert.equal(f.calls.filter(([method]) => method === "send").length, 3);
});

test("lost access pauses monitoring, retains publication, and returning discovery requires reactivation", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "retained" });
  f.setAccessible([]);
  await f.controller.refreshCards(f.guild, { checkAvailability: true });
  let saved = f.store.getManagedServers()[0];
  assert.equal(saved.active, false); assert.equal(saved.unavailable, true); assert.equal(saved.published, true);
  assert.equal(saved.discordChannelId, "retained"); assert.equal(saved.deleted, undefined);
  f.setAccessible([{ identifier: "server", uuid: "server-uuid", name: "Returned" }]);
  await f.controller.refreshCards(f.guild, { checkAvailability: true });
  saved = f.store.getManagedServers()[0];
  assert.equal(saved.active, false); assert.equal(saved.unavailable, true);
  assert.match(JSON.stringify(f.messages.get(f.store.getCardMessageId("server")).embeds), /reactivation required/);
});

test("reactivation reuses the retained channel after an explicit visibility confirmation", async (t) => {
  const f = fixture(t); f.add({ unavailable: true, discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:activate"));
  const prompt = f.replies.find((reply) => reply.content?.includes("Existing channel permissions stay unchanged"));
  assert.ok(prompt, "retained own channel must be eligible for reactivation");
  assert.equal(f.store.getManagedServers()[0].active, false);
  const customId = prompt.components[0].components[0].data.custom_id;
  await f.controller.handleInteraction(f.interaction(customId));
  const server = f.store.getManagedServers()[0];
  assert.equal(server.active, true); assert.equal(server.unavailable, false);
  assert.equal(server.discordChannelId, "retained");
  assert.equal(f.calls.some(([method]) => method === "create" || method === "permissions"), false);
});

test("settings keep Satisfactory credentials private and relay disabling uses separate control", async (t) => {
  const f = fixture(t); f.add({ game: { type: "satisfactory", apiToken: "private-game-token" } });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["off"] }));
  const modal = f.interaction("bridge:card:server:save-settings", { modal: true });
  const values = { name: "Renamed", description: "Hello\nworld", relay: "", idle: "", warning: "60" };
  modal.fields = { getTextInputValue: (id) => values[id] };
  await f.controller.handleInteraction(modal);
  assert.equal(f.store.getManagedServers()[0].game.apiToken, "private-game-token");
  assert.equal(fs.readFileSync(f.paths.configPath, "utf8").includes("private-game-token"), false);
  assert.equal(isServerRelayEnabled({ ...f.config.servers[0], active: true, discordChannelId: "retained" }), false);
  await f.controller.handleInteraction(f.interaction("bridge:guide:export"));
  const exported = f.replies.at(-1).files[0].attachment.toString();
  assert.equal(exported.includes("private-game-token"), false); assert.equal(exported.includes("private-panel-key"), false);
});

test("marking deleted requires unavailability and confirmation and retains channel/settings", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:confirm-deleted"));
  assert.equal(f.store.getManagedServers()[0].deleted, undefined);
  f.store.updateManagedServer("server", { active: false, unavailable: true });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:deleted"));
  assert.equal(f.store.getManagedServers()[0].deleted, undefined);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:confirm-deleted"));
  assert.equal(f.store.getManagedServers()[0].deleted, true);
  assert.equal(f.store.getManagedServers()[0].discordChannelId, "retained");
  assert.equal(f.calls.some(([method]) => method === "delete"), false);
});

test("card text does not mention users from an untrusted server name", () => {
  const card = buildServerSetupCard({ identifier: "server", name: "@everyone <@123>" }, null);
  assert.deepEqual(card.allowedMentions, { parse: [] });
  assert.equal(card.content.includes("@everyone"), false);
  assert.equal(card.embeds[0].title.includes("@everyone"), false);
  assert.ok(card.components[0].components[0].data.custom_id);
});

test("activation confirmation rechecks panel access when discovery changes after the prompt", async (t) => {
  const f = fixture(t); f.add();
  await f.controller.handleInteraction(f.interaction("bridge:card:server:bind-selected", { values: ["existing"] }));
  const prompt = f.replies.find((reply) => reply.content?.includes("Existing channel permissions stay unchanged"));
  assert.ok(prompt);
  f.setAccessible([]);
  await f.controller.handleInteraction(f.interaction(prompt.components[0].components[0].data.custom_id));
  assert.equal(f.store.getManagedServers()[0].active, false, "stale confirmation must not resume a server the current key cannot access");
  assert.equal(f.calls.some(([method]) => method === "poll"), false);
});

test("migration requires explicit confirmation and reports conflicts without altering settings", async (t) => {
  const f = fixture(t);
  const previousPath = process.env.CONFIG_PATH;
  const legacyPath = path.join(path.dirname(f.paths.configPath), "legacy.json");
  fs.writeFileSync(legacyPath, JSON.stringify({ discord: { guildId: "other", statusChannelId: "status" },
    pterodactyl: { baseUrl: "https://panel.example", apiKey: "other-private-key" }, servers: [{ name: "Legacy", pterodactylServerId: "legacy", discordChannelId: "legacy-channel", game: { type: "minecraft" } }] }));
  process.env.CONFIG_PATH = legacyPath;
  t.after(() => { if (previousPath === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = previousPath; });
  const command = f.interaction(null);
  command.commandName = "bridge"; command.isChatInputCommand = () => true;
  command.options = { getSubcommand: () => "migrate", getBoolean: () => false };
  await f.controller.handleInteraction(command);
  assert.match(f.replies.at(-1).content, /confirm:true/);
  command.deferred = false; command.replied = false;
  command.options.getBoolean = () => true;
  await f.controller.handleInteraction(command);
  assert.match(f.replies.at(-1).content, /conflicts.*guild/);
  assert.equal(f.store.getGuildId(), "guild");
  assert.equal(f.store.getConnectionKey(), "private-panel-key");
  assert.equal(f.replies.some((reply) => JSON.stringify(reply).includes("other-private-key")), false);
});

test("guild owner can use persistent cards without an administrator permission bit", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:disable", { admin: false, userId: "owner" }));
  assert.equal(f.store.getManagedServers()[0].active, false);
  assert.equal(f.store.document.audit.at(-1).actorId, "owner");
});

test("binding a formerly bot-managed record to a different channel never transfers permission ownership", async (t) => {
  const f = fixture(t); f.add({ channelManaged: true, discordChannelId: "retained" });
  f.channels.set("public-category", { id: "public-category", type: ChannelType.GuildCategory });
  f.guild.roles.fetch = async (id) => ({ id, managed: false });
  f.store.configureCategories("guild", { privateCategoryId: "category", publicCategoryId: "public-category", linkedChannelRoleId: "linked-role" });
  await f.reconcile();
  await f.controller.handleInteraction(f.interaction("bridge:card:server:bind-selected", { values: ["existing"] }));
  const prompt = f.replies.find((reply) => reply.content?.includes("Existing channel permissions stay unchanged")); assert.ok(prompt);
  await f.controller.handleInteraction(f.interaction(prompt.components[0].components[0].data.custom_id));
  assert.equal(f.store.getManagedServers()[0].active, true);
  assert.equal(f.store.getManagedServers()[0].discordChannelId, "existing");
  assert.equal(f.store.getManagedServers()[0].channelManaged, false);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:publish"));
  const confirmation = f.replies.at(-1).components[0].components[0].data.custom_id;
  await f.controller.handleInteraction(f.interaction(confirmation));
  assert.equal(f.store.getManagedServers()[0].published, true);
  assert.equal(f.calls.some(([method]) => method === "permissions"), false);
});


test("server settings forms serialize within Discord field and component limits", async (t) => {
  const f = fixture(t); f.add({ game: { type: "satisfactory" } });
  for (const action of ["settings", "game-api"]) {
    await f.controller.handleInteraction(f.interaction(`bridge:card:server:${action}`));
    const json = f.replies.at(-1).modal.toJSON();
    assert.ok(json.components.length <= 5);
    for (const item of json.components) assert.ok(item.components[0].label.length <= 45);
  }
  buildServerSetupCard({ identifier: "server", name: "World" }, f.store.getManagedServers()[0]).components.forEach((row) => row.toJSON());
});

test("replacement game API settings preserve private credential isolation and do not resume paused monitoring", async (t) => {
  const f = fixture(t); f.add({ unavailable: true, game: { type: "satisfactory", apiToken: "old-token" } });
  const modal = f.interaction("bridge:card:server:save-game-api", { modal: true });
  const values = { token: "new-game-private-token", url: "https://game.example/api/v1", tls: "false" };
  modal.fields = { getTextInputValue: (id) => values[id] };
  await f.controller.handleInteraction(modal);
  const saved = f.store.getManagedServers()[0];
  assert.equal(saved.game.apiToken, "new-game-private-token");
  assert.equal(saved.game.apiUrl, "https://game.example/api/v1");
  assert.equal(saved.game.allowInsecureTls, false);
  assert.equal(saved.active, false);
  assert.equal(fs.readFileSync(f.paths.configPath, "utf8").includes("new-game-private-token"), false);
  assert.equal(JSON.stringify(f.store.exportRedacted()).includes("new-game-private-token"), false);
  assert.equal(f.replies.some((reply) => JSON.stringify(reply).includes("new-game-private-token")), false);
});


test("configured admin role can use cards but another role cannot", async (t) => {
  const f = fixture(t); f.add();
  f.config.discord.serverAdminRoleId = "1515105756075003974";
  assert.equal(f.controller.authorized(f.interaction("bridge:card:server:disable", { admin: false, roles: ["1515105756075003974"] })), true);
  assert.equal(f.controller.authorized(f.interaction("bridge:card:server:disable", { admin: false, roles: ["other"] })), false);
  assert.equal(f.controller.authorized(f.interaction("bridge:card:server:disable", { admin: false, roles: ["1515105756075003974"], guildId: "other" })), false);
});


test("status creation verifies saved binding and reuses an existing channel", async (t) => {
  const f = fixture(t);
  let forced = false;
  f.guild.channels.fetch = async (id, options) => { if (id === "status") forced = options?.force === true; return f.channels.get(id) ?? null; };
  await f.controller.handleInteraction(f.interaction("bridge:guide:status-create"));
  assert.equal(forced, true);
  assert.equal(f.calls.some(([method]) => method === "create"), false);
  assert.equal(f.store.document.settings.discord.statusChannelId, "status");
});

for (const missing of ["null", "unknown-channel"]) test(`status creation replaces deleted saved channel (${missing})`, async (t) => {
  const f = fixture(t); f.channels.delete("status");
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => { if (id === "status" && missing === "unknown-channel") throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); return fetch(id, options); };
  await f.controller.handleInteraction(f.interaction("bridge:guide:status-create"));
  const creations = f.calls.filter(([method]) => method === "create");
  assert.equal(creations.length, 1);
  assert.equal(creations[0][1].parent, "category");
  assert.equal(creations[0][1].permissionOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel), true);
  assert.notEqual(f.store.document.settings.discord.statusChannelId, "status");
  assert.equal(f.store.document.settings.discord.statusChannelManaged, true);
  await f.controller.handleInteraction(f.interaction("bridge:guide:status-create"));
  assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
});

for (const code of [50001, 50013, "ECONNRESET"]) test(`status channel lookup failure ${code} retains binding without creation`, async (t) => {
  const f = fixture(t);
  f.guild.channels.fetch = async () => { throw Object.assign(new Error("lookup failed"), { code }); };
  await f.controller.handleInteraction(f.interaction("bridge:guide:status-create"));
  assert.equal(f.calls.some(([method]) => method === "create"), false);
  assert.equal(f.store.document.settings.discord.statusChannelId, "status");
});

test("active server card repairs a deleted binding privately and does not duplicate it on retry", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "deleted-channel", channelManaged: true });
  const fetched = [];
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => { fetched.push([id, options]); return fetch(id, options); };
  const card = buildServerSetupCard({ identifier: "server", name: "My server" }, f.store.getManagedServers()[0]);
  assert.equal(card.components[0].components[0].data.custom_id, "bridge:card:server:activate");
  assert.equal(card.components[0].components[0].data.disabled, undefined);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:activate"));
  const saved = f.store.getManagedServers()[0];
  assert.equal(saved.active, true); assert.equal(saved.published, false);
  assert.notEqual(saved.discordChannelId, "deleted-channel");
  assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
  assert.equal(f.calls.find(([method]) => method === "create")[1].parent, "category");
  assert.ok(fetched.some(([id, options]) => id === "deleted-channel" && options?.force === true));
  await f.controller.handleInteraction(f.interaction("bridge:card:server:activate"));
  assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
});


test("admin cards use compact boxed embeds and clear old plaintext on edits", async (t) => {
  const f = fixture(t); f.add(); await f.controller.refreshCards(f.guild);
  for (const id of ["overview", "server"]) {
    const payload = f.messages.get(f.store.getCardMessageId(id));
    assert.equal(payload.content, ""); assert.equal(payload.embeds.length, 1);
    assert.ok(payload.embeds[0].title); assert.ok(payload.embeds[0].fields.length);
    assert.ok(payload.embeds[0].description.length < 180);
  }
  const legacy = buildServerSetupCard({ identifier: "legacy", name: "Legacy" }, null, true);
  assert.equal(legacy.components.length, 0); assert.match(legacy.embeds[0].description, /Migrate/);
});


test("activation review shows exact changes and releases lock without refreshing cards", async (t) => {
  const f = fixture(t); f.add({ unavailable: true, published: true, discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:activate"));
  const review = f.replies.find(reply => reply.embeds?.[0].title === "Confirm monitoring & linked channel");
  assert.ok(review);
  const fields = Object.fromEntries(review.embeds[0].fields.map(field => [field.name, field.value]));
  assert.match(fields["Linked channel"], /<#retained> → <#retained>.*same channel/);
  assert.equal(fields.Monitoring, "Paused: unavailable → Active");
  assert.equal(fields["Main status page"], "Listed → Not listed (use Publish status & channel separately)");
  assert.match(fields.Actions, /No server start\/stop command/);
  assert.equal(f.calls.some(([method]) => method === "reconcile" || method === "send"), false);
  assert.equal(f.controller.locked, false);
  assert.equal(f.store.getManagedServers()[0].active, false);
});

test("busy response names the operation and affected server", async (t) => {
  const f = fixture(t); f.add();
  f.controller.currentOperation = f.controller.operationDescription(f.interaction("bridge:card:server:activate"));
  f.controller.locked = true;
  await f.controller.handleInteraction(f.interaction("bridge:card:server:settings"));
  assert.match(f.replies.at(-1).content, /Starting monitoring for \*\*My server\*\* is in progress/);
  assert.equal(f.store.getManagedServers()[0].active, false);
});

for (const [game, template] of [["factorio", "/shout {platform}<{author}>: {content}"], ["minecraft", "/say [{platform}] {author}: {content}"], ["satisfactory", null]]) test(`${game} import supplies the supported relay default automatically`, async (t) => {
  const f = fixture(t);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:import", { values: [game] }));
  const saved = f.store.getManagedServers()[0];
  assert.equal(saved.game.chatCommandTemplate, template);
  assert.equal(saved.chatRelay, Boolean(template));
});

test("standard settings do not ask for templates and relay controls retain custom commands", async (t) => {
  const f = fixture(t); f.add({ game: { type: "factorio", chatCommandTemplate: "/shout CUSTOM {content}" } });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:settings"));
  const fields = f.replies.at(-1).modal.toJSON().components.map(row => row.components[0]);
  assert.equal(fields.some(field => field.custom_id === "relay" || /template/i.test(field.label)), false);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["off"] }));
  assert.equal(f.store.getManagedServers()[0].chatRelay, false);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["on"] }));
  assert.equal(f.store.getManagedServers()[0].chatRelay, true);
  assert.equal(f.store.getManagedServers()[0].game.chatCommandTemplate, "/shout CUSTOM {content}");
});

test("enabling relay fills a missing game default without administrator input", async (t) => {
  const f = fixture(t); f.add({ chatRelay: false });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["on"] }));
  assert.equal(f.store.getManagedServers()[0].game.chatCommandTemplate, "/say [{platform}] {author}: {content}");
  assert.equal(f.store.getManagedServers()[0].chatRelay, true);
});

test("unsupported game relay remains disabled and advanced blank restores supported defaults", async (t) => {
  const f = fixture(t); f.add({ game: { type: "satisfactory" }, chatRelay: false });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["on"] }));
  assert.equal(f.store.getManagedServers()[0].chatRelay, false);
  assert.match(f.replies.at(-1).content, /no supported default/);
  f.store.updateManagedServer("server", { game: { type: "minecraft", chatCommandTemplate: "/say CUSTOM {content}" } });
  const submit = f.interaction("bridge:card:server:relay-custom-save", { modal: true });
  submit.fields = { getTextInputValue: () => "" };
  await f.controller.handleInteraction(submit);
  assert.equal(f.store.getManagedServers()[0].game.chatCommandTemplate, "/say [{platform}] {author}: {content}");
});

test("activation pushes the affected card without another discovery request", async (t) => {
  const f = fixture(t); f.add({ unavailable: true, discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:activate"));
  const prompt = f.replies.find(reply => reply.embeds?.[0].title === "Confirm monitoring & linked channel");
  const discoveries = f.calls.filter(([method]) => method === "discovery").length;
  await f.controller.handleInteraction(f.interaction(prompt.components[0].components[0].data.custom_id));
  const card = f.messages.get(f.store.getCardMessageId("server"));
  assert.equal(card.embeds[0].fields.find(field => field.name === "State").value, "Monitoring");
  assert.match(card.embeds[0].fields.find(field => field.name === "Publication").value, /Publish status & channel/);
  const publish = card.components.flatMap(row => row.components).find(button => button.data.label === "Publish status & channel");
  assert.equal(publish.data.disabled, false);
  // Activation's access validation is separate from refreshing all discovery cards.
  assert.equal(f.calls.some(([method]) => method === "send" && f.store.getCardMessageId("overview")), false);
  assert.ok(f.calls.filter(([method]) => method === "discovery").length <= discoveries + 1);
});


test("usability: edits and their card update finish while discovery is blocked", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  await f.controller.refreshCards(f.guild);
  let releaseDiscovery; let startedDiscovery;
  const started = new Promise(resolve => { startedDiscovery = resolve; });
  f.options.pterodactylClient.listAccessibleServers = () => { startedDiscovery(); return new Promise(resolve => { releaseDiscovery = resolve; }); };
  const discovery = f.controller.handleInteraction(f.interaction("bridge:guide:refresh"));
  await started;
  try {
    assert.equal(f.controller.locked, false);
    await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["off"] }));
    assert.equal(f.store.getManagedServers()[0].chatRelay, false);
    assert.equal(f.controller.locked, false);
    assert.match(f.replies.at(-1).content, /disabled/);
    const card = f.messages.get(f.store.getCardMessageId("server"));
    assert.equal(card.embeds[0].fields.find(f => f.name === "Chat relay").value, "Disabled");
  } finally { releaseDiscovery([{ identifier: "server", uuid: "server-uuid", name: "My server" }]); await discovery; }
});

test("usability: complete game selection, activation, publish, relay, and archive journey", async (t) => {
  const f = fixture(t);
  f.channels.set("public-category", { id: "public-category", type: ChannelType.GuildCategory });
  f.guild.roles.fetch = async id => ({ id, managed: false });
  f.store.configureCategories("guild", { privateCategoryId: "category", publicCategoryId: "public-category", linkedChannelRoleId: "linked-role" });
  await f.reconcile(); await f.controller.refreshCards(f.guild);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:import", { values: ["factorio"] }));
  assert.equal(f.store.getManagedServers()[0].chatRelay, true);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:bind-selected", { values: ["existing"] }));
  const activation = f.replies.at(-1); assert.match(activation.embeds[0].title, /Confirm/);
  await f.controller.handleInteraction(f.interaction(activation.components[0].components[0].data.custom_id));
  const active = f.messages.get(f.store.getCardMessageId("server"));
  assert.equal(active.components[0].components.find(b => b.data.label === "Publish status & channel").data.disabled, false);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:publish"));
  const publication = f.replies.at(-1);
  assert.equal(f.store.getManagedServers()[0].published, false);
  await f.controller.handleInteraction(f.interaction(publication.components[0].components[0].data.custom_id));
  assert.equal(f.store.getManagedServers()[0].published, true);
  assert.equal(f.messages.get(f.store.getCardMessageId("server")).embeds[0].fields.find(f => f.name === "Main status page").value, "Listed");
  await f.controller.handleInteraction(f.interaction("bridge:card:server:relay-set", { values: ["off"] }));
  assert.equal(f.store.getManagedServers()[0].chatRelay, false);
  await archiveServer(f);
  assert.equal(f.store.getManagedServers()[0].archived, true);
  assert.equal(f.messages.get(f.store.getCardMessageId("server")).embeds[0].fields.find(f => f.name === "State").value, "Archived");
  assert.equal(f.calls.some(([method]) => method === "delete"), false);
});


test("usability: channel binding acknowledges before any Discord lookup", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  const click = f.interaction("bridge:card:server:bind-selected", { values: ["existing"] });
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => { if (id === "existing") assert.equal(click.deferred, true); return fetch(id, options); };
  await f.controller.handleInteraction(click);
  assert.match(f.replies.at(-1).content, /Bind to/);
});

test("usability: private-category selection acknowledges before its Discord lookup", async (t) => {
  const f = fixture(t);
  f.controller.categoryDrafts.set("caller", { guildId: "guild", at: Date.now() });
  const click = f.interaction("bridge:guide:category-private", { values: ["category"] });
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => { if (id === "category") assert.equal(click.deferred, true); return fetch(id, options); };
  await f.controller.handleInteraction(click);
  assert.match(f.replies.at(-1).content, /public category/i);
});

test("advanced relay commands reject multiple lines without changing saved settings", async t => {
  const f = fixture(t); f.add({ game: { type: "minecraft", chatCommandTemplate: "/say {content}" } });
  const submit = f.interaction("bridge:card:server:relay-custom-save", { modal: true });
  submit.fields = { getTextInputValue: () => "/say {content}\n/another" };
  await f.controller.handleInteraction(submit);
  assert.equal(f.store.getManagedServers()[0].game.chatCommandTemplate, "/say {content}");
  assert.match(f.replies.at(-1).content, /single line/);
});

test("archive and unarchive announce saved lifecycle changes after monitoring reconciliation", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "retained" });
  const notices = [];
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, event => {
    notices.push(event);
    assert.equal(f.config.servers[0].active, event.kind === "server-unarchived");
    assert.equal(f.config.servers[0].archived, event.kind === "server-archived");
  });
  await archiveServer(f);
  assert.equal(notices[0].kind, "server-archived");
  assert.equal(notices[0].server.discordChannelId, "retained");
  assert.match(f.replies.at(-1).content, /Monitoring, chat relay and idle auto-stop are paused/);
  await archiveServer(f);
  assert.equal(notices[1].kind, "server-unarchived");
  assert.equal(f.store.getManagedServers()[0].active, true);
  assert.equal(f.store.getManagedServers()[0].published, true);
  assert.match(f.replies.at(-1).content, /Previous state restored/);
  assert.equal(f.calls.some(([method]) => method === "delete"), false);
});

test("failed archive save does not announce or change lifecycle state", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  const notices = [];
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, event => notices.push(event));
  f.store.updateManagedServer = () => { throw Error("Storage failure"); };
  await archiveServer(f);
  assert.equal(notices.length, 0);
  assert.equal(f.store.getManagedServers()[0].archived, false);
});

test("failed archive announcement preserves state and still reaches other destinations", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  let delivered = false;
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, () => { throw Error("Missing channel access"); });
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, () => { delivered = true; });
  await archiveServer(f);
  assert.equal(delivered, true);
  assert.equal(f.store.getManagedServers()[0].archived, true);
  assert.match(f.replies.at(-1).content, /announcement failed/);
});

for (const prior of [{ active: true, published: false }, { active: false, published: true }]) {
  test(`unarchive restores saved monitoring ${prior.active} and publication ${prior.published} across restart`, async (t) => {
    const f = fixture(t); f.add({ ...prior, discordChannelId: "retained" });
    await archiveServer(f);
    const resumedStore = new PersistentConfigStore(f.paths); assert.equal(resumedStore.load(), true);
    f.controller.configStore = resumedStore;
    await archiveServer(f);
    const restored = resumedStore.getManagedServers()[0];
    assert.equal(restored.active, prior.active);
    assert.equal(restored.published, prior.published);
    assert.equal(restored.archiveResumeState, null);
  });
}

test("archive review defaults to keeping power unchanged and requires an explicit choice", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "retained" });
  const power = [];
  f.options.pterodactylClient.setPowerState = async (...args) => power.push(args);
  await f.controller.handleInteraction(f.interaction("bridge:card:server:archive"));
  const review = f.replies.at(-1);
  assert.match(review.content, /Default: keep/);
  assert.equal(f.store.getManagedServers()[0].archived, false);
  const buttons = review.components[0].toJSON().components;
  assert.match(buttons[0].label, /do not stop/);
  assert.equal(buttons[0].style, 1);
  assert.equal(buttons[1].style, 4);
  await f.controller.handleInteraction(f.interaction(buttons[0].custom_id));
  assert.equal(f.store.getManagedServers()[0].archived, true);
  assert.deepEqual(power, []);
});

test("archive and stop sends one power request only after monitoring is paused", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "retained" });
  const power = [], notices = [];
  f.options.pterodactylClient.setPowerState = async (...args) => {
    assert.equal(f.config.servers[0].active, false);
    assert.equal(f.config.servers[0].archived, true);
    power.push(args);
  };
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, event => notices.push(event));
  await f.controller.handleInteraction(f.interaction("bridge:card:server:archive"));
  const choice = f.replies.at(-1).components[0].components[1].data.custom_id;
  await f.controller.handleInteraction(f.interaction(choice));
  await f.controller.handleInteraction(f.interaction(choice));
  assert.deepEqual(power, [["server", "stop"]]);
  assert.equal(notices[0].stopOutcome, "accepted");
  await archiveServer(f);
  assert.equal(f.store.getManagedServers()[0].active, true);
  assert.deepEqual(power, [["server", "stop"]], "unarchive never starts the game server");
});

test("failed optional stop preserves archive state and reports unconfirmed power outcome", async (t) => {
  const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
  f.options.pterodactylClient.setPowerState = async () => { throw Error("Timeout"); };
  const notices = [];
  f.controller.eventBus.on(CoreEvents.SERVER_NOTICE, event => notices.push(event));
  await archiveServer(f, { stop: true });
  assert.equal(f.store.getManagedServers()[0].archived, true);
  assert.equal(notices[0].stopOutcome, "failed");
  assert.match(f.replies.at(-1).content, /could not be confirmed/);
});

for (const invalid of ["expired", "other-admin", "changed", "access-lost"]) {
  test(`archive stop confirmation rejects ${invalid} without a power request`, async (t) => {
    const f = fixture(t); f.add({ active: true, discordChannelId: "retained" });
    let requests = 0;
    f.options.pterodactylClient.setPowerState = async () => { requests++; };
    await f.controller.handleInteraction(f.interaction("bridge:card:server:archive"));
    const choice = f.replies.at(-1).components[0].components[1].data.custom_id;
    if (invalid === "expired") for (const pending of f.controller.pending.values()) pending.at = 0;
    if (invalid === "changed") f.store.updateManagedServer("server", { published: true });
    if (invalid === "access-lost") f.setAccessible([]);
    await f.controller.handleInteraction(f.interaction(choice, invalid === "other-admin" ? { userId: "another" } : {}));
    assert.equal(requests, 0);
    assert.equal(f.store.getManagedServers()[0].archived, false);
  });
}

test("archive choice IDs fit Discord limits for migrated UUID server identifiers", async (t) => {
  const f = fixture(t); f.add({ pterodactylServerId: "12345678-1234-1234-1234-123456789012", discordChannelId: "retained" });
  await f.controller.handleInteraction(f.interaction("bridge:card:12345678-1234-1234-1234-123456789012:archive"));
  for (const row of f.replies.at(-1).components) {
    for (const button of row.toJSON().components) assert.ok(button.custom_id.length <= 100);
  }
});

test("lost access prevents unarchive from silently resuming monitoring", async (t) => {
  const f = fixture(t); f.add({ active: true, published: true, discordChannelId: "retained" });
  await archiveServer(f);
  f.setAccessible([]);
  await archiveServer(f);
  assert.equal(f.store.getManagedServers()[0].archived, true);
  assert.match(f.replies.at(-1).content, /remains archived/);
});

test("legacy archives resume monitoring without issuing a game-server start", async (t) => {
  const f = fixture(t); f.add({ archived: true, active: false, published: true, discordChannelId: "retained" });
  let power = 0;
  f.options.pterodactylClient.setPowerState = async () => { power++; };
  await archiveServer(f);
  assert.equal(f.store.getManagedServers()[0].active, true);
  assert.equal(f.store.getManagedServers()[0].published, true);
  assert.equal(power, 0);
});

test("ordering popup includes archived servers and persists all three display orders", async t => {
  const f = fixture(t); f.add({ name: "First", archived: true });f.controller.categoryLayout.sync = async () => {};
  f.store.addManagedServer({ name: "Second", pterodactylServerId: "second", active: false, archived: false, published: false, game: { type: "minecraft" } });await f.reconcile();
  await f.controller.handleInteraction(f.interaction("bridge:guide:order"));
  const modal = f.replies.at(-1).modal.toJSON();assert.match(modal.components[0].components[0].value, /First \[archived\] \| 0/);
  const submit = f.interaction(modal.custom_id, { modal: true });submit.fields = { getTextInputValue: () => "First [archived] | 9000\nSecond | -20" };
  await f.controller.handleInteraction(submit);assert.deepEqual(f.config.servers.map(s => s.pterodactylServerId), ["second", "server"]);
  const restarted = new PersistentConfigStore(f.paths);restarted.load();assert.deepEqual(restarted.getRuntimeConfig().servers.map(s => s.pterodactylServerId), ["second", "server"]);
  await f.controller.handleInteraction(f.interaction("bridge:guide:order"));
  assert.equal(f.replies.at(-1).modal.toJSON().components[0].components[0].value, "Second | 0\nFirst [archived] | 10");
});


test("admin control cards follow saved display order without deleting other messages", async t => {
  const f = fixture(t); f.add();
  f.controller.categoryLayout.sync = async () => {};
  f.store.addManagedServer({ name: "Second", pterodactylServerId: "second", active: false, archived: false, published: false, game: { type: "minecraft" } });
  await f.reconcile(); await f.controller.refreshCards(f.guild);
  const old = [f.store.getCardMessageId("server"), f.store.getCardMessageId("second")];
  f.messages.set("human-history", { content: "keep me" });
  f.store.updateSettings({ discord: { serverDisplayOrder: ["second", "server"] } });await f.reconcile();await f.controller.refreshCards(f.guild);
  const ids = [f.store.getCardMessageId("second"), f.store.getCardMessageId("server")];
  assert.ok(ids[0].localeCompare(ids[1], undefined, { numeric: true }) < 0);
  assert.ok(old.every(id => !f.messages.has(id)));assert.ok(f.messages.has("human-history"));
  assert.deepEqual(f.store.document.administration.pendingCardDeletion, []);
  const sent = f.calls.filter(([name]) => name === "send").length;
  await f.controller.refreshCards(f.guild);assert.equal(f.calls.filter(([name]) => name === "send").length, sent);
});

test("admin card replacement preserves cleanup after a failed deletion and restart", async t => {
  const f = fixture(t); f.add();f.controller.categoryLayout.sync = async () => {};
  f.store.addManagedServer({ name: "Second", pterodactylServerId: "second", active: false, archived: false, published: false, game: { type: "minecraft" } });await f.reconcile();await f.controller.refreshCards(f.guild);
  f.store.updateSettings({ discord: { serverDisplayOrder: ["second", "server"] } });await f.reconcile();
  const channel = f.channels.get("admin"), remove = channel.messages.delete;
  channel.messages.delete = async () => { throw new Error("temporary Discord failure"); };
  await assert.rejects(f.controller.refreshCards(f.guild));
  const restarted = new PersistentConfigStore(f.paths);assert.equal(restarted.load(), true);assert.ok(restarted.document.administration.pendingCardDeletion.length > 0);
  channel.messages.delete = remove;await f.controller.refreshCards(f.guild);assert.deepEqual(f.store.document.administration.pendingCardDeletion, []);
});


test("failed batch creation keeps old admin card bindings until every replacement is ready", async t => {
  const f = fixture(t); f.add();f.controller.categoryLayout.sync = async () => {};await f.controller.refreshCards(f.guild);
  const old = f.store.getCardMessageId("server"), overview = f.store.getCardMessageId("overview");
  f.store.updateSettings({ discord: { serverDisplayOrder: ["server"], adminDisplayOrderRevision: 1 } });await f.reconcile();
  const channel = f.channels.get("admin"), send = channel.send;let count = 0;
  channel.send = async payload => { if (++count === 2) throw new Error("send failed");return send(payload); };
  await assert.rejects(f.controller.refreshCards(f.guild));assert.equal(f.store.getCardMessageId("server"), old);assert.equal(f.store.getCardMessageId("overview"), overview);assert.ok(f.messages.has(old));
  channel.send = send;await f.controller.refreshCards(f.guild);assert.deepEqual(f.store.document.administration.pendingCardDeletion, []);
});


test("Settings exposes, persists and clears the archive message", async t => {
  const f = fixture(t);f.add({ archiveNote: "Previous season ended" });
  await f.controller.handleInteraction(f.interaction("bridge:card:server:settings"));
  const fields = f.replies.at(-1).modal.toJSON().components.map(row=>row.components[0]);
  const archive=fields.find(field=>field.custom_id==="archive");assert.equal(archive.value,"Previous season ended");assert.equal(archive.required,false);assert.equal(archive.max_length,1000);
  const values={name:"My server",description:"",idle:"",warning:"60",archive:" World preserved for the next season "};
  const submit=f.interaction("bridge:card:server:save-settings",{modal:true});submit.fields={getTextInputValue:key=>values[key]};await f.controller.handleInteraction(submit);
  const restarted=new PersistentConfigStore(f.paths);assert.equal(restarted.load(),true);assert.equal(restarted.getManagedServers()[0].archiveNote,"World preserved for the next season");assert.equal(f.config.servers[0].archiveNote,"World preserved for the next season");
  values.archive="";await f.controller.handleInteraction(submit);assert.equal(f.store.getManagedServers()[0].archiveNote,null);
});
