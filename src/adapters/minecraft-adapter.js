import { CHAT_RELAY_CAPTURE_MS } from "../lib/relay-limits.js";

const LIST_COMMAND = "/list";
const TIME_COMMAND = "/time query gametime";
const ANSI_CONTROL_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

// Vanilla Minecraft log lines are prefixed with [HH:MM:SS] [Thread/Level]: — some
// Pterodactyl eggs strip this prefix, so we make it optional throughout.
const MC_LOG_PREFIX = /^(?:(?:\[\d{2}:\d{2}:\d{2}\]\s+)?(?:\[[^\]]+\]\s*)+:\s*)?/;
const MC_CHAT_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}<(.+?)>\\s+(.+)$`);
const MC_PLAYER_EVENT_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}(\\S+) (joined|left) the game$`);
const MC_LIST_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}There are (\\d+)(?:\\s+of a max(?:imum)? of\\s+|\\s*\\/\\s*)\\d+ players? online:(.*)$`, "i");
const MC_TIME_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}The time is (\\d+)$`, "i");
const MC_PREFIXED_CONTENT_PATTERN = /^(?:\[\d{2}:\d{2}:\d{2}\]\s+)?(?:\[[^\]]+\]\s*)+:\s*(.*)$/;

const DEFAULT_BACKUP_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const MS_PER_TICK = 50;

function normalizeConsoleLines(lines) {
  return lines
    .flatMap((line) => String(line ?? "").split(/\r?\n/))
    .map(normalizeConsoleLine)
    .filter(Boolean);
}

function normalizeConsoleLine(line) {
  return String(line ?? "").replace(ANSI_CONTROL_PATTERN, "").trim();
}

function parsePlayerList(lines) {
  const normalizedLines = normalizeConsoleLines(lines);
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index];
    const match = line.match(MC_LIST_PATTERN);
    if (!match) continue;

    const count = Number(match[1]);
    if (count === 0) return { playerCount: 0, players: [] };

    const playerText = match[2].trim()
      || normalizedLines[index + 1]?.match(MC_PREFIXED_CONTENT_PATTERN)?.[1]?.trim()
      || "";
    const players = playerText
      .trim()
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    return { playerCount: count, players };
  }

  return null;
}

function parseGameTime(lines) {
  for (const line of normalizeConsoleLines(lines)) {
    const match = line.match(MC_TIME_PATTERN);
    if (!match) continue;
    return Number(match[1]) * MS_PER_TICK;
  }

  return null;
}

function simplifyStatus(currentState) {
  switch (currentState) {
    case "running": return "Online";
    case "starting": return "Starting";
    case "stopping": return "Stopping";
    case "offline": return "Offline";
    default: return currentState;
  }
}

export class MinecraftAdapter {
  constructor({ serverConfig, pterodactylClient }) {
    this.serverConfig = serverConfig;
    this.pterodactylClient = pterodactylClient;
    this.onlinePlayers = null;
    this.onlinePlayerCount = null;
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
      this.onlinePlayerCount = null;
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

    if (this.playerListRefreshPromise) {
      await this.playerListRefreshPromise;
    } else if (this.onlinePlayers === null) {
      await this.refreshOnlinePlayers();
    }

    const playerCount = this.onlinePlayerCount ?? this.onlinePlayers.length;
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

  supportsDiscordRelay() {
    return true;
  }

  supportsChatRelay() {
    return this.supportsDiscordRelay();
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
      const lines = await this.pterodactylClient.runCommand(
        this.serverConfig.pterodactylServerId,
        LIST_COMMAND
      );
      const parsed = parsePlayerList(lines);
      if (parsed && this.playerEventRevision === eventRevisionAtStart) {
        this.onlinePlayers = parsed.players;
        this.onlinePlayerCount = parsed.playerCount;
      }
      if (this.onlinePlayers === null) {
        this.onlinePlayers = [];
        this.onlinePlayerCount = 0;
      }
      return this.onlinePlayers;
    })();

    try {
      return await this.playerListRefreshPromise;
    } finally {
      this.playerListRefreshPromise = null;
    }
  }

  async handleDiscordMessage(message) {
    return this.handleChatCommand(message.command);
  }

  async handleChatMessage(message) {
    return this.handleChatCommand(message.command);
  }

  async handleChatCommand(command) {
    if (!command) return null;
    await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, command, {
      captureMs: CHAT_RELAY_CAPTURE_MS
    });
    return null;
  }

  shouldRefreshOnlinePlayers(line) {
    return MC_PLAYER_EVENT_PATTERN.test(normalizeConsoleLine(line));
  }

  applyPlayerEvent(line) {
    const match = normalizeConsoleLine(line).match(MC_PLAYER_EVENT_PATTERN);
    if (!match) return false;
    if (this.onlinePlayers === null) {
      this.onlinePlayers = [];
      this.onlinePlayerCount = 0;
    }
    this.playerEventRevision += 1;
    const name = match[1];
    const action = match[2];
    if (action === "joined") {
      if (!this.onlinePlayers.includes(name)) {
        this.onlinePlayers = [...this.onlinePlayers, name];
        this.onlinePlayerCount = (this.onlinePlayerCount ?? 0) + 1;
      }
    } else {
      const wasOnline = this.onlinePlayers.includes(name);
      this.onlinePlayers = this.onlinePlayers.filter((p) => p !== name);
      if (wasOnline) {
        this.onlinePlayerCount = Math.max(0, (this.onlinePlayerCount ?? 0) - 1);
      }
    }
    return true;
  }

  parseConsoleChatLine(line) {
    const normalized = normalizeConsoleLine(line);
    const match = normalized.match(MC_CHAT_PATTERN);
    if (!match) return null;

    const authorName = match[1].trim();
    const content = match[2].trim();
    if (!authorName || !content) return null;

    return { authorName, content };
  }

  async #resolveGameDuration(playerCount) {
    if (playerCount > 0) {
      if (this.gameDurationFetchedAt === null) {
        const fetched = await this.#fetchGameDuration();
        this.gameDurationMs = fetched;
        this.gameDurationFetchedAt = Date.now();
        return fetched;
      }
      return this.gameDurationMs != null
        ? this.gameDurationMs + (Date.now() - this.gameDurationFetchedAt)
        : null;
    }

    if (this.gameDurationFetchedAt !== null) {
      const fetched = await this.#fetchGameDuration();
      this.gameDurationMs = fetched ?? this.gameDurationMs;
      this.gameDurationFetchedAt = null;
      return this.gameDurationMs;
    }

    if (this.gameDurationMs === null) {
      const fetched = await this.#fetchGameDuration();
      this.gameDurationMs = fetched;
      return fetched;
    }

    return this.gameDurationMs;
  }

  async #fetchGameDuration() {
    try {
      const lines = await this.pterodactylClient.runCommand(
        this.serverConfig.pterodactylServerId,
        TIME_COMMAND
      );
      return parseGameTime(lines);
    } catch {
      return null;
    }
  }
}
