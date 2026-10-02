import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Events } from "discord.js";
import { main } from "../src/index.js";
import { readSyncHealth } from "../src/lib/sync-health.js";

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bootstrap-"));
  const environment = { DISCORD_TOKEN: "test-bootstrap-token", KOOK_ENABLED: "false", CONFIG_PATH: path.join(directory, "missing.json"), PERSISTENT_CONFIG_PATH: path.join(directory, "persistent-config.json"), PERSISTENT_SECRETS_PATH: path.join(directory, "persistent-secrets.json"), STATE_PATH: path.join(directory, "runtime.json"), HEARTBEAT_PATH: path.join(directory, "heartbeat"), SYNC_HEALTH_PATH: path.join(directory, "health.json") };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(directory, { recursive: true, force: true }); });
  const calls = [];
  const logs = [];
  const guild = { id: "guild", channels: { async fetch() { return null; } } };
  class DiscordMock {
    constructor(options) { this.guildId = options.guildId; this.client = new EventEmitter(); this.client.user = { id: "bot" }; this.client.guilds = { cache: new Map([["guild", guild]]) }; this.client.isReady = () => this.online; this.online = false; }
    onMessage() {} onInteraction() {} onReaction() {} setSlashCommands(commands) { this.commands = commands; }
    async start() { this.online = true; this.client.emit(Events.ClientReady); }
    async stop() { this.online = false; }
  }
  class PanelMock {
    constructor(options) { Object.assign(this, options); this.websocketCredentialCache = new Map(); this.failResources = false; }
    async listAccessibleServers() { calls.push("discovery"); return [{ identifier: "server", name: "World" }]; }
    async getServerResources() { calls.push("resources"); if (this.failResources) throw new Error("mock access lost"); return { currentState: "offline" }; }
    async getServerDefaultAllocation() { calls.push("allocation"); return { ip: "127.0.0.1", port: 25565 }; }
  }
  class ListenerMock { start() {} stop() {} }
  const services = { DiscordBridge: DiscordMock, PterodactylClient: PanelMock, DiscordPlatformListener: ListenerMock, logger: { info(message) { logs.push(message); }, warn() {}, error() {}, attachDiscordSink() {} } };
  return { environment, directory, calls, services, logs };
}

test("entrypoint boots and restarts with only a token, reports setup health and never polls", async (t) => {
  const f = setup(t);
  const listeners = process.listenerCount("uncaughtException");
  let runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  assert.equal(runtime.runtime.config.setupMode, true);
  assert.deepEqual(f.logs.filter(message => message === "Bridge ready"), ["Bridge ready"]);
  assert.equal(runtime.statusSyncService.started, false);
  assert.equal(readSyncHealth(f.environment.SYNC_HEALTH_PATH).mode, "setup");
  assert.equal(fs.existsSync(f.environment.HEARTBEAT_PATH), true);
  assert.deepEqual(f.calls, []);
  assert.equal(process.listenerCount("uncaughtException"), listeners);
  runtime.configStore.claimGuild("guild");
  await runtime.shutdown("TEST");
  runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  assert.equal(runtime.discordBridge.guildId, "guild");
  assert.equal(runtime.configStore.getGuildId(), "guild");
  assert.equal(runtime.statusSyncService.started, false);
  await runtime.shutdown("TEST");
});

