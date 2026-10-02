import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import { BRIDGE_ADMIN_COMMANDS, BridgeAdminController, fetchSavedServerChannel } from "../src/services/bridge-admin-controller.js";

function fixture({ admin = true, channelId = "admin", key = "old-key" } = {}) {
  const calls = [];
  const managed = [];
  const channels = new Map();
  const config = {
    discord: { guildId: "guild", statusChannelId: "status", logChannelId: "logs",
      privateCategoryId: "category", publicCategoryId: "public-category", linkedChannelRoleId: "linked-role" },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: key },
    servers: [{ name: "Legacy", pterodactylServerId: "legacy", discordChannelId: "legacy-channel", game: { type: "minecraft" } }]
  };
  const store = {
    document: { settings: { discord: config.discord, servers: [{ pterodactylServerId: "legacy" }] } },
    getAdminChannelId: () => "admin",
    getCategoryId: () => "category",
    setCategoryId() {},
    getManagedServers: () => structuredClone(managed),
    addManagedServer(server) { managed.push(structuredClone(server)); calls.push({ method: "save-import" }); },
    updateManagedServer(id, changes, { apiToken } = {}) {
      const server = managed.find((item) => item.pterodactylServerId === id);
      Object.assign(server, changes);
      if (apiToken) server.game.apiToken = apiToken;
      calls.push({ method: "save-update", id, changes });
    },
    setConnectionKey(next) { calls.push({ method: "save-key", next }); }
  };
  function editableChannel(id, parentId, overwrites = []) {
    return { id, type: ChannelType.GuildText, parentId,
      permissionOverwrites: { cache: new Map(overwrites.map((overwrite) => [overwrite.id, overwrite])),
        async edit(_target, permissions) { calls.push({ method: "permission-edit", permissions }); } },
      async edit(options) {
        calls.push({ method: "channel-edit", id, options });
        this.parentId = options.parent;
        this.permissionOverwrites.cache = new Map(options.permissionOverwrites.map((overwrite) => [overwrite.id, overwrite]));
      },
      async delete() { calls.push({ method: "delete" }); }
    };
  }
  const existing = {
    ...editableChannel("existing", "unrelated-category"),
    id: "existing", type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: { cache: new Map(), async edit(_target, permissions) { calls.push({ method: "permission-edit", permissions }); } }
  };
  channels.set(existing.id, existing);
  channels.set("category", { id: "category", type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([["guild", { id: "guild", type: OverwriteType.Role,
      deny: { bitfield: PermissionFlagsBits.ViewChannel, has: (permission) => permission === PermissionFlagsBits.ViewChannel }, allow: { bitfield: 0n } }]]) } });
  channels.set("public-category", { id: "public-category", type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([["guild", { id: "guild", type: OverwriteType.Role,
      allow: { bitfield: PermissionFlagsBits.ViewChannel }, deny: { bitfield: 0n } }]]) } });
  channels.set("status", editableChannel("status", "category", [
    { id: "guild", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: "bot", type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] }
  ]));
  const guild = {
    id: "guild", ownerId: "owner", roles: { everyone: { id: "guild" }, async fetch(id) { return id === "linked-role" ? { id, managed: false } : null; } },
    channels: {
      async fetch(id) { return channels.get(id) ?? null; },
      async create(options) {
        calls.push({ method: "create", options });
        const channel = editableChannel("new-channel", options.parent, options.permissionOverwrites);
        channels.set(channel.id, channel);
        return channel;
      }
    }
  };
  const pterodactylClient = {
    apiKey: key, websocketCredentialCache: new Map(),
    async listAccessibleServers() { return [
      { identifier: "legacy", name: "Legacy" }, { identifier: "new-id", name: "New World" }
    ]; },
    async getServerResources(id) {
      const visible = await this.listAccessibleServers();
      if (!visible.some(s => [s.identifier, s.uuid, s.legacyIdentifier].includes(id))) throw new Error("Access denied");
      return { currentState: "offline" };
    },
    async getServerDefaultAllocation() { return { ip: "127.0.0.1", port: 25565, isDefault: true }; }
  };
  const syncService = {
    onConfigReloaded() { calls.push({ method: "runtime-update" }); },
    async syncOnce() { calls.push({ method: "poll" }); },
    requestSync() { calls.push({ method: "poll-scheduled" }); }
  };
  const controller = new BridgeAdminController({
    discordBridge: { onInteraction() {} }, configStore: store, config, pterodactylClient,
    syncService, guildId: "guild", logger: { error() {}, info() {} }
  });
  function command(subcommand, values = {}) {
    return {
      commandName: "bridge", guildId: "guild", channelId, guild, user: { id: "caller" },
      client: { user: { id: "bot" } },
      memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
      isChatInputCommand: () => true, isModalSubmit: () => false, isButton: () => false, isAutocomplete: () => false,
      options: {
        getSubcommand: () => subcommand, getString: (name) => values[name] ?? null,
        getBoolean: (name) => values[name] ?? null, getChannel: (name) => values[name] ?? null,
        getInteger: (name) => values[name] ?? null
      },
      deferred: false, replied: false,
      async deferReply() { this.deferred = true; },
      async editReply(payload) { calls.push({ method: "reply", payload }); },
      async reply(payload) { this.replied = true; calls.push({ method: "reply", payload }); },
      async showModal(modal) { calls.push({ method: "modal", modal }); }
    };
  }
  return { controller, command, calls, managed, config, existing, store, pterodactylClient, guild, channels };
}

