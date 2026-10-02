import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentConfigStore } from "../src/lib/persistent-config-store.js";

const legacyConfig = {
  discord: { guildId: "guild", statusChannelId: "status" },
  pterodactyl: { baseUrl: "https://panel.example.com", apiKey: "ptlc_private_value" },
  servers: [{
    name: "Satisfactory",
    pterodactylServerId: "server-id",
    discordChannelId: "server-channel",
    game: { type: "satisfactory", apiToken: "satisfactory_private_value" }
  }]
};

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-store-"));
  const configPath = path.join(directory, "persistent-config.json");
  const secretsPath = path.join(directory, "persistent-secrets.json");
  const errors = [];
  const makeStore = () => new PersistentConfigStore({
    configPath,
    secretsPath,
    logger: { error: (message) => errors.push(message) }
  });
  try {
    return run({ directory, configPath, secretsPath, makeStore, errors });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("legacy import separates credentials into private, atomic files", () => {
  withStore(({ directory, configPath, secretsPath, makeStore }) => {
    const store = makeStore();
    assert.equal(store.load(), true);
    assert.equal(store.syncLegacyConfig(legacyConfig), true);

    const configText = fs.readFileSync(configPath, "utf8");
    const secretText = fs.readFileSync(secretsPath, "utf8");
    const config = JSON.parse(configText);
    const secrets = JSON.parse(secretText);
    assert.equal(config.schemaVersion, 2);
    assert.equal(config.source, "legacy");
    assert.equal(config.settings.pterodactyl.apiKeyRef, "pterodactyl/default/client-api-key");
    assert.equal(config.settings.servers[0].game.apiTokenRef, "server/server-id/satisfactory-api-token");
    assert.equal(configText.includes("ptlc_private_value"), false);
    assert.equal(configText.includes("satisfactory_private_value"), false);
    assert.equal(secrets.values["pterodactyl/default/client-api-key"], "ptlc_private_value");
    assert.equal(secrets.values["server/server-id/satisfactory-api-token"], "satisfactory_private_value");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["persistent-config.json", "persistent-secrets.json"]);
  });
});

test("admin channel persists across restart and later legacy imports", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const first = makeStore();
    first.load();
    first.syncLegacyConfig(legacyConfig);
    first.setAdminChannelId("guild", "bridge-admin-channel");

    const restarted = makeStore();
    assert.equal(restarted.load(), true);
    assert.equal(restarted.getAdminChannelId("guild"), "bridge-admin-channel");
    assert.equal(restarted.syncLegacyConfig({
      ...legacyConfig,
      servers: [{ ...legacyConfig.servers[0], name: "Renamed" }]
    }), true);
    assert.equal(restarted.getAdminChannelId("guild"), "bridge-admin-channel");
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).settings.servers[0].name, "Renamed");
    assert.equal(JSON.parse(fs.readFileSync(secretsPath, "utf8")).values["pterodactyl/default/client-api-key"], "ptlc_private_value");
  });
});

test("damaged or unsupported documents block setup without being overwritten", () => {
  for (const badDocument of ["{broken", JSON.stringify({ schemaVersion: 99, source: "legacy", settings: {}, administration: {} })]) {
    withStore(({ configPath, secretsPath, makeStore, errors }) => {
      fs.writeFileSync(configPath, badDocument);
      fs.writeFileSync(secretsPath, JSON.stringify({ schemaVersion: 1, values: {} }));
      const store = makeStore();
      assert.equal(store.load(), false);
      assert.equal(store.syncLegacyConfig(legacyConfig), false);
      assert.throws(() => store.getAdminChannelId("guild"), /unavailable/);
      assert.equal(fs.readFileSync(configPath, "utf8"), badDocument);
      assert.equal(errors.some((message) => message.includes("ptlc_private_value")), false);
    });
  }
});

