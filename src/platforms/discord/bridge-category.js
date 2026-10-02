import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";

export const BRIDGE_CATEGORY_NAME = "Pterodactyl Bridge";
const flights = new WeakMap();

export function bridgePrivateOverwrites({ guild, botUserId, actorId }) {
  const access = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...Array.from(new Set([botUserId, actorId, guild.ownerId])).map((id) => ({
      id, type: OverwriteType.Member,
      allow: id === botUserId ? [...access, PermissionFlagsBits.ManageChannels] : access
    }))
  ];
}

export const privateBridgeOverwrites = bridgePrivateOverwrites;

/** Administration has no requester/owner grants or inherited category access. */
export function bridgeAdminOverwrites({ guild, botUserId, adminRoleId = null }) {
  const access = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  if (adminRoleId === guild.id) throw new Error("Administration role must not be @everyone");
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botUserId, type: OverwriteType.Member, allow: [...access, PermissionFlagsBits.ManageChannels] },
    ...(adminRoleId ? [{ id: adminRoleId, type: OverwriteType.Role, allow: access }] : [])
  ];
}

/** Resolve the privately owned category before creating any bridge channel. */
export async function ensureBridgeCategory({ guild, configStore, botUserId, actorId }) {
  let pending = flights.get(configStore);
  if (!pending) { pending = new Map(); flights.set(configStore, pending); }
  if (pending.has(guild.id)) return pending.get(guild.id);
  const task = (async () => {
    const configuredId = configStore.document?.settings?.discord?.privateCategoryId;
    const savedId = configStore.getCategoryId(guild.id);
    if (configuredId) {
      if (savedId && savedId !== configuredId) throw new Error("Private category does not match the saved bridge category.");
      const configured = await guild.channels.fetch(configuredId);
      assertPrivateBridgeCategory(configured, guild.id);
      if (!savedId) configStore.setCategoryId(guild.id, configured.id);
      return configured;
    }
    if (savedId) {
      const saved = await guild.channels.fetch(savedId);
      if (!saved || saved.type !== ChannelType.GuildCategory) {
        throw new Error("Saved bridge category is unavailable. Restore it before creating bridge channels.");
      }
      assertPrivateBridgeCategory(saved, guild.id);
      return saved;
    }
    const channels = await guild.channels.fetch();
    if (Array.from(channels.values()).some((channel) => channel.type === ChannelType.GuildCategory && channel.name === BRIDGE_CATEGORY_NAME)) {
      throw new Error("An unsaved bridge category exists. Check persistent storage before retrying.");
    }
    const category = await guild.channels.create({
      name: BRIDGE_CATEGORY_NAME, type: ChannelType.GuildCategory,
      permissionOverwrites: bridgePrivateOverwrites({ guild, botUserId, actorId })
    });
    try { configStore.setCategoryId(guild.id, category.id); }
    catch (error) {
      try { await category.delete(); } catch { /* Orphan detection prevents duplicate creation on retry. */ }
      throw error;
    }
    return category;
  })();
  pending.set(guild.id, task);
  try { return await task; } finally { if (pending.get(guild.id) === task) pending.delete(guild.id); }
}

/** Existing private categories retain their name, permissions, and unrelated children. */
export function assertPrivateBridgeCategory(category, guildId) {
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error("Selected private category is unavailable.");
  const everyone = category.permissionOverwrites?.cache?.get(guildId);
  if (!everyone?.deny?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error("Selected private category must explicitly deny View Channel to @everyone.");
  }
  return category;
}

/** Publication must use an explicitly selected existing public category. */
export async function ensurePublicBridgeCategory({ guild, configStore }) {
  configStore.getCategoryId(guild.id); // Enforce store availability and installation ownership.
  const settings = configStore.document?.settings?.discord;
  const publicId = settings?.publicCategoryId;
  if (!publicId || publicId === settings.privateCategoryId || publicId === configStore.getCategoryId(guild.id)) {
    throw new Error("Select a separate existing public category before publishing.");
  }
  const category = await guild.channels.fetch(publicId);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error("Selected public category is unavailable.");
  return category;
}
