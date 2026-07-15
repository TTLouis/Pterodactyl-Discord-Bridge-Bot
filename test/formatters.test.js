import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServerOfflineEmbed,
  buildServerOnlineEmbed,
  buildServerStartingStateEmbed,
  buildServerStoppingStateEmbed,
  buildStatusPanel
} from "../src/lib/formatters.js";

function createSnapshot(description) {
  return {
    name: "Test Server",
    description,
    publicAddress: "play.example.com",
    publicPort: 25565,
    maxPlayers: 20,
    playerCount: 0,
    onlinePlayers: [],
    memoryBytes: 1024,
    cpuPercent: 1,
    gameDurationMs: 60000,
    simplifiedStatus: "Online"
  };
}

function getInfoField(description) {
  const panel = buildStatusPanel([createSnapshot(description)], { displayTimeZone: "UTC" });
  return panel.embeds[0].toJSON().fields[0].value;
}

test("server descriptions preserve manual newlines and Discord Markdown", () => {
  const description = "**Version:** 2.0\nVanilla server\n\n- New players welcome\n中文说明";
  const value = getInfoField(description);

  assert.match(value, /\*\*Description\*\*\n\*\*Version:\*\* 2\.0\nVanilla server\n\n- New players welcome\n中文说明$/);
  assert.doesNotMatch(value, /Vanilla serv\ner/);
});

test("server descriptions still respect the Discord field length limit", () => {
  const value = getInfoField("x".repeat(2000));
  assert.ok(value.length <= 1024);
  assert.match(value, /\.\.\.$/);
});

test("server addresses render in code blocks for easier copying", () => {
  const value = getInfoField("");

  assert.match(value, /\*\*Server Address\*\*\n```text\nplay\.example\.com:25565\n```\n\*\*Description\*\*/);
});

test("server address field uses full embed width", () => {
  const panel = buildStatusPanel([createSnapshot("")], { displayTimeZone: "UTC" });
  const infoField = panel.embeds[0].toJSON().fields[0];

  assert.equal(infoField.inline, false);
});

test("status panels explain when player names are unavailable from the API", () => {
  const snapshot = createSnapshot("");
  snapshot.playerCount = 2;
  snapshot.onlinePlayers = null;
  snapshot.playerNamesAvailable = false;

  const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });
  const statusField = panel.embeds[0].toJSON().fields[1].value;

  assert.match(statusField, /Unavailable from API/);
});

test("status panels include Satisfactory progression state in server infos", () => {
  const snapshot = createSnapshot("");
  snapshot.gameDurationMs = 93784000;
  snapshot.satisfactoryState = {
    techTier: 7,
    activeSchematic: "Logistics Mk2",
    gamePhase: "Project Assembly"
  };

  const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });
  const serverInfoField = panel.embeds[0].toJSON().fields[2];

  assert.equal(serverInfoField.name, "Server Infos");
  assert.equal(serverInfoField.value, [
    "**RAM:** 0 MiB",
    "**CPU:** 1%",
    "",
    "**Total Game Duration**",
    "**Time:** 1d 2h 3m",
    "**Tier:** 7",
    "**Game Phase:** Project Assembly",
    "**Active Schematic:** Logistics Mk2"
  ].join("\n"));
});

test("status panels label cached game duration as last known", () => {
  const snapshot = createSnapshot("");
  snapshot.simplifiedStatus = "Offline";
  snapshot.gameDurationMs = 3720000;
  snapshot.gameDurationCached = true;

  const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });
  const serverInfoField = panel.embeds[0].toJSON().fields[2];

  assert.match(serverInfoField.value, /\*\*Last Known Time:\*\* 1h 2m/);
});

test("status panels distinguish auto-stopped servers from offline servers", () => {
  const snapshot = createSnapshot("");
  snapshot.simplifiedStatus = "Offline";
  snapshot.autoStopped = true;

  const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });
  const embed = panel.embeds[0].toJSON();
  const statusField = embed.fields[1].value;
  const offlineColor = buildServerOfflineEmbed("Test Server").toJSON().color;

  assert.match(statusField, /🟣 Auto-stopped/);
  assert.doesNotMatch(statusField, /🔴 Offline/);
  assert.equal(embed.color, 0x8b5cf6);
  assert.notEqual(embed.color, offlineColor);
});

test("status panels mark unavailable game duration explicitly", () => {
  const snapshot = createSnapshot("");
  snapshot.gameDurationMs = null;

  const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });
  const serverInfo = panel.embeds[0].data.fields.find((field) => field.name === "Server Infos");

  assert.match(serverInfo.value, /\*\*Time:\*\* Unavailable/);
});

test("status panel colors match lifecycle action colors", () => {
  const expectedColors = {
    Online: buildServerOnlineEmbed("Test Server").toJSON().color,
    Starting: buildServerStartingStateEmbed("Test Server").toJSON().color,
    Stopping: buildServerStoppingStateEmbed("Test Server").toJSON().color,
    Offline: buildServerOfflineEmbed("Test Server").toJSON().color
  };

  for (const [simplifiedStatus, expectedColor] of Object.entries(expectedColors)) {
    const snapshot = createSnapshot("");
    snapshot.simplifiedStatus = simplifiedStatus;

    const panel = buildStatusPanel([snapshot], { displayTimeZone: "UTC" });

    assert.equal(panel.embeds[0].toJSON().color, expectedColor);
  }
});

test("server online embeds can include start attribution", () => {
  const startedAt = new Date("2026-07-01T02:50:00.000Z");
  const embed = buildServerOnlineEmbed("Test Server", {
    startedBy: "Tester",
    startedAt
  }).toJSON();

  assert.match(embed.description, /Started by \*\*Tester\*\*/);
  assert.match(embed.description, /Start requested <t:1782874200:R> \(<t:1782874200:f>\)/);
});
