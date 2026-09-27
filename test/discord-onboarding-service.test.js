import assert from "node:assert/strict";
import test from "node:test";
import { DiscordOnboardingService } from "../src/services/discord-onboarding-service.js";

function ownerInteraction(overrides = {}) {
  const calls = [];
  return {
    calls,
    interaction: {
      guild: { ownerId: "owner" },
      user: { id: "owner", username: "owner" },
      memberPermissions: null,
      channelId: "general",
      deferred: false,
      replied: false,
      isChatInputCommand() { return true; },
      isStringSelectMenu() { return false; },
      options: { getSubcommand() { return "setup"; } },
      async deferReply(payload) { calls.push({ method: "deferReply", payload }); this.deferred = true; },
      async editReply(payload) { calls.push({ method: "editReply", payload }); },
      async reply(payload) { calls.push({ method: "reply", payload }); this.replied = true; },
      async followUp(payload) { calls.push({ method: "followUp", payload }); },
      ...overrides
    }
  };
}

test("/bridge setup creates dedicated admin and status channels on first run", async () => {
  const config = { discord: {}, servers: [] };
  const persisted = [];
  const sent = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {
      async createPrivateAdminChannel() { return { id: "admin" }; },
      async ensureServerCategories() {
        return { activeCategoryId: "active-category", archiveCategoryId: "archive-category" };
      },
      async createStatusChannel({ parentId }) {
        assert.equal(parentId, "active-category");
        return { id: "status" };
      },
      async sendMessage(channelId, content) { sent.push({ channelId, content }); }
    },
    pterodactylClient: { async listServers() { throw new Error("should not be called yet"); } },
    configStore: {
      updateDiscordChannels(value) { persisted.push(value); }
    },
    logger: { info() {}, error() {} }
  });

  const { interaction, calls } = ownerInteraction();
  await service.handleInteraction(interaction);

  assert.equal(config.discord.adminChannelId, "admin");
  assert.equal(config.discord.statusChannelId, "status");
  assert.equal(config.discord.activeServerCategoryId, "active-category");
  assert.equal(config.discord.archiveServerCategoryId, "archive-category");
  assert.equal(persisted.at(-1).adminChannelId, "admin");
  assert.equal(persisted.at(-1).statusChannelId, "status");
  assert.equal(persisted.at(-1).activeServerCategoryId, "active-category");
  assert.equal(persisted.at(-1).archiveServerCategoryId, "archive-category");
  assert.equal(sent[0].channelId, "admin");
  assert.match(calls.at(-1).payload.content, /Continue by running/);
});

test("/bridge setup validates the panel and offers unimported servers", async () => {
  const config = {
    discord: {
      adminChannelId: "admin",
      statusChannelId: "status",
      activeServerCategoryId: "active-category",
      archiveServerCategoryId: "archive-category"
    },
    servers: [{ pterodactylServerId: "already" }]
  };
  const service = new DiscordOnboardingService({
    config,
    discordBridge: { async setChannelCategory() {} },
    pterodactylClient: {
      async listServers() {
        return [
          { identifier: "already", name: "Existing", description: null },
          { identifier: "new-id", name: "New Factory", description: "Fresh map" }
        ];
      }
    },
    configStore: {},
    logger: { info() {}, error() {} }
  });

  const { interaction, calls } = ownerInteraction({ channelId: "admin" });
  await service.handleInteraction(interaction);

  const reply = calls.find((call) => call.method === "editReply")?.payload;
  assert.match(reply.content, /Found 2 accessible server/);
  assert.equal(reply.components.length, 1);
});

test("game selection persists and activates a discovered server", async () => {
  const config = {
    discord: {
      adminChannelId: "admin",
      statusChannelId: "status",
      activeServerCategoryId: "active-category",
      archiveServerCategoryId: "archive-category"
    },
    servers: []
  };
  const imported = [];
  let reloadCalls = 0;
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {
      async createServerChannel(_name, { parentId }) {
        assert.equal(parentId, "active-category");
        return { id: "new-channel" };
      }
    },
    pterodactylClient: {
      async listServers() {
        return [{ identifier: "factory-id", name: "Factory", description: null }];
      }
    },
    configStore: {
      addServer(server) { imported.push(server); }
    },
    logger: { info() {}, error() {} },
    async onConfigChanged() {
      reloadCalls += 1;
      return true;
    }
  });

  const calls = [];
  const interaction = {
    guild: { ownerId: "owner" },
    user: { id: "owner", username: "owner" },
    memberPermissions: null,
    channelId: "admin",
    customId: "bridge:game:factory-id",
    values: ["factorio"],
    deferred: false,
    replied: false,
    isChatInputCommand() { return false; },
    isStringSelectMenu() { return true; },
    async deferUpdate() { calls.push({ method: "deferUpdate" }); this.deferred = true; },
    async editReply(payload) { calls.push({ method: "editReply", payload }); },
    async reply(payload) { calls.push({ method: "reply", payload }); this.replied = true; },
    async followUp(payload) { calls.push({ method: "followUp", payload }); }
  };

  await service.handleInteraction(interaction);

  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0], {
    name: "Factory",
    pterodactylServerId: "factory-id",
    discordChannelId: "new-channel",
    game: { type: "factorio" },
    autoStop: { enabled: false }
  });
  assert.equal(reloadCalls, 1);
  assert.match(calls.at(-1).payload.content, /Imported \*\*Factory\*\*/);
});


