import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusPanel } from "../src/lib/formatters.js";

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
