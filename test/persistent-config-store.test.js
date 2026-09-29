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
    assert.equal(config.schemaVersion, 1);
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
    store.updateManagedServer("new-sat", { active: true }, { apiToken: "sat_private_value" });
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