test("a failed store write disables setup without changing the legacy input", () => {
  withStore(({ configPath, makeStore, errors }) => {
    const store = makeStore();
    store.load();
    fs.mkdirSync(configPath);
    assert.equal(store.syncLegacyConfig(legacyConfig), false);
    assert.throws(() => store.getAdminChannelId("guild"), /unavailable/);
    assert.equal(legacyConfig.pterodactyl.apiKey, "ptlc_private_value");
    assert.equal(errors.some((message) => message.includes("ptlc_private_value")), false);
  });
});

test("Discord-managed connection and inactive imports survive legacy sync and restart", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const first = makeStore();
    first.load();
    first.syncLegacyConfig(legacyConfig);
    first.setConnectionKey("ptlc_new_private_value", legacyConfig.pterodactyl.baseUrl);
    first.addManagedServer({
      name: "New World", pterodactylServerId: "new-id", game: { type: "minecraft" },
      active: false, published: false, archived: false, discordChannelId: null
    });
    assert.throws(() => first.addManagedServer({ pterodactylServerId: "new-id" }), /already linked/);
    first.syncLegacyConfig({ ...legacyConfig, pterodactyl: { ...legacyConfig.pterodactyl, apiKey: "ptlc_old_changed" } });
    const restarted = makeStore();
    assert.equal(restarted.load(), true);
    assert.equal(restarted.getConnectionKey(), "ptlc_new_private_value");
    assert.equal(restarted.getManagedServers()[0].active, false);
    assert.equal(fs.readFileSync(configPath, "utf8").includes("ptlc_new_private_value"), false);
    assert.equal(JSON.parse(fs.readFileSync(secretsPath, "utf8")).values["pterodactyl/default/client-api-key"], "ptlc_new_private_value");
    restarted.updateManagedServer("new-id", { active: true, discordChannelId: "private-channel" });
    const afterActivation = makeStore();
    assert.equal(afterActivation.load(), true);
    assert.equal(afterActivation.getManagedServers()[0].discordChannelId, "private-channel");
  });
});

test("Satisfactory activation token stays outside ordinary persistent configuration", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const store = makeStore();
    store.load();
    store.syncLegacyConfig(legacyConfig);
    store.addManagedServer({ name: "Factory", pterodactylServerId: "new-sat", game: { type: "satisfactory" }, active: false, published: false, archived: false });
    store.updateManagedServer("new-sat", { active: true, discordChannelId: "sat-channel" }, { apiToken: "sat_private_value" });
    assert.equal(store.getManagedServers()[0].game.apiToken, "sat_private_value");
    assert.equal(fs.readFileSync(configPath, "utf8").includes("sat_private_value"), false);
    assert.equal(fs.readFileSync(secretsPath, "utf8").includes("sat_private_value"), true);
  });
});

test("damaged managed imports disable administration without replacing legacy files", () => {
  withStore(({ configPath, makeStore }) => {
    const first = makeStore();
    first.load();
    first.syncLegacyConfig(legacyConfig);
    const document = JSON.parse(fs.readFileSync(configPath, "utf8"));
    document.managed.servers = [{
      name: "Broken", pterodactylServerId: "broken", active: true, published: false,
      archived: false, discordChannelId: "channel", publicPort: "invalid",
      game: { type: "minecraft" }
    }];
    fs.writeFileSync(configPath, JSON.stringify(document));
    const restarted = makeStore();
    assert.equal(restarted.load(), false);
    assert.equal(restarted.syncLegacyConfig(legacyConfig), false);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).managed.servers[0].publicPort, "invalid");
  });
});

