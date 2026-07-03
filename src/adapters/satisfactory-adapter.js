import { SatisfactoryClient } from "../services/satisfactory-client.js";

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

export class SatisfactoryAdapter {
  constructor({ serverConfig, logger, satisfactoryClient = new SatisfactoryClient() }) {
    this.serverConfig = serverConfig;
    this.satisfactoryClient = satisfactoryClient;
    this.logger = logger;
    this.playerCount = 0;
    this.maxPlayers = serverConfig.maxPlayers;
    this.gameDurationMs = null;
    this.techTier = null;
    this.activeSchematic = "";
    this.gamePhase = "";
  }

  supportsConsoleSubscription() {
    return false;
  }

  supportsDiscordRelay() {
    return Boolean(
      this.serverConfig.game.chatCommandTemplate
      || this.serverConfig.game.discordChatCommandTemplate
      || this.serverConfig.game.kookChatCommandTemplate
    );
  }

  supportsChatRelay() {
    return this.supportsDiscordRelay();
  }

  onConfigReloaded() {
    this.playerCount = 0;
    this.maxPlayers = this.serverConfig.maxPlayers;
    this.gameDurationMs = null;
    this.techTier = null;
    this.activeSchematic = "";
    this.gamePhase = "";
  }

  async fetchSnapshot(resources) {
    if (resources.currentState !== "running") {
      this.playerCount = 0;
      this.gameDurationMs = null;
      this.techTier = null;
      this.activeSchematic = "";
      this.gamePhase = "";

      return this.#buildSnapshot(resources);
    }

    try {
      const serverState = await this.satisfactoryClient.queryServerState(this.serverConfig);
      this.playerCount = serverState.numConnectedPlayers ?? 0;
      this.maxPlayers = serverState.playerLimit ?? this.serverConfig.maxPlayers;
      this.techTier = serverState.techTier;
      this.activeSchematic = serverState.activeSchematic;
      this.gamePhase = serverState.gamePhase;
      this.gameDurationMs = serverState.totalGameDuration != null
        ? serverState.totalGameDuration * 1000
        : null;
    } catch (error) {
      this.logger?.warn(
        `Failed querying Satisfactory API for ${this.serverConfig.name}; keeping the last known API state.`,
        error
      );
    }

    return this.#buildSnapshot(resources);
  }

  async handleDiscordMessage(message) {
    return this.handleChatCommand(message.command);
  }

  async handleChatMessage(message) {
    return this.handleChatCommand(message.command);
  }

  async handleChatCommand(command) {
    if (!command) {
      return null;
    }

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
    return null;
  }

  parseConsoleChatLine() {
    return null;
  }

  #buildSnapshot(resources) {
    return {
      name: this.serverConfig.name,
      asciiTitle: this.serverConfig.asciiTitle,
      description: this.serverConfig.description,
      publicAddress: this.serverConfig.publicAddress,
      publicPort: this.serverConfig.publicPort,
      maxPlayers: this.maxPlayers,
      channelId: this.serverConfig.discordChannelId,
      currentState: resources.currentState,
      simplifiedStatus: simplifyStatus(resources.currentState),
      playerCount: this.playerCount,
      onlinePlayers: this.playerCount > 0 ? null : [],
      playerNamesAvailable: false,
      cpuPercent: resources.cpuPercent,
      memoryBytes: resources.memoryBytes,
      uptimeMs: resources.uptimeMs,
      gameDurationMs: this.gameDurationMs,
      satisfactoryState: {
        techTier: this.techTier,
        activeSchematic: this.activeSchematic,
        gamePhase: this.gamePhase
      }
    };
  }
}
