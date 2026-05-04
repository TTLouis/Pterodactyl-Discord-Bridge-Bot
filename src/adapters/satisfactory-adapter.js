import { SatisfactoryClient } from "../services/satisfactory-client.js";

const LIST_PLAYERS_COMMAND = "ListPlayers";
const UNAVAILABLE_PLAYER_NAMES = null;

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

function normalizePlayerName(value) {
  return String(value ?? "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isListPlayersUnsupported(result) {
  const output = [result.commandResult, ...result.outputLines].join("\n").toLowerCase();
  return output.includes("command not recognized") || output.includes("unknown command") || output.includes("not found");
}

function parsePlayersFromSummary(line) {
  const summaryMatch = line.match(/(?:connected|online)\s*:?\s*(.+)$/i);
  if (!summaryMatch) {
    return [];
  }

  return summaryMatch[1]
    .split(",")
    .map(normalizePlayerName)
    .filter(Boolean);
}

function parsePlayerList(lines) {
  const players = [];

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line) {
      continue;
    }

    if (line.toLowerCase() === LIST_PLAYERS_COMMAND.toLowerCase()) {
      continue;
    }

    const indexedMatch = line.match(/^(?:player\s+)?\d+\s*[:.-]\s*(.+)$/i);
    if (indexedMatch) {
      players.push(normalizePlayerName(indexedMatch[1]));
      continue;
    }

    const bulletedMatch = line.match(/^(?:[-*]\s+)(.+)$/);
    if (bulletedMatch) {
      players.push(normalizePlayerName(bulletedMatch[1]));
      continue;
    }

    if (/connected|online/i.test(line) && line.includes(",")) {
      players.push(...parsePlayersFromSummary(line));
    }
  }

  return [...new Set(players.filter(Boolean))];
}

export class SatisfactoryAdapter {
  constructor({ serverConfig, logger }) {
    this.serverConfig = serverConfig;
    this.satisfactoryClient = new SatisfactoryClient();
    this.logger = logger;
    this.onlinePlayers = UNAVAILABLE_PLAYER_NAMES;
    this.playerListSupported = true;
    this.playerListRefreshPromise = null;
  }

  supportsConsoleSubscription() {
    return false;
  }

  supportsDiscordRelay() {
    return Boolean(this.serverConfig.game.chatCommandTemplate);
  }

  async fetchSnapshot(resources) {
    if (resources.currentState !== "running") {
      this.onlinePlayers = [];

      return this.#buildSnapshot(resources, {
        playerCount: 0,
        onlinePlayers: [],
        gameDurationMs: null
      });
    }

    try {
      const serverState = await this.satisfactoryClient.queryServerState(this.serverConfig);
      const playerCount = serverState.numConnectedPlayers ?? 0;
      const maxPlayers = serverState.playerLimit ?? this.serverConfig.maxPlayers;
      const onlinePlayers = await this.#resolveOnlinePlayers(playerCount);
      const gameDurationMs = serverState.totalGameDuration != null ? serverState.totalGameDuration * 1000 : null;

      return this.#buildSnapshot(resources, {
        playerCount,
        maxPlayers,
        onlinePlayers,
        gameDurationMs
      });
    } catch (error) {
      this.logger?.warn(`Failed querying Satisfactory API for ${this.serverConfig.name}, falling back to panel resources.`, error);

      return this.#buildSnapshot(resources, {
        playerCount: 0,
        onlinePlayers: this.onlinePlayers,
        gameDurationMs: null
      });
    }
  }

  async handleDiscordMessage(message) {
    const template = this.serverConfig.game.chatCommandTemplate;
    if (!template) {
      return null;
    }

    const content = sanitizeContent(message.content);
    if (!content) {
      return null;
    }

    const authorName = sanitizeAuthorName(message.authorName) || "Discord";
    const command = renderTemplate(template, {
      authorName,
      content
    });
    const result = await this.satisfactoryClient.runCommand(this.serverConfig, command);

    if (!result.returnValue) {
      throw new Error(result.commandResult || "Satisfactory command returned an unsuccessful result.");
    }

    return null;
  }

  shouldRefreshOnlinePlayers() {
    return false;
  }

  async refreshOnlinePlayers() {
    return this.onlinePlayers;
  }

  parseConsoleChatLine() {
    return null;
  }

  async #resolveOnlinePlayers(playerCount) {
    if (playerCount === 0) {
      this.onlinePlayers = [];
      return [];
    }

    if (!this.playerListSupported) {
      this.onlinePlayers = UNAVAILABLE_PLAYER_NAMES;
      return this.onlinePlayers;
    }

    if (Array.isArray(this.onlinePlayers) && this.onlinePlayers.length === playerCount) {
      return [...this.onlinePlayers];
    }

    return this.refreshOnlinePlayersFromServer();
  }

  async refreshOnlinePlayersFromServer() {
    if (this.playerListRefreshPromise) {
      return this.playerListRefreshPromise;
    }

    this.playerListRefreshPromise = (async () => {
      const result = await this.satisfactoryClient.runCommand(this.serverConfig, LIST_PLAYERS_COMMAND);
      const players = parsePlayerList(result.outputLines);

      if (!result.returnValue && isListPlayersUnsupported(result)) {
        this.playerListSupported = false;
        this.onlinePlayers = UNAVAILABLE_PLAYER_NAMES;
        return this.onlinePlayers;
      }

      if (players.length === 0) {
        this.onlinePlayers = UNAVAILABLE_PLAYER_NAMES;
        return this.onlinePlayers;
      }

      this.onlinePlayers = players;
      return [...players];
    })();

    try {
      return await this.playerListRefreshPromise;
    } catch (error) {
      this.logger?.warn(`Failed refreshing Satisfactory player names for ${this.serverConfig.name}.`, error);
      this.onlinePlayers = UNAVAILABLE_PLAYER_NAMES;
      return this.onlinePlayers;
    } finally {
      this.playerListRefreshPromise = null;
    }
  }

  #buildSnapshot(resources, overrides) {
    return {
      name: this.serverConfig.name,
      asciiTitle: this.serverConfig.asciiTitle,
      description: this.serverConfig.description,
      publicAddress: this.serverConfig.publicAddress,
      publicPort: this.serverConfig.publicPort,
      maxPlayers: overrides.maxPlayers ?? this.serverConfig.maxPlayers,
      channelId: this.serverConfig.discordChannelId,
      currentState: resources.currentState,
      simplifiedStatus: simplifyStatus(resources.currentState),
      playerCount: overrides.playerCount ?? 0,
      onlinePlayers: overrides.onlinePlayers ?? [],
      cpuPercent: resources.cpuPercent,
      memoryBytes: resources.memoryBytes,
      uptimeMs: resources.uptimeMs,
      gameDurationMs: overrides.gameDurationMs ?? null
    };
  }
}
