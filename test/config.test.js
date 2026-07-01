import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, normalizeDescription, resolvePollingInterval } from "../src/lib/config.js";

test("descriptionLines takes precedence and preserves authored lines", () => {
  assert.equal(normalizeDescription({
    description: "legacy",
    descriptionLines: ["**Heading**", "", "中文说明"]
  }), "**Heading**\n\n中文说明");
});

test("descriptionLines preserves intentional spacing", () => {
  assert.equal(normalizeDescription({
    descriptionLines: ["  indented", "", "trailing  "]
  }), "  indented\n\ntrailing  ");
});

test("legacy description strings remain supported", () => {
  assert.equal(normalizeDescription({ description: "  Legacy description  " }), "Legacy description");
});

test("servers.json polling intervals take precedence over legacy environment values", () => {
  assert.equal(resolvePollingInterval(300, "60", 60), 300);
});

test("legacy polling environment values remain a fallback", () => {
  assert.equal(resolvePollingInterval(undefined, "120", 60), 120);
});

test("loadConfig preserves KOOK top-level and per-server channel settings", () => {
  const previousEnv = {
    CONFIG_PATH: process.env.CONFIG_PATH,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    KOOK_ENABLED: process.env.KOOK_ENABLED,
    KOOK_TOKEN: process.env.KOOK_TOKEN
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-bot-config-"));
  const configPath = path.join(tempDir, "servers.json");

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      discord: {
        guildId: "discord-guild",
        statusChannelId: "discord-status",
        displayTimeZone: "UTC"
      },
      kook: {
        guildId: "kook-guild",
        statusChannelId: "kook-status",
        logChannelId: "kook-log",
        displayTimeZone: "Asia/Shanghai"
      },
      pterodactyl: {
        baseUrl: "https://panel.example.com",
        apiKey: "ptlc_test"
      },
      servers: [{
        name: "Factory",
        discordChannelId: "discord-server",
        kookChannelId: "kook-server",
        pterodactylServerId: "factory-id",
        game: {
          type: "factorio"
        }
      }]
    }), "utf8");

    process.env.CONFIG_PATH = configPath;
    process.env.DISCORD_TOKEN = "discord-token";
    process.env.KOOK_ENABLED = "false";
    delete process.env.KOOK_TOKEN;

    const runtime = loadConfig();

    assert.equal(runtime.config.kook.guildId, "kook-guild");
    assert.equal(runtime.config.kook.statusChannelId, "kook-status");
    assert.equal(runtime.config.kook.logChannelId, "kook-log");
    assert.equal(runtime.config.kook.displayTimeZone, "Asia/Shanghai");
    assert.equal(runtime.config.servers[0].kookChannelId, "kook-server");
    assert.equal(runtime.kookToken, null);
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
