import { PermissionFlagsBits } from "discord.js";
import {
  buildActivityCancelledEmbed,
  buildAutoStopWarningEmbed,
  buildAutoStoppedEmbed,
  buildCancelStopEmbed,
  buildManuallyStoppedEmbed,
  buildServerOnlineEmbed,
  buildStartRequestedEmbed,
  buildServerStartingEmbed
} from "../lib/formatters.js";

export const CANCEL_AUTO_STOP_REACTION = "🔴";
export const RESTART_SERVER_REACTION = "🟢";

export function canMemberRestartExternallyStoppedServer(member, discordConfig) {
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roles = member?.roles?.cache;
  if (!roles) {
    return false;
  }

  if (discordConfig.serverAdminRoleId && roles.has(discordConfig.serverAdminRoleId)) {
    return true;
  }

  const roleName = discordConfig.serverAdminRoleName?.toLowerCase();
  return Boolean(roleName && Array.from(roles.values()).some((role) => role.name?.toLowerCase() === roleName));
}

export function canRestartExternallyStoppedServer(interaction, discordConfig) {
  return canMemberRestartExternallyStoppedServer(interaction.member, discordConfig);
}

function describeExternalRestartAccess(discordConfig) {
  const roleName = discordConfig.serverAdminRoleName;
  return roleName
    ? `a Discord administrator or a member with the \`${roleName}\` role`
    : "a Discord administrator";
}

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
        // A player joined while a warning was pending; cancel visibly.
        await this.#deleteLegacyWarningMessage(server);
        try {
          await this.discordBridge.replaceActionMessage(server.discordChannelId, {
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
        await this.#deleteLegacyWarningMessage(server);
        await this.discordBridge.replaceActionMessage(server.discordChannelId, {
          embeds: [buildAutoStoppedEmbed(server.name)]
        }, {
          reactions: [RESTART_SERVER_REACTION]
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
        const message = await this.discordBridge.replaceActionMessage(server.discordChannelId, {
          embeds: [buildAutoStopWarningEmbed(server.name, stopAt)]
        }, {
          reactions: [CANCEL_AUTO_STOP_REACTION]
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

    await this.#deleteLegacyWarningMessage(server);
    this.stateStore.setAutoStopState(server.pterodactylServerId, {
      manualStop: true,
      warningMessageId: null
    });
    try {
      await this.discordBridge.replaceActionMessage(server.discordChannelId, {
        embeds: [buildManuallyStoppedEmbed(server.name, describeExternalRestartAccess(this.config.discord))]
      }, {
        reactions: [RESTART_SERVER_REACTION]
      });
    } catch (error) {
      this.logger.error(`Failed to send manual-stop notification for ${server.name}`, error);
    }
  }

  // Called when a server transitions from offline → running.
  async onCameOnline(server) {
    this.stateStore.clearAutoStopState(server.pterodactylServerId);
    const startInfo = this.#getLastStartInfo(server);
    try {
      await this.discordBridge.replaceActionMessage(server.discordChannelId, {
        embeds: [buildServerOnlineEmbed(server.name, startInfo)]
      });
    } catch (error) {
      this.logger.error(`Failed to send online notification for ${server.name}`, error);
    }
  }

  // Handler for the /start-server slash command.
  async handleStartCommand(server, interaction) {
    const requestedBy = interaction.member?.displayName ?? interaction.user.username;
    const started = await this.#requestServerStart(server, {
      requestedBy,
      member: interaction.member,
      onAlreadyRunning: async () => {
        await interaction.reply({ content: "The server is already running.", ephemeral: true });
      },
      onPanelUnavailable: async () => {
        await interaction.reply({ content: "Could not reach the panel. Try again in a moment.", ephemeral: true });
      },
      onUnauthorized: async () => {
        await interaction.reply({
          content: `This server was stopped externally. Only ${describeExternalRestartAccess(this.config.discord)} can restart it.`,
          ephemeral: true
        });
      },
      onAccepted: async () => {
        await interaction.reply({ embeds: [buildStartRequestedEmbed(server.name)], ephemeral: true });
      },
      onFailure: async () => {
        await interaction.followUp({ content: "Failed to send the start signal. Check the panel.", ephemeral: true });
      }
    });

    return started;
  }

  async handleStartReaction(server, reaction) {
    if (!this.#isCurrentActionReaction(server, reaction)) {
      return false;
    }

    await this.#removeReaction(reaction);
    const started = await this.#requestServerStart(server, {
      requestedBy: reaction.displayName,
      member: reaction.member,
      onAlreadyRunning: async () => {},
      onPanelUnavailable: async () => {},
      onUnauthorized: async () => {},
      onAccepted: async () => {},
      onFailure: async () => {}
    });
    return started;
  }

  async #requestServerStart(server, {
    requestedBy,
    member,
    onAlreadyRunning,
    onPanelUnavailable,
    onUnauthorized,
    onAccepted,
    onFailure
  }) {
    let resources;
    try {
      resources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
    } catch (error) {
      this.logger.error(`Failed to fetch resources for ${server.name} during /start-server`, error);
      await onPanelUnavailable();
      return false;
    }

    if (resources.currentState === "running" || resources.currentState === "starting") {
      await onAlreadyRunning();
      return false;
    }

    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    const isManualStop = state.manualStop && !state.stoppedByBot;

    if (isManualStop) {
      if (!canMemberRestartExternallyStoppedServer(member, this.config.discord)) {
        await onUnauthorized();
        return false;
      }
    }

    const requestedAt = Date.now();
    try {
      await onAccepted();
      await this.discordBridge.replaceActionMessage(server.discordChannelId, {
        embeds: [buildServerStartingEmbed(server.name, requestedBy)]
      });
      await this.pterodactylClient.setPowerState(server.pterodactylServerId, "start");
      this.#recordStartRequest(server, { requestedBy, requestedAt });
      this.stateStore.clearAutoStopState(server.pterodactylServerId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to start ${server.name} via /start-server`, error);
      await onFailure();
      return false;
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
    await interaction.reply({ content: "Auto-stop cancelled.", ephemeral: true });
    try {
      await this.#cancelPendingAutoStop(server, cancelledBy);
    } catch (error) {
      this.logger.error(`Failed to confirm /cancel-stop for ${server.name}`, error);
    }
  }

  async handleCancelStopReaction(server, reaction) {
    if (!this.#isCurrentActionReaction(server, reaction)) {
      return false;
    }

    if (!server.autoStop?.enabled) {
      await this.#removeReaction(reaction);
      return false;
    }

    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningSentAt || state.stoppedByBot) {
      await this.#removeReaction(reaction);
      return false;
    }

    try {
      await this.#removeReaction(reaction);
      await this.#cancelPendingAutoStop(server, reaction.displayName);
    } catch (error) {
      this.logger.error(`Failed to cancel auto-stop by reaction for ${server.name}`, error);
      return false;
    }

    return true;
  }

  async #cancelPendingAutoStop(server, cancelledBy) {
    await this.#deleteLegacyWarningMessage(server);
    this.stateStore.setAutoStopState(server.pterodactylServerId, {
      lastNonEmptyAt: Date.now(),
      warningSentAt: null,
      warningMessageId: null
    });

    await this.discordBridge.replaceActionMessage(server.discordChannelId, {
      embeds: [buildCancelStopEmbed(server.name, cancelledBy)]
    });
  }

  #isCurrentActionReaction(server, reaction) {
    return reaction.messageId === this.stateStore.getActionMessageId(server.discordChannelId);
  }

  #recordStartRequest(server, { requestedBy, requestedAt }) {
    this.stateStore.setServerRuntimeState?.(server.pterodactylServerId, {
      lastStartRequestedBy: requestedBy,
      lastStartRequestedAt: requestedAt
    });
  }

  #getLastStartInfo(server) {
    const runtimeState = this.stateStore.getServerRuntimeState?.(server.pterodactylServerId) ?? {};
    return {
      startedBy: runtimeState.lastStartRequestedBy ?? null,
      startedAt: runtimeState.lastStartRequestedAt ?? null
    };
  }

  async #deleteLegacyWarningMessage(server) {
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningMessageId) return;
    if (state.warningMessageId === this.stateStore.getActionMessageId(server.discordChannelId)) return;
    try {
      await this.discordBridge.deleteMessage(server.discordChannelId, state.warningMessageId);
    } catch (error) {
      this.logger.warn(`Failed to delete warning message for ${server.name}`, error);
    }
  }

  async #removeReaction(reaction) {
    try {
      await reaction.removeUserReaction();
    } catch (error) {
      this.logger.warn(`Failed to remove reaction ${reaction.emoji} from ${reaction.userId}.`, error);
    }
  }
}