test("empty managed installation claims one guild and survives restart", () => {
  withStore(({ makeStore }) => {
    const store = makeStore();
    assert.equal(store.load(), true);
    assert.equal(store.initialize(), true);
    assert.equal(store.initialize(), false);
    assert.equal(store.getGuildId(), null);
    assert.equal(store.claimGuild("guild"), true);
    assert.equal(store.claimGuild("guild"), false);
    assert.throws(() => store.claimGuild("other"), /Guild/);
    store.setAdminChannelId("guild", "private");
    store.setCardMessageId("server", "message");
    store.updateSettings({ discord: { statusChannelId: "status" } });
    const restarted = makeStore();
    assert.equal(restarted.load(), true);
    assert.equal(restarted.getGuildId(), "guild");
    assert.equal(restarted.getAdminChannelId("guild"), "private");
    assert.equal(restarted.getCardMessageId("server"), "message");
    assert.equal(restarted.getRuntimeConfig().discord.statusChannelId, "status");
    assert.deepEqual(restarted.getRuntimeConfig().servers, []);
  });
});

test("migration backs up private data, rejects conflicts and makes managed configuration authoritative", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.syncLegacyConfig(legacyConfig);
    assert.deepEqual(store.migrateLegacyConfig({ ...legacyConfig, discord: { guildId: "other" } }).conflicts, ["guild"]);
    const migrated = store.migrateLegacyConfig(legacyConfig);
    assert.equal(migrated.migrated, true);
    assert.equal(fs.statSync(migrated.backupPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(migrated.backupPath)).legacy.pterodactyl.apiKey, legacyConfig.pterodactyl.apiKey);
    store.updateManagedServer("server-id", { name: "Managed name", active: false, archived: true, published: true });
    assert.equal(store.syncLegacyConfig({ ...legacyConfig, servers: [] }), true);
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.document.source, "managed");
    assert.equal(restarted.getRuntimeConfig().servers[0].name, "Managed name");
    assert.equal(restarted.getRuntimeConfig().servers[0].game.apiToken, "satisfactory_private_value");
    assert.equal(restarted.document.settings.servers.length, 0);
  });
});

test("interrupted two-file transaction recovers its complete configuration and credentials", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const store = makeStore(); store.load(); store.initialize(); store.claimGuild("guild");
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === configPath) throw new Error("simulated interrupted config commit");
      return originalRename(source, target);
    };
    try { assert.throws(() => store.setConnectionKey("replacement-secret", "https://new-panel.example"), /unavailable/); }
    finally { fs.renameSync = originalRename; }
    assert.equal(fs.existsSync(`${configPath}.journal`), true);
    assert.equal(JSON.parse(fs.readFileSync(configPath)).managed.connection, null);
    assert.equal(JSON.parse(fs.readFileSync(secretsPath)).values["pterodactyl/default/client-api-key"], "replacement-secret");
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.getRuntimeConfig().pterodactyl.baseUrl, "https://new-panel.example");
    assert.equal(restarted.getConnectionKey(), "replacement-secret");
    assert.equal(fs.existsSync(`${configPath}.journal`), false);
  });
});

test("managed import secrets and audit events cannot leak modal credentials into export", () => {
  withStore(({ configPath, makeStore }) => {
    const store = makeStore(); store.load(); store.initialize();
    store.addManagedServer({ name: "Factory", pterodactylServerId: "sat", active: false, published: false,
      archived: false, game: { type: "satisfactory", apiToken: "private-game-token" } });
    store.recordAudit("server.import", { actorId: "123", serverId: "sat", apiToken: "secret" });
    assert.equal(store.getManagedServers()[0].game.apiToken, "private-game-token");
    assert.equal(fs.readFileSync(configPath, "utf8").includes("private-game-token"), false);
    const exported = JSON.stringify(store.exportRedacted());
    assert.equal(exported.includes("private-game-token"), false);
    assert.equal(exported.includes('"apiToken":"secret"'), false);
    assert.throws(() => store.recordAudit("a secret value"), /Invalid audit/);
  });
});

test("damaged recovery journal does not overwrite the last intact configuration", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const store = makeStore(); store.load(); store.initialize(); store.claimGuild("guild");
    const intact = fs.readFileSync(configPath, "utf8");
    const document = JSON.parse(intact);
    document.managed.servers.push({ name: "Broken", pterodactylServerId: "broken", active: true,
      published: true, archived: false, game: { type: "minecraft" } });
    fs.writeFileSync(`${configPath}.journal`, JSON.stringify({ schemaVersion: 2, document,
      secrets: JSON.parse(fs.readFileSync(secretsPath, "utf8")) }));
    const restarted = makeStore(); assert.equal(restarted.load(), false);
    assert.equal(fs.readFileSync(configPath, "utf8"), intact);
    assert.equal(fs.existsSync(`${configPath}.journal`), true);
  });
});

