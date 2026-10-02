import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionsBitField, PermissionFlagsBits as P } from "discord.js";
import { categoryChannelOrder, DiscordCategoryLayout, ARCHIVE_DIVIDER_NAME } from "../src/platforms/discord/category-layout.js";
import { orderServers } from "../src/lib/server-display-order.js";

const records = [
  { pterodactylServerId: "b", discordChannelId: "b", active: true, published: true },
  { pterodactylServerId: "a", discordChannelId: "a", active: true, published: true },
  { pterodactylServerId: "old", discordChannelId: "old", archived: true },
  { pterodactylServerId: "unavailable", discordChannelId: "unavailable", unavailable: true },
  { pterodactylServerId: "private", discordChannelId: "private", published: false }
];

test("layout follows live status order, unavailable entries, divider, archive and remaining channels", () => {
  const channels = ["other", "old", "a", "status", "private", "divider", "b", "unavailable"].map(id => ({ id }));
  assert.deepEqual(categoryChannelOrder({ channels, servers: records, statusChannelId: "status", dividerChannelId: "divider" }),
    ["status", "b", "a", "unavailable", "divider", "old", "other", "private"]);
});

test("saved order appends new servers and preserves stable order of unspecified records", () => {
  assert.deepEqual(orderServers(records, ["a", "missing", "b"]).map(s => s.pterodactylServerId), ["a", "b", "old", "unavailable", "private"]);
});

function fixture() {
  const channels = new Map(), calls = [];
  const role = { id: "players", managed: false };
  const config = { discord: { channelOrderingEnabled: true, publicCategoryId: "category", statusChannelId: "status", linkedChannelRoleId: role.id }, servers: records };
  const configStore = { document: { settings: { discord: {} } }, updateSettings(change) { Object.assign(this.document.settings.discord, change.discord); } };
  const channel = (id, position, parent = "category") => {
    const c = { id, name: id, type: ChannelType.GuildText, parentId: parent, rawPosition: position, permissionOverwrites: { cache: new Map() },
      permissionsFor(target) {
        if (target === "bot") return new PermissionsBitField(PermissionsBitField.All);
        const overwrite = this.permissionOverwrites.cache.get(target.id);
        return new PermissionsBitField(overwrite?.allow ?? 0n);
      },
      async edit(options) {
        calls.push(["edit", id]);
        if (options.parent) this.parentId = options.parent;
        if (options.name) this.name = options.name;
        if (options.permissionOverwrites) this.permissionOverwrites.cache = new Map(options.permissionOverwrites.map(o => [o.id, o]));
      }
    };
    channels.set(id, c); return c;
  };
  channel("other", 0); channel("old", 1); channel("a", 2); channel("b", 3); channel("unavailable", 4); channel("status", 5, "old-category");
  channels.set("category", { id: "category", type: ChannelType.GuildCategory, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) });
  const guild = { id: "guild", roles: { async fetch() { return role; } }, channels: {
    async fetch(id) { return id ? channels.get(id) ?? null : channels; },
    async create(options) { calls.push(["create"]); const c = channel("divider", 6); await c.edit(options); return c; },
    async setPositions(positions) { calls.push(["positions"]); for (const entry of positions) channels.get(entry.channel).rawPosition = entry.position; }
  } };
  return { channels, calls, config, configStore, guild, service: new DiscordCategoryLayout({ config, configStore, botUserId: () => "bot" }) };
}

test("layout moves status, creates a persisted read-only divider and is idempotent", async () => {
  const f = fixture(); await f.service.sync(f.guild);
  assert.equal(f.channels.get("status").parentId, "category");
  assert.equal(f.configStore.document.settings.discord.archiveDividerChannelId, "divider");
  const divider = f.channels.get("divider");
  assert.equal(divider.name, ARCHIVE_DIVIDER_NAME);
  const access = divider.permissionOverwrites.cache.get("players");
  assert.equal(new PermissionsBitField(access.allow).has([P.ViewChannel, P.ReadMessageHistory]), true);
  for (const denied of [P.SendMessages, P.AddReactions, P.SendMessagesInThreads, P.CreatePublicThreads, P.UseApplicationCommands]) {
    assert.equal(new PermissionsBitField(access.deny).has(denied), true);
  }
  const mutations = f.calls.length; await f.service.sync(f.guild);
  assert.equal(f.calls.length, mutations);
});

test("archiving moves a channel below the divider; unarchiving restores its live position", async () => {
  const f = fixture(); await f.service.sync(f.guild);
  f.config.servers = records.map(s => s.pterodactylServerId === "b" ? { ...s, archived: true } : s);
  await f.service.sync(f.guild);
  assert.ok(f.channels.get("b").rawPosition > f.channels.get("divider").rawPosition);
  f.config.servers = records; await f.service.sync(f.guild);
  assert.ok(f.channels.get("b").rawPosition < f.channels.get("a").rawPosition);
});

test("layout repairs divider permission drift and reuses the existing divider after binding loss", async () => {
  const f = fixture(); await f.service.sync(f.guild);
  f.channels.get("divider").permissionOverwrites.cache.clear();
  delete f.configStore.document.settings.discord.archiveDividerChannelId;
  await f.service.sync(f.guild);
  assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
  assert.equal(f.configStore.document.settings.discord.archiveDividerChannelId, "divider");
});

test("unconfigured layouts do not move channels or create a divider", async () => {
  const f = fixture(); f.config.discord.channelOrderingEnabled = false; await f.service.sync(f.guild);
  assert.deepEqual(f.calls, []);
});

test("custom ordering includes unavailable servers in their chosen position", () => {
  const channels = ["a", "b", "unavailable", "status", "divider"].map(id => ({ id }));
  assert.deepEqual(categoryChannelOrder({ channels, servers: records, statusChannelId: "status", dividerChannelId: "divider", savedOrder: ["unavailable", "a", "b"] }),
    ["status", "unavailable", "a", "b", "divider"]);
});
