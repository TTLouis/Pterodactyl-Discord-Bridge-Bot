const LIST_COMMAND = "/list";
const TIME_COMMAND = "/time query gametime";

// Vanilla Minecraft log lines are prefixed with [HH:MM:SS] [Thread/Level]: — some
// Pterodactyl eggs strip this prefix, so we make it optional throughout.
const MC_LOG_PREFIX = /^(?:\[\d{2}:\d{2}:\d{2}\] \[[^\]]+\]: )?/;
const MC_CHAT_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}<(.+?)>\\s+(.+)$`);
const MC_PLAYER_EVENT_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}(\\S+) (joined|left) the game$`);
const MC_LIST_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}There are (\\d+) of a max(?:imum)? of \\d+ players? online:(.*)$`, "i");
const MC_TIME_PATTERN = new RegExp(`${MC_LOG_PREFIX.source}The time is (\\d+)$`, "i");

const BACKUP_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MS_PER_TICK = 50;

function normalizeConsoleLines(lines) {
  return lines
    .flatMap((line) => String(line ?? "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

function parsePlayerList(lines) {
  for (const line of normalizeConsoleLines(lines)) {
    const match = line.match(MC_LIST_PATTERN);
    if (!match) continue;

    const count = Number(match[1]);
    if (count === 0) return { playerCount: 0, players: [] };

    const players = match[2]
      .trim()
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    return { playerCount: count, players };
  }

  return { playerCount: 0, players: [] };
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
    }, BACKUP_REFRESH_INTERVAL_MS);
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
      const lines = await this.pterodactylClient.runCommand(
        this.serverConfig.pterodactylServerId,
        LIST_COMMAND
      );
      const parsed = parsePlayerList(lines);
      this.onlinePlayers = parsed.players;
      return parsed.players;
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
    await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, command);
    return null;
  }

  shouldRefreshOnlinePlayers(line) {
    return MC_PLAYER_EVENT_PATTERN.test(String(line ?? "").trim());
  }

  applyPlayerEvent(line) {
    if (this.onlinePlayers === null) return false;
    const match = String(line ?? "").trim().match(MC_PLAYER_EVENT_PATTERN);
    if (!match) return false;
    const name = match[1];
    const action = match[2];
    if (action === "joined") {
      if (!this.onlinePlayers.includes(name)) {
        this.onlinePlayers = [...this.onlinePlayers, name];
      }
    } else {
      this.onlinePlayers = this.onlinePlayers.filter((p) => p !== name);
    }
    return true;
  }

  parseConsoleChatLine(line) {
    const normalized = String(line ?? "").trim();
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
