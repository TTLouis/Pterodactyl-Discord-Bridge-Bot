import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, normalizeDescription } from "../src/lib/config.js";

test("description preserves authored lines", () => {
  assert.equal(normalizeDescription({
    description: ["**Heading**", "", "中文说明"]
  }), "**Heading**\n\n中文说明");
});

test("description preserves intentional spacing", () => {
  assert.equal(normalizeDescription({
    description: ["  indented", "", "trailing  "]
  }), "  indented\n\ntrailing  ");
});

test("description must be an array of lines", () => {
  assert.equal(normalizeDescription({ description: "Single-line descriptions are no longer supported" }), "");
});

function loadFactorioConfig(game) {
  const previousEnv = {
    CONFIG_PATH: process.env.CONFIG_PATH,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    KOOK_ENABLED: process.env.KOOK_ENABLED,
    KOOK_TOKEN: process.env.KOOK_TOKEN
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-bot-factorio-config-"));
  const configPath = path.join(tempDir, "servers.json");

  fs.writeFileSync(configPath, JSON.stringify({
    discord: { guildId: "discord-guild", statusChannelId: "discord-status", displayTimeZone: "UTC" },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: "ptlc_test" },
    servers: [{
      name: "Factorio",
      discordChannelId: "discord-server",
      pterodactylServerId: "factorio-id",
      game
    }]
  }), "utf8");

  try {
    process.env.CONFIG_PATH = configPath;
    process.env.DISCORD_TOKEN = "discord-token";
    process.env.KOOK_ENABLED = "false";
    delete process.env.KOOK_TOKEN;
    return loadConfig();
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("Factorio relay config requires an executable command and content placeholder", () => {
  assert.throws(
    () => loadFactorioConfig({ type: "factorio", chatCommandTemplate: "{platform}: {content}" }),
    /Factorio server "Factorio" chatCommandTemplate must start with a Factorio console command/
  );

  assert.throws(
    () => loadFactorioConfig({ type: "factorio", chatCommandTemplate: "/shout {author}" }),
    /Factorio server "Factorio" chatCommandTemplate must include the \{content\} placeholder/
  );
});

test("Factorio relay config uses one core-resolved platform template", () => {
  const runtime = loadFactorioConfig({
    type: "factorio",
    chatCommandTemplate: "/shout {platform}<{author}>: {content}"
  });

  assert.equal(runtime.config.servers[0].game.chatCommandTemplate, "/shout {platform}<{author}>: {content}");
});

test("both configured Factorio servers use executable relay commands", () => {
  const rawConfig = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "servers.json"), "utf8"));
  const factorioServers = rawConfig.servers.filter((server) => server.game?.type === "factorio");

  assert.equal(factorioServers.length, 2);
  for (const server of factorioServers) {
    assert.match(server.game.chatCommandTemplate, /^\/shout .*\{content\}$/);
  }
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

function loadConfigWithServer(serverOverrides) {
  const previousEnv = {
    CONFIG_PATH: process.env.CONFIG_PATH,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    KOOK_ENABLED: process.env.KOOK_ENABLED,
    KOOK_TOKEN: process.env.KOOK_TOKEN
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-bot-server-config-"));
  const configPath = path.join(tempDir, "servers.json");

  fs.writeFileSync(configPath, JSON.stringify({
    discord: { guildId: "discord-guild", statusChannelId: "discord-status", displayTimeZone: "UTC" },
    pterodactyl: { baseUrl: "https://panel.example.com", apiKey: "ptlc_test" },
    servers: [{
      name: "Factorio",
      discordChannelId: "discord-server",
      pterodactylServerId: "factorio-id",
      game: { type: "factorio" },
      ...serverOverrides
    }]
  }), "utf8");

  try {
    process.env.CONFIG_PATH = configPath;
    process.env.DISCORD_TOKEN = "discord-token";
    process.env.KOOK_ENABLED = "false";
    delete process.env.KOOK_TOKEN;
    return loadConfig();
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("autoStop timeouts fall back to defaults when omitted", () => {
  const { config } = loadConfigWithServer({ autoStop: { enabled: true } });
  assert.deepEqual(config.servers[0].autoStop, {
    enabled: true,
    emptyTimeoutHours: 24,
    warningMinutesBefore: 60
  });
});

test("a zero autoStop timeout is rejected instead of silently defaulting", () => {
  assert.throws(
    () => loadConfigWithServer({ autoStop: { enabled: true, emptyTimeoutHours: 0 } }),
    /autoStop\.emptyTimeoutHours must be a positive number/
  );
});

test("a non-numeric autoStop timeout is rejected", () => {
  assert.throws(
    () => loadConfigWithServer({ autoStop: { enabled: true, warningMinutesBefore: "soon" } }),
    /autoStop\.warningMinutesBefore must be a positive number/
  );
});

test("a warning window wider than the idle window is rejected", () => {
  assert.throws(
    () => loadConfigWithServer({
      autoStop: { enabled: true, emptyTimeoutHours: 1, warningMinutesBefore: 120 }
    }),
    /warningMinutesBefore \(120\) must be less than autoStop\.emptyTimeoutHours in minutes \(60\)/
  );
});

test("disabled autoStop skips numeric validation entirely", () => {
  const { config } = loadConfigWithServer({ autoStop: { enabled: false, emptyTimeoutHours: 0 } });
  assert.equal(config.servers[0].autoStop, null);
});

test("publicPort is normalized to a number and defaults to null", () => {
  assert.equal(loadConfigWithServer({ publicPort: "34197" }).config.servers[0].publicPort, 34197);
  assert.equal(loadConfigWithServer({}).config.servers[0].publicPort, null);
});

test("an out-of-range publicPort is rejected", () => {
  assert.throws(
    () => loadConfigWithServer({ publicPort: 70000 }),
    /publicPort must be an integer between 1 and 65535/
  );
  assert.throws(
    () => loadConfigWithServer({ publicPort: "not-a-port" }),
    /publicPort must be an integer between 1 and 65535/
  );
});

test("playerListRefreshIntervalSeconds defaults to 900 and rejects invalid values", () => {
  assert.equal(
    loadConfigWithServer({}).config.servers[0].game.playerListRefreshIntervalSeconds,
    900
  );
  assert.throws(
    () => loadConfigWithServer({ game: { type: "factorio", playerListRefreshIntervalSeconds: -5 } }),
    /game\.playerListRefreshIntervalSeconds must be a positive number/
  );
});
