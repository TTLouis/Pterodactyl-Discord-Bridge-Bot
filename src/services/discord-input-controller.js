import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "./auto-stop-service.js";

export const DISCORD_SLASH_COMMANDS = [
  { name: "start-server", description: "Start a stopped game server" },
  { name: "cancel-stop", description: "Cancel a pending auto-stop" },
  { name: "refresh-status", description: "Force refresh all game server status panels" },
  { name: "restart-bot", description: "Restart the bot process" },
  {
    name: "bridge",
    description: "Configure Pterodactyl Platform Bridge",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "setup",
        description: "Create/continue Discord onboarding and import a Pterodactyl server"
      }
    ]
  }
];

export class DiscordInputController {
  constructor({
    config,
    discordBridge,
    autoStopService,
    syncService,
    onboardingService = null,
    logger,
    onRestartRequested = null,
    restartDelayMs = 1000
  }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.autoStopService = autoStopService;
    this.syncService = syncService;
    this.onboardingService = onboardingService;
    this.logger = logger;
    this.onRestartRequested = onRestartRequested;
    this.restartDelayMs = restartDelayMs;
  }

  start() {
    this.discordBridge.setSlashCommands(DISCORD_SLASH_COMMANDS);
    this.discordBridge.onInteraction(async (interaction) => this.#handleInteraction(interaction));
    this.discordBridge.onReaction(async (reaction) => this.#handleReaction(reaction));
  }

  async #handleInteraction(interaction) {
    if (interaction.isStringSelectMenu?.()) {
      if (interaction.customId?.startsWith("bridge:") && this.onboardingService) {
        await this.onboardingService.handleInteraction(interaction);
      }
      return;
    }

    if (interaction.commandName === "bridge") {
      if (!this.onboardingService) {
        await interaction.reply({
          content: "Discord onboarding is not available in this runtime.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await this.onboardingService.handleInteraction(interaction);
      return;
    }

    if (interaction.commandName === "refresh-status") {
      await this.#handleRefreshStatusCommand(interaction);
      return;
    }

    if (interaction.commandName === "restart-bot") {
      await this.#handleRestartBotCommand(interaction);
      return;
    }

    const server = this.config.servers.find((entry) => !entry.archived && entry.discordChannelId === interaction.channelId);
    if (!server) {
      await interaction.reply({ content: "This command can only be used in a configured server channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      if (interaction.commandName === "start-server") {
        const startRequested = await this.autoStopService.handleStartCommand(server, interaction);
        if (startRequested) await this.syncService.syncOnce({ force: true });
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

  async #handleRefreshStatusCommand(interaction) {
    const adminChannelId = this.config.discord.adminChannelId;
    if (!adminChannelId) {
      await interaction.reply({ content: "No Discord admin channel is configured for this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.channelId !== adminChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured admin channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    const requestedBy = interaction.member?.displayName ?? interaction.user?.username ?? "Unknown";
    this.logger.info("Manual status refresh requested", { requestedBy, channelId: interaction.channelId });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.syncService.syncOnce({ force: true, reason: "manual" });
    await interaction.editReply({ content: "Status refresh completed for all configured game servers." });
  }

  async #handleRestartBotCommand(interaction) {
    const adminChannelId = this.config.discord.adminChannelId;
    if (!adminChannelId) {
      await interaction.reply({ content: "No Discord admin channel is configured for this bot.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.channelId !== adminChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured admin channel.", flags: MessageFlags.Ephemeral });
      return;
    }
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
    const server = this.config.servers.find((entry) => !entry.archived && entry.discordChannelId === reaction.channelId);
    if (!server) return;

    try {
      if (reaction.emoji === RESTART_SERVER_REACTION) {
        const startRequested = await this.autoStopService.handleStartReaction(server, reaction);
        if (startRequested) await this.syncService.syncOnce({ force: true });
      } else if (reaction.emoji === CANCEL_AUTO_STOP_REACTION) {
        await this.autoStopService.handleCancelStopReaction(server, reaction);
      }
    } catch (error) {
      this.logger.error(`Failed handling ${reaction.emoji} reaction for ${server.name}`, error);
    }
  }
}