test("version-one private volume loads and upgrades without losing administration bindings", () => {
  withStore(({ configPath, secretsPath, makeStore }) => {
    const first = makeStore(); first.load(); first.syncLegacyConfig(legacyConfig); first.setAdminChannelId("guild", "private");
    for (const file of [configPath, secretsPath]) {
      const data = JSON.parse(fs.readFileSync(file)); data.schemaVersion = 1;
      fs.writeFileSync(file, JSON.stringify(data));
    }
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.getAdminChannelId("guild"), "private");
    restarted.setCardMessageId("server-id", "message");
    assert.equal(JSON.parse(fs.readFileSync(configPath)).schemaVersion, 2);
    assert.equal(JSON.parse(fs.readFileSync(secretsPath)).schemaVersion, 2);
    assert.equal(restarted.getConnectionKey(), legacyConfig.pterodactyl.apiKey);
  });
});

test("migration retains disjoint existing managed imports, settings and credentials", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.syncLegacyConfig(legacyConfig);
    store.setConnectionKey("managed-private-key", legacyConfig.pterodactyl.baseUrl);
    store.addManagedServer({ name: "Managed Factory", pterodactylServerId: "imported", pterodactylUuid: "imported-uuid",
      active: false, published: true, archived: true, discordChannelId: "retained-channel",
      game: { type: "satisfactory", apiToken: "managed-game-secret" } });
    const result = store.migrateLegacyConfig(legacyConfig);
    assert.equal(result.migrated, true);
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    const records = restarted.getManagedServers();
    assert.equal(records.length, 2);
    const imported = records.find((record) => record.pterodactylServerId === "imported");
    assert.equal(imported.archived, true); assert.equal(imported.published, true);
    assert.equal(imported.discordChannelId, "retained-channel");
    assert.equal(imported.game.apiToken, "managed-game-secret");
    assert.equal(restarted.getConnectionKey(), "managed-private-key");
    assert.equal(records.find((record) => record.pterodactylServerId === "server-id").game.apiToken, "satisfactory_private_value");
    assert.deepEqual(restarted.document.settings.servers, []);
  });
});

test("migration retains selected category routing, administration role and status binding", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.syncLegacyConfig(legacyConfig);
    store.setAdminChannelId("guild", "admin");
    store.configureCategories("guild", { privateCategoryId: "private", publicCategoryId: "semi-public", linkedChannelRoleId: "players" });
    store.updateSettings({ discord: { bridgeAdminRoleId: "operators", statusChannelId: "selected-status", statusChannelManaged: true } });
    assert.equal(store.migrateLegacyConfig(legacyConfig).migrated, true);
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    const discord = restarted.getRuntimeConfig().discord;
    assert.equal(discord.privateCategoryId, "private");
    assert.equal(discord.publicCategoryId, "semi-public");
    assert.equal(discord.linkedChannelRoleId, "players");
    assert.equal(discord.bridgeAdminRoleId, "operators");
    assert.equal(discord.statusChannelId, "selected-status");
    assert.equal(discord.statusChannelManaged, true);
    assert.equal(restarted.getCategoryId("guild"), "private");
  });
});

test("migration reports retained UUID and channel conflicts without overwriting imports", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.syncLegacyConfig(legacyConfig);
    store.addManagedServer({ name: "Existing", pterodactylServerId: "short", pterodactylUuid: "uuid",
      active: false, archived: false, published: false, discordChannelId: "retained-channel", game: { type: "minecraft" } });
    const before = store.exportRedacted();
    const result = store.migrateLegacyConfig({ ...legacyConfig, servers: [{ ...legacyConfig.servers[0], pterodactylServerId: "uuid", discordChannelId: "retained-channel" }] });
    assert.equal(result.migrated, false);
    assert.deepEqual(result.conflicts, ["server:uuid", "discord-channel:retained-channel"]);
    assert.deepEqual(store.exportRedacted(), before);
  });
});

