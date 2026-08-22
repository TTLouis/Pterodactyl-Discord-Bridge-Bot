import { CHAT_RELAY_CAPTURE_MS } from "../lib/relay-limits.js";

const ONLINE_PLAYERS_COMMAND = "/players o";
const TIME_COMMAND = "/time";
const ANSI_CONTROL_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const FACTORIO_CHAT_LINE_PATTERN = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+)?\[CHAT\]\s+([^:]+):\s*(.*)$/;
const FACTORIO_GPS_ONLY_PATTERN = /^\[gps=[^\]]+\]$/i;
const FACTORIO_PLAYER_EVENT_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(JOIN|LEAVE)\] .+ (joined|left) the game$/;
const FACTORIO_INFO_LOG_LINE_PATTERN = /^\d+(?:\.\d+)?\s+Info\b/;

function normalizeConsoleLines(lines) {
  return lines
    .flatMap((line) => String(line ?? "").split(/\r?\n/))
    .map(normalizeConsoleLine)
    .filter(Boolean);
}

function normalizeConsoleLine(line) {
  return String(line ?? "").replace(ANSI_CONTROL_PATTERN, "").trim();
}

function isFactorioInfoLogLine(line) {
  return FACTORIO_INFO_LOG_LINE_PATTERN.test(String(line ?? "").trim());
}

function stripEchoedCommand(command, lines) {
  let removed = false;

  return lines.filter((line) => {
    if (!removed && line.trim() === command.trim()) {
      removed = true;
      return false;
    }

    return true;
  });
}

const PLAYER_ENTRY_PATTERN = /^(.+?)\s+\(online\)$/i;

function parsePlayerList(lines) {
  const normalizedLines = stripEchoedCommand(
    ONLINE_PLAYERS_COMMAND,
    normalizeConsoleLines(lines).filter((line) => !isFactorioInfoLogLine(line))
  );
  const headerIndex = normalizedLines.findIndex((line) => /Players\s*\(\d+\):/i.test(line));
  if (headerIndex === -1) {
    // No parsable output is not the same as an empty server; let the caller keep
    // the last known list instead of reporting zero players.
    return null;
  }

  const players = normalizedLines
    .slice(headerIndex + 1)
    .map((line) => line.match(PLAYER_ENTRY_PATTERN)?.[1] ?? null)
    .filter(Boolean);

  return { playerCount: players.length, players };
}

