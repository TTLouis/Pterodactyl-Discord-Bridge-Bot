import WebSocket from "ws";
import { logger } from "../lib/logger.js";

const SUBSCRIPTION_AUTH_TIMEOUT_MS = 10_000;
const BACKLOG_READY_TIMEOUT_MS = 1_000;

export class PterodactylClient {
  constructor({
    baseUrl,
    apiKey,
    wingsFqdn,
    wingsWsScheme,
    wingsWsPort,
    subscriptionAuthTimeoutMs = SUBSCRIPTION_AUTH_TIMEOUT_MS,
    backlogReadyTimeoutMs = BACKLOG_READY_TIMEOUT_MS,
    webSocketFactory = (url, options) => new WebSocket(url, options)
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.wingsFqdn = wingsFqdn ?? null;
    this.wingsWsScheme = wingsWsScheme ?? null;
    this.wingsWsPort = wingsWsPort ?? null;
    this.subscriptionAuthTimeoutMs = subscriptionAuthTimeoutMs;
    this.backlogReadyTimeoutMs = backlogReadyTimeoutMs;
    this.webSocketFactory = webSocketFactory;
    this.commandQueues = new Map();
    this.consoleSessions = new Map();
    this.websocketCredentialCache = new Map();

    try {
      logger.info("PterodactylClient initialized", {
        panelHost: new URL(this.baseUrl).host,
        wingsFqdnOverride: this.wingsFqdn ?? "(none)",
        wingsWsSchemeOverride: this.wingsWsScheme ?? "(none)",
        wingsWsPortOverride: this.wingsWsPort ?? "(none)"
      });
    } catch {
      // baseUrl parse failure will surface naturally on first API call
    }
  }

  #apiHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    };
  }