test("admin commands expose connect, discovery, import, activation and publishing", () => {
  assert.deepEqual(BRIDGE_ADMIN_COMMANDS.map((command) => command.name), ["connect", "servers", "import", "activate", "publish"]);
});

test("administration commands require the saved channel and administrator rights", async () => {
  for (const options of [{ admin: false }, { channelId: "elsewhere" }]) {
    const { controller, command, calls } = fixture(options);
    await controller.handleInteraction(command("servers"));
    assert.match(calls.at(-1).payload.content, /saved #bridge-admin channel/);
    assert.equal(calls.some((call) => call.method === "save-import"), false);
  }
});

test("discovery marks linked servers and import defaults to inactive without side effects", async () => {
  const { controller, command, calls, managed } = fixture();
  await controller.handleInteraction(command("servers"));
  assert.match(calls.at(-1).payload.content, /Legacy.*linked/);
  assert.match(calls.at(-1).payload.content, /New World.*available/);
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft" }));
  assert.equal(managed[0].active, false);
  assert.equal(managed[0].published, false);
  assert.equal(managed[0].discordChannelId, null);
  assert.equal(calls.some((call) => call.method === "create" || call.method === "poll"), false);
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft" }));
  assert.equal(managed.length, 1);
  assert.match(calls.at(-1).payload.content, /already linked/);
});

test("a legacy UUID link also blocks importing its short identifier", async () => {
  const { controller, command, calls, store, pterodactylClient, managed } = fixture();
  store.document.settings.servers = [{ pterodactylServerId: "full-uuid" }];
  pterodactylClient.listAccessibleServers = async () => [{ identifier: "short-id", uuid: "full-uuid", name: "Already Managed" }];
  await controller.handleInteraction(command("servers"));
  assert.match(calls.at(-1).payload.content, /Already Managed.*linked/);
  await controller.handleInteraction(command("import", { server: "short-id", game: "minecraft" }));
  assert.equal(managed.length, 0);
  assert.match(calls.at(-1).payload.content, /already linked/);
});

test("activate now creates a private server channel and starts polling while hidden", async () => {
  const { controller, command, calls, managed, config } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true }));
  assert.equal(managed[0].active, true);
  assert.equal(managed[0].published, false);
  assert.equal(managed[0].discordChannelId, "new-channel");
  assert.equal(config.servers.at(-1).published, false);
  assert.equal(calls.some((call) => call.method === "runtime-update"), true);
  assert.equal(calls.some((call) => call.method === "poll-scheduled"), true);
  const overwrites = calls.find((call) => call.method === "create").options.permissionOverwrites;
  assert.deepEqual(overwrites[0], { id: "guild", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(overwrites.slice(1).map((entry) => entry.id), ["bot", "caller", "owner"]);
});

test("existing channel visibility is shown before activation and permissions stay unchanged", async () => {
  const { controller, command, calls, existing, managed } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true, channel: existing }));
  assert.equal(managed[0].active, false);
  assert.match(calls.at(-1).payload.embeds[0].fields.find(field => field.name === "Channel access").value, /Visible to @everyone/);
  const customId = calls.at(-1).payload.components[0].components[0].data.custom_id;
  const button = command("activate");
  button.isChatInputCommand = () => false;
  button.isButton = () => true;
  button.customId = customId;
  await controller.handleInteraction(button);
  assert.equal(managed[0].active, true);
  assert.equal(managed[0].channelManaged, false);
  assert.equal(calls.some((call) => call.method === "permission-edit"), false);
});