test("/bridge servers shows managed and discoverable servers", async () => {
  const config = {
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    pterodactyl: { baseUrl: "https://panel.example.test", apiKey: "hidden-key" },
    features: { gameChatRelayEnabled: false },
    servers: [{
      name: "Factory",
      pterodactylServerId: "factory-id",
      discordChannelId: "factory-channel",
      archived: false,
      game: { type: "factorio" },
      autoStop: null
    }]
  };
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: {
      async listServers() {
        return [
          { identifier: "factory-id", name: "Factory" },
          { identifier: "minecraft-id", name: "Minecraft" }
        ];
      }
    },
    configStore: {},
    logger: { info() {}, warn() {}, error() {} }
  });
  const { interaction, calls } = ownerInteraction({
    channelId: "admin",
    options: { getSubcommand() { return "servers"; } }
  });

  await service.handleInteraction(interaction);

  const reply = calls.find((call) => call.method === "editReply")?.payload.content;
  assert.match(reply, /Managed servers \(1\)/);
  assert.match(reply, /Factory/);
  assert.match(reply, /Available to import \(1\)/);
  assert.match(reply, /Minecraft/);
});

test("/bridge connection hides the API key", async () => {
  const config = {
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    pterodactyl: { baseUrl: "https://panel.example.test", apiKey: "super-secret-api-key" },
    features: { gameChatRelayEnabled: false },
    servers: []
  };
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: { async listServers() { return [{ identifier: "one", name: "One" }]; } },
    configStore: {},
    logger: { info() {}, warn() {}, error() {} }
  });
  const { interaction, calls } = ownerInteraction({
    channelId: "admin",
    options: { getSubcommand() { return "connection"; } }
  });

  await service.handleInteraction(interaction);

  const reply = calls.find((call) => call.method === "editReply")?.payload.content;
  assert.match(reply, /connection: healthy/);
  assert.match(reply, /panel\.example\.test/);
  assert.doesNotMatch(reply, /super-secret-api-key/);
});

test("/bridge configure persists safe live settings", async () => {
  const config = {
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    pterodactyl: { baseUrl: "https://panel.example.test", apiKey: "hidden" },
    features: { gameChatRelayEnabled: false },
    servers: [{
      name: "Factory",
      pterodactylServerId: "factory-id",
      discordChannelId: "factory-channel",
      archived: false,
      game: { type: "factorio" },
      autoStop: null
    }]
  };
  const updates = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: {},
    configStore: {
      updateServer(serverId, next) {
        updates.push({ serverId, next });
        Object.assign(config.servers[0], next);
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    async onConfigChanged() { return true; }
  });
  const options = {
    getSubcommand() { return "configure"; },
    getString(name) {
      if (name === "server") return "factory-id";
      if (name === "name") return "Factory Prime";
      return null;
    },
    getBoolean(name) {
      if (name === "archived") return false;
      if (name === "auto-stop") return true;
      return null;
    },
    getNumber(name) {
      if (name === "empty-hours") return 8;
      if (name === "warning-minutes") return 30;
      return null;
    }
  };
  const { interaction, calls } = ownerInteraction({ channelId: "admin", options });

  await service.handleInteraction(interaction);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].serverId, "factory-id");
  assert.deepEqual(updates[0].next, {
    name: "Factory Prime",
    archived: false,
    autoStop: { enabled: true, emptyTimeoutHours: 8, warningMinutesBefore: 30 }
  });
  assert.match(calls.at(-1).payload.content, /Updated \*\*Factory Prime\*\*/);
});

test("/bridge configure rejects an auto-stop warning longer than the timeout", async () => {
  const config = {
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    servers: [{
      name: "Factory",
      pterodactylServerId: "factory-id",
      discordChannelId: "factory-channel",
      game: { type: "factorio" },
      autoStop: null
    }]
  };
  let writes = 0;
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: {},
    configStore: { updateServer() { writes += 1; } },
    logger: { info() {}, warn() {}, error() {} }
  });
  const options = {
    getSubcommand() { return "configure"; },
    getString(name) { return name === "server" ? "factory-id" : null; },
    getBoolean(name) { return name === "auto-stop" ? true : null; },
    getNumber(name) {
      if (name === "empty-hours") return 1;
      if (name === "warning-minutes") return 60;
      return null;
    }
  };
  const { interaction, calls } = ownerInteraction({ channelId: "admin", options });

  await service.handleInteraction(interaction);

  assert.equal(writes, 0);
  assert.match(calls.at(-1).payload.content, /warning time must be shorter/);
});

