import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/lib/config.js";

// servers.example.json is the onboarding path now that the setup wizard lives on
// its own branch. The wizard drifted out of sync with the validator and could
// emit a config that refused to load; these tests keep the template from doing
// the same, since a new deployment starts by copying it verbatim.
function loadExample({ kookEnabled }) {
  const previousEnv = {
    CONFIG_PATH: process.env.CONFIG_PATH,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    KOOK_ENABLED: process.env.KOOK_ENABLED,
    KOOK_TOKEN: process.env.KOOK_TOKEN
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-example-"));
  const configPath = path.join(tempDir, "servers.json");
  fs.copyFileSync("servers.example.json", configPath);

  try {
    process.env.CONFIG_PATH = configPath;
    process.env.DISCORD_TOKEN = "discord-token";
    process.env.KOOK_ENABLED = String(kookEnabled);
    process.env.KOOK_TOKEN = "kook-token";
    return loadConfig();
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("servers.example.json validates as shipped", () => {
  const { config } = loadExample({ kookEnabled: false });

  assert.ok(config.servers.length > 0);
  assert.deepEqual(
    config.servers.map((server) => server.game.type).sort(),
    ["factorio", "minecraft", "satisfactory"]
  );
});

test("the example covers every supported game type", () => {
  const { config } = loadExample({ kookEnabled: false });
  const types = new Set(config.servers.map((server) => server.game.type));

  // If a new game type is added, the template should demonstrate it.
  for (const type of ["factorio", "minecraft", "satisfactory"]) {
    assert.ok(types.has(type), `servers.example.json should include a ${type} server`);
  }
});

test("example placeholder IDs are rejected rather than silently used", () => {
  // The KOOK placeholders must not look like real IDs, or a copied template
  // would start up pointing at nothing.
  assert.throws(
    () => loadExample({ kookEnabled: true }),
    /Config must include kook\.(guildId|statusChannelId) when KOOK_ENABLED=true/
  );
});

test("the example auto-stop windows satisfy the cross-field rule", () => {
  const { config } = loadExample({ kookEnabled: false });

  for (const server of config.servers) {
    if (!server.autoStop) continue;
    assert.ok(
      server.autoStop.warningMinutesBefore < server.autoStop.emptyTimeoutHours * 60,
      `${server.name} has a warning window wider than its idle window`
    );
  }
});