test("category persistence preserves administration channel and saved card bindings across restart", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.initialize(); store.claimGuild("guild");
    store.setAdminChannelId("guild", "admin"); store.setCardMessageId("server", "message");
    store.setCategoryId("guild", "category");
    store.setAdminChannelId("guild", "new-admin");
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.getCategoryId("guild"), "category");
    assert.equal(restarted.getAdminChannelId("guild"), "new-admin");
    assert.equal(restarted.getCardMessageId("server"), "message");
    assert.throws(() => restarted.getCategoryId("other"), /Guild/);
    assert.throws(() => restarted.setCategoryId("other", "foreign"), /Guild/);
  });
});

test("private/public category and linked role configuration persists atomically without losing administration bindings", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.initialize(); store.claimGuild("guild");
    store.setAdminChannelId("guild", "admin"); store.setCardMessageId("server", "message");
    const ids = { privateCategoryId: "private", publicCategoryId: "public", linkedChannelRoleId: "linked-role" };
    store.configureCategories("guild", ids);
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.getCategoryId("guild"), "private");
    for (const [key, value] of Object.entries(ids)) assert.equal(restarted.getRuntimeConfig().discord[key], value);
    assert.equal(restarted.getAdminChannelId("guild"), "admin");
    assert.equal(restarted.getCardMessageId("server"), "message");
    const unchanged = restarted.exportRedacted();
    assert.throws(() => restarted.configureCategories("guild", { ...ids, publicCategoryId: "private" }), /must differ/);
    assert.throws(() => restarted.configureCategories("guild", { ...ids, linkedChannelRoleId: "" }), /required/);
    assert.throws(() => restarted.configureCategories("other", ids), /Guild/);
    assert.deepEqual(restarted.exportRedacted(), unchanged);
  });
});

test("legacy restart synchronization preserves administrator-selected private/public routing and linked role", () => {
  withStore(({ makeStore }) => {
    const store = makeStore(); store.load(); store.syncLegacyConfig(legacyConfig);
    const routing = { privateCategoryId: "private", publicCategoryId: "public", linkedChannelRoleId: "linked-role", bridgeAdminRoleId: "admin-role" };
    store.updateSettings({ discord: { bridgeAdminRoleId: routing.bridgeAdminRoleId } });
    store.configureCategories("guild", routing);
    const restarted = makeStore(); assert.equal(restarted.load(), true);
    assert.equal(restarted.syncLegacyConfig({ ...legacyConfig, discord: { ...legacyConfig.discord,
      privateCategoryId: "old-private", publicCategoryId: "old-public", linkedChannelRoleId: "old-role", bridgeAdminRoleId: "old-admin-role" } }), true);
    for (const [key, value] of Object.entries(routing)) assert.equal(restarted.getRuntimeConfig().discord[key], value);
    assert.equal(restarted.getCategoryId("guild"), "private");
    const again = makeStore(); assert.equal(again.load(), true);
    for (const [key, value] of Object.entries(routing)) assert.equal(again.getRuntimeConfig().discord[key], value);
  });
});

test("Source managed imports survive persistence and restart", () => {
  withStore(({ makeStore }) => {
    const store = makeStore();
    store.load();
    store.syncLegacyConfig(legacyConfig);
    store.addManagedServer({ name: "Source", pterodactylServerId: "source-id", active: false,
      published: false, archived: false, game: { type: "source" } });
    const restarted = makeStore();
    assert.equal(restarted.load(), true);
    assert.equal(restarted.available, true);
    assert.equal(restarted.getManagedServers()[0].game.type, "source");
  });
});
