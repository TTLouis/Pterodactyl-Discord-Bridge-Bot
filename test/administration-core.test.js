import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CoreEventBus, CoreEvents } from "../src/core/core-events.js";
import { AdministrationConfigurationCoordinator } from "../src/core/administration/configuration-coordinator.js";
import { getAdministrationState } from "../src/core/administration/server-state.js";
import { canAccessServer } from "../src/core/administration/server-access.js";

test("core administration notifies affected platforms after applying runtime, without discovery", async () => {
  const bus = new CoreEventBus(); const calls = [];
  bus.on(CoreEvents.ADMINISTRATION_CONFIGURATION_CHANGED, ({ serverId }) => calls.push(["platform-update", serverId]));
  const core = new AdministrationConfigurationCoordinator({ eventBus: bus, applyRuntime: () => calls.push(["runtime-applied"]) });
  await core.apply("server");
  assert.deepEqual(calls, [["runtime-applied"], ["platform-update", "server"]]);
});

test("core publication policy rejects paused records and supplies supported relay defaults", () => {
  for (const change of [{ active: false }, { archived: true }, { unavailable: true }, { deleted: true }]) {
    assert.equal(getAdministrationState({ active: true, game: { type: "factorio" }, ...change }).canPublish, false);
  }
  assert.equal(getAdministrationState({ active: true, published: true, game: { type: "minecraft" } }).canPublish, true);
  assert.equal(getAdministrationState({ active: true, game: { type: "minecraft" } }).canPublish, true);
  assert.equal(getAdministrationState({ active: true, game: { type: "minecraft" } }).relayEnabled, true);
  assert.equal(getAdministrationState({ active: true, game: { type: "satisfactory" } }).relaySupported, false);
});

test("core access validation checks only the selected resource, preserving failure denial", async () => {
  const calls = [];
  assert.equal(await canAccessServer({ async getServerResources(id) { calls.push(id); } }, "selected"), true);
  assert.deepEqual(calls, ["selected"]);
  assert.equal(await canAccessServer({ async getServerResources() { throw new Error("403"); } }, "selected"), false);
});

test("core administration has no Discord or platform imports", () => {
  const root = new URL("../src/core/administration/", import.meta.url);
  for (const name of fs.readdirSync(root).filter(name => name.endsWith(".js"))) {
    assert.doesNotMatch(fs.readFileSync(new URL(name, root), "utf8"), /from\s+["'](?:discord\.js|[^"']*platforms\/|[^"']*discord-)/);
  }
});