test("publishing reveals only a bot-created channel and updates panel visibility", async () => {
  const { controller, command, calls, managed, config } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true }));
  await controller.handleInteraction(command("publish", { server: "new-id" }));
  assert.equal(managed[0].published, false, "publication must wait for confirmation");
  const confirmation = command("publish");
  confirmation.customId = calls.at(-1).payload.components[0].components[0].data.custom_id;
  confirmation.isChatInputCommand = () => false;
  confirmation.isButton = () => true;
  await controller.handleInteraction(confirmation);
  assert.equal(managed[0].published, true);
  assert.equal(config.servers.at(-1).published, true);
  const publication = calls.find((call) => call.method === "channel-edit").options;
  assert.equal(publication.parent, "public-category");
  assert.deepEqual(publication.permissionOverwrites.map((overwrite) => overwrite.id), ["guild", "linked-role", "bot"]);
  assert.deepEqual(publication.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.deepEqual(publication.permissionOverwrites[1].allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]);
});

test("connection modal validates access and never returns or logs the key", async () => {
  const { controller, command, calls, config, pterodactylClient } = fixture();
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer new-private-key");
    if (String(url).includes("/resources")) return { ok: true, async json() { return { attributes: { current_state: "offline", resources: {} } }; } };
    return { ok: true, async json() { return {
      data: [{ attributes: { identifier: "legacy", name: "Legacy" } }, { attributes: { identifier: "new-id", name: "New World" } }],
      meta: { pagination: { total_pages: 1 } }
    }; } };
  };
  try {
    const modal = command("connect");
    modal.isChatInputCommand = () => false;
    modal.isModalSubmit = () => true;
    modal.customId = "bridge:connect";
    modal.fields = { getTextInputValue: (id) => id === "url" ? "https://panel.example.com" : "new-private-key" };
    await controller.handleInteraction(modal);
    assert.equal(config.pterodactyl.apiKey, "new-private-key");
    assert.equal(pterodactylClient.apiKey, "new-private-key");
    assert.equal(calls.some((call) => call.method === "save-key"), true);
    assert.equal(calls.filter((call) => call.method === "reply").every((call) => !JSON.stringify(call.payload).includes("new-private-key")), true);
  } finally { global.fetch = originalFetch; }
});

test("a failed import save does not create a channel or poll", async () => {
  const { controller, command, calls, store } = fixture();
  store.addManagedServer = () => { throw new Error("disk full"); };
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true }));
  assert.equal(calls.some((call) => call.method === "create" || call.method === "poll"), false);
  assert.match(calls.at(-1).payload.content, /Bridge operation failed/);
});

test("a failed activation save removes the newly created private channel", async () => {
  const { controller, command, calls, store, managed } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft" }));
  store.updateManagedServer = () => { throw new Error("disk full"); };
  await controller.handleInteraction(command("activate", { server: "new-id" }));
  assert.equal(managed[0].active, false);
  assert.equal(calls.some((call) => call.method === "create"), true);
  assert.equal(calls.some((call) => call.method === "delete"), true);
  assert.equal(calls.some((call) => call.method === "runtime-update"), false);
});

test("a failed publish save restores private channel visibility", async () => {
  const { controller, command, calls, store, managed } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true }));
  store.updateManagedServer = () => { throw new Error("disk full"); };
  await controller.handleInteraction(command("publish", { server: "new-id" }));
  assert.equal(managed[0].published, false, "publication must wait for confirmation");
  const confirmation = command("publish");
  confirmation.customId = calls.at(-1).payload.components[0].components[0].data.custom_id;
  confirmation.isChatInputCommand = () => false;
  confirmation.isButton = () => true;
  await controller.handleInteraction(confirmation);
  assert.equal(managed[0].published, false);
  const edits = calls.filter((call) => call.method === "channel-edit");
  assert.deepEqual(edits.map((call) => call.options.parent), ["public-category", "category"]);
  assert.deepEqual(edits.at(-1).options.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
});

