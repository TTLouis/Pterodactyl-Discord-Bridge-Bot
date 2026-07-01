import { getKookStatePath } from "../lib/kook-config.js";
import { StateStore } from "../lib/state-store.js";
import {
  getActionMessageEntry,
  setActionMessageEntry,
  shouldEditActionMessage
} from "../lib/action-message-state.js";

const DEFAULT_API_BASE_URL = "https://www.kookapp.cn/api/v3";
const REQUEST_TIMEOUT_MS = 10_000;

export class KookBridge {
  constructor({
    token,
    guildId,
    stateStore = new StateStore(getKookStatePath()),
    logger,
    apiBaseUrl = process.env.KOOK_API_BASE_URL ?? DEFAULT_API_BASE_URL
  }) {
    this.token = token;
    this.guildId = guildId;
    this.stateStore = stateStore;
    this.logger = logger;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.handlers = [];
    this.interactionHandlers = [];
    this.reactionHandlers = [];
    this.slashCommands = [];
    this.actionMessageQueues = new Map();
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  onInteraction(handler) {
    this.interactionHandlers.push(handler);
  }

  onReaction(handler) {
    this.reactionHandlers.push(handler);
  }

  setSlashCommands(commands) {
    this.slashCommands = commands;
  }

  async start() {
    this.stateStore.load();
    this.logger.info("KOOK bridge ready", {
      guildId: this.guildId,
      statePath: this.stateStore.filePath
    });
  }

  async stop() {}

  async sendMessage(channelId, content) {
    const payload = this.#normalizeMessagePayload(content);
    const result = await this.#post("/message/create", {
      ...payload,
      target_id: channelId
    });

    return {
      id: result.msg_id,
      raw: result
    };
  }

  async replaceActionMessage(channelId, content, { reactions = [], meta = {}, preferEdit = false } = {}) {
    return this.#withActionMessageQueue(channelId, () => this.#replaceActionMessage(channelId, content, {
      reactions,
      meta,
      preferEdit
    }));
  }

  async #replaceActionMessage(channelId, content, { reactions = [], meta = {}, preferEdit = false } = {}) {
    const previousEntry = getActionMessageEntry(this.stateStore, channelId);
    const payload = this.#normalizeMessagePayload(content);

    if (shouldEditActionMessage(previousEntry, meta, { preferEdit })) {
      try {
        await this.#post("/message/update", {
          ...payload,
          msg_id: previousEntry.messageId
        });
        setActionMessageEntry(this.stateStore, channelId, previousEntry.messageId, meta);
        this.logger.info("Edited KOOK action message", {
          channelId,
          messageId: previousEntry.messageId,
          server: meta.serverName,
          previousKind: previousEntry.kind,
          nextKind: meta.kind
        });
        return { id: previousEntry.messageId };
      } catch (error) {
        this.logger.warn(`Failed to edit KOOK action message ${previousEntry.messageId}, sending a new one instead.`, error);
      }
    }

    if (previousEntry?.messageId) {
      try {
        await this.deleteMessage(channelId, previousEntry.messageId);
        this.logger.info("Deleted previous KOOK action message", {
          channelId,
          messageId: previousEntry.messageId,
          server: previousEntry.serverName,
          previousKind: previousEntry.kind,
          nextKind: meta.kind
        });
      } catch (error) {
        this.logger.warn(`Failed to delete previous KOOK action message ${previousEntry.messageId}.`, error);
      }
    }

    const message = await this.sendMessage(channelId, payload);
    setActionMessageEntry(this.stateStore, channelId, message.id, meta);

    for (const reaction of reactions) {
      try {
        await this.#post("/message/add-reaction", {
          msg_id: message.id,
          emoji: reaction
        });
      } catch (error) {
        this.logger.warn(`Failed to add KOOK reaction ${reaction} to action message ${message.id}.`, error);
      }
    }

    return message;
  }

  async #withActionMessageQueue(channelId, callback) {
    const previous = this.actionMessageQueues.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.actionMessageQueues.set(channelId, current);

    try {
      return await current;
    } finally {
      if (this.actionMessageQueues.get(channelId) === current) {
        this.actionMessageQueues.delete(channelId);
      }
    }
  }

  async deleteMessage(channelId, messageId) {
    await this.#post("/message/delete", { msg_id: messageId });
  }

  async upsertStatusPanel(channelId, panel) {
    const knownMessageIds = this.stateStore.getStatusMessageIds(channelId);
    const knownMessageId = knownMessageIds[0] ?? null;
    const payload = this.#normalizeMessagePayload(panel);

    if (knownMessageId) {
      try {
        await this.#post("/message/update", {
          ...payload,
          msg_id: knownMessageId
        });
        await this.#deleteStaleStatusMessages(channelId, knownMessageIds.slice(1));
        this.stateStore.setStatusMessageIds(channelId, [knownMessageId]);
        return;
      } catch (error) {
        this.logger.warn(`Failed to edit KOOK status panel message ${knownMessageId}, sending a new one instead.`, error);
      }
    }

    const message = await this.sendMessage(channelId, payload);
    await this.#deleteStaleStatusMessages(channelId, knownMessageIds);
    this.stateStore.setStatusMessageIds(channelId, [message.id]);
  }

  async #deleteStaleStatusMessages(channelId, messageIds) {
    for (const staleMessageId of messageIds) {
      try {
        await this.deleteMessage(channelId, staleMessageId);
      } catch (error) {
        this.logger.warn(`Failed to delete stale KOOK status panel message ${staleMessageId}.`, error);
      }
    }
  }

  #normalizeMessagePayload(content) {
    if (content && typeof content === "object" && Number.isInteger(content.type) && typeof content.content === "string") {
      return {
        type: content.type,
        content: content.content
      };
    }

    if (typeof content === "string") {
      return {
        type: 9,
        content
      };
    }

    return {
      type: 9,
      content: String(content ?? "")
    };
  }

  async #post(endpoint, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Accept-Language": "en-US",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 0) {
        const message = body?.message ?? response.statusText;
        throw new Error(`${endpoint} failed (${response.status}): ${message}`);
      }

      return body.data ?? {};
    } finally {
      clearTimeout(timeout);
    }
  }
}
