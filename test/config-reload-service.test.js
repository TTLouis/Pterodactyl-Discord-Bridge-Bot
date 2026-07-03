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
    kook: {
      guildId: "kook-guild",
      statusChannelId: "kook-status",
      logChannelId: "kook-logs",
      displayTimeZone: "Asia/Shanghai",
      serverAdminRoleName: "server-admin"
    },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: "key", pollIntervalSeconds: 60 },
    servers: [{
      name: "Server",
      description: "Old description",
      discordChannelId: "server-channel",
      kookChannelId: "kook-server-channel",
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
  next.kook.displayTimeZone = "Asia/Shanghai";
  next.servers[0].description = "New\n\ndescription";
  next.servers[0].maxPlayers = 20;

  applyReloadedConfig(current, next);

  assert.equal(current.servers[0], originalServer);
  assert.equal(originalServer.description, "New\n\ndescription");
  assert.equal(originalServer.maxPlayers, 20);
  assert.equal(current.discord.displayTimeZone, "America/Toronto");
  assert.equal(current.kook.displayTimeZone, "Asia/Shanghai");
});

test("live reload applies polling interval changes", () => {
  const current = createConfig();
  const originalPterodactyl = current.pterodactyl;
  const next = createConfig();
  next.pterodactyl.pollIntervalSeconds = 300;
  next.pterodactyl.activePlayerPollIntervalSeconds = 30;

  applyReloadedConfig(current, next);

  assert.equal(current.pterodactyl, originalPterodactyl);
  assert.equal(current.pterodactyl.pollIntervalSeconds, 300);
  assert.equal(current.pterodactyl.activePlayerPollIntervalSeconds, 30);
});

test("live reload still rejects Pterodactyl connection changes", () => {
  const current = createConfig();
  const next = createConfig();
  next.pterodactyl.baseUrl = "https://different-panel.example.com";

  assert.throws(
    () => validateReloadCompatibility(current, next),
    /Pterodactyl connection settings changed/
  );
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

test("live reload rejects KOOK structural changes", () => {
  const current = createConfig();
  const next = createConfig();
  next.kook.statusChannelId = "different-kook-status";

  assert.throws(
    () => validateReloadCompatibility(current, next),
    /KOOK channel or guild settings changed/
  );
});

test("live reload rejects server KOOK channel changes", () => {
  const current = createConfig();
  const next = createConfig();
  next.servers[0].kookChannelId = "different-kook-channel";

  assert.throws(
    () => validateReloadCompatibility(current, next),
    /KOOK channel changed/
  );
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

test("live reload accepts Satisfactory API setting changes", () => {
  const current = createConfig({
    servers: [{
      name: "Factory",
      description: "Old description",
      discordChannelId: "server-channel",
      kookChannelId: "kook-server-channel",
      pterodactylServerId: "server-id",
      publicAddress: "factory.example.com",
      publicPort: 7777,
      maxPlayers: 8,
      game: {
        type: "satisfactory",
        apiUrl: "https://factory.example.com:7777/api/v1",
        apiToken: "old-token",
        allowInsecureTls: true,
        apiRequestTimeoutMs: 10000,
        chatCommandTemplate: null
      },
      autoStop: null
    }]
  });
  const originalServer = current.servers[0];
  const next = createConfig({
    servers: [{
      ...current.servers[0],
      game: {
        ...current.servers[0].game,
        apiToken: "new-token",
        apiRequestTimeoutMs: 5000
      }
    }]
  });

  applyReloadedConfig(current, next);

  assert.equal(current.servers[0], originalServer);
  assert.equal(current.servers[0].game.apiToken, "new-token");
  assert.equal(current.servers[0].game.apiRequestTimeoutMs, 5000);
});

test("live reload rejects game type changes even when Satisfactory is involved", () => {
  const current = createConfig();
  const next = createConfig();
  next.servers[0].game = {
    type: "satisfactory",
    apiUrl: "https://factory.example.com:7777/api/v1",
    apiToken: "token",
    allowInsecureTls: true,
    apiRequestTimeoutMs: 10000
  };

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
