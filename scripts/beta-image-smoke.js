// Feed this file to the built image's Node stdin; no Discord login or panel requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import { PersistentConfigStore } from "/app/src/lib/persistent-config-store.js";
import { loadConfig } from "/app/src/lib/config.js";
const store = new PersistentConfigStore();
assert.equal(store.load(), true);
if (process.env.SMOKE_PHASE === "fresh") {
  assert.equal(fs.existsSync("/app/servers.json"), false);
  assert.equal(fs.existsSync("/app/.env"), false);
  assert.equal(fs.existsSync("/app/docker-compose.override.yml"), false);
  store.initialize();
  const runtime = loadConfig({ rawConfig: store.getRuntimeConfig(), managed: true });
  assert.equal(runtime.config.setupMode, true);
  assert.deepEqual(runtime.config.servers, []);
  store.claimGuild("smoke-guild");
  store.setAdminChannelId("smoke-guild", "smoke-admin");
  store.setCardMessageId("smoke-server", "smoke-card");
  store.setConnectionKey("smoke-private-key", "https://panel.example");
  store.updateSettings({ discord: { statusChannelId: "smoke-status" } });
  for (const file of [store.configPath, store.secretsPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(store.exportRedacted()).includes("smoke-private-key"), false);
} else if (process.env.SMOKE_PHASE === "restart") {
  assert.equal(store.getGuildId(), "smoke-guild");
  assert.equal(store.getCardMessageId("smoke-server"), "smoke-card");
  assert.equal(store.getConnectionKey(), "smoke-private-key");
  assert.equal(loadConfig({ rawConfig: store.getRuntimeConfig(), managed: true }).config.setupMode, false);
  // Simulate an interruption after the complete durable journal but before both files commit.
  const document = structuredClone(store.document);
  document.administration.cards["smoke-server"] = "recovered-card";
  fs.writeFileSync(store.journalPath, JSON.stringify({ schemaVersion: 2, document, secrets: store.secrets }), { mode: 0o600 });
  fs.writeFileSync(store.configPath, "{interrupted");
} else if (process.env.SMOKE_PHASE === "recovery") {
  assert.equal(store.getCardMessageId("smoke-server"), "recovered-card");
  assert.equal(store.getConnectionKey(), "smoke-private-key");
  assert.equal(fs.existsSync(store.journalPath), false);
} else throw new Error("Choose a smoke phase");
console.log(`Image smoke passed: ${process.env.SMOKE_PHASE}`);
