import assert from "node:assert/strict";
import test from "node:test";
import { DiscordInputController } from "../src/services/discord-input-controller.js";

function fixture() {
  const server = { name: "Beta", pterodactylServerId: "server", discordChannelId: "channel" };
  let handler;
  let reactionHandler;
  const prompts = [];
  const powers = [];
  const audits = [];
  const syncs = [];
  const controller = new DiscordInputController({
    config: { discord: { guildId: "guild" }, servers: [server] },
    discordBridge: {
      setSlashCommands() {},
      onInteraction(fn) { handler = fn; },
      onReaction(fn) { reactionHandler = fn; },
      async sendMessage(channel, payload) { prompts.push(payload); }
    },
    autoStopService: {
      stateStore: { getActionMessageId() { return "current-action"; } },
      onAudit(entry) { audits.push(entry); },
      async handleStartCommand(record, interaction) {
        powers.push({ record, member: interaction.member });
        await interaction.reply({ content: "Accepted" });
        return true;
      }
    },
    syncService: { async syncOnce(options) { syncs.push(options); } },
    logger: { info() {}, warn() {}, error() {} }
  });
  controller.start();
  function interaction(extra = {}) {
    return {
      guildId: "guild", channelId: "channel", user: { id: "actor" },
      async reply(payload) { prompts.push(payload); },
      ...extra
    };
  }
  async function request() {
    await handler(interaction({ commandName: "start-server" }));
    return prompts.at(-1).components[0].toJSON().components[0].custom_id;
  }
  return { controller, server, prompts, powers, audits, syncs, interaction, request, handle: (value) => handler(value), reaction: (value) => reactionHandler(value) };
}

test("confirmation executes once after refreshing requester permissions", async () => {
  const f = fixture();
  const customId = await f.request();
  assert.equal(f.powers.length, 0);
  const refreshedMember = { roles: "fresh roles" };
  await f.handle(f.interaction({ customId, guild: { members: { async fetch(id) { assert.equal(id, "actor"); return refreshedMember; } } } }));
  assert.equal(f.powers.length, 1);
  assert.equal(f.powers[0].member, refreshedMember);
  assert.deepEqual(f.syncs, [{ force: true }]);
  await f.handle(f.interaction({ customId }));
  assert.equal(f.powers.length, 1);
});

test("wrong user and wrong channel cannot consume another request", async () => {
  const f = fixture();
  const customId = await f.request();
  await f.handle(f.interaction({ customId, user: { id: "intruder" } }));
  await f.handle(f.interaction({ customId, channelId: "other" }));
  assert.equal(f.powers.length, 0);
  assert.equal(f.controller.pendingPowerConfirmations.size, 1);
  await f.handle(f.interaction({ customId }));
  assert.equal(f.powers.length, 1);
});

test("expired and newly unavailable requests never send power", async () => {
  const f = fixture();
  let customId = await f.request();
  const pending = [...f.controller.pendingPowerConfirmations.values()][0];
  pending.expiresAt = Date.now() - 1;
  await f.handle(f.interaction({ customId }));
  assert.equal(f.powers.length, 0);
  customId = await f.request();
  f.server.unavailable = true;
  await f.handle(f.interaction({ customId }));
  assert.equal(f.powers.length, 0);
  assert.deepEqual(f.audits.map((entry) => entry.outcome), ["requested", "expired", "requested", "blocked"]);
});

test("green reactions require the current action message and button confirmation", async () => {
  const f = fixture();
  const reaction = {
    channelId: "channel", userId: "actor", emoji: "🟢",
    async removeUserReaction() {}
  };
  await f.reaction({ ...reaction, messageId: "old-action" });
  assert.equal(f.prompts.length, 0);
  await f.reaction({ ...reaction, messageId: "current-action" });
  assert.equal(f.powers.length, 0);
  const customId = f.prompts[0].components[0].toJSON().components[0].custom_id;
  await f.handle(f.interaction({ customId }));
  assert.equal(f.powers.length, 1);
});

test("failed member revalidation prevents sending power", async () => {
  const f = fixture();
  const customId = await f.request();
  await f.handle(f.interaction({ customId, guild: { members: { async fetch() { throw new Error("no access"); } } } }));
  assert.equal(f.powers.length, 0);
});