function stripFactorioColorTags(value) {
  return String(value ?? "").replace(/\[\/?color(?:=#[0-9a-f]{6})?\]/gi, "");
}

function isPlatformRelayName(authorName) {
  return /^(?:DISCORD|KOOK)<.+>$/i.test(stripFactorioColorTags(authorName));
}

function isPlatformRelayContent(content) {
  return /^(?:DISCORD|KOOK)<.+>:\s*/i.test(stripFactorioColorTags(content));
}

function isGpsOnlyContent(content) {
  return FACTORIO_GPS_ONLY_PATTERN.test(String(content ?? "").trim());
}

function normalizeChatAuthorName(authorName) {
  const value = String(authorName ?? "").trim();
  const angleMatch = value.match(/^<(.+)>$/);
  return (angleMatch?.[1] ?? value).trim();
}

function parseGameDuration(lines) {
  const text = normalizeConsoleLines(lines)
    .filter((line) => !isFactorioInfoLogLine(line))
    .join(" ");

  let totalMs = 0;
  let matched = false;

  const hoursMatch = text.match(/(\d+)\s+hours?/i);
  const minutesMatch = text.match(/(\d+)\s+minutes?/i);
  const secondsMatch = text.match(/(\d+)\s+seconds?/i);

  if (hoursMatch) { totalMs += Number(hoursMatch[1]) * 3600000; matched = true; }
  if (minutesMatch) { totalMs += Number(minutesMatch[1]) * 60000; matched = true; }
  if (secondsMatch) { totalMs += Number(secondsMatch[1]) * 1000; matched = true; }

  return matched ? totalMs : null;
}

const DEFAULT_BACKUP_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export class FactorioAdapter {
  constructor({ serverConfig, pterodactylClient, logger = null }) {
    this.serverConfig = serverConfig;
    this.pterodactylClient = pterodactylClient;
    this.logger = logger;
    this.onlinePlayers = null;
    this.playerEventRevision = 0;
    this.gameDurationMs = null;
    this.gameDurationFetchedAt = null;
    this.playerListRefreshPromise = null;
    this.backupRefreshHandle = null;
  }

  start() {
    this.backupRefreshHandle = setInterval(() => {
      if (this.onlinePlayers === null) {
        return;
      }

      void this.refreshOnlinePlayers().catch(() => {});
    }, this.#backupRefreshIntervalMs());
  }

  #backupRefreshIntervalMs() {
    const seconds = Number(this.serverConfig.game?.playerListRefreshIntervalSeconds);
    return Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : DEFAULT_BACKUP_REFRESH_INTERVAL_MS;
  }

  stop() {
    if (this.backupRefreshHandle) {
      clearInterval(this.backupRefreshHandle);
      this.backupRefreshHandle = null;
    }
  }

  async fetchSnapshot(resources) {
    if (resources.currentState !== "running") {
      this.onlinePlayers = null;
      this.playerEventRevision += 1;
      this.gameDurationMs = null;
      this.gameDurationFetchedAt = null;

      return {
        name: this.serverConfig.name,
        asciiTitle: this.serverConfig.asciiTitle,
        description: this.serverConfig.description,
        publicAddress: this.serverConfig.publicAddress,
        publicPort: this.serverConfig.publicPort,
        maxPlayers: this.serverConfig.maxPlayers,
        channelId: this.serverConfig.discordChannelId,
        currentState: resources.currentState,
        simplifiedStatus: simplifyStatus(resources.currentState),
        playerCount: 0,
        onlinePlayers: [],
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        uptimeMs: resources.uptimeMs,
        gameDurationMs: null
      };
    }

    try {
      if (this.playerListRefreshPromise) {
        await this.playerListRefreshPromise;
      } else if (this.onlinePlayers === null) {
        await this.refreshOnlinePlayers();
      }
    } catch (error) {
      this.onlinePlayers ??= [];
      this.logger?.warn(`Factorio console is not ready for ${this.serverConfig.name}; using the last available player snapshot until it reconnects.`, error);
    }

    const playerCount = this.onlinePlayers.length;
    const gameDurationMs = await this.#resolveGameDuration(playerCount);

    return {
      name: this.serverConfig.name,
      asciiTitle: this.serverConfig.asciiTitle,
      description: this.serverConfig.description,
      publicAddress: this.serverConfig.publicAddress,
      publicPort: this.serverConfig.publicPort,
      maxPlayers: this.serverConfig.maxPlayers,
      channelId: this.serverConfig.discordChannelId,
      currentState: resources.currentState,
      simplifiedStatus: simplifyStatus(resources.currentState),
      playerCount,
      onlinePlayers: [...this.onlinePlayers],
      cpuPercent: resources.cpuPercent,
      memoryBytes: resources.memoryBytes,
      uptimeMs: resources.uptimeMs,
      gameDurationMs
    };
  }

  supportsConsoleSubscription() {
    return true;
  }

  supportsChatRelay() {
    return true;
  }

  shouldRefreshOnlinePlayersOnConsoleConnect() {
    return true;
  }

  async refreshOnlinePlayers() {
    if (this.playerListRefreshPromise) {
      return this.playerListRefreshPromise;
    }

    this.playerListRefreshPromise = (async () => {
      const eventRevisionAtStart = this.playerEventRevision;
      const lines = await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, ONLINE_PLAYERS_COMMAND);
      const parsed = parsePlayerList(lines);
      // Discard the result if a join or leave landed while the command was in flight.
      if (parsed && this.playerEventRevision === eventRevisionAtStart) {
        this.onlinePlayers = parsed.players;
      }
      if (this.onlinePlayers === null) {
        this.onlinePlayers = [];
      }
      return this.onlinePlayers;
    })();

    try {
      return await this.playerListRefreshPromise;
    } finally {
      this.playerListRefreshPromise = null;
    }
  }

  async handleChatMessage(message) {
    return this.handleChatCommand(message.command);
  }

  async handleChatCommand(command) {
    if (!command) {
      return null;
    }
    await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, command, {
      captureMs: CHAT_RELAY_CAPTURE_MS
    });
    return null;
  }

  async #resolveGameDuration(playerCount) {
    if (playerCount > 0) {
      if (this.gameDurationFetchedAt === null) {
        // First poll with players — establish baseline from the server
        const fetched = await this.#fetchGameDuration();
        this.gameDurationMs = fetched;
        this.gameDurationFetchedAt = Date.now();
        return fetched;
      }
      // Project forward: game time tracks real time 1:1
      return this.gameDurationMs != null
        ? this.gameDurationMs + (Date.now() - this.gameDurationFetchedAt)
        : null;
    }

    if (this.gameDurationFetchedAt !== null) {
      // Just went empty — fetch once to lock in the accurate value
      const fetched = await this.#fetchGameDuration();
      this.gameDurationMs = fetched ?? this.gameDurationMs;
      this.gameDurationFetchedAt = null;
      return this.gameDurationMs;
    }

    // Empty but no baseline yet (bot just started) — fetch once to get an initial value
    if (this.gameDurationMs === null) {
      const fetched = await this.#fetchGameDuration();
      this.gameDurationMs = fetched;
      return fetched;
    }

    return this.gameDurationMs;
  }

  async #fetchGameDuration() {
    try {
      const lines = await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, TIME_COMMAND);
      return parseGameDuration(lines);
    } catch {
      return null;
    }
  }

  shouldRefreshOnlinePlayers(line) {
    return FACTORIO_PLAYER_EVENT_PATTERN.test(String(line ?? "").trim());
  }

  applyPlayerEvent(line) {
    const normalized = String(line ?? "").trim();
    const joinMatch = normalized.match(/\[JOIN\] (.+) joined the game$/);
    if (joinMatch) {
      this.playerEventRevision += 1;
      const name = joinMatch[1];
      // Console events can arrive before the initial /players o response. Like
      // Minecraft, keep that event immediately instead of briefly showing zero
      // players until the next refresh completes.
      this.onlinePlayers ??= [];
      if (!this.onlinePlayers.includes(name)) {
        this.onlinePlayers = [...this.onlinePlayers, name];
      }
      return true;
    }
    const leaveMatch = normalized.match(/\[LEAVE\] (.+) left the game$/);
    if (leaveMatch) {
      this.playerEventRevision += 1;
      this.onlinePlayers ??= [];
      this.onlinePlayers = this.onlinePlayers.filter((p) => p !== leaveMatch[1]);
      return true;
    }
    return false;
  }

  parseConsoleChatLine(line) {
    const normalized = normalizeConsoleLine(line);
    const match = normalized.match(FACTORIO_CHAT_LINE_PATTERN);
    if (!match) {
      return null;
    }

    const rawAuthorName = match[1].trim();
    const authorName = normalizeChatAuthorName(rawAuthorName);
    const content = match[2].trim();
    if (!authorName || !content || isPlatformRelayName(authorName) || isPlatformRelayContent(content) || isGpsOnlyContent(content)) {
      return null;
    }

    return {
      authorName,
      content
    };
  }
}

function simplifyStatus(currentState) {
  switch (currentState) {
    case "running":
      return "Online";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "offline":
      return "Offline";
    default:
      return currentState;
  }
}
