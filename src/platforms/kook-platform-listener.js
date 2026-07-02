import { CoreEvents } from "../core/core-events.js";
import { buildActionMessageMeta } from "../lib/action-message-state.js";
import { buildKookActionMessageForEvent, buildKookStatusPanel } from "../lib/kook-card-formatters.js";

function formatKookGroupRelayMessage(message) {
  const platform = message.sourcePlatform === "discord" ? "Discord" : "聊天";
  return `[${platform}] **${message.authorName}**: ${message.content}`;
}

function formatKookServerNotice(event) {
  if (event.kind === "satisfactory-player-count") {
    const action = event.action === "joined" ? "加入" : "离开";
    return `${event.changedPlayers} 名玩家${action} **${event.server.name}**。(${event.playerCount}/${event.maxPlayers})`;
  }

  if (event.kind === "relay-failed") {
    return `转发失败：${event.message}`;
  }

  return null;
}

export class KookPlatformListener {
  constructor({ eventBus, kookBridge, config, logger }) {
    this.eventBus = eventBus;
    this.kookBridge = kookBridge;
    this.config = config;
    this.logger = logger;
    this.unsubscribers = [];
  }

  start() {
    if (this.unsubscribers.length > 0) return;

    this.unsubscribers = [
      this.eventBus.on(CoreEvents.STATUS_PANEL_UPDATED, (event) => this.#handleSafely("upsert status panel", () => this.#handleStatusPanelUpdated(event))),
      this.eventBus.on(CoreEvents.SERVER_ACTION_MESSAGE, (event) => this.#handleSafely("replace action message", () => this.#handleServerActionMessage(event))),
      this.eventBus.on(CoreEvents.GAME_CHAT_RELAY, (event) => this.#handleSafely("send game chat relay", () => this.#handleGameChatRelay(event))),
      this.eventBus.on(CoreEvents.GROUP_CHAT_RELAY, (event) => this.#handleSafely("send group chat relay", () => this.#handleGroupChatRelay(event))),
      this.eventBus.on(CoreEvents.SERVER_NOTICE, (event) => this.#handleSafely("send server notice", () => this.#handleServerNotice(event)))
    ];
  }

  stop() {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  async #handleStatusPanelUpdated({ snapshots }) {
    if (!this.config.kook?.statusChannelId) {
      return null;
    }

    await this.kookBridge.upsertStatusPanel(
      this.config.kook.statusChannelId,
      buildKookStatusPanel(snapshots, {
        displayTimeZone: this.config.kook.displayTimeZone ?? "Asia/Shanghai"
      })
    );
    return { platform: "kook" };
  }

  async #handleServerActionMessage(event) {
    const kookChannelId = event.server.kookChannelId;
    if (!kookChannelId) {
      return null;
    }

    const message = buildKookActionMessageForEvent(event);
    if (!message) {
      return null;
    }

    await this.kookBridge.replaceActionMessage(kookChannelId, message, {
      meta: buildActionMessageMeta(event),
      preferEdit: true
    });
    return { platform: "kook" };
  }

  async #handleGameChatRelay(event) {
    const kookChannelId = event.server.kookChannelId;
    if (!kookChannelId) {
      return null;
    }

    await this.kookBridge.sendMessage(kookChannelId, `**${event.authorName}**: ${event.content}`);
    return { platform: "kook" };
  }

  async #handleGroupChatRelay(event) {
    const kookChannelId = event.server.kookChannelId;
    if (event.sourcePlatform === "kook" || !kookChannelId) {
      return null;
    }

    await this.kookBridge.sendMessage(kookChannelId, formatKookGroupRelayMessage(event));
    return { platform: "kook" };
  }

  async #handleServerNotice(event) {
    const kookChannelId = event.server.kookChannelId;
    if (!kookChannelId) {
      return null;
    }

    const content = formatKookServerNotice(event);
    if (!content) {
      return null;
    }

    await this.kookBridge.sendMessage(kookChannelId, content);
    return { platform: "kook" };
  }

  async #handleSafely(action, callback) {
    try {
      return await callback();
    } catch (error) {
      this.logger.warn(`Failed to ${action} on KOOK.`, error);
      return null;
    }
  }
}
