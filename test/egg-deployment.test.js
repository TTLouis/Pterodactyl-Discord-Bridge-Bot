import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const egg = JSON.parse(fs.readFileSync(new URL("../deployment/egg-pterodactyl-platform-bridge.json", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));

test("release Egg pins the canonical image and supplies a fixed, signal-safe startup", () => {
  assert.equal(egg.meta.version, "PTDL_v2");
  assert.deepEqual(Object.values(egg.docker_images), [`ghcr.io/ttlouis/pterodactyl-discord-bridge-bot:${pkg.version}`]);
  assert.equal(egg.startup, "node /app/src/index.js");
  assert.equal(egg.config.stop, "^C");
  assert.deepEqual(JSON.parse(egg.config.startup), { done: "Bridge ready" });
  assert.deepEqual(JSON.parse(egg.config.files), {});
  assert.equal(egg.variables.find(v => v.env_variable === "BRIDGE_DEPLOYMENT").default_value, "pterodactyl");
  assert.equal(egg.variables.find(v => v.env_variable === "BRIDGE_DEPLOYMENT").user_editable, false);
  assert.equal(egg.variables.find(v => v.env_variable === "DISCORD_TOKEN").default_value, "");
  assert.equal(egg.variables.find(v => v.env_variable === "KOOK_ENABLED").default_value, "false");
  assert.equal(new Set(egg.variables.map(v => v.env_variable)).size, egg.variables.length);
});