test("completing setup starts monitoring; settings preserve runtime identity and restart retains imports", async (t) => {
  const f = setup(t);
  let runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  runtime.configStore.claimGuild("guild");
  runtime.configStore.setConnectionKey("test-key", "https://panel.example");
  await runtime.reconcile();
  assert.equal(runtime.statusSyncService.started, false, "status channel still required");
  runtime.configStore.updateSettings({ discord: { statusChannelId: "status" } });
  await runtime.reconcile();
  assert.equal(runtime.statusSyncService.started, true);
  assert.equal(readSyncHealth(f.environment.SYNC_HEALTH_PATH).mode, "monitoring");
  runtime.configStore.addManagedServer({ name: "World", pterodactylServerId: "server", active: true, archived: false, published: false, discordChannelId: "server-channel", game: { type: "minecraft" } });
  await runtime.reconcile();
  runtime.configStore.updateSettings({ pterodactyl: { baseUrl: "https://panel.example/" } });
  await runtime.reconcile();
  assert.equal(runtime.statusSyncService.pterodactylClient.baseUrl, "https://panel.example");
  const original = runtime.runtime.config.servers[0];
  original.publicAddress = "127.0.0.1"; original.publicPort = 25565;
  const adapter = runtime.statusSyncService.adapters.get("server");
  runtime.configStore.updateManagedServer("server", { description: ["Changed"] });
  await runtime.reconcile();
  assert.equal(runtime.runtime.config.servers[0], original);
  assert.equal(original.publicPort, 25565);
  assert.notEqual(runtime.statusSyncService.adapters.get("server"), adapter, "settings changes replace the runtime adapter");
  await runtime.shutdown("TEST");
  runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  assert.equal(runtime.runtime.config.servers.length, 1);
  assert.equal(f.logs.filter(message => message === "Bridge ready").length, 2);
  assert.equal(runtime.runtime.config.servers[0].description, "Changed");
  assert.equal(runtime.statusSyncService.adapters.size, 1);
  await runtime.shutdown("TEST");
});

test("poll access failure persists unavailable and a restart cannot silently reactivate it", async (t) => {
  const f = setup(t);
  let runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  runtime.configStore.claimGuild("guild");
  runtime.configStore.setConnectionKey("test-key", "https://panel.example");
  runtime.configStore.updateSettings({ discord: { statusChannelId: "status" } });
  runtime.configStore.addManagedServer({ name: "World", pterodactylServerId: "server", active: true, archived: false, published: true, discordChannelId: "server-channel", publicAddress: "127.0.0.1", publicPort: 25565, game: { type: "minecraft" } });
  await runtime.reconcile();
  runtime.statusSyncService.pterodactylClient.failResources = true;
  await runtime.statusSyncService.syncOnce({ force: true });
  if (runtime.statusSyncService.activeSync) await runtime.statusSyncService.activeSync;
  const saved = runtime.configStore.getManagedServers()[0];
  assert.equal(saved.active, false); assert.equal(saved.unavailable, true); assert.equal(saved.published, true);
  assert.equal(runtime.statusSyncService.adapters.size, 0);
  assert.ok(saved.lastSuccessAt === null || typeof saved.lastSuccessAt === "string");
  await runtime.shutdown("TEST");
  f.calls.length = 0;
  runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  assert.equal(runtime.statusSyncService.adapters.size, 0);
  assert.equal(f.calls.includes("resources"), false);
  assert.equal(f.calls.includes("allocation"), false);
  await runtime.shutdown("TEST");
});


test("usability: applying settings returns while the game status request is still blocked", async (t) => {
  const f = setup(t); const runtime = await main({ services: f.services, registerProcessHandlers: false });
  await runtime.ready;
  runtime.configStore.claimGuild("guild"); runtime.configStore.setConnectionKey("test-key", "https://panel.example");
  runtime.configStore.updateSettings({ discord: { statusChannelId: "status" } });
  runtime.configStore.addManagedServer({ name: "World", pterodactylServerId: "server", active: true, archived: false, published: false, discordChannelId: "server-channel", game: { type: "minecraft" } });
  await runtime.reconcile();
  let release; let called = false;
  runtime.statusSyncService.pterodactylClient.getServerResources = () => { called = true; return new Promise(resolve => { release = resolve; }); };
  runtime.configStore.updateManagedServer("server", { description: ["Saved immediately"] });
  await runtime.reconcile({ waitForStatus: false });
  assert.equal(runtime.runtime.config.servers[0].description, "Saved immediately");
  assert.equal(called, true); assert.ok(runtime.statusSyncService.activeSync);
  release({ currentState: "offline" });
  await runtime.statusSyncService.activeSync; await runtime.shutdown("TEST");
});

test("failed Discord login never announces bridge readiness", async (t) => {
  const f = setup(t);
  class FailedDiscord extends f.services.DiscordBridge {
    async start() { throw new Error("mock login failed"); }
  }
  await assert.rejects(main({ services: { ...f.services, DiscordBridge: FailedDiscord }, registerProcessHandlers: false }), /mock login failed/);
  assert.equal(f.logs.includes("Bridge ready"), false);
});
