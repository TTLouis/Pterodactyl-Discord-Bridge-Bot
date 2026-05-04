import { PermissionFlagsBits } from "discord.js";
import {
  buildActivityCancelledEmbed,
  buildAutoStopWarningEmbed,
  buildAutoStoppedEmbed,
  buildCancelStopEmbed,
  buildManuallyStoppedEmbed,
  buildServerStartingEmbed
} from "../lib/formatters.js";

export class AutoStopService {
  constructor({ config, pterodactylClient, discordBridge, stateStore, logger }) {
    this.config = config;
    this.pterodactylClient = pterodactylClient;
    this.discordBridge = discordBridge;
    this.stateStore = stateStore;
    this.logger = logger;
  }

  // Called from StatusSyncService after each successful poll for a running server.
  async onRunningSnapshot(server, playerCount) {
    if (!server.autoStop?.enabled) return;

    const now = Date.now();
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);

    // Don't re-trigger if the bot already sent the stop command this cycle.
    if (state.stoppedByBot) return;

    if (playerCount > 0) {
      if (state.warningSentAt) {
        // A player joined while a warning was pending — cancel visibly.
        await this.#deleteWarningMessage(server);
        try {
          await this.discordBridge.sendMessage(server.discordChannelId, {
            embeds: [buildActivityCancelledEmbed(server.name)]
          });
        } catch (error) {
          this.logger.error(`Failed to send activity-cancel notification for ${server.name}`, error);
        }
      }
      this.stateStore.setAutoStopState(server.pterodactylServerId, {
        lastNonEmptyAt: now,
        warningSentAt: null,
        warningMessageId: null
      });
      return;
    }

    // Server is empty — start or continue idle tracking.
    if (!state.lastNonEmptyAt) {
      this.stateStore.setAutoStopState(server.pterodactylServerId, { lastNonEmptyAt: now });
      return;
    }

    const { emptyTimeoutHours, warningMinutesBefore } = server.autoStop;
    const stopMs = emptyTimeoutHours * 3600 * 1000;
    const warningMs = stopMs - warningMinutesBefore * 60 * 1000;
    const idleMs = now - state.lastNonEmptyAt;

    if (idleMs >= stopMs) {
      this.logger.info(`Auto-stopping ${server.name} after ${Math.round(idleMs / 3600000)}h of inactivity`);
      try {
        await this.#deleteWarningMessage(server);
        await this.discordBridge.sendMessage(server.discordChannelId, {
          embeds: [buildAutoStoppedEmbed(server.name)]
        });
        this.stateStore.setAutoStopState(server.pterodactylServerId, {
          stoppedByBot: true,
          warningMessageId: null
        });
        await this.pterodactylClient.setPowerState(server.pterodactylServerId, "stop");
      } catch (error) {
        this.logger.error(`Failed to auto-stop ${server.name}`, error);
      }
      return;
    }

    if (idleMs >= warningMs && !state.warningSentAt) {
      const stopAt = new Date(state.lastNonEmptyAt + stopMs);
      this.logger.info(`Sending auto-stop warning for ${server.name}`);
      try {
        const message = await this.discordBridge.sendMessage(server.discordChannelId, {
          embeds: [buildAutoStopWarningEmbed(server.name, stopAt)]
        });
        this.stateStore.setAutoStopState(server.pterodactylServerId, {
          warningSentAt: now,
          warningMessageId: message.id
        });
      } catch (error) {
        this.logger.error(`Failed to send auto-stop warning for ${server.name}`, error);
      }
    }
  }

  // Called when a server transitions from running → offline.
  async onWentOffline(server) {
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (state.stoppedByBot) {
      // Bot initiated this stop; notification was already sent in onRunningSnapshot.
      return;
    }

    await this.#deleteWarningMessage(server);
    this.stateStore.setAutoStopState(server.pterodactylServerId, {
      manualStop: true,
      warningMessageId: null
    });
    try {
      await this.discordBridge.sendMessage(server.discordChannelId, {
        embeds: [buildManuallyStoppedEmbed(server.name)]
      });
    } catch (error) {
      this.logger.error(`Failed to send manual-stop notification for ${server.name}`, error);
    }
  }

  // Called when a server transitions from offline → running.
  async onCameOnline(server) {
    this.stateStore.clearAutoStopState(server.pterodactylServerId);
    try {
      await this.discordBridge.sendMessage(server.discordChannelId, "Server is back online.");
    } catch (error) {
      this.logger.error(`Failed to send online notification for ${server.name}`, error);
    }
  }

  // Handler for the /start-server slash command.
  async handleStartCommand(server, interaction) {
    let resources;
    try {
      resources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
    } catch (error) {
      this.logger.error(`Failed to fetch resources for ${server.name} during /start-server`, error);
      await interaction.reply({ content: "Could not reach the panel. Try again in a moment.", ephemeral: true });
      return;
    }

    if (resources.currentState === "running" || resources.currentState === "starting") {
      await interaction.reply({ content: "The server is already running.", ephemeral: true });
      return;
    }

    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    const isManualStop = state.manualStop && !state.stoppedByBot;

    if (isManualStop) {
      const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false;
      if (!isAdmin) {
        await interaction.reply({
          content: "This server was stopped externally. Only a server admin can restart it.",
          ephemeral: true
        });
        return;
      }
    }

    const requestedBy = interaction.member?.displayName ?? interaction.user.username;
    try {
      await interaction.reply({ embeds: [buildServerStartingEmbed(server.name, requestedBy)] });
      this.stateStore.clearAutoStopState(server.pterodactylServerId);
      await this.pterodactylClient.setPowerState(server.pterodactylServerId, "start");
    } catch (error) {
      this.logger.error(`Failed to start ${server.name} via /start-server`, error);
      await interaction.followUp({ content: "Failed to send the start signal. Check the panel.", ephemeral: true });
    }
  }

  // Handler for the /cancel-stop slash command.
  async handleCancelStopCommand(server, interaction) {
    if (!server.autoStop?.enabled) {
      await interaction.reply({ content: "Auto-stop is not enabled for this server.", ephemeral: true });
      return;
    }

    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningSentAt || state.stoppedByBot) {
      await interaction.reply({ content: "There is no pending auto-stop to cancel.", ephemeral: true });
      return;
    }

    const cancelledBy = interaction.member?.displayName ?? interaction.user.username;
    await this.#deleteWarningMessage(server);
    this.stateStore.setAutoStopState(server.pterodactylServerId, {
      lastNonEmptyAt: Date.now(),
      warningSentAt: null,
      warningMessageId: null
    });

    try {
      await interaction.reply({ embeds: [buildCancelStopEmbed(server.name, cancelledBy)] });
    } catch (error) {
      this.logger.error(`Failed to confirm /cancel-stop for ${server.name}`, error);
    }
  }

  async #deleteWarningMessage(server) {
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningMessageId) return;
    try {
      await this.discordBridge.deleteMessage(server.discordChannelId, state.warningMessageId);
    } catch (error) {
      this.logger.warn(`Failed to delete warning message for ${server.name}`, error);
    }
  }
}
