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