test("Satisfactory activation requests a private token before creating a channel", async () => {
  const { controller, command, calls, managed } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "satisfactory", activate: true }));
  assert.equal(managed[0].active, false);
  assert.equal(calls.some((call) => call.method === "create"), false);
  assert.match(calls.at(-1).payload.content, /game API token/);
  const buttonId = calls.at(-1).payload.components[0].components[0].data.custom_id;
  const button = command("activate");
  button.isChatInputCommand = () => false;
  button.isButton = () => true;
  button.customId = buttonId;
  await controller.handleInteraction(button);
  assert.equal(calls.at(-1).method, "modal");
  assert.equal(calls.at(-1).modal.data.custom_id.startsWith("bridge:token:"), true);
});


test("first Satisfactory activation polls with the private token and normalized game settings", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "satisfactory", activate: true }));
  const buttonId = f.calls.at(-1).payload.components[0].components[0].data.custom_id;
  const tokenButton = f.command("activate");
  tokenButton.isChatInputCommand = () => false;
  tokenButton.isButton = () => true;
  tokenButton.customId = buttonId;
  await f.controller.handleInteraction(tokenButton);
  const modal = f.command("activate");
  modal.isChatInputCommand = () => false;
  modal.isModalSubmit = () => true;
  modal.customId = f.calls.at(-1).modal.data.custom_id;
  modal.fields = { getTextInputValue: () => "game-private-token" };
  let firstPollGame;
  f.controller.syncService.requestSync = () => { firstPollGame = f.config.servers.find((server) => server.pterodactylServerId === "new-id").game; };
  await f.controller.handleInteraction(modal);
  assert.equal(firstPollGame.apiToken, "game-private-token");
  assert.equal(firstPollGame.apiRequestTimeoutMs, 10000);
  assert.equal(firstPollGame.apiUrl, "https://127.0.0.1:25565/api/v1");
  assert.equal(f.managed[0].active, true);
  assert.equal(f.managed[0].publicPort, 25565);
  assert.equal(f.calls.filter((call) => call.method === "reply").every((call) => !JSON.stringify(call.payload).includes("game-private-token")), true);
});


async function confirmPublication(f) {
  const confirmation = f.command("publish");
  confirmation.customId = f.calls.at(-1).payload.components[0].components[0].data.custom_id;
  confirmation.isChatInputCommand = () => false;
  confirmation.isButton = () => true;
  await f.controller.handleInteraction(confirmation);
}

test("publication keeps linked channels private until confirmation and uses only the required role afterward", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  const created = f.calls.find((call) => call.method === "create");
  assert.equal(created.options.parent, "category", "new channels must never be created at the guild root");
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  assert.equal(f.channels.get("new-channel").parentId, "category");
  assert.equal(f.calls.filter((call) => call.method === "channel-edit").length, 0);
  assert.match(f.calls.at(-1).payload.content, /linked-role/);
  assert.match(f.calls.at(-1).payload.content, /public-category/);
  await confirmPublication(f);
  const overwrites = f.channels.get("new-channel").permissionOverwrites.cache;
  assert.equal(f.channels.get("new-channel").parentId, "public-category");
  assert.deepEqual([...overwrites.keys()], ["guild", "linked-role", "bot"]);
  assert.deepEqual(overwrites.get("guild").deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(overwrites.get("guild").allow, undefined, "@everyone must never receive publication access");
  assert.ok(overwrites.get("linked-role").allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(overwrites.get("bot").allow.includes(PermissionFlagsBits.ManageRoles));
  assert.equal(overwrites.has("caller"), false, "creator-specific access must not bypass the linked role");
});

test("missing or managed roles and invalid public categories fail before changing either channel", async () => {
  for (const problem of ["missing", "managed", "everyone", "private-category"]) {
    const f = fixture();
    f.config.discord.statusChannelManaged = true;
    await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
    await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
    if (problem === "missing") f.guild.roles.fetch = async () => null;
    if (problem === "managed") f.guild.roles.fetch = async () => ({ id: "linked-role", managed: true });
    if (problem === "everyone") f.guild.roles.fetch = async () => ({ id: "guild", managed: false });
    if (problem === "private-category") f.config.discord.publicCategoryId = "category";
    await confirmPublication(f);
    assert.equal(f.managed[0].published, false);
    assert.equal(f.calls.filter((call) => call.method === "channel-edit").length, 0, problem);
    assert.equal(f.channels.get("new-channel").parentId, "category");
    assert.equal(f.channels.get("status").parentId, "category");
  }
});

test("publication moves existing linked channels and retains an externally bound status channel", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true, channel: f.existing }));
  const activate = f.command("activate");
  activate.customId = f.calls.at(-1).payload.components[0].components[0].data.custom_id;
  activate.isChatInputCommand = () => false;
  activate.isButton = () => true;
  await f.controller.handleInteraction(activate);
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  await confirmPublication(f);
  assert.equal(f.managed[0].published, true);
  assert.equal(f.existing.parentId, "public-category");
  assert.equal(f.channels.get("status").parentId, "category");
  assert.deepEqual([...f.existing.permissionOverwrites.cache.keys()], ["guild", "linked-role", "bot"]);
});

