import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits, OverwriteType } from "discord.js";
import { ensureBridgeCategory, ensurePublicBridgeCategory, privateBridgeOverwrites, bridgeAdminOverwrites } from "../src/services/bridge-category.js";

function fixture({ savedId = null, saved = null, failSave = false, channels = [] } = {}) {
  const calls = [];
  let categoryId = savedId;
  const category = { id: "category", name: "Pterodactyl Bridge", type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([["guild", { deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]) },
    async delete() { calls.push("delete"); } };
  const configStore = { getCategoryId(guildId) { assert.equal(guildId, "guild"); return categoryId; },
    setCategoryId(guildId, id) { assert.equal(guildId, "guild"); calls.push("persist"); if (failSave) throw new Error("storage unavailable"); categoryId = id; } };
  const guild = { id: "guild", ownerId: "owner", channels: {
    async fetch(id) { calls.push(id ? "fetch-saved" : "fetch-all"); return id ? saved ?? (id === category.id ? category : null) : new Map(channels.map((channel) => [channel.id, channel])); },
    async create(options) { calls.push(options); return category; }
  } };
  return { guild, configStore, category, calls, options: { guild, configStore, botUserId: "bot", actorId: "caller" } };
}

test("category creation denies everyone and gives bot/owner/requester explicit private access", async () => {
  const f = fixture(); assert.equal(await ensureBridgeCategory(f.options), f.category);
  const options = f.calls.find((call) => typeof call === "object");
  assert.equal(options.type, ChannelType.GuildCategory); assert.equal(options.name, "Pterodactyl Bridge");
  assert.deepEqual(options.permissionOverwrites[0], { id: "guild", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(options.permissionOverwrites.slice(1).map((entry) => entry.id), ["bot", "caller", "owner"]);
  assert.equal(options.permissionOverwrites[1].allow.includes(PermissionFlagsBits.ManageChannels), true);
  assert.equal(options.permissionOverwrites[2].allow.includes(PermissionFlagsBits.ManageChannels), false);
  assert.equal(f.calls.at(-1), "persist");
});

test("concurrent channel operations share one category creation and repeated operations reuse its binding", async () => {
  const f = fixture();
  const results = await Promise.all([ensureBridgeCategory(f.options), ensureBridgeCategory(f.options), ensureBridgeCategory(f.options)]);
  assert.deepEqual(results, [f.category, f.category, f.category]);
  assert.equal(f.calls.filter((call) => typeof call === "object").length, 1);
  assert.equal(f.calls.filter((call) => call === "persist").length, 1);
  assert.equal(await ensureBridgeCategory(f.options), f.category);
  assert.equal(f.calls.filter((call) => typeof call === "object").length, 1);
  assert.equal(f.calls.at(-1), "fetch-saved");
});

test("missing or wrong-type persisted category fails without orphaning root-level channels", async () => {
  for (const saved of [null, { id: "saved", type: ChannelType.GuildText }]) {
    const f = fixture({ savedId: "saved", saved });
    await assert.rejects(ensureBridgeCategory(f.options), /unavailable/);
    assert.deepEqual(f.calls, ["fetch-saved"]);
  }
});

test("failed category persistence cleans up and rejects the child-creation prerequisite", async () => {
  const f = fixture({ failSave: true });
  await assert.rejects(ensureBridgeCategory(f.options), /storage unavailable/);
  assert.equal(f.calls.at(-1), "delete");
  assert.equal(f.calls.filter((call) => typeof call === "object").length, 1);
});

test("an unsaved matching category blocks duplicate creation instead of adopting unknown permissions", async () => {
  const f = fixture({ channels: [{ id: "orphan", name: "Pterodactyl Bridge", type: ChannelType.GuildCategory }] });
  await assert.rejects(ensureBridgeCategory(f.options), /unsaved/);
  assert.deepEqual(f.calls, ["fetch-all"]);
});

test("owner/requester/bot access entries are deduplicated", () => {
  const overwrites = privateBridgeOverwrites({ guild: { id: "guild", ownerId: "bot" }, botUserId: "bot", actorId: "bot" });
  assert.equal(overwrites.length, 2);
  assert.equal(overwrites[1].allow.includes(PermissionFlagsBits.ManageChannels), true);
});

test("configured existing private category is validated and persisted without renaming or editing permissions", async () => {
  const f = fixture();
  f.configStore.document = { settings: { discord: { privateCategoryId: "category" } } };
  f.category.name = "Existing Private Category";
  f.category.permissionOverwrites = { cache: new Map([["guild", { deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]) };
  assert.equal(await ensureBridgeCategory(f.options), f.category);
  assert.deepEqual(f.calls, ["fetch-saved", "persist"]);
  assert.equal(f.category.name, "Existing Private Category");
  await ensureBridgeCategory(f.options);
  assert.equal(f.calls.filter((call) => call === "persist").length, 1);
});

test("configured private category without explicit everyone privacy fails before persistence or child creation", async () => {
  const f = fixture();
  f.configStore.document = { settings: { discord: { privateCategoryId: "category" } } };
  f.category.permissionOverwrites = { cache: new Map([["guild", { deny: { has: () => false } }]]) };
  await assert.rejects(ensureBridgeCategory(f.options), /explicitly deny/);
  assert.deepEqual(f.calls, ["fetch-saved"]);
});

test("configured private category mismatch with existing binding fails closed", async () => {
  const f = fixture({ savedId: "other-category" });
  f.configStore.document = { settings: { discord: { privateCategoryId: "category" } } };
  await assert.rejects(ensureBridgeCategory(f.options), /does not match/);
  assert.deepEqual(f.calls, []);
});

test("publication resolves only the explicitly selected distinct existing public category", async () => {
  const f = fixture({ savedId: "private" });
  f.configStore.document = { settings: { discord: { privateCategoryId: "private", publicCategoryId: "category" } } };
  assert.equal(await ensurePublicBridgeCategory(f.options), f.category);
  assert.deepEqual(f.calls, ["fetch-saved"]);
});

test("publication fails closed for absent, identical, deleted, or wrong-type public category", async () => {
  for (const [id, selected] of [[null, null], ["private", null], ["missing", null], ["saved", { id: "saved", type: ChannelType.GuildText }]]) {
    const f = fixture({ savedId: "private", saved: selected });
    f.configStore.document = { settings: { discord: { privateCategoryId: "private", publicCategoryId: id } } };
    await assert.rejects(ensurePublicBridgeCategory(f.options), /public category/);
    assert.equal(f.calls.some((call) => typeof call === "object" || call === "persist"), false);
  }
});

test("a saved category edited to become public fails before admin permissions can be synchronized", async () => {
  const f = fixture({ savedId: "category" });
  f.category.permissionOverwrites.cache.set("guild", { deny: { has: () => false } });
  await assert.rejects(ensureBridgeCategory(f.options), /explicitly deny/);
  assert.deepEqual(f.calls, ["fetch-saved"]);
});

test("admin channel explicitly grants only configured role and bot and denies everyone", () => {
  const overwrites = bridgeAdminOverwrites({ guild: { id: "guild", ownerId: "owner" }, botUserId: "bot", adminRoleId: "admin-role" });
  assert.deepEqual(overwrites.map(({ id, type }) => ({ id, type })), [
    { id: "guild", type: OverwriteType.Role }, { id: "bot", type: OverwriteType.Member }, { id: "admin-role", type: OverwriteType.Role }
  ]);
  assert.deepEqual(overwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(overwrites[2].allow.includes(PermissionFlagsBits.ViewChannel), true);
  assert.equal(overwrites[2].allow.includes(PermissionFlagsBits.ManageChannels), false);
  assert.throws(() => bridgeAdminOverwrites({ guild: { id: "guild" }, botUserId: "bot", adminRoleId: "guild" }), /must not be/);
});
