import fs from "node:fs";
import path from "node:path";

function defaultConfig() {
  return {
    discord: {},
    pterodactyl: {},
    features: { gameChatRelayEnabled: false },
    servers: []
  };
}

export class ConfigStore {
  constructor(filePath, { logger = null } = {}) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return defaultConfig();
    }

    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Configuration at ${this.filePath} must contain a JSON object.`);
    }

    parsed.discord ??= {};
    parsed.pterodactyl ??= {};
    parsed.features ??= { gameChatRelayEnabled: false };
    parsed.servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    return parsed;
  }

  updateDiscordChannels({ adminChannelId, statusChannelId }) {
    const config = this.read();
    config.discord ??= {};
    if (adminChannelId) config.discord.adminChannelId = adminChannelId;
    if (statusChannelId) config.discord.statusChannelId = statusChannelId;
    this.#write(config);
    return config;
  }

  addServer(server) {
    const config = this.read();
    config.servers ??= [];

    if (config.servers.some((entry) => entry.pterodactylServerId === server.pterodactylServerId)) {
      throw new Error(`Pterodactyl server ${server.pterodactylServerId} is already imported.`);
    }

    config.servers.push(server);
    this.#write(config);
    return config;
  }

  #write(config) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, this.filePath);
    this.logger?.info("Persistent bridge configuration updated", { configPath: this.filePath });
  }
}