test("managed-server autocomplete returns matching identifiers", async () => {
  const config = {
    discord: { adminChannelId: "admin" },
    servers: [
      { name: "Factorio Factory", pterodactylServerId: "factorio-id" },
      { name: "Minecraft", pterodactylServerId: "mc-id" }
    ]
  };
  const responses = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: {},
    configStore: {},
    logger: { info() {}, warn() {}, error() {} }
  });
  await service.handleInteraction({
    guild: { ownerId: "owner" },
    user: { id: "owner" },
    commandName: "bridge",
    isAutocomplete() { return true; },
    options: { getFocused() { return { name: "server", value: "fact" }; } },
    async respond(value) { responses.push(value); }
  });

  assert.deepEqual(responses[0], [{ name: "Factorio Factory · factorio-id", value: "factorio-id" }]);
});


test("Satisfactory modal persists the token without echoing or logging it", async () => {
  const config = {
    discord: {
      adminChannelId: "admin",
      statusChannelId: "status",
      activeServerCategoryId: "active-category",
      archiveServerCategoryId: "archive-category"
    },
    servers: []
  };
  const imported = [];
  const logs = [];
  const calls = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {
      async createServerChannel(_name, { parentId }) {
        assert.equal(parentId, "active-category");
        return { id: "sat-channel" };
      }
    },
    pterodactylClient: {
      async listServers() { return [{ identifier: "sat-id", name: "Satisfactory" }]; }
    },
    configStore: { addServer(server) { imported.push(server); } },
    logger: {
      info(message, details) { logs.push({ message, details }); },
      warn() {},
      error(message, details) { logs.push({ message, details }); }
    },
    async onConfigChanged() { return true; }
  });
  const interaction = {
    guild: { ownerId: "owner" },
    user: { id: "owner" },
    channelId: "admin",
    customId: "bridge:satisfactory:sat-id",
    deferred: false,
    replied: false,
    isAutocomplete() { return false; },
    isChatInputCommand() { return false; },
    isModalSubmit() { return true; },
    isStringSelectMenu() { return false; },
    fields: {
      getTextInputValue(name) {
        if (name === "api-token") return "very-secret-token";
        if (name === "api-url") return "";
        return "";
      }
    },
    async deferReply(payload) { calls.push({ method: "deferReply", payload }); this.deferred = true; },
    async editReply(payload) { calls.push({ method: "editReply", payload }); },
    async reply(payload) { calls.push({ method: "reply", payload }); this.replied = true; },
    async followUp(payload) { calls.push({ method: "followUp", payload }); }
  };

  await service.handleInteraction(interaction);

  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].game, { type: "satisfactory", apiToken: "very-secret-token" });
  const visible = JSON.stringify(calls);
  assert.doesNotMatch(visible, /very-secret-token/);
  assert.doesNotMatch(JSON.stringify(logs), /very-secret-token/);
  assert.match(calls.at(-1).payload.content, /stored without being echoed back/);
});

test("/bridge backup creates a local backup without attaching it to Discord", async () => {
  const config = { discord: { adminChannelId: "admin" }, servers: [] };
  const calls = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
    pterodactylClient: {},
    configStore: { createBackup() { return "/data/backups/bridge-config-test.json"; } },
    logger: { info() {}, warn() {}, error() {} }
  });
  const { interaction } = ownerInteraction({
    channelId: "admin",
    options: { getSubcommand() { return "backup"; } },
    async reply(payload) { calls.push(payload); this.replied = true; }
  });

  await service.handleInteraction(interaction);

  assert.equal(calls.length, 1);
  assert.match(calls[0].content, /bridge-config-test\.json/);
  assert.equal(calls[0].files, undefined);
});


test("/bridge configure moves archived servers into the hidden archive category", async () => {
  const config = {
    discord: {
      adminChannelId: "admin",
      statusChannelId: "status",
      activeServerCategoryId: "active-category",
      archiveServerCategoryId: "archive-category"
    },
    servers: [{
      name: "Factory",
      pterodactylServerId: "factory-id",
      discordChannelId: "factory-channel",
      archived: false,
      game: { type: "factorio" },
      autoStop: null
    }]
  };
  const placements = [];
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {
      async setServerChannelArchived(channelId, archived, categories) {
        placements.push({ channelId, archived, categories });
      }
    },
    pterodactylClient: {},
    configStore: {
      updateServer(serverId, updates) {
        assert.equal(serverId, "factory-id");
        Object.assign(config.servers[0], updates);
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    async onConfigChanged() { return true; }
  });
  const options = {
    getSubcommand() { return "configure"; },
    getString(name) { return name === "server" ? "factory-id" : null; },
    getBoolean(name) { return name === "archived" ? true : null; },
    getNumber() { return null; }
  };
  const { interaction, calls } = ownerInteraction({ channelId: "admin", options });

  await service.handleInteraction(interaction);

  assert.equal(config.servers[0].archived, true);
  assert.deepEqual(placements, [{
    channelId: "factory-channel",
    archived: true,
    categories: {
      activeCategoryId: "active-category",
      archiveCategoryId: "archive-category"
    }
  }]);
  assert.match(calls.at(-1).payload.content, /hidden archive category/);
});
