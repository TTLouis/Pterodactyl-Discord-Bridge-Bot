import { formatPlatformRelay } from "../lib/chat-relay-formatters.js";
import { CoreEvents } from "../core/core-events.js";
import { buildActionMessageMeta } from "../lib/action-message-state.js";
import {
  buildKookActionMessageForEvent,
  buildKookArchivePanel,
  buildKookStatusPanel,
  MAX_STATUS_PANEL_SERVERS
} from "../lib/kook-card-formatters.js";

// Mirrors the Discord listener: relay-queue notices are operator-facing.
const LOG_CHANNEL_NOTICE_KINDS = new Set([
  "relay-queue-expired",
  "relay-queue-overflow",
  "relay-failed",
  "relay-uncertain",
  "relay-cancelled",
  "relay-restored-discarded",
  "relay-persistence-failed",
  "auto-stop-failed"
]);

function formatKookServerNotice(event) {
  if (event.kind === "server-archived" || event.kind === "server-unarchived") {
    const name = String(event.server.name).replace(/[`*_~<>@\r\n]/g, " ");
    const note = event.server.archiveNote ? `\n${String(event.server.archiveNote).replace(/@/g, "＠").slice(0, 1000)}` : "";
    const power = event.stopOutcome === "accepted" ? "管理员已请求停止服务器，请求已接受，关闭过程可能仍在进行。"
      : event.stopRequested ? "无法确认管理员的停止请求，请在 Pterodactyl 面板检查服务器运行状态。"
      : "游戏服务器的运行状态不变。";
    return event.kind === "server-archived"
      ? `📦 ${name} 已归档。监控、聊天转发和空闲自动停止已暂停。本频道及消息历史保留。${power}${note}`
      : `📂 ${name} 已取消归档，恢复归档前的设置：监控${event.server.active ? "已启用" : "暂停"}，主状态页面${event.server.published ? "已列出" : "未列出"}。本频道及消息历史保留，游戏服务器的运行状态不变。`;
  }
  if (["relay-uncertain", "relay-cancelled", "relay-restored-discarded", "relay-persistence-failed"].includes(event.kind)) {
    return `${event.server.name}: ${event.message}`;
  }

  if (event.kind === "satisfactory-player-count") {
    const action = event.action === "joined" ? "加入" : "离开";
    return `${event.changedPlayers} 名玩家${action} **${event.server.name}**。(${event.playerCount}/${event.maxPlayers})`;
  }

  if (event.kind === "relay-failed") {
    return `转发失败：${event.message}`;
  }

  if (event.kind === "auto-stop-failed") {
    return `**${event.server.name}** 自动停止失败：${event.message}。冷却后将重试。`;
  }

  if (event.kind === "relay-queue-expired") {
    return `**${event.server.name}** 有 ${event.expiredCount} 条排队转发消息因超过 24 小时而过期。`;
  }

  if (event.kind === "relay-queue-overflow") {
    return `**${event.server.name}** 的转发队列已达上限 ${event.limit} 条，服务器恢复前将丢弃最早的消息。`;
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
    this.warnedAboutTruncation = false;
  }

  start() {
    if (this.unsubscribers.length > 0) return;

    this.unsubscribers = [
      this.eventBus.on(CoreEvents.STATUS_PANEL_UPDATED, (event) => this.#handleSafely("upsert status panel", () => this.#handleStatusPanelUpdated(event))),
      this.eventBus.on(CoreEvents.SERVER_ACTION_MESSAGE, (event) => this.#handleSafely("replace action message", () => this.#handleServerActionMessage(event))),
      this.eventBus.on(CoreEvents.GAME_CHAT_RELAY, (event) => this.#handleGameChatRelay(event)),
      this.eventBus.on(CoreEvents.GROUP_CHAT_RELAY, (event) => this.#handleGroupChatRelay(event)),
      this.eventBus.on(CoreEvents.SERVER_NOTICE, (event) => this.#handleSafely("send server notice", () => this.#handleServerNotice(event)))
    ];
  }

  stop() {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  #warnIfTruncated(snapshots) {
    if (snapshots.length <= MAX_STATUS_PANEL_SERVERS || this.warnedAboutTruncation) {
      return;
    }

    this.warnedAboutTruncation = true;
    this.logger?.warn("KOOK status panel is truncated", {
      configuredServers: snapshots.length,
      shown: MAX_STATUS_PANEL_SERVERS,
      omitted: snapshots.slice(MAX_STATUS_PANEL_SERVERS).map((snapshot) => snapshot.name)
    });
  }

  async #handleStatusPanelUpdated({ snapshots, archivedServers = [], livePanelChanged = true, archivePanelChanged = true }) {
    if (!this.config.kook?.statusChannelId) {
      return null;
    }

    if (archivePanelChanged) {
      await this.kookBridge.upsertStatusPanel(
        this.config.kook.statusChannelId,
        buildKookArchivePanel(archivedServers),
        { panelKey: "archive" }
      );
    }

    if (livePanelChanged) {
      this.#warnIfTruncated(snapshots);
      await this.kookBridge.upsertStatusPanel(
        this.config.kook.statusChannelId,
        buildKookStatusPanel(snapshots, {
          displayTimeZone: this.config.kook.displayTimeZone ?? "Asia/Shanghai"
        }),
        { panelKey: "live" }
      );
    }
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
    return this.#sendRelay(event);
  }

  async #handleGroupChatRelay(event) {
    if (event.sourcePlatform === "kook") return null;
    return this.#sendRelay(event);
  }

  async #sendRelay(event) {
    if (event.destinationPlatform && event.destinationPlatform !== "kook") return null;
    const channelId = event.server.kookChannelId;
    if (!channelId) return null;
    const parts = event.formattedContent ? [event.formattedContent] : formatPlatformRelay(event, "kook");
    let message;
    for (const content of parts) {
      if (event.isCurrent && !event.isCurrent()) throw Object.assign(new Error("Relay route changed"), { deliveryStatus: "not-sent" });
      if (this.kookBridge.sendRelayText) message = await this.kookBridge.sendRelayText(channelId, content, event);
      else {
        event.onDispatch?.();
        message = await this.kookBridge.sendMessage(channelId, content);
      }
    }
    return { platform: "kook", message };
  }

  async #handleServerNotice(event) {
    const kookChannelId = LOG_CHANNEL_NOTICE_KINDS.has(event.kind)
      ? this.config.kook?.logChannelId
      : event.server.kookChannelId;
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
