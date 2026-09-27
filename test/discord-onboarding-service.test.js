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
      async createStatusChannel() { return { id: "status" }; },
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
  assert.deepEqual(persisted, [{ adminChannelId: "admin", statusChannelId: "status" }]);
  assert.equal(sent[0].channelId, "admin");
  assert.match(calls.at(-1).payload.content, /Continue by running/);
});

test("/bridge setup validates the panel and offers unimported servers", async () => {
  const config = {
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    servers: [{ pterodactylServerId: "already" }]
  };
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {},
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
    discord: { adminChannelId: "admin", statusChannelId: "status" },
    servers: []
  };
  const imported = [];
  let reloadCalls = 0;
  const service = new DiscordOnboardingService({
    config,
    discordBridge: {
      async createServerChannel() { return { id: "new-channel" }; }
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
