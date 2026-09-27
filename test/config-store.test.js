import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/services/config-store.js";

test("ConfigStore persists onboarding channels and imported servers atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-store-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: {},
      pterodactyl: {},
      features: { gameChatRelayEnabled: false },
      servers: []
    }), "utf8");

    const store = new ConfigStore(configPath);
    store.updateDiscordChannels({ adminChannelId: "admin", statusChannelId: "status" });
    store.addServer({
      name: "Factory",
      pterodactylServerId: "factory-id",
      discordChannelId: "factory-channel",
      game: { type: "factorio" }
    });

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.discord.adminChannelId, "admin");
    assert.equal(persisted.discord.statusChannelId, "status");
    assert.equal(persisted.servers.length, 1);
    assert.equal(persisted.servers[0].pterodactylServerId, "factory-id");

    assert.throws(
      () => store.addServer({
        name: "Factory Duplicate",
        pterodactylServerId: "factory-id",
        discordChannelId: "other-channel",
        game: { type: "factorio" }
      }),
      /already imported/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("ConfigStore updates safe server settings without changing topology", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-update-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: {},
      pterodactyl: {},
      servers: [{
        name: "Factory",
        pterodactylServerId: "factory-id",
        discordChannelId: "factory-channel",
        game: { type: "factorio" },
        autoStop: { enabled: false }
      }]
    }), "utf8");

    const store = new ConfigStore(configPath);
    store.updateServer("factory-id", {
      name: "Factory Prime",
      archived: true,
      autoStop: { enabled: true, emptyTimeoutHours: 6, warningMinutesBefore: 30 }
    });

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const server = persisted.servers[0];
    assert.equal(server.name, "Factory Prime");
    assert.equal(server.archived, true);
    assert.deepEqual(server.autoStop, {
      enabled: true,
      emptyTimeoutHours: 6,
      warningMinutesBefore: 30
    });
    assert.equal(server.discordChannelId, "factory-channel");
    assert.equal(server.pterodactylServerId, "factory-id");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("ConfigStore creates local restricted backups", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-backup-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: {},
      pterodactyl: {},
      servers: [{
        name: "Satisfactory",
        pterodactylServerId: "sat-id",
        discordChannelId: "sat-channel",
        game: { type: "satisfactory", apiToken: "secret-token" }
      }]
    }), "utf8");

    const store = new ConfigStore(configPath);
    const backupPath = store.createBackup(new Date("2026-09-27T02:00:00.000Z"));
    assert.equal(path.basename(backupPath), "bridge-config-2026-09-27T02-00-00-000Z.json");
    assert.equal(path.dirname(backupPath), path.join(tempDir, "backups"));
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    assert.equal(backup.servers[0].game.apiToken, "secret-token");
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("ConfigStore removes managed servers without changing unrelated settings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-remove-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: { guildId: "guild" },
      pterodactyl: { baseUrl: "https://panel.example.test" },
      servers: [
        { name: "One", pterodactylServerId: "one", discordChannelId: "one-channel" },
        { name: "Two", pterodactylServerId: "two", discordChannelId: "two-channel" }
      ]
    }), "utf8");

    const store = new ConfigStore(configPath);
    const removed = store.removeServer("one");
    assert.equal(removed.name, "One");

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(persisted.servers.map((server) => server.pterodactylServerId), ["two"]);
    assert.equal(persisted.discord.guildId, "guild");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ConfigStore rebinds Discord channels and rejects duplicate bindings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-rebind-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: {},
      pterodactyl: {},
      servers: [
        { name: "One", pterodactylServerId: "one", discordChannelId: "one-channel" },
        { name: "Two", pterodactylServerId: "two", discordChannelId: "two-channel" }
      ]
    }), "utf8");

    const store = new ConfigStore(configPath);
    store.updateServerChannel("one", "replacement-channel");
    let persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.servers[0].discordChannelId, "replacement-channel");

    assert.throws(
      () => store.updateServerChannel("one", "two-channel"),
      /already bound to Two/
    );
    persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.servers[0].discordChannelId, "replacement-channel");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
