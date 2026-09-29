import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";

const BRIDGE_ADMIN_TOPIC = "Private administration for the Pterodactyl bridge";

export const BRIDGE_SETUP_COMMAND = {
  name: "bridge",
  description: "Manage the Pterodactyl bridge",
  default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  options: [{ type: 1, name: "setup", description: "Create or open the private bridge administration channel" }]
};

export function canRunBridgeSetup(interaction) {
  return interaction.user?.id === interaction.guild?.ownerId
    || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

export class BridgeSetupController {
  constructor({ discordBridge, configStore, guildId, logger = null }) {
    this.discordBridge = discordBridge;
    this.configStore = configStore;
    this.guildId = guildId;
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
    if (interaction.guildId !== this.guildId || !interaction.guild || !canRunBridgeSetup(interaction)) {
      await interaction.reply({ content: "Only the guild owner or an administrator can set up this bridge.", flags: MessageFlags.Ephemeral });
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
      const existingId = this.configStore.getAdminChannelId(this.guildId);
      if (existingId) {
        const existing = await interaction.guild.channels.fetch(existingId);
        if (!existing || existing.type !== ChannelType.GuildText) {
          await interaction.editReply("The saved bridge administration channel is unavailable. No new channel was created; check the saved channel before retrying.");
          return;
        }
        await interaction.editReply(`Bridge administration channel: <#${existing.id}>`);
        return;
      }

      const channels = await interaction.guild.channels.fetch();
      if (Array.from(channels.values()).some((channel) => channel.type === ChannelType.GuildText && channel.topic === BRIDGE_ADMIN_TOPIC)) {
        await interaction.editReply("An unsaved bridge administration channel already exists. No new channel was created; check the existing channel and persistent storage.");
        return;
      }

      const memberIds = new Set([interaction.client.user.id, interaction.user.id, interaction.guild.ownerId]);
      const access = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
      const permissionOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...Array.from(memberIds).map((id) => ({
          id,
          allow: id === interaction.client.user.id ? [...access, PermissionFlagsBits.ManageChannels] : access
        }))
      ];

      createdChannel = await interaction.guild.channels.create({
        name: "bridge-admin",
        type: ChannelType.GuildText,
        topic: BRIDGE_ADMIN_TOPIC,
        permissionOverwrites
      });
      this.configStore.setAdminChannelId(this.guildId, createdChannel.id);
      persisted = true;
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
