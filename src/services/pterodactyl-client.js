import WebSocket from "ws";
import { logger } from "../lib/logger.js";

export class PterodactylClient {
  constructor({ baseUrl, apiKey, wingsFqdn, wingsWsScheme, wingsWsPort }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.wingsFqdn = wingsFqdn ?? null;
    this.wingsWsScheme = wingsWsScheme ?? null;
    this.wingsWsPort = wingsWsPort ?? null;
    this.commandQueues = new Map();
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

  async getServerResources(serverId) {
    const response = await fetch(`${this.baseUrl}/api/client/servers/${serverId}/resources`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Pterodactyl resources request failed with ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
    return {
      currentState: body.attributes.current_state,
      memoryBytes: body.attributes.resources?.memory_bytes ?? null,
      cpuPercent: body.attributes.resources?.cpu_absolute ?? null,
      uptimeMs: body.attributes.resources?.uptime ?? null
    };
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

    const response = await fetch(`${this.baseUrl}/api/client/servers/${serverId}/websocket`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Pterodactyl websocket request failed with ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
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

  subscribeToConsole(serverId, { onConnected, onLine, onError, onStatusChange, reconnectDelayMs = 5000 } = {}) {
    let ws = null;
    let reconnectHandle = null;
    let stopped = false;
    let awaitingInitialLogs = false;
    let consoleConnectedAt = null;

    const clearReconnect = () => {
      if (!reconnectHandle) {
        return;
      }

      clearTimeout(reconnectHandle);
      reconnectHandle = null;
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectHandle) {
        return;
      }

      reconnectHandle = setTimeout(() => {
        reconnectHandle = null;
        void connect();
      }, reconnectDelayMs);
    };

    const closeSocket = () => {
      if (!ws) {
        return;
      }

      const activeSocket = ws;
      ws = null;

      try {
        activeSocket.close();
      } catch {}
    };

    const handleConsoleOutput = (payloadArgs, metadata = {}) => {
      const rawLine = Array.isArray(payloadArgs) ? payloadArgs.join("\n") : String(payloadArgs ?? "");
      const lines = rawLine
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        onLine?.(line, metadata);
      }
    };

    const connect = async () => {
      try {
        const { socket, token, origin } = await this.getServerWebsocket(serverId);
        if (stopped) {
          return;
        }

        const rewrittenSocket = this.#rewriteWingsSocketUrl(socket);
        const nextSocket = new WebSocket(rewrittenSocket, {
          headers: {
            Origin: origin
          }
        });
        ws = nextSocket;

        nextSocket.on("open", () => {
          nextSocket.send(JSON.stringify({ event: "auth", args: [token] }));
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
            this.#invalidateWebsocketCredentials(serverId);
            onError?.(new Error(`Pterodactyl websocket auth failed for server ${serverId}`));
            closeSocket();
            scheduleReconnect();
            return;
          }

          if (payload.event === "auth success") {
            consoleConnectedAt = Date.now();
            awaitingInitialLogs = true;
            nextSocket.send(JSON.stringify({ event: "send logs", args: [null] }));
            onConnected?.();
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
            handleConsoleOutput(payload.args, { connectedAt: consoleConnectedAt, isBacklog });
          }
        });

        nextSocket.on("error", (error) => {
          onError?.(error);
        });

        nextSocket.on("close", (code, reason) => {
          if (ws === nextSocket) {
            ws = null;
          }

          if (stopped || code === 1000) {
            return;
          }

          onError?.(new Error(`Pterodactyl websocket closed unexpectedly: ${code} ${reason.toString()}`));
          scheduleReconnect();
        });
      } catch (error) {
        onError?.(error);
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      stopped = true;
      clearReconnect();
      closeSocket();
    };
  }

  async runCommand(serverId, command, options = {}) {
    const current = this.commandQueues.get(serverId) ?? Promise.resolve();
    const next = current.then(() => this.#executeCommand(serverId, command, options));
    this.commandQueues.set(serverId, next.then(() => {}, () => {}));
    return next;
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

  async #executeCommand(serverId, command, options = {}) {
    const { captureMs = 2500 } = options;
    const { socket, token, origin } = await this.getServerWebsocket(serverId);
    const rewrittenSocket = this.#rewriteWingsSocketUrl(socket);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(rewrittenSocket, {
        headers: {
          Origin: origin
        }
      });

      const lines = [];
      let settled = false;
      let timeoutHandle = null;

      const finish = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        try {
          ws.close();
        } catch {}

        if (error) {
          reject(error);
          return;
        }

        resolve(lines);
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({ event: "auth", args: [token] }));
      });

      ws.on("message", (buffer) => {
        const payload = JSON.parse(buffer.toString());

        if (payload.event === "auth success") {
          ws.send(JSON.stringify({ event: "send command", args: [command] }));
          timeoutHandle = setTimeout(() => finish(), captureMs);
          return;
        }

        if (payload.event === "auth error") {
          this.#invalidateWebsocketCredentials(serverId);
          finish(new Error(`Pterodactyl websocket auth failed for server ${serverId}`));
          return;
        }

        if (payload.event === "ping") {
          ws.send(JSON.stringify({ event: "pong", args: [] }));
          return;
        }

        if (payload.event !== "console output") {
          return;
        }

        const line = Array.isArray(payload.args) ? payload.args.join("\n") : String(payload.args ?? "");
        lines.push(line);
      });

      ws.on("error", (error) => {
        finish(error);
      });

      ws.on("close", (code, reason) => {
        if (!settled && code !== 1000) {
          finish(new Error(`Pterodactyl websocket closed unexpectedly: ${code} ${reason.toString()}`));
        }
      });
    });
  }
}
