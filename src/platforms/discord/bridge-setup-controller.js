import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";

import { ensureBridgeCategory, bridgeAdminOverwrites } from "./bridge-category.js";

const BRIDGE_ADMIN_TOPIC = "Private administration for the Pterodactyl bridge";

export const BRIDGE_SETUP_COMMAND = {
  name: "bridge",
  description: "Manage the Pterodactyl bridge",
  default_member_permissions: null,
  options: [{ type: 1, name: "setup", description: "Create or open the private bridge administration channel" }]
};

export function canRunBridgeSetup(interaction, adminRoleId = null) {
  if (interaction.user?.id === interaction.guild?.ownerId
    || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))) return true;
  if (!adminRoleId || adminRoleId === interaction.guildId || adminRoleId === interaction.guild?.id) return false;
  const roles = interaction.member?.roles;
  return Boolean(roles?.cache?.has?.(adminRoleId) || (Array.isArray(roles) && roles.includes(adminRoleId)));
}

export class BridgeSetupController {
  constructor({ discordBridge, configStore, guildId, onSetup = null, logger = null }) {
    this.discordBridge = discordBridge;
    this.configStore = configStore;
    this.guildId = guildId;
    this.onSetup = onSetup;
    this.logger = logger;
    this.started = false;
    this.setupInProgress = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.discordBridge.onInteraction((interaction) => this.handleInteraction(interaction));
  }

  async handleInteraction(interaction) {
    if (interaction.commandName !== "bridge" || interaction.options?.getSubcommand?.(false) !== "setup") return;
    const discordSettings = this.configStore.document?.settings?.discord;
    const adminRoleId = discordSettings?.bridgeAdminRoleId ?? discordSettings?.serverAdminRoleId ?? null;
    if ((this.guildId && interaction.guildId !== this.guildId) || !interaction.guild || !canRunBridgeSetup(interaction, this.guildId ? adminRoleId : null)) {
      await interaction.reply({ content: "Only the guild owner, an administrator, or the configured administration role in a claimed guild can set up this bridge.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.setupInProgress) {
      await interaction.reply({ content: "Bridge setup is already in progress. Try again shortly.", flags: MessageFlags.Ephemeral });
      return;
    }

    this.setupInProgress = true;
    let createdChannel = null;
    let persisted = false;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (adminRoleId) {
        if (adminRoleId === interaction.guild.id) throw new Error("Administration role must not be @everyone");
        const role = await interaction.guild.roles.fetch(adminRoleId);
        if (!role || role.id !== adminRoleId || role.managed || (role.guild?.id && role.guild.id !== interaction.guild.id)) {
          throw new Error("Configured administration role must be an existing role in this guild");
        }
      }
      if (!this.guildId) {
        this.configStore.claimGuild(interaction.guildId);
        this.guildId = interaction.guildId;
        await this.discordBridge.claimGuild(this.guildId);
      }
      const existingId = this.configStore.getAdminChannelId(this.guildId);
      if (existingId) {
        let existing;
        try { existing = await interaction.guild.channels.fetch(existingId, { force: true }); }
        catch (error) { if (Number(error?.code) !== 10003) throw error; }
        if (existing) {
          if (existing.type !== ChannelType.GuildText) {
            await interaction.editReply("The saved bridge administration channel has an unexpected type. No new channel was created; check the saved binding before retrying.");
            return;
          }
          const category = await ensureBridgeCategory({ guild: interaction.guild, configStore: this.configStore,
            botUserId: interaction.client.user.id, actorId: interaction.user.id });
          await existing.permissionOverwrites.set(bridgeAdminOverwrites({ guild: interaction.guild,
            botUserId: interaction.client.user.id, adminRoleId }));
          if (existing.parentId !== category.id) await existing.setParent(category.id, { lockPermissions: false });
          await this.onSetup?.(interaction.guild, existing);
          await interaction.editReply(`Bridge administration channel: <#${existing.id}>`);
          return;
        }
      }

      const channels = await interaction.guild.channels.fetch();
      if (Array.from(channels.values()).some((channel) => channel.type === ChannelType.GuildText && channel.topic === BRIDGE_ADMIN_TOPIC)) {
        await interaction.editReply("An unsaved bridge administration channel already exists. No new channel was created; check the existing channel and persistent storage.");
        return;
      }

      const category = await ensureBridgeCategory({ guild: interaction.guild, configStore: this.configStore,
        botUserId: interaction.client.user.id, actorId: interaction.user.id });
      const permissionOverwrites = bridgeAdminOverwrites({ guild: interaction.guild,
        botUserId: interaction.client.user.id, adminRoleId });

      createdChannel = await interaction.guild.channels.create({
        name: "bridge-admin",
        parent: category.id,
        type: ChannelType.GuildText,
        topic: BRIDGE_ADMIN_TOPIC,
        permissionOverwrites
      });
      this.configStore.setAdminChannelId(this.guildId, createdChannel.id);
      persisted = true;
      await this.onSetup?.(interaction.guild, createdChannel);
      await interaction.editReply(`Created bridge administration channel: <#${createdChannel.id}>`);
    } catch {
      if (persisted) {
        this.logger?.warn("Bridge administration channel was saved, but the Discord confirmation could not be sent.");
        return;
      }
      if (createdChannel && !persisted) {
        try {
          await createdChannel.delete();
        } catch {
          this.logger?.error("Could not remove an unpersisted bridge administration channel; manual cleanup may be required.");
        }
      }
      this.logger?.error("Bridge setup failed; no credentials were logged.");
      const message = "Bridge setup failed. Check bot permissions and persistent storage, then try again.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } finally {
      this.setupInProgress = false;
    }
  }
}
