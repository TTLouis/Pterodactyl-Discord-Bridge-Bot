import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReloadedConfig,
  ConfigReloadService,
  validateReloadCompatibility
} from "../src/services/config-reload-service.js";

function createConfig(overrides = {}) {
  return {
    discord: {
      guildId: "guild",
      statusChannelId: "status",
      logChannelId: "logs",
      displayTimeZone: "UTC",
      serverAdminRoleName: "server-admin"
    },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: "key", pollIntervalSeconds: 60 },
    servers: [{
      name: "Server",
      description: "Old description",
      discordChannelId: "server-channel",
      pterodactylServerId: "server-id",
      publicAddress: "old.example.com",
      publicPort: 1234,
      maxPlayers: 10,
      game: { type: "factorio", chatCommandTemplate: "/shout {content}" },
      autoStop: null
    }],
    ...overrides
  };
}

test("live reload updates server objects in place", () => {
  const current = createConfig();
  const originalServer = current.servers[0];
  const next = createConfig();
  next.discord.displayTimeZone = "America/Toronto";
  next.servers[0].description = "New\n\ndescription";
  next.servers[0].maxPlayers = 20;

  applyReloadedConfig(current, next);

  assert.equal(current.servers[0], originalServer);
  assert.equal(originalServer.description, "New\n\ndescription");
  assert.equal(originalServer.maxPlayers, 20);
  assert.equal(current.discord.displayTimeZone, "America/Toronto");
});

test("live reload rejects structural server changes", () => {
  const current = createConfig();
  const next = createConfig();
  next.servers[0].discordChannelId = "different-channel";

  assert.throws(
    () => validateReloadCompatibility(current, next),
    /restart the bot/
  );
  assert.equal(current.servers[0].discordChannelId, "server-channel");
});

test("live reload rejects game setting changes captured by adapters", () => {
  const current = createConfig();
  const next = createConfig();
  next.servers[0].game.chatCommandTemplate = "/shout UPDATED {content}";

  assert.throws(
    () => validateReloadCompatibility(current, next),
    /Game settings changed/
  );
});

test("failed reloads keep the running configuration", async () => {
  let reloadCalls = 0;
  const errors = [];
  const service = new ConfigReloadService({
    configPath: "unused.json",
    loadConfig() {
      throw new SyntaxError("Unexpected token");
    },
    async onReload() {
      reloadCalls += 1;
    },
    logger: {
      info() {},
      error(message) { errors.push(message); }
    }
  });

  assert.equal(await service.reloadNow(), false);
  assert.equal(reloadCalls, 0);
  assert.match(errors[0], /continuing with the previous configuration/);
});
