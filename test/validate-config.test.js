import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runValidator(configPath) {
  const env = { ...process.env, CONFIG_PATH: configPath, KOOK_ENABLED: "false" };
  delete env.DISCORD_TOKEN;
  delete env.KOOK_TOKEN;

  return execFileSync(process.execPath, ["scripts/validate-config.js"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("validate-config accepts the shipped example without runtime tokens", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-validate-config-"));
  const configPath = path.join(tempDir, "servers.json");
  fs.copyFileSync("servers.example.json", configPath);

  try {
    assert.match(runValidator(configPath), /Configuration is valid:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validate-config rejects duplicate active server mappings", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-validate-config-"));
  const configPath = path.join(tempDir, "servers.json");
  const config = JSON.parse(fs.readFileSync("servers.example.json", "utf8"));
  config.servers[1].discordChannelId = config.servers[0].discordChannelId;
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  try {
    assert.throws(
      () => runValidator(configPath),
      (error) => /Duplicate Discord channel ID/.test(error.stderr)
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("validate-config rejects malformed JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-validate-config-"));
  const configPath = path.join(tempDir, "servers.json");
  fs.writeFileSync(configPath, '{"discord":', "utf8");

  try {
    assert.throws(
      () => runValidator(configPath),
      (error) => /Configuration is invalid:/.test(error.stderr)
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
