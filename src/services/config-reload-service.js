import fs from "node:fs";

const RELOAD_DEBOUNCE_MS = 300;

function stableJson(value) {
  return JSON.stringify(value);
}

function fixedPterodactylSettings(config) {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    wingsFqdn: config.wingsFqdn,
    wingsWsScheme: config.wingsWsScheme,
    wingsWsPort: config.wingsWsPort
  };
}

function fixedKookSettings(config) {
  return {
    guildId: config.kook?.guildId ?? null,
    statusChannelId: config.kook?.statusChannelId ?? null,
    logChannelId: config.kook?.logChannelId ?? null
  };
}

export function validateReloadCompatibility(currentConfig, nextConfig) {
  const fixedDiscordKeys = ["guildId", "statusChannelId", "logChannelId"];
  for (const key of fixedDiscordKeys) {
    if ((currentConfig.discord[key] ?? null) !== (nextConfig.discord[key] ?? null)) {
      throw new Error(`discord.${key} changed; restart the bot to apply this setting.`);
    }
  }

  if (stableJson(fixedKookSettings(currentConfig)) !== stableJson(fixedKookSettings(nextConfig))) {
    throw new Error("KOOK channel or guild settings changed; restart the bot to apply them.");
  }

  if (stableJson(fixedPterodactylSettings(currentConfig.pterodactyl)) !== stableJson(fixedPterodactylSettings(nextConfig.pterodactyl))) {
    throw new Error("Pterodactyl connection settings changed; restart the bot to apply them.");
  }

  const currentServers = new Map(
    currentConfig.servers.map((server) => [server.pterodactylServerId, server])
  );

  if (currentServers.size !== nextConfig.servers.length) {
    throw new Error("The configured server list changed; restart the bot to apply server additions or removals.");
  }

  for (const server of nextConfig.servers) {
    const current = currentServers.get(server.pterodactylServerId);
    if (!current) {
      throw new Error("A Pterodactyl server ID changed; restart the bot to apply server topology changes.");
    }

    if (current.discordChannelId !== server.discordChannelId) {
      throw new Error(`Discord channel changed for "${server.name}"; restart the bot to apply it.`);
    }

    if ((current.kookChannelId ?? null) !== (server.kookChannelId ?? null)) {
      throw new Error(`KOOK channel changed for "${server.name}"; restart the bot to apply it.`);
    }

    if (stableJson(current.game) !== stableJson(server.game)) {
      throw new Error(`Game settings changed for "${server.name}"; restart the bot to apply them.`);
    }
  }
}

export function applyReloadedConfig(currentConfig, nextConfig) {
  validateReloadCompatibility(currentConfig, nextConfig);

  Object.assign(currentConfig.discord, nextConfig.discord);
  currentConfig.kook ??= {};
  Object.assign(currentConfig.kook, nextConfig.kook ?? {});
  Object.assign(currentConfig.pterodactyl, nextConfig.pterodactyl);
  const currentServers = new Map(
    currentConfig.servers.map((server) => [server.pterodactylServerId, server])
  );
  currentConfig.servers = nextConfig.servers.map((server) => {
    const current = currentServers.get(server.pterodactylServerId);
    Object.assign(current, server);
    return current;
  });
}

export class ConfigReloadService {
  constructor({ configPath, loadConfig, onReload, logger }) {
    this.configPath = configPath;
    this.loadConfig = loadConfig;
    this.onReload = onReload;
    this.logger = logger;
    this.debounceHandle = null;
    this.listener = null;
  }

  start() {
    if (this.listener) return;

    this.listener = (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      if (this.debounceHandle) clearTimeout(this.debounceHandle);
      this.debounceHandle = setTimeout(() => {
        this.debounceHandle = null;
        void this.reloadNow();
      }, RELOAD_DEBOUNCE_MS);
    };

    fs.watchFile(this.configPath, { interval: 500 }, this.listener);
    this.logger.info(`Watching ${this.configPath} for configuration changes`);
  }

  stop() {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.listener) {
      fs.unwatchFile(this.configPath, this.listener);
      this.listener = null;
    }
  }

  async reloadNow() {
    try {
      const nextConfig = this.loadConfig().config;
      await this.onReload(nextConfig);
      this.logger.info("Reloaded servers.json and refreshed the Discord status panel");
      return true;
    } catch (error) {
      this.logger.error(`Could not reload servers.json; continuing with the previous configuration: ${error.message}`);
      return false;
    }
  }
}
