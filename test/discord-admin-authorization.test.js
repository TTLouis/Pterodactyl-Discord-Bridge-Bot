import assert from "node:assert/strict";
import test from "node:test";
import { DiscordInputController } from "../src/services/discord-input-controller.js";

function fixture({ roleField = "bridgeAdminRoleId", claimed = true } = {}) {
  const syncs = [];
  const restarts = [];
  const replies = [];
  let handler;
  const config = { discord: { guildId: claimed ? "guild" : null, logChannelId: "logs", [roleField]: "bridge-role" }, servers: [] };
  const controller = new DiscordInputController({
    config,
    discordBridge: { setSlashCommands() {}, onInteraction(fn) { handler = fn; }, onReaction() {} },
    autoStopService: {},
    syncService: { async syncOnce(options) { syncs.push(options); } },
    onRestartRequested(request) { restarts.push(request); }, restartDelayMs: 0,
    logger: { info() {}, warn() {}, error() {} }
  });
  controller.start();
  function interaction(commandName, extra = {}) {
    return {
      commandName, guildId: "guild", channelId: "logs", guild: { ownerId: "owner" },
      user: { id: "operator", username: "Operator" }, memberPermissions: { has: () => false },
      member: { roles: { cache: new Map([["bridge-role", { id: "bridge-role" }]]) } },
      async reply(payload) { replies.push(payload); },
      async deferReply() {}, async editReply(payload) { replies.push(payload); },
      ...extra
    };
  }
  return { config, syncs, restarts, replies, interaction, handle: (value) => handler(value) };
}

test("configured role members can refresh and restart without Discord Administrator permission", async () => {
  for (const roleField of ["bridgeAdminRoleId", "serverAdminRoleId"]) {
    const f = fixture({ roleField });
    await f.handle(f.interaction("refresh-status"));
    await f.handle(f.interaction("restart-bot"));
    assert.deepEqual(f.syncs, [{ force: true, reason: "manual" }]);
    assert.equal(f.restarts.length, 1);
  }
});

test("ordinary members, other guilds, and unclaimed installations cannot run administration commands", async () => {
  for (const commandName of ["refresh-status", "restart-bot"]) {
    for (const condition of ["no-role", "other-guild", "unclaimed"]) {
      const f = fixture({ claimed: condition !== "unclaimed" });
      const overrides = condition === "no-role" ? { member: { roles: [] } }
        : condition === "other-guild" ? { guildId: "other-guild" } : {};
      await f.handle(f.interaction(commandName, overrides));
      assert.equal(f.syncs.length, 0, condition);
      assert.equal(f.restarts.length, 0, condition);
    }
  }
});

test("owner and administrators retain administration access after role membership is revoked", async () => {
  for (const extra of [
    { user: { id: "owner" }, member: { roles: [] } },
    { memberPermissions: { has: () => true }, member: { roles: [] } }
  ]) {
    const f = fixture();
    await f.handle(f.interaction("restart-bot", extra));
    assert.equal(f.restarts.length, 1);
  }
});
