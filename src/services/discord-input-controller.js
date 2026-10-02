import { canRunBridgeSetup } from "./bridge-setup-controller.js";
import { isServerActionsEnabled } from "../lib/server-lifecycle.js";
import { randomUUID } from "node:crypto";
import { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "./auto-stop-service.js";

export const DISCORD_SLASH_COMMANDS = [
  { name: "start-server", description: "Start a stopped game server" },
  { name: "cancel-stop", description: "Cancel a pending auto-stop" },
  { name: "refresh-status", description: "Force refresh all game server status panels" },
  { name: "restart-bot", description: "Restart the bot process" }
];

export class DiscordInputController {
  constructor({ config, discordBridge, autoStopService, syncService, logger, onRestartRequested = null, restartDelayMs = 1000 }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.autoStopService = autoStopService;
    this.syncService = syncService;
    this.logger = logger;
    this.onRestartRequested = onRestartRequested;
    this.restartDelayMs = restartDelayMs;
    this.pendingPowerConfirmations = new Map();
    this.powerConfirmationTtlMs = 60_000;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.discordBridge.setSlashCommands(DISCORD_SLASH_COMMANDS);
    this.discordBridge.onInteraction(async (interaction) => this.#handleInteraction(interaction));
    this.discordBridge.onReaction(async (reaction) => this.#handleReaction(reaction));
  }

  async #handleInteraction(interaction) {
    if (interaction.customId?.startsWith("bridge-power:")) { await this.#confirmPower(interaction); return; }
    if (this.config.discord.guildId && interaction.guildId && interaction.guildId !== this.config.discord.guildId) return;
    if (interaction.commandName === "refresh-status") {
      await this.#handleRefreshStatusCommand(interaction);
      return;
    }

    if (interaction.commandName === "restart-bot") {
      await this.#handleRestartBotCommand(interaction);
      return;
    }

    if (interaction.commandName !== "start-server" && interaction.commandName !== "cancel-stop") return;

    const server = this.config.servers.find((entry) => isServerActionsEnabled(entry) && entry.discordChannelId === interaction.channelId);
    if (!server) {
      await interaction.reply({ content: "This command can only be used in a configured server channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      if (interaction.commandName === "start-server") {
        await this.#requestConfirmation(server, {
          userId: interaction.user?.id,
          guildId: interaction.guildId ?? this.config.discord.guildId,
          channelId: interaction.channelId,
          reply: (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral })
        });
      } else if (interaction.commandName === "cancel-stop") {
        await this.autoStopService.handleCancelStopCommand(server, interaction);
      }
    } catch (error) {
      this.logger.error(`Failed handling /${interaction.commandName} for ${server.name}`, error);
      try {
        const replyMethod = interaction.replied || interaction.deferred ? "followUp" : "reply";
        await interaction[replyMethod]({ content: "Something went wrong. Try again later.", flags: MessageFlags.Ephemeral });
      } catch {}
    }
  }

  async #audit(serverId, userId, outcome) {
    try {
      await this.autoStopService.onAudit?.({ user: userId, server: serverId, action: "start-confirmation", outcome });
    } catch (error) { this.logger.warn?.("Failed recording confirmation audit", error); }
  }

  async #requestConfirmation(server, { userId, guildId, channelId, reply }) {
    if (!userId) return;
    const now = Date.now();
    for (const [id, pending] of this.pendingPowerConfirmations) {
      if (pending.expiresAt <= now) this.pendingPowerConfirmations.delete(id);
    }
    // Bound memory even when users issue requests without pressing a button.
    if (this.pendingPowerConfirmations.size >= 1000) {
      this.pendingPowerConfirmations.delete(this.pendingPowerConfirmations.keys().next().value);
    }
    const id = randomUUID();
    this.pendingPowerConfirmations.set(id, {
      userId, guildId, channelId, serverId: server.pterodactylServerId, expiresAt: now + this.powerConfirmationTtlMs
    });
    await reply({
      content: `Start **${server.name}**? Confirm within 60 seconds. The panel and your permissions will be checked again.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bridge-power:confirm:${id}`).setLabel("Confirm start").setEmoji("🟢").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bridge-power:cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      )]
    });
    await this.#audit(server.pterodactylServerId, userId, "requested");
  }

  async #confirmPower(interaction) {
    const [, operation, id] = interaction.customId.split(":");
    const pending = this.pendingPowerConfirmations.get(id);
    const reject = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!pending) { await reject("This confirmation expired or was already used. Request a new start."); return; }
    if (pending.userId !== interaction.user?.id
      || pending.channelId !== interaction.channelId
      || pending.guildId !== (interaction.guildId ?? this.config.discord.guildId)
      || (this.config.discord.guildId && pending.guildId !== this.config.discord.guildId)) {
      await reject("Only the original requester can confirm this action in its server channel.");
      return;
    }
    this.pendingPowerConfirmations.delete(id);
    if (pending.expiresAt <= Date.now()) {
      await this.#audit(pending.serverId, pending.userId, "expired");
      await reject("This confirmation expired. Request a new start.");
      return;
    }
    if (operation === "cancel") {
      await this.#audit(pending.serverId, pending.userId, "cancelled");
      await interaction.update({ content: "Start cancelled.", components: [] });
      return;
    }
    const server = this.config.servers.find((entry) =>
      entry.pterodactylServerId === pending.serverId && entry.discordChannelId === pending.channelId && isServerActionsEnabled(entry));
    if (!server || operation !== "confirm") {
      await this.#audit(pending.serverId, pending.userId, "blocked");
      await reject("Monitoring is disabled or panel access is unavailable. Ask an administrator to check and reactivate the server.");
      return;
    }
    try {
      if (interaction.guild?.members?.fetch) interaction.member = await interaction.guild.members.fetch(pending.userId);
      const started = await this.autoStopService.handleStartCommand(server, interaction);
      await this.#audit(pending.serverId, pending.userId, started ? "confirmed" : "rejected");
      if (started) await this.syncService.syncOnce({ force: true });
    } catch (error) {
      await this.#audit(pending.serverId, pending.userId, "failed");
      this.logger.error("Failed confirming server start", error);
      if (!interaction.replied && !interaction.deferred) await reject("Could not confirm your permissions or reach the panel. Request a new start.");
    }
  }

  async #requireAdministrationAccess(interaction) {
    const claimedGuildId = this.config.discord.guildId;
    const roleId = this.config.discord.bridgeAdminRoleId ?? this.config.discord.serverAdminRoleId;
    if (claimedGuildId && interaction.guildId === claimedGuildId && canRunBridgeSetup(interaction, roleId)) return true;
    await interaction.reply({
      content: "Only the guild owner, an administrator, or a member with the configured bridge administration role can use this command.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }

  async #handleRefreshStatusCommand(interaction) {
    const logChannelId = this.config.discord.logChannelId;
    if (!logChannelId) {
      await interaction.reply({ content: "No Discord log channel is configured for this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.channelId !== logChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured log channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (!await this.#requireAdministrationAccess(interaction)) return;
    const requestedBy = interaction.member?.displayName ?? interaction.user?.username ?? "Unknown";
    this.logger.info("Manual status refresh requested", { requestedBy, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.syncService.syncOnce({ force: true, reason: "manual" });
    await interaction.editReply({ content: "Status refresh completed for all configured game servers." });
  }

  async #handleRestartBotCommand(interaction) {
    const logChannelId = this.config.discord.logChannelId;
    if (!logChannelId) {
      await interaction.reply({ content: "No Discord log channel is configured for this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.channelId !== logChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured log channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!await this.#requireAdministrationAccess(interaction)) return;
    if (!this.onRestartRequested) {
      await interaction.reply({ content: "Bot restart is not available in this runtime.", flags: MessageFlags.Ephemeral });
      return;
    }

    const requestedBy = interaction.member?.displayName ?? interaction.user?.username ?? "Unknown";
    this.logger.info("Bot restart requested", { requestedBy, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ content: "Restarting bot process. It should come back online shortly." });

    const request = () => void this.onRestartRequested({ requestedBy, channelId: interaction.channelId });
    if (this.restartDelayMs <= 0) request();
    else setTimeout(request, this.restartDelayMs);
  }

  async #handleReaction(reaction) {
    const server = this.config.servers.find((entry) => isServerActionsEnabled(entry) && entry.discordChannelId === reaction.channelId);
    if (!server) return;

    try {
      if (reaction.emoji === RESTART_SERVER_REACTION) {
        if (reaction.messageId !== this.autoStopService.stateStore?.getActionMessageId(server.discordChannelId)) return;
        await reaction.removeUserReaction();
        await this.#requestConfirmation(server, {
          userId: reaction.userId,
          guildId: this.config.discord.guildId,
          channelId: reaction.channelId,
          reply: (payload) => this.discordBridge.sendMessage(reaction.channelId, {
            ...payload,
            content: `<@${reaction.userId}> ${payload.content}`,
            allowedMentions: { users: [reaction.userId] }
          })
        });
      } else if (reaction.emoji === CANCEL_AUTO_STOP_REACTION) {
        await this.autoStopService.handleCancelStopReaction(server, reaction);
      }
    } catch (error) {
      this.logger.error(`Failed handling ${reaction.emoji} reaction for ${server.name}`, error);
    }
  }
}
