import { CoreEvents } from "../core/core-events.js";
import {
  buildActivityCancelledEmbed,
  buildAutoStopWarningEmbed,
  buildAutoStoppedEmbed,
  buildCancelStopEmbed,
  buildManuallyStoppedEmbed,
  buildServerOfflineEmbed,
  buildServerOnlineEmbed,
  buildServerStartingEmbed,
  buildServerStartingStateEmbed,
  buildServerStoppingStateEmbed,
  buildStatusPanel
} from "../lib/formatters.js";
import { buildActionMessageMeta } from "../lib/action-message-state.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "../services/auto-stop-service.js";

function formatDiscordRelayMessage(message) {
  return `**${message.authorName}**: ${message.content}`;
}

function formatDiscordGroupRelayMessage(message) {
  const platform = message.sourcePlatform === "kook" ? "KOOK" : "Chat";
  return `[${platform}] **${message.authorName}**: ${message.content}`;
}

function buildDiscordActionMessage(event) {
  switch (event.kind) {
    case "activity-cancelled":
      return { payload: { embeds: [buildActivityCancelledEmbed(event.server.name)] } };
    case "auto-stop-warning":
      return {
        payload: { embeds: [buildAutoStopWarningEmbed(event.server.name, event.stopAt)] },
        reactions: [CANCEL_AUTO_STOP_REACTION]
      };
    case "auto-stopped":
      return {
        payload: { embeds: [buildAutoStoppedEmbed(event.server.name)] },
        reactions: [RESTART_SERVER_REACTION]
      };
    case "manual-stopped":
      return {
        payload: { embeds: [buildManuallyStoppedEmbed(event.server.name, event.restartAccess)] },
        reactions: [RESTART_SERVER_REACTION]
      };
    case "server-online":
      return { payload: { embeds: [buildServerOnlineEmbed(event.server.name, event.startInfo)] } };
    case "server-starting-requested":
      return { payload: { embeds: [buildServerStartingEmbed(event.server.name, event.requestedBy)] } };
    case "auto-stop-cancelled":
      return { payload: { embeds: [buildCancelStopEmbed(event.server.name, event.cancelledBy)] } };
    case "server-starting-state":
      return { payload: { embeds: [buildServerStartingStateEmbed(event.server.name)] } };
    case "server-stopping-state":
      return { payload: { embeds: [buildServerStoppingStateEmbed(event.server.name)] } };
    case "server-offline":
      return {
        payload: { embeds: [buildServerOfflineEmbed(event.server.name, event.currentState)] },
        reactions: [RESTART_SERVER_REACTION]
      };
    default:
      return null;
  }
}

function formatDiscordServerNotice(event) {
  if (event.kind === "satisfactory-player-count") {
    const noun = event.changedPlayers === 1 ? "player" : "players";
    return `${event.changedPlayers} ${noun} ${event.action} **${event.server.name}**. (${event.playerCount}/${event.maxPlayers})`;
  }

  if (event.kind === "relay-failed") {
    return `Relay failed: ${event.message}`;
  }

  return null;
}

export class DiscordPlatformListener {
  constructor({ eventBus, discordBridge, config }) {
    this.eventBus = eventBus;
    this.discordBridge = discordBridge;
    this.config = config;
    this.unsubscribers = [];
  }

  start() {
    if (this.unsubscribers.length > 0) return;

    this.unsubscribers = [
      this.eventBus.on(CoreEvents.STATUS_PANEL_UPDATED, (event) => this.#handleStatusPanelUpdated(event)),
      this.eventBus.on(CoreEvents.SERVER_ACTION_MESSAGE, (event) => this.#handleServerActionMessage(event)),
      this.eventBus.on(CoreEvents.SERVER_ACTION_MESSAGE_DELETE, (event) => this.#handleServerActionMessageDelete(event)),
      this.eventBus.on(CoreEvents.GAME_CHAT_RELAY, (event) => this.#handleGameChatRelay(event)),
      this.eventBus.on(CoreEvents.GROUP_CHAT_RELAY, (event) => this.#handleGroupChatRelay(event)),
      this.eventBus.on(CoreEvents.SERVER_NOTICE, (event) => this.#handleServerNotice(event))
    ];
  }

  stop() {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  async #handleStatusPanelUpdated({ snapshots }) {
    await this.discordBridge.upsertStatusPanel(
      this.config.discord.statusChannelId,
      buildStatusPanel(snapshots, {
        displayTimeZone: this.config.discord.displayTimeZone
      })
    );
  }

  async #handleServerActionMessage(event) {
    const actionMessage = buildDiscordActionMessage(event);
    if (!actionMessage || !event.server.discordChannelId) {
      return null;
    }

    const message = await this.discordBridge.replaceActionMessage(
      event.server.discordChannelId,
      actionMessage.payload,
      {
        reactions: actionMessage.reactions ?? [],
        meta: buildActionMessageMeta(event),
        preferEdit: true
      }
    );

    return {
      platform: "discord",
      message
    };
  }

  async #handleServerActionMessageDelete(event) {
    if (!event.server.discordChannelId || !event.messageId) {
      return null;
    }

    await this.discordBridge.deleteMessage(event.server.discordChannelId, event.messageId);
    return { platform: "discord" };
  }

  async #handleGameChatRelay(event) {
    if (!event.server.discordChannelId) {
      return null;
    }

    const message = await this.discordBridge.sendMessage(event.server.discordChannelId, formatDiscordRelayMessage(event));
    return {
      platform: "discord",
      message
    };
  }

  async #handleGroupChatRelay(event) {
    if (event.sourcePlatform === "discord" || !event.server.discordChannelId) {
      return null;
    }

    const message = await this.discordBridge.sendMessage(event.server.discordChannelId, formatDiscordGroupRelayMessage(event));
    return {
      platform: "discord",
      message
    };
  }

  async #handleServerNotice(event) {
    if (!event.server.discordChannelId) {
      return null;
    }

    const content = formatDiscordServerNotice(event);
    if (!content) {
      return null;
    }

    const message = await this.discordBridge.sendMessage(event.server.discordChannelId, content);
    return {
      platform: "discord",
      message
    };
  }
}
