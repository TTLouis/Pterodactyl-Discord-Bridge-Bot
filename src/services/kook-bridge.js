import { getKookStatePath } from "../lib/kook-config.js";
import { StateStore } from "../lib/state-store.js";
import WebSocket from "ws";
import {
  getActionMessageEntry,
  setActionMessageEntry,
  shouldEditActionMessage
} from "../lib/action-message-state.js";

const DEFAULT_API_BASE_URL = "https://www.kookapp.cn/api/v3";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_GATEWAY_RECONNECT_DELAY_MS = 5_000;
const REQUEST_RETRY_DELAY_MS = 1_000;
const RETRYABLE_ENDPOINTS = new Set([
  "/message/update",
  "/message/delete",
  "/message/add-reaction"
]);

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function parseGatewayPayload(data) {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
        : String(data ?? "");
  return JSON.parse(text);
}

function isTextMessageEvent(event) {
  return event?.channel_type === "GROUP" && (event.type === 1 || event.type === 9);
}

function resolveAuthorName(event) {
  return event.extra?.author?.nickname
    ?? event.extra?.author?.username
    ?? event.author?.nickname
    ?? event.author?.username
    ?? event.author_id
    ?? "KOOK";
}

export class KookBridge {
  constructor({
    token,
    guildId,
    stateStore = new StateStore(getKookStatePath()),
    logger,
    apiBaseUrl = process.env.KOOK_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    requestTimeoutMs = parsePositiveInteger(process.env.KOOK_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    requestRetryDelayMs = REQUEST_RETRY_DELAY_MS,
    gatewayHeartbeatIntervalMs = DEFAULT_GATEWAY_HEARTBEAT_INTERVAL_MS,
    gatewayReconnectDelayMs = DEFAULT_GATEWAY_RECONNECT_DELAY_MS,
    webSocketFactory = (url) => new WebSocket(url)
  }) {
    this.token = token;
    this.guildId = guildId;
    this.stateStore = stateStore;
    this.logger = logger;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestRetryDelayMs = requestRetryDelayMs;
    this.gatewayHeartbeatIntervalMs = gatewayHeartbeatIntervalMs;
    this.gatewayReconnectDelayMs = gatewayReconnectDelayMs;
    this.webSocketFactory = webSocketFactory;
    this.handlers = [];
    this.interactionHandlers = [];
    this.reactionHandlers = [];
    this.slashCommands = [];
    this.actionMessageQueues = new Map();
    this.socket = null;
    this.heartbeatHandle = null;
    this.reconnectHandle = null;
    this.lastSequence = 0;
    this.sessionId = null;
    this.botUserId = null;
    this.stopped = true;
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
    this.stopped = false;
    this.stateStore.load();
    try {
      const me = await this.#get("/user/me");
      this.botUserId = me.id != null ? String(me.id) : null;
    } catch (error) {
      this.logger.warn("Failed to fetch KOOK bot user; inbound self-message filtering may be limited.", error);
    }

    try {
      await this.#connectGateway();
    } catch (error) {
      this.logger.warn("Failed to connect KOOK gateway; will retry in the background.", error);
      this.#scheduleReconnect();
    }

    this.logger.info("KOOK bridge ready", {
      guildId: this.guildId,
      statePath: this.stateStore.filePath
    });
  }

  async stop() {
    this.stopped = true;
    this.#clearHeartbeat();
    if (this.reconnectHandle) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners?.();
      socket.close?.();
    }
  }

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

  async #connectGateway() {
    const gateway = await this.#get("/gateway/index", { compress: 0 });
    if (this.stopped) {
      return;
    }

    const socket = this.webSocketFactory(gateway.url);
    this.socket = socket;

    socket.on("message", (data) => {
      void this.#handleGatewayMessage(data);
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.#clearHeartbeat();
      this.#scheduleReconnect();
    });

    socket.on("error", (error) => {
      this.logger.warn("KOOK gateway socket error.", error);
    });
  }

  async #handleGatewayMessage(data) {
    let payload;
    try {
      payload = parseGatewayPayload(data);
    } catch (error) {
      this.logger.warn("Received invalid KOOK gateway payload.", error);
      return;
    }

    if (payload.s === 1) {
      if (payload.d?.code !== 0) {
        this.logger.warn("KOOK gateway rejected the session.", payload.d);
        return;
      }

      this.sessionId = payload.d?.session_id ?? this.sessionId;
      this.#startHeartbeat();
      return;
    }

    if (payload.s === 0) {
      const sequence = Number(payload.sn);
      if (Number.isFinite(sequence)) {
        this.lastSequence = sequence;
      }
      await this.#handleGatewayEvent(payload.d);
      return;
    }

    if (payload.s === 5) {
      this.logger.warn("KOOK gateway requested reconnect.");
      this.socket?.close?.();
    }
  }

  async #handleGatewayEvent(event) {
    if (!isTextMessageEvent(event)) {
      return;
    }

    const guildId = event.extra?.guild_id != null ? String(event.extra.guild_id) : null;
    if (guildId && guildId !== String(this.guildId)) {
      return;
    }

    const authorId = event.author_id != null ? String(event.author_id) : null;
    if (authorId && this.botUserId && authorId === this.botUserId) {
      return;
    }

    if (event.extra?.author?.bot) {
      return;
    }

    const content = String(event.content ?? "").trim();
    const channelId = event.target_id != null ? String(event.target_id) : null;
    if (!content || !channelId) {
      return;
    }

    const message = {
      sourcePlatform: "kook",
      authorId,
      authorName: resolveAuthorName(event),
      channelId,
      content,
      messageId: event.msg_id ?? null
    };

    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  #startHeartbeat() {
    this.#clearHeartbeat();
    this.heartbeatHandle = setInterval(() => {
      const socket = this.socket;
      if (!socket || this.stopped) {
        return;
      }

      if (socket.readyState !== undefined && socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ s: 2, sn: this.lastSequence }));
    }, this.gatewayHeartbeatIntervalMs);
  }

  #clearHeartbeat() {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectHandle) {
      return;
    }

    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.#connectGateway().catch((error) => {
        this.logger.warn("Failed to reconnect KOOK gateway; will retry.", error);
        this.#scheduleReconnect();
      });
    }, this.gatewayReconnectDelayMs);
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
    const maxAttempts = RETRYABLE_ENDPOINTS.has(endpoint) ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.#postOnce(endpoint, payload);
      } catch (error) {
        lastError = error;
        if (!isAbortError(error) || attempt >= maxAttempts) {
          throw error;
        }

        this.logger?.warn(`KOOK API ${endpoint} timed out; retrying once.`, error);
        await sleep(this.requestRetryDelayMs);
      }
    }

    throw lastError;
  }

  async #get(endpoint, params = {}) {
    const url = new URL(`${this.apiBaseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bot ${this.token}`,
          "Accept-Language": "en-US"
        },
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

  async #postOnce(endpoint, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

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