test("bot-created status channel copies public category permissions with explicit bot access", async () => {
  const f = fixture();
  f.config.discord.statusChannelManaged = true;
  const categoryBefore = f.channels.get("public-category").permissionOverwrites.cache;
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  await confirmPublication(f);
  const status = f.channels.get("status");
  assert.equal(status.parentId, "public-category");
  assert.equal(status.permissionOverwrites.cache.get("guild").allow, PermissionFlagsBits.ViewChannel);
  assert.ok(status.permissionOverwrites.cache.get("bot").allow.includes(PermissionFlagsBits.ManageRoles));
  assert.equal(f.channels.get("public-category").permissionOverwrites.cache, categoryBefore, "selected categories must remain untouched");
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1);
});

test("failed publication save restores both channel parents and original permission snapshots", async () => {
  const f = fixture();
  f.config.discord.statusChannelManaged = true;
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  const serverBefore = structuredClone([...f.channels.get("new-channel").permissionOverwrites.cache.values()]);
  const statusBefore = structuredClone([...f.channels.get("status").permissionOverwrites.cache.values()]);
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  f.store.updateManagedServer = () => { throw new Error("disk full"); };
  await confirmPublication(f);
  assert.equal(f.managed[0].published, false);
  assert.equal(f.channels.get("new-channel").parentId, "category");
  assert.equal(f.channels.get("status").parentId, "category");
  const stripDefaults = (overwrites) => overwrites.map(({ allow, deny, ...rest }) => ({
    ...rest, ...(allow === undefined || allow === 0n ? {} : { allow }), ...(deny === undefined || deny === 0n ? {} : { deny })
  }));
  assert.deepEqual(stripDefaults([...f.channels.get("new-channel").permissionOverwrites.cache.values()]), serverBefore);
  assert.deepEqual(stripDefaults([...f.channels.get("status").permissionOverwrites.cache.values()]), statusBefore);
});

test("failed status edit rolls back a previously moved linked channel before publication is saved", async () => {
  const f = fixture();
  f.config.discord.statusChannelManaged = true;
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  const status = f.channels.get("status");
  const edit = status.edit;
  let attempts = 0;
  status.edit = async function(options) {
    await edit.call(this, options);
    if (++attempts === 1) throw new Error("status permission update failed");
  };
  await confirmPublication(f);
  assert.equal(f.managed[0].published, false);
  assert.equal(f.channels.get("new-channel").parentId, "category");
  assert.equal(status.parentId, "category");
  assert.equal(f.calls.some((call) => call.method === "save-update" && call.changes.published === true), false);
});

test("unavailable original permission snapshots fall back to a private category on failed publication", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  const channel = f.channels.get("new-channel");
  delete channel.parentId;
  channel.permissionOverwrites.cache = undefined;
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  f.store.updateManagedServer = () => { throw new Error("disk full"); };
  await confirmPublication(f);
  assert.equal(f.managed[0].published, false);
  assert.equal(channel.parentId, "category");
  assert.deepEqual(channel.permissionOverwrites.cache.get("guild").deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(channel.permissionOverwrites.cache.has("linked-role"), false);
});


