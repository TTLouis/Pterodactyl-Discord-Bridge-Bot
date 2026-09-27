function simplifyStatus(currentState) {
  switch (currentState) {
    case "running": return "Online";
    case "starting": return "Starting";
    case "stopping": return "Stopping";
    case "offline": return "Offline";
    default: return currentState || "Unknown";
  }
}

export class GenericPterodactylAdapter {
  constructor({ serverConfig }) {
    this.serverConfig = serverConfig;
  }

  supportsConsoleSubscription() {
    return false;
  }

  supportsChatRelay() {
    return false;
  }

  async fetchSnapshot(resources) {
    return {
      name: this.serverConfig.name,
      asciiTitle: this.serverConfig.asciiTitle,
      description: this.serverConfig.description,
      publicAddress: this.serverConfig.publicAddress,
      publicPort: this.serverConfig.publicPort,
      maxPlayers: null,
      channelId: this.serverConfig.discordChannelId,
      currentState: resources.currentState,
      simplifiedStatus: simplifyStatus(resources.currentState),
      playerCount: null,
      playerNamesAvailable: false,
      onlinePlayers: null,
      cpuPercent: resources.cpuPercent,
      memoryBytes: resources.memoryBytes,
      uptimeMs: resources.uptimeMs,
      gameDurationMs: null,
      genericPterodactyl: true
    };
  }
}