  async #getJson(pathname, errorLabel) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      headers: this.#apiHeaders()
    });

    if (!response.ok) {
      throw new Error(`Pterodactyl ${errorLabel} request failed with ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async getServerResources(serverId) {
    const body = await this.#getJson(`/api/client/servers/${serverId}/resources`, "resources");
    return {
      currentState: body.attributes.current_state,
      memoryBytes: body.attributes.resources?.memory_bytes ?? null,
      cpuPercent: body.attributes.resources?.cpu_absolute ?? null,
      uptimeMs: body.attributes.resources?.uptime ?? null
    };
  }

  async getServerAllocations(serverId) {
    const body = await this.#getJson(`/api/client/servers/${serverId}/network/allocations`, "allocations");
    const rawAllocations = Array.isArray(body.data) ? body.data : [];

    return rawAllocations
      .map((entry) => {
        const attributes = entry?.attributes ?? entry;
        const port = Number(attributes?.port);

        return {
          id: attributes?.id ?? null,
          ip: attributes?.ip ?? null,
          ipAlias: attributes?.ip_alias ?? attributes?.alias ?? null,
          port: Number.isFinite(port) ? port : null,
          notes: attributes?.notes ?? null,
          isDefault: Boolean(attributes?.is_default)
        };
      })
      .filter((allocation) => allocation.port !== null);
  }

  async getServerDefaultAllocation(serverId) {
    const allocations = await this.getServerAllocations(serverId);
    return allocations.find((allocation) => allocation.isDefault) ?? allocations[0] ?? null;
  }

  #invalidateWebsocketCredentials(serverId) {
    this.websocketCredentialCache.delete(serverId);
  }

  #rewriteWingsSocketUrl(rawSocket) {
    let url;
    try {
      url = new URL(rawSocket);
    } catch {
      throw new Error("Pterodactyl returned an unparseable websocket URL");
    }

    const originalScheme = url.protocol.replace(/:$/, "");
    const originalHost = url.hostname;
    const originalPort = url.port;

    const hasOverride = this.wingsFqdn !== null || this.wingsWsScheme !== null || this.wingsWsPort !== null;

    if (this.wingsWsScheme !== null) {
      url.protocol = this.wingsWsScheme + ":";
    }
    if (this.wingsFqdn !== null) {
      url.hostname = this.wingsFqdn;
    }
    if (this.wingsWsPort !== null) {
      url.port = this.wingsWsPort;
    } else if (this.wingsFqdn !== null || this.wingsWsScheme !== null) {
      url.port = "";
    }

    const finalScheme = url.protocol.replace(/:$/, "");
    const changed = finalScheme !== originalScheme || url.hostname !== originalHost || url.port !== originalPort;
    if (changed) {
      logger.info("Wings websocket URL rewritten", {
        returned: { scheme: originalScheme, host: originalHost, port: originalPort || "(default)" },
        final: { scheme: finalScheme, host: url.hostname, port: url.port || "(default)" }
      });
    }

    return url.toString();
  }

  async getServerWebsocket(serverId) {
    const cached = this.websocketCredentialCache.get(serverId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.credentials;
    }

    const body = await this.#getJson(`/api/client/servers/${serverId}/websocket`, "websocket");
    const credentials = {
      socket: body.data.socket,
      token: body.data.token,
      origin: this.baseUrl
    };

    // Pterodactyl tokens are valid for ~10 minutes; cache for 8 to stay clear of expiry
    this.websocketCredentialCache.set(serverId, {
      credentials,
      expiresAt: Date.now() + 8 * 60 * 1000
    });

    return credentials;
  }

  subscribeToConsole(serverId, {
    onConnected,
    onLine,
    onError,
    onStatusChange,
    onReady,
    sendLogs = true,
    reconnectDelayMs = 5000
  } = {}) {
    let ws = null;
    let reconnectHandle = null;
    let authTimeoutHandle = null;
    let backlogTimeoutHandle = null;
    let stopped = false;
    let awaitingInitialLogs = false;
    let consoleConnectedAt = null;
    let hasConnectedSuccessfully = false;
    let currentConnectionIsReconnect = false;
    let authenticatedSocket = null;
    let readySocket = null;
    let activeCommand = null;
    let state = "connecting";

    const setState = (nextState) => {
      state = nextState;
    };

    const clearReconnect = () => {
      if (reconnectHandle) {
        clearTimeout(reconnectHandle);
        reconnectHandle = null;
      }
    };

    const clearAuthTimeout = () => {
      if (authTimeoutHandle) {
        clearTimeout(authTimeoutHandle);
        authTimeoutHandle = null;
      }
    };

    const clearBacklogTimeout = () => {
      if (backlogTimeoutHandle) {
        clearTimeout(backlogTimeoutHandle);
        backlogTimeoutHandle = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectHandle) return;
      reconnectHandle = setTimeout(() => {
        reconnectHandle = null;
        void connect();
      }, reconnectDelayMs);
    };

    const closeSocket = () => {
      if (!ws) return;
      const activeSocket = ws;
      ws = null;
      try {
        activeSocket.close();
      } catch {}
    };

    const finishCommand = (command, error = null) => {
      if (!command || command.settled) return;
      command.settled = true;
      if (command.timeoutHandle) clearTimeout(command.timeoutHandle);
      if (activeCommand === command) activeCommand = null;
      if (error) command.reject(error);
      else command.resolve(command.lines);
    };

    const rejectActiveCommand = (error) => {
      if (activeCommand) finishCommand(activeCommand, error);
    };

    const isReady = () => state === "ready" && authenticatedSocket === ws;
    const notifyReady = () => {
      if (readySocket === ws) return;
      readySocket = ws;
      onReady?.({ isReconnect: currentConnectionIsReconnect });
    };

    const sendCommand = (command, { captureMs = 2500, queueDelayMs = null } = {}) => new Promise((resolve, reject) => {
      if (!isReady() || activeCommand) {
        reject(new Error(`Pterodactyl console session is not ready for server ${serverId}`));
        return;
      }

      const queuedCommand = { command, captureMs, resolve, reject, lines: [], settled: false, timeoutHandle: null };
      activeCommand = queuedCommand;
      try {
        authenticatedSocket.send(JSON.stringify({ event: "send command", args: [command] }));
        logger.info("Pterodactyl command dispatched", {
          serverId,
          transport: "persistent",
          queueDelayMs,
          commandLength: String(command ?? "").length
        });
        queuedCommand.timeoutHandle = setTimeout(() => finishCommand(queuedCommand), captureMs);
      } catch (error) {
        finishCommand(queuedCommand, error);
      }
    });

    const handleConsoleOutput = (payloadArgs, metadata = {}) => {
      const rawLine = Array.isArray(payloadArgs) ? payloadArgs.join("\n") : String(payloadArgs ?? "");
      const lines = rawLine
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        if (activeCommand && !metadata.isBacklog) activeCommand.lines.push(line);
        onLine?.(line, metadata);
      }
    };

    const connect = async () => {
      try {
        const { socket, token, origin } = await this.getServerWebsocket(serverId);
        if (stopped) return;

        const nextSocket = this.webSocketFactory(this.#rewriteWingsSocketUrl(socket), {
          headers: { Origin: origin }
        });
        ws = nextSocket;
        setState("connecting");
        clearAuthTimeout();
        authTimeoutHandle = setTimeout(() => {
          if (ws !== nextSocket || stopped || authenticatedSocket === nextSocket) return;
          const error = new Error(`Pterodactyl websocket authentication timed out for server ${serverId}`);
          setState("disconnected");
          onError?.(error);
          closeSocket();
          scheduleReconnect();
        }, this.subscriptionAuthTimeoutMs);

        nextSocket.on("open", () => {
          try {
            nextSocket.send(JSON.stringify({ event: "auth", args: [token] }));
          } catch (error) {
            onError?.(error);
            closeSocket();
            scheduleReconnect();
          }
        });

        nextSocket.on("message", (buffer) => {
          let payload;
          try {
            payload = JSON.parse(buffer.toString());
          } catch (error) {
            onError?.(error);
            return;
          }

          if (payload.event === "auth error") {
            clearAuthTimeout();
            clearBacklogTimeout();
            authenticatedSocket = null;
            setState("disconnected");
            rejectActiveCommand(new Error(`Pterodactyl websocket auth failed for server ${serverId}`));
            this.#invalidateWebsocketCredentials(serverId);
            onError?.(new Error(`Pterodactyl websocket auth failed for server ${serverId}`));
            closeSocket();
            scheduleReconnect();
            return;
          }

          if (payload.event === "auth success") {
            clearAuthTimeout();
            authenticatedSocket = nextSocket;
            consoleConnectedAt = Date.now();
            const isReconnect = hasConnectedSuccessfully;
            currentConnectionIsReconnect = isReconnect;
            hasConnectedSuccessfully = true;
            awaitingInitialLogs = sendLogs && isReconnect;
            if (awaitingInitialLogs) {
              setState("backlog-syncing");
              nextSocket.send(JSON.stringify({ event: "send logs", args: [null] }));
              clearBacklogTimeout();
              backlogTimeoutHandle = setTimeout(() => {
                if (ws !== nextSocket || state !== "backlog-syncing") return;
                awaitingInitialLogs = false;
                setState("ready");
                logger.warn("Pterodactyl console backlog timed out; persistent commands are now enabled.", { serverId });
                notifyReady();
              }, this.backlogReadyTimeoutMs);
            } else {
              setState("ready");
              notifyReady();
            }
            logger.info("Pterodactyl console websocket authenticated", { serverId, isReconnect, state });
            onConnected?.({ isReconnect });
            return;
          }

          if (payload.event === "ping") {
            nextSocket.send(JSON.stringify({ event: "pong", args: [] }));
            return;
          }

          if (payload.event === "status") {
            const newState = Array.isArray(payload.args) ? payload.args[0] : null;
            if (newState) onStatusChange?.(newState);
            return;
          }

          if (payload.event === "console output") {
            const isBacklog = awaitingInitialLogs;
            awaitingInitialLogs = false;
            if (isBacklog) {
              clearBacklogTimeout();
              setState("ready");
              logger.info("Pterodactyl console backlog received", { serverId });
              notifyReady();
            }
            handleConsoleOutput(payload.args, {
              connectedAt: consoleConnectedAt,
              isBacklog,
              isReconnect: currentConnectionIsReconnect && isBacklog
            });
          }
        });

        nextSocket.on("error", (error) => {
          if (authenticatedSocket === nextSocket) {
            authenticatedSocket = null;
            setState("disconnected");
          }
          onError?.(error);
        });

        nextSocket.on("close", (code, reason) => {
          clearAuthTimeout();
          clearBacklogTimeout();
          if (authenticatedSocket === nextSocket) authenticatedSocket = null;
          awaitingInitialLogs = false;
          setState(stopped ? "stopped" : "disconnected");
          rejectActiveCommand(new Error(`Pterodactyl websocket closed before command completed: ${code} ${reason.toString()}`));
          if (ws === nextSocket) ws = null;
          if (stopped || code === 1000) return;
          onError?.(new Error(`Pterodactyl websocket closed unexpectedly: ${code} ${reason.toString()}`));
          scheduleReconnect();
        });
      } catch (error) {
        setState("disconnected");
        onError?.(error);
        scheduleReconnect();
      }
    };

    void connect();

    const unsubscribe = () => {
      stopped = true;
      clearReconnect();
      clearAuthTimeout();
      clearBacklogTimeout();
      setState("stopped");
      rejectActiveCommand(new Error(`Pterodactyl console subscription stopped for server ${serverId}`));
      closeSocket();
      if (this.consoleSessions.get(serverId)?.unsubscribe === unsubscribe) {
        this.consoleSessions.delete(serverId);
      }
    };

    unsubscribe.sendCommand = sendCommand;
    this.consoleSessions.set(serverId, { unsubscribe, isReady, sendCommand, getState: () => state });
    return unsubscribe;
  }

  async runCommand(serverId, command, options = {}) {
    const current = this.commandQueues.get(serverId) ?? Promise.resolve();
    const queuedAt = Date.now();
    const next = current.catch(() => {}).then(async () => {
      const session = this.consoleSessions.get(serverId);
      if (!session?.isReady()) {
        throw new Error(`Pterodactyl console session is not ready for server ${serverId}`);
      }
      return session.sendCommand(command, {
        ...options,
        queueDelayMs: Date.now() - queuedAt
      });
    });
    this.commandQueues.set(serverId, next.then(() => {}, () => {}));
    return next;
  }

  isConsoleSessionReady(serverId) {
    return this.consoleSessions.get(serverId)?.isReady() ?? false;
  }

  async setPowerState(serverId, action) {
    const response = await fetch(`${this.baseUrl}/api/client/servers/${serverId}/power`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ signal: action })
    });

    if (!response.ok) {
      throw new Error(`Pterodactyl power request failed with ${response.status}: ${await response.text()}`);
    }
  }

}
