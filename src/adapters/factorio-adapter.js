const ONLINE_PLAYERS_COMMAND = "/players o";
const TIME_COMMAND = "/time";
const FACTORIO_CHAT_LINE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[CHAT\] ([^:]+):\s*(.*)$/;
const FACTORIO_PLAYER_EVENT_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(JOIN|LEAVE)\] .+ (joined|left) the game$/;
const FACTORIO_INFO_LOG_LINE_PATTERN = /^\d+(?:\.\d+)?\s+Info\b/;

function sanitizeContent(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeAuthorName(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTemplate(template, values) {
  return template.replaceAll("{author}", values.authorName).replaceAll("{content}", values.content);
}

function normalizeConsoleLines(lines) {
  return lines
    .flatMap((line) => String(line ?? "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
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
    return { playerCount: 0, players: [] };
  }

  const players = normalizedLines
    .slice(headerIndex + 1)
    .map((line) => line.match(PLAYER_ENTRY_PATTERN)?.[1] ?? null)
    .filter(Boolean);

  return { playerCount: players.length, players };
}

function isDiscordRelayName(authorName) {
  return /^DISCORD<.+>$/.test(authorName);
}

function isServerConsoleName(authorName) {
  return /^<.+>$/.test(authorName);
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

const BACKUP_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export class FactorioAdapter {
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

    if (this.onlinePlayers === null) {
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

  shouldRefreshOnlinePlayersOnConsoleConnect() {
    return true;
  }

  async refreshOnlinePlayers() {
    if (this.playerListRefreshPromise) {
      return this.playerListRefreshPromise;
    }

    this.playerListRefreshPromise = (async () => {
      const lines = await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, ONLINE_PLAYERS_COMMAND);
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
    const content = sanitizeContent(message.content);
    if (!content) {
      return null;
    }

    const authorName = sanitizeAuthorName(message.authorName) || "Discord";
    const command = renderTemplate(this.serverConfig.game.chatCommandTemplate, {
      authorName,
      content
    });

    await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, command);
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

  parseConsoleChatLine(line) {
    const normalized = String(line ?? "").trim();
    const match = normalized.match(FACTORIO_CHAT_LINE_PATTERN);
    if (!match) {
      return null;
    }

    const authorName = match[1].trim();
    const content = match[2].trim();
    if (!authorName || !content || isDiscordRelayName(authorName) || isServerConsoleName(authorName)) {
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