test("the configured administration role grants controls only in the claimed guild and saved channel", async () => {
  const f = fixture({ admin: false });
  f.config.discord.bridgeAdminRoleId = "bridge-role";
  const allowed = f.command("import", { server: "new-id", game: "minecraft" });
  allowed.member = { roles: { cache: new Map([["bridge-role", { id: "bridge-role" }]]) } };
  await f.controller.handleInteraction(allowed);
  assert.equal(f.managed.length, 1);
  const wrongGuild = f.command("servers");
  wrongGuild.guildId = "other-guild";
  wrongGuild.member = allowed.member;
  await f.controller.handleInteraction(wrongGuild);
  assert.match(f.calls.at(-1).payload.content, /saved #bridge-admin channel/);
  const wrongChannel = f.command("servers");
  wrongChannel.channelId = "elsewhere";
  wrongChannel.member = allowed.member;
  await f.controller.handleInteraction(wrongChannel);
  assert.match(f.calls.at(-1).payload.content, /saved #bridge-admin channel/);
});

test("a removed administration role loses control access and the configured server admin role is supported", async () => {
  const f = fixture({ admin: false });
  f.config.discord.serverAdminRoleId = "server-admin-role";
  const allowed = f.command("servers");
  allowed.member = { roles: ["server-admin-role"] };
  await f.controller.handleInteraction(allowed);
  assert.match(f.calls.at(-1).payload.content, /Accessible servers/);
  const revoked = f.command("servers");
  revoked.member = { roles: [] };
  await f.controller.handleInteraction(revoked);
  assert.match(f.calls.at(-1).payload.content, /configured bridge administration role/);
});


async function savedChannelFixture({ active = false, published = false, channelId = "saved-missing" } = {}) {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft" }));
  Object.assign(f.managed[0], { active, published, discordChannelId: channelId, channelManaged: true });
  f.config.servers.push(structuredClone(f.managed[0]));
  return f;
}

test("activation force-checks and confirms an existing saved channel before reusing it", async () => {
  const f = await savedChannelFixture({ channelId: "existing" });
  const fetches = [];
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => { fetches.push({ id, options }); return fetch(id, options); };
  await f.controller.handleInteraction(f.command("activate", { server: "new-id" }));
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.match(f.calls.at(-1).payload.embeds[0].fields.find(field => field.name === "Linked channel").value, /<#existing>/);
  assert.ok(fetches.filter((call) => call.id === "existing").every((call) => call.options.force === true));
  const confirm = f.command("activate");
  confirm.customId = f.calls.at(-1).payload.components[0].components[0].data.custom_id;
  confirm.isChatInputCommand = () => false;
  confirm.isButton = () => true;
  await f.controller.handleInteraction(confirm);
  assert.equal(f.managed[0].discordChannelId, "existing");
  assert.equal(f.managed[0].active, true);
  assert.equal(f.calls.some((call) => call.method === "create"), false);
});

test("explicit activation repairs active or inactive bindings only after confirmed Discord absence", async () => {
  for (const active of [false, true]) {
    for (const missing of ["null", "10003"]) {
      const f = await savedChannelFixture({ active, published: true });
      const fetch = f.guild.channels.fetch;
      f.guild.channels.fetch = async (id, options) => {
        if (id !== "saved-missing") return fetch(id, options);
        assert.equal(options.force, true);
        if (missing === "10003") throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        return null;
      };
      await f.controller.handleInteraction(f.command("activate", { server: "new-id" }));
      const creation = f.calls.find((call) => call.method === "create");
      assert.equal(creation.options.parent, "category");
      assert.deepEqual(creation.options.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
      assert.equal(f.managed[0].discordChannelId, "new-channel");
      assert.equal(f.managed[0].active, true);
      assert.equal(f.managed[0].published, false, "repair must not publish its replacement automatically");
    }
  }
});

test("ambiguous errors, missing access, and wrong channel types never recreate a binding", async () => {
  for (const failure of [new Error("network error"), Object.assign(new Error("missing permissions"), { code: 50013 }),
    Object.assign(new Error("proxy 404"), { status: 404 }), { id: "saved-missing", type: ChannelType.GuildCategory }]) {
    const f = await savedChannelFixture({ active: true, published: true });
    const fetch = f.guild.channels.fetch;
    f.guild.channels.fetch = async (id, options) => {
      if (id !== "saved-missing") return fetch(id, options);
      assert.equal(options.force, true);
      if (failure instanceof Error) throw failure;
      return failure;
    };
    await f.controller.handleInteraction(f.command("activate", { server: "new-id" }));
    assert.equal(f.calls.some((call) => call.method === "create"), false);
    assert.equal(f.managed[0].discordChannelId, "saved-missing");
    assert.equal(f.managed[0].published, true);
  }
});

test("a saved binding that reappears before creation gets a fresh confirmation instead of a duplicate", async () => {
  const f = await savedChannelFixture({ channelId: "existing" });
  let attempts = 0;
  const fetch = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id, options) => {
    if (id !== "existing") return fetch(id, options);
    assert.equal(options.force, true);
    return ++attempts < 3 ? null : f.existing;
  };
  await f.controller.handleInteraction(f.command("activate", { server: "new-id" }));
  assert.equal(f.calls.some((call) => call.method === "create"), false);
  assert.match(f.calls.at(-1).payload.embeds[0].fields.find(field => field.name === "Linked channel").value, /<#existing>/);
  assert.equal(f.managed[0].active, false);
});

test("failed replacement persistence removes the new private channel and keeps its original binding", async () => {
  const f = await savedChannelFixture({ active: true, published: true });
  f.store.updateManagedServer = () => { throw new Error("disk full"); };
  await f.controller.handleInteraction(f.command("activate", { server: "new-id" }));
  assert.equal(f.calls.some((call) => call.method === "delete"), true);
  assert.equal(f.managed[0].discordChannelId, "saved-missing");
  assert.equal(f.managed[0].published, true);
});

test("saved binding helper never infers deletion from non-Discord error bodies", async () => {
  await assert.rejects(fetchSavedServerChannel({ channels: { async fetch() { throw Object.assign(new Error("upstream unavailable"), { code: 404 }); } } }, "saved"));
});


test("publication moves a bound linked channel in the selected private category", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  f.store.updateManagedServer("new-id", { channelManaged: false });
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  assert.match(f.calls.at(-1).payload.content, /linked channel <#new-channel> will move/);
  await confirmPublication(f);
  const channel = f.channels.get("new-channel");
  assert.equal(channel.parentId, "public-category");
  assert.deepEqual([...channel.permissionOverwrites.cache.keys()], ["guild", "linked-role", "bot"]);
  assert.equal(f.managed[0].published, true);
});

test("publication explains missing routing without offering an invalid confirmation", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  delete f.config.discord.publicCategoryId;
  delete f.config.discord.linkedChannelRoleId;
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  assert.match(f.calls.at(-1).payload.content, /Choose Categories \/ access role/);
  assert.equal(f.calls.at(-1).payload.components, undefined);
  assert.equal(f.managed[0].published, false);
});

for (const mismatch of ["parent", "permissions"]) {
  test(`publication verifies ${mismatch} and rolls back an incomplete Discord edit`, async () => {
    const f = fixture();
    await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
    const channel = f.channels.get("new-channel");
    const originalEdit = channel.edit.bind(channel);
    channel.edit = async options => {
      await originalEdit(options);
      if (options.parent === "public-category") {
        if (mismatch === "parent") channel.parentId = "category";
        else channel.permissionOverwrites.cache.delete("linked-role");
      }
    };
    await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
    await confirmPublication(f);
    assert.equal(f.managed[0].published, false);
    assert.equal(channel.parentId, "category");
    assert.equal(channel.permissionOverwrites.cache.has("linked-role"), false);
    assert.equal(f.calls.some(c => c.method === "save-update" && c.changes.published === true), false);
  });
}

test("publication checks bot permissions at the destination before moving channels", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  f.channels.get("public-category").permissionsFor = () => ({ has: () => false });
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  await confirmPublication(f);
  assert.equal(f.managed[0].published, false);
  assert.equal(f.calls.some(c => c.method === "channel-edit"), false);
});

test("already-published migrated channels can repair their category and role permissions", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  f.store.updateManagedServer("new-id", { published: true, channelManaged: false });
  f.config.servers.at(-1).published = true;
  f.channels.get("new-channel").parentId = "unrelated-category";
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  await confirmPublication(f);
  assert.equal(f.channels.get("new-channel").parentId, "public-category");
  assert.deepEqual([...f.channels.get("new-channel").permissionOverwrites.cache.keys()], ["guild", "linked-role", "bot"]);
  assert.equal(f.managed[0].published, true);
});

test("publication fails and restores permissions if linked-role effective access is insufficient", async () => {
  const f = fixture();
  await f.controller.handleInteraction(f.command("import", { server: "new-id", game: "minecraft", activate: true }));
  const channel = f.channels.get("new-channel");
  channel.permissionsFor = target => ({ has: () => target !== "linked-role" && target?.id !== "linked-role" });
  await f.controller.handleInteraction(f.command("publish", { server: "new-id" }));
  await confirmPublication(f);
  assert.equal(f.managed[0].published, false);
  assert.equal(channel.parentId, "category");
  assert.equal(channel.permissionOverwrites.cache.has("linked-role"), false);
});
