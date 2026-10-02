import { ChannelType, OverwriteType, PermissionsBitField, PermissionFlagsBits } from "discord.js";
import { isServerMonitoringEnabled } from "../../lib/server-lifecycle.js";
import { orderServers } from "../../lib/server-display-order.js";

// Discord strips ASCII equals signs; Unicode separators survive API readback.
export const ARCHIVE_DIVIDER_NAME = "一一archieve一一";

export function categoryChannelOrder({ channels, statusChannelId, dividerChannelId, servers, savedOrder = [] }) {
  const present = new Set(channels.map(channel => channel.id));
  const live = servers.filter(server => server.published !== false && isServerMonitoringEnabled(server));
  const unavailable = servers.filter(server => server.published !== false && server.unavailable && !server.archived && !server.deleted);
  const archived = servers.filter(server => server.archived || server.deleted);
  const desired = [statusChannelId, ...orderServers([...live, ...unavailable], savedOrder).map(server => server.discordChannelId), dividerChannelId,
    ...archived.map(server => server.discordChannelId), ...channels.map(channel => channel.id)];
  return [...new Set(desired.filter(id => present.has(id)))];
}

function overwritesMatch(channel, expected) {
  const actual = [...(channel.permissionOverwrites?.cache?.values() ?? [])];
  return actual.length === expected.length && expected.every(wanted => actual.some(saved => saved.id === wanted.id && saved.type === wanted.type
    && new PermissionsBitField(saved.allow?.bitfield ?? saved.allow ?? 0n).bitfield === new PermissionsBitField(wanted.allow ?? 0n).bitfield
    && new PermissionsBitField(saved.deny?.bitfield ?? saved.deny ?? 0n).bitfield === new PermissionsBitField(wanted.deny ?? 0n).bitfield));
}

export class DiscordCategoryLayout {
  constructor({ config, configStore, botUserId }) { Object.assign(this, { config, configStore, botUserId }); this.pending = null; }
  sync(guild) {
    const task = (this.pending ?? Promise.resolve()).catch(() => {}).then(() => this.apply(guild));
    this.pending = task;
    return task.finally(() => { if (this.pending === task) this.pending = null; });
  }
  async apply(guild) {
    const settings = this.config.discord;
    if (!settings.channelOrderingEnabled) return;
    const category = await guild.channels.fetch(settings.publicCategoryId, { force: true });
    const role = await guild.roles.fetch(settings.linkedChannelRoleId);
    if (!category || category.type !== ChannelType.GuildCategory || !role || role.managed || role.id === guild.id) throw new Error("Category ordering requires the selected destination and linked role");
    const botId = this.botUserId();
    if (!category.permissionsFor(botId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) throw new Error("Missing category management permissions");
    const status = await guild.channels.fetch(settings.statusChannelId, { force: true });
    if (!status || status.type !== ChannelType.GuildText) throw new Error("Main status channel unavailable");
    if (status.parentId !== category.id) await status.edit({ parent: category.id, lockPermissions: false });
    const all = await guild.channels.fetch();
    let divider = this.configStore.document.settings.discord.archiveDividerChannelId
      ? all.get(this.configStore.document.settings.discord.archiveDividerChannelId) : null;
    if (divider && divider.type !== ChannelType.GuildText) throw new Error("Saved archive divider is not a text channel");
    if (!divider) {
      const matches = [...all.values()].filter(channel => channel?.parentId === category.id && channel.name === ARCHIVE_DIVIDER_NAME);
      if (matches.length > 1) throw new Error("Multiple archive dividers require administrator review");
      divider = matches[0];
    }
    const read = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
    const overwrites = [
      { id: guild.id, type: OverwriteType.Role, deny: PermissionsBitField.All },
      { id: role.id, type: OverwriteType.Role, allow: read, deny: PermissionsBitField.All & ~read },
      { id: botId, type: OverwriteType.Member, allow: read | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles }
    ];
    if (!divider) divider = await guild.channels.create({ name: ARCHIVE_DIVIDER_NAME, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites });
    else if (divider.parentId !== category.id || divider.name !== ARCHIVE_DIVIDER_NAME || !overwritesMatch(divider, overwrites)) {
      await divider.edit({ name: ARCHIVE_DIVIDER_NAME, parent: category.id, permissionOverwrites: overwrites });
    }
    divider = await guild.channels.fetch(divider.id, { force: true });
    if (divider.name !== ARCHIVE_DIVIDER_NAME || divider.parentId !== category.id || !overwritesMatch(divider, overwrites)
      || !divider.permissionsFor(role)?.has(read) || divider.permissionsFor(role)?.has(PermissionFlagsBits.SendMessages)) throw new Error("Archive divider access verification failed");
    if (this.configStore.document.settings.discord.archiveDividerChannelId !== divider.id) {
      this.configStore.updateSettings({ discord: { archiveDividerChannelId: divider.id } });
      settings.archiveDividerChannelId = divider.id;
    }
    const fresh = await guild.channels.fetch();
    const children = [...fresh.values()].filter(channel => channel?.parentId === category.id).sort((a, b) => a.rawPosition - b.rawPosition || a.id.localeCompare(b.id));
    const desired = categoryChannelOrder({ channels: children, statusChannelId: status.id, dividerChannelId: divider.id, servers: this.config.servers, savedOrder: settings.serverDisplayOrder });
    const current = children.map(channel => channel.id);
    if (desired.some((id, index) => id !== current[index])) {
      const start = Math.min(...children.map(channel => channel.rawPosition));
      await guild.channels.setPositions(desired.map((channel, index) => ({ channel, position: start + index })));
    }
    const verified = [...(await guild.channels.fetch()).values()].filter(channel => channel?.parentId === category.id)
      .sort((a, b) => a.rawPosition - b.rawPosition || a.id.localeCompare(b.id)).map(channel => channel.id);
    if (verified.length !== desired.length || desired.some((id, index) => id !== verified[index])) throw new Error("Category channel order verification failed");
  }
}
