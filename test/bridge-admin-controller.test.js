import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import { BRIDGE_ADMIN_COMMANDS, BridgeAdminController } from "../src/services/bridge-admin-controller.js";

function fixture({ admin = true, channelId = "admin", key = "old-key" } = {}) {
  const calls = [];
  const managed = [];
  const channels = new Map();
  const config = {
    discord: { guildId: "guild", statusChannelId: "status", logChannelId: "logs" },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: key },
    servers: [{ name: "Legacy", pterodactylServerId: "legacy", discordChannelId: "legacy-channel", game: { type: "minecraft" } }]
  };
  const store = {
    document: { settings: { servers: [{ pterodactylServerId: "legacy" }] } },
    getAdminChannelId: () => "admin",
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
  const existing = {
    id: "existing", type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: { async edit(_target, permissions) { calls.push({ method: "permission-edit", permissions }); } }
  };
  channels.set(existing.id, existing);
  const guild = {
    id: "guild", ownerId: "owner", roles: { everyone: { id: "guild" } },
    channels: {
      async fetch(id) { return channels.get(id) ?? null; },
      async create(options) {
        calls.push({ method: "create", options });
        const channel = {
          id: "new-channel", type: ChannelType.GuildText,
          permissionOverwrites: { async edit(_target, permissions) { calls.push({ method: "permission-edit", permissions }); } },
          async delete() { calls.push({ method: "delete" }); }
        };
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
    async getServerDefaultAllocation() { return { ip: "127.0.0.1", port: 25565, isDefault: true }; }
  };
  const syncService = {
    onConfigReloaded() { calls.push({ method: "runtime-update" }); },
    async syncOnce() { calls.push({ method: "poll" }); }
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
  return { controller, command, calls, managed, config, existing, store, pterodactylClient, guild };
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
  assert.equal(calls.some((call) => call.method === "poll"), true);
  const overwrites = calls.find((call) => call.method === "create").options.permissionOverwrites;
  assert.deepEqual(overwrites[0], { id: "guild", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(overwrites.slice(1).map((entry) => entry.id), ["bot", "caller", "owner"]);
});

test("existing channel visibility is shown before activation and permissions stay unchanged", async () => {
  const { controller, command, calls, existing, managed } = fixture();
  await controller.handleInteraction(command("import", { server: "new-id", game: "minecraft", activate: true, channel: existing }));
  assert.equal(managed[0].active, false);
  assert.match(calls.at(-1).payload.content, /currently visible to @everyone/);
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
  assert.equal(managed[0].published, true);
  assert.equal(config.servers.at(-1).published, true);
  assert.deepEqual(calls.find((call) => call.method === "permission-edit").permissions, { ViewChannel: true });
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
  assert.equal(managed[0].published, false);
  assert.deepEqual(calls.filter((call) => call.method === "permission-edit").map((call) => call.permissions), [
    { ViewChannel: true }, { ViewChannel: false }
  ]);
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
