import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { getAdministrationState } from "../../core/administration/server-state.js";
const label = (value) => String(value).replace(/[`\r\n<>@]/g, " ").slice(0, 80);
const button = (id, text, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(text).setEmoji(emoji).setStyle(style);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
export function buildServerSetupCard(discovered, managed, legacy = false) {
  const id = discovered.identifier ?? managed.pterodactylServerId;
  const prefix = `bridge:card:${id}:`;
  const policy = managed ? getAdministrationState(managed) : null;
  const state = managed ? managed.deleted ? "Deleted" : managed.unavailable ? "Unavailable — reactivation required" : managed.archived ? "Archived" : managed.active ? "Monitoring" : "Inactive" : legacy ? "Legacy configuration — migrate to edit" : "Ready to import";
  const nextStep = legacy ? "Existing configuration. Migrate legacy settings to edit this server here."
    : !managed ? "Choose a game below to import this server."
    : managed.unavailable || managed.deleted ? "Check panel access, then reactivate explicitly."
    : managed.archived ? "Unarchive server restores its previous monitoring and main status page settings. Its linked channel and history are retained."
    : !managed.active ? "Start monitoring to create a private linked channel or reuse the saved one. This does not add the server to the main status page."
    : !managed.published ? "Monitoring is enabled. Publish status & channel to add this server to the main status page and open its private linked channel to the selected role."
    : "Monitoring is enabled and this server is on the main status page. Use Settings to adjust it.";
  const embeds = [{ title: label(managed?.name ?? discovered.name), color: legacy ? 0x747f8d : managed?.unavailable ? 0xfaa61a : managed?.active ? 0x57f287 : 0x5865f2,
    description: nextStep,
    fields: [{ name: "State", value: state, inline: true }, { name: "Main status page", value: managed?.archived ? "Archived; previous listing saved" : managed?.published ? "Listed" : legacy ? "Existing configuration" : "Not listed", inline: true },
      ...(managed ? [{ name: "Game", value: label(managed.game.type), inline: true }, { name: "Chat relay", value: !policy.relaySupported ? "Not supported" : !policy.relayEnabled ? "Disabled" : policy.monitoring ? "Enabled" : "Enabled (monitoring paused)", inline: true }, { name: "Linked channel", value: managed.discordChannelId ? `<#${managed.discordChannelId}>` : "Not created", inline: true }, { name: "Publication", value: policy.publicationBlocker === "already-published" ? "Listed on the main status page; linked-channel access follows its saved permissions." : policy.canPublish ? "Publish status & channel adds the main status entry and opens a private linked channel to the selected role. Review the destination before confirming." : "Start monitoring before publishing status and linked-channel access." }] : [])],
    footer: { text: `Server ID: ${id}` } }];
  if (legacy) return { content: "", embeds, components: [], allowedMentions: { parse: [] } };
  const components = managed ? [
    row(button(prefix + "activate", managed.active && !managed.archived && !managed.unavailable && !managed.deleted ? "Check linked channel" : "Start monitoring", "▶️", ButtonStyle.Primary), button(prefix + "bind", "Link existing channel", "🔗"), button(prefix + "publish", "Publish status & channel", "🌐").setDisabled(!policy.canPublish), button(prefix + "settings", "Settings", "⚙️")),
    row(button(prefix + "archive", managed.archived ? "Unarchive server" : "Archive server", "📦"), button(prefix + "disable", "Pause monitoring", "⏸️"), button(prefix + "deleted", "Mark record deleted", "🗂️").setDisabled(!managed.unavailable || managed.deleted), button(prefix + "relay", "Chat relay", "💬"))
  ] : [row(new StringSelectMenuBuilder().setCustomId(prefix + "import").setPlaceholder("🎮 Choose game to import privately").addOptions(["factorio", "minecraft", "satisfactory", "source"].map((value) => ({ label: value === "source" ? "Source engine" : value[0].toUpperCase() + value.slice(1), value }))))];
  if (managed?.game.type === "satisfactory") components[1].addComponents(button(prefix + "game-api", "Game API credentials", "🔑"));
  return { content: "", embeds, components, allowedMentions: { parse: [] } };
}


export function buildAdministrationOverview(config) {
  const connected = Boolean(config.pterodactyl.baseUrl && config.pterodactyl.apiKey);
  return { content: "", embeds: [{ title: "Bridge administration", color: 0x5865f2,
      description: "Choose a game → start monitoring with a linked channel → publish to the main status page and open linked-channel access to the selected role.",
      fields: [{ name: "Panel", value: connected ? "✅ Connected" : "Connect your panel below", inline: true },
        { name: "Main status page channel", value: config.discord.statusChannelId ? `<#${config.discord.statusChannelId}>` : "Create or select a channel", inline: true },
        { name: "Channel categories", value: config.discord.privateCategoryId && config.discord.publicCategoryId ? `Private: <#${config.discord.privateCategoryId}>\nPublic / semi-public: <#${config.discord.publicCategoryId}>` : "Choose categories and an access role below" }],
      footer: { text: "Changes persist across restarts • Export omits credentials" } }], allowedMentions: { parse: [] }, components: [
      row(button("bridge:guide:connect", "Connect panel", "🔑", ButtonStyle.Primary), button("bridge:guide:status-create", "Create main status page", "📊"), button("bridge:guide:status-select", "Select main status channel", "🔗"), button("bridge:guide:categories", "Categories / access role", "🗂️")),
      row(button("bridge:guide:diagnostics", "Diagnostics", "🩺"), button("bridge:guide:export", "Export", "📥"), button("bridge:guide:display", "Archive / deleted display", "👁️"), button("bridge:guide:migrate", "Migrate legacy settings", "📦")),
      row(button("bridge:guide:refresh", "Refresh admin panels", "🔄"))
    ] };
}
