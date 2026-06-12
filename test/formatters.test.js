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
