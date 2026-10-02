import { isServerActionsEnabled } from "../lib/server-lifecycle.js";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { CoreEvents } from "../core/core-events.js";
import { buildStartRequestedEmbed } from "../lib/formatters.js";

const STOP_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

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
  constructor({ config, pterodactylClient, eventBus, stateStore, logger, onAudit = null, onServerUnavailable = null }) {
    this.config = config;
    this.pterodactylClient = pterodactylClient;
    this.eventBus = eventBus;
    this.stateStore = stateStore;
    this.logger = logger;
    this.onAudit = onAudit;
    this.onServerUnavailable = onServerUnavailable;
  }

  // Called from StatusSyncService after each successful poll for a running server.
  async onRunningSnapshot(server, playerCount) {
    if (!this.#canOperate(server) || !server.autoStop?.enabled) return;

    const now = Date.now();
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);

    // Don't re-trigger if the bot already sent the stop command this cycle.
    if (state.stoppedByBot) return;

    if (playerCount > 0) {
      if (state.warningSentAt) {
        // A player joined while a warning was pending; cancel visibly.
        await this.#deleteLegacyWarningMessage(server);
        try {
          await this.#publishActionMessage(server, {
            kind: "activity-cancelled"
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
      await this.#autoStopServer(server, { idleMs, state, now });
      return;
    }

    if (idleMs >= warningMs && !state.warningSentAt) {
      const stopAt = new Date(state.lastNonEmptyAt + stopMs);
      this.logger.info(`Sending auto-stop warning for ${server.name}`);
      try {
        const results = await this.#publishActionMessage(server, {
          kind: "auto-stop-warning",
          stopAt
        });
        const messageId = this.#getDiscordMessageId(results);
        this.stateStore.setAutoStopState(server.pterodactylServerId, {
          warningSentAt: now,
          warningMessageId: messageId
        });
      } catch (error) {
        this.logger.error(`Failed to send auto-stop warning for ${server.name}`, error);
      }
    }
  }

  /**
   * Issues the stop, then records and announces it.
   *
   * The old order announced the stop and set stoppedByBot first, so a failed
   * power request left Discord claiming the server had stopped while it kept
   * running, and the stoppedByBot short-circuit then disabled auto-stop for
   * that server until it next came online, which it never would.
   */
  async #autoStopServer(server, { idleMs, state, now }) {
    if (!this.#canOperate(server)) return;
    const serverId = server.pterodactylServerId;

    if (state.lastStopAttemptAt && now - state.lastStopAttemptAt < STOP_RETRY_COOLDOWN_MS) {
      return;
    }

    this.logger.info(`Auto-stopping ${server.name} after ${Math.round(idleMs / 3600000)}h of inactivity`);

    try {
      await this.pterodactylClient.setPowerState(serverId, "stop");
      await this.#audit(server, "system", "auto-stop", "accepted");
    } catch (error) {
      await this.#audit(server, "system", "auto-stop", "failed");
      this.logger.error(`Failed to auto-stop ${server.name}`, error);
      this.stateStore.setAutoStopState(serverId, { lastStopAttemptAt: now });
      try {
        await this.eventBus.emit(CoreEvents.SERVER_NOTICE, {
          kind: "auto-stop-failed",
          server,
          message: error.message
        });
      } catch (noticeError) {
        this.logger.warn(`Failed publishing auto-stop failure for ${server.name}`, noticeError);
      }
      return;
    }

    // Record before the offline transition lands, so onWentOffline suppresses
    // the duplicate "stopped externally" notice.
    this.stateStore.setAutoStopState(serverId, { stoppedByBot: true, lastStopAttemptAt: null });

    try {
      await this.#deleteLegacyWarningMessage(server);
      this.stateStore.setAutoStopState(serverId, { warningMessageId: null });
      await this.#publishActionMessage(server, { kind: "auto-stopped" });
    } catch (error) {
      this.logger.error(`Failed to announce auto-stop for ${server.name}`, error);
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
      await this.#publishActionMessage(server, {
        kind: "manual-stopped",
        restartAccess: describeExternalRestartAccess(this.config.discord)
      });
    } catch (error) {
      this.logger.error(`Failed to send manual-stop notification for ${server.name}`, error);
    }
  }

  // Called when a server transitions from offline → running.
  async onCameOnline(server, startInfo = null) {
    this.stateStore.clearAutoStopState(server.pterodactylServerId);
    const resolvedStartInfo = startInfo ?? this.#consumeStartAttribution(server);
    try {
      await this.#publishActionMessage(server, {
        kind: "server-online",
        startInfo: resolvedStartInfo
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
      userId: interaction.user?.id ?? null,
      member: interaction.member,
      onAlreadyRunning: async () => {
        await interaction.reply({ content: "The server is already running.", flags: MessageFlags.Ephemeral });
      },
      onPanelUnavailable: async () => {
        await interaction.reply({ content: "Could not reach the panel. Try again in a moment.", flags: MessageFlags.Ephemeral });
      },
      onUnauthorized: async () => {
        await interaction.reply({
          content: `This server was stopped externally. Only ${describeExternalRestartAccess(this.config.discord)} can restart it.`,
          flags: MessageFlags.Ephemeral
        });
      },
      onAccepted: async () => {
        await interaction.reply({ embeds: [buildStartRequestedEmbed(server.name)], flags: MessageFlags.Ephemeral });
      },
      onFailure: async () => {
        await interaction.followUp({ content: "Failed to send the start signal. Check the panel.", flags: MessageFlags.Ephemeral });
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
      userId: reaction.userId ?? reaction.user?.id ?? null,
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
    userId = null,
    member,
    onAlreadyRunning,
    onPanelUnavailable,
    onUnauthorized,
    onAccepted,
    onFailure
  }) {
    if (!this.#canOperate(server)) { await onPanelUnavailable(); return false; }
    let resources;
    try {
      resources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
    } catch (error) {
      if (error.retryable) { server.accessUncertain = true; this.stateStore.clearAutoStopState?.(server.pterodactylServerId); }
      else await this.#markUnavailable(server);
      await this.#audit(server, userId, "start", "failed");
      this.logger.error(`Failed to fetch resources for ${server.name} during /start-server`, error);
      await onPanelUnavailable();
      return false;
    }

    if (!this.#canOperate(server)) { await onPanelUnavailable(); return false; }
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
      await this.#publishActionMessage(server, {
        kind: "server-starting-requested",
        requestedBy
      });
      this.#recordPendingStart(server, { requestedBy, requestedAt });
      if (!this.#canOperate(server)) throw new Error("Server monitoring was disabled.");
      await this.pterodactylClient.setPowerState(server.pterodactylServerId, "start");
      await this.#audit(server, userId, "start", "accepted");
      this.stateStore.clearAutoStopState(server.pterodactylServerId);
      return true;
    } catch (error) {
      await this.#audit(server, userId, "start", "failed");
      this.#clearPendingStart(server);
      this.logger.error(`Failed to start ${server.name} via /start-server`, error);
      await onFailure();
      return false;
    }
  }

  // Handler for the /cancel-stop slash command.
  async handleCancelStopCommand(server, interaction) {
    if (!this.#canOperate(server) || !server.autoStop?.enabled) {
      await interaction.reply({ content: "Auto-stop is not enabled for this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningSentAt || state.stoppedByBot) {
      await interaction.reply({ content: "There is no pending auto-stop to cancel.", flags: MessageFlags.Ephemeral });
      return;
    }

    const cancelledBy = interaction.member?.displayName ?? interaction.user.username;
    await interaction.reply({ content: "Auto-stop cancelled.", flags: MessageFlags.Ephemeral });
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

    if (!this.#canOperate(server) || !server.autoStop?.enabled) {
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

    await this.#publishActionMessage(server, {
      kind: "auto-stop-cancelled",
      cancelledBy
    });
  }

  #isCurrentActionReaction(server, reaction) {
    return reaction.messageId === this.stateStore.getActionMessageId(server.discordChannelId);
  }

  #recordPendingStart(server, { requestedBy, requestedAt }) {
    if (this.stateStore.setPendingStartAttribution) {
      this.stateStore.setPendingStartAttribution(server.pterodactylServerId, {
        source: "discord",
        startedBy: requestedBy,
        startedAt: requestedAt
      });
      return;
    }

    this.stateStore.setServerRuntimeState?.(server.pterodactylServerId, {
      pendingStartAttribution: {
        source: "discord",
        startedBy: requestedBy,
        startedAt: requestedAt
      }
    });
  }

  #clearPendingStart(server) {
    if (this.stateStore.clearPendingStartAttribution) {
      this.stateStore.clearPendingStartAttribution(server.pterodactylServerId);
      return;
    }

    const runtimeState = this.stateStore.getServerRuntimeState?.(server.pterodactylServerId);
    if (runtimeState?.pendingStartAttribution) {
      delete runtimeState.pendingStartAttribution;
      this.stateStore.setServerRuntimeState?.(server.pterodactylServerId, runtimeState);
    }
  }

  #consumeStartAttribution(server) {
    let pending;
    if (this.stateStore.consumePendingStartAttribution) {
      pending = this.stateStore.consumePendingStartAttribution(server.pterodactylServerId);
    } else {
      const runtimeState = this.stateStore.getServerRuntimeState?.(server.pterodactylServerId) ?? {};
      pending = runtimeState.pendingStartAttribution ?? null;
      if (pending) {
        delete runtimeState.pendingStartAttribution;
        this.stateStore.setServerRuntimeState?.(server.pterodactylServerId, runtimeState);
      }
    }

    if (pending?.source === "discord" && pending.startedBy) {
      return {
        source: "discord",
        startedBy: pending.startedBy,
        startedAt: pending.startedAt ?? null
      };
    }

    return {
      source: "pterodactyl-panel",
      startedBy: null,
      startedAt: null
    };
  }

  #canOperate(server) {
    return isServerActionsEnabled(server) && (!this.config.servers || this.config.servers.includes(server));
  }

  async #markUnavailable(server) {
    server.unavailable = true;
    this.stateStore.clearAutoStopState?.(server.pterodactylServerId);
    try {
      await this.onServerUnavailable?.(server, { reason: "Panel access failed; check connectivity and permissions, then reactivate." });
    } catch (error) {
      this.logger.warn?.("Failed persisting unavailable server state", error);
    }
  }

  async #audit(server, user, action, outcome) {
    try {
      await this.onAudit?.({ user: user == null ? null : String(user).slice(0, 100), server: server.pterodactylServerId, action, outcome });
    } catch (error) {
      this.logger.warn?.("Failed recording power action audit", error);
    }
  }

  async #publishActionMessage(server, event) {
    return this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, {
      server,
      ...event
    });
  }

  #getDiscordMessageId(results) {
    return results.find((result) => result?.platform === "discord")?.message?.id ?? null;
  }

  async #deleteLegacyWarningMessage(server) {
    const state = this.stateStore.getAutoStopState(server.pterodactylServerId);
    if (!state.warningMessageId) return;
    if (state.warningMessageId === this.stateStore.getActionMessageId(server.discordChannelId)) return;
    try {
      await this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE_DELETE, {
        server,
        messageId: state.warningMessageId
      });
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
