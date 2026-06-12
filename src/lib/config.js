import fs from "node:fs";
import path from "node:path";

function assertRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveDisplayTimeZone(discordConfig) {
  const value =
    process.env.DISCORD_DISPLAY_TIMEZONE ??
    discordConfig?.displayTimeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    throw new Error(`Config must include a valid discord.displayTimeZone IANA value. Received: ${value}`);
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolvePollingInterval(configValue, environmentValue, fallback) {
  return normalizePositiveNumber(configValue ?? environmentValue, fallback);
}

function normalizeAsciiTitle(server) {
  if (typeof server.asciiTitle === "string") {
    const value = server.asciiTitle.trim();
    return value ? value : null;
  }

  if (Array.isArray(server.asciiTitleLines)) {
    const lines = server.asciiTitleLines.map((line) => String(line ?? ""));
    const value = lines.join("\n").trim();
    return value ? value : null;
  }

  return null;
}

export function normalizeDescription(server) {
  if (Array.isArray(server.descriptionLines)) {
    const value = server.descriptionLines.map((line) => String(line ?? "")).join("\n");
    return value.trim() ? value : "";
  }

  return typeof server.description === "string" ? server.description.trim() : "";
}

function normalizeFactorioGame(server) {
  const playerListRefreshIntervalSeconds = Number(server.game?.playerListRefreshIntervalSeconds);

  return {
    type: "factorio",
    chatCommandTemplate: server.game?.chatCommandTemplate ?? "/shout DISCORD<{author}>: {content}",
    playerListRefreshIntervalSeconds: Number.isFinite(playerListRefreshIntervalSeconds)
      ? playerListRefreshIntervalSeconds
      : 900
  };
}

function deriveSatisfactoryApiUrl(server) {
  if (server.game?.apiUrl) {
    return server.game.apiUrl;
  }

  if (!server.publicAddress || !server.publicPort) {
    return null;
  }

  return `https://${server.publicAddress}:${server.publicPort}/api/v1`;
}

function normalizeMinecraftGame(server) {
  return {
    type: "minecraft",
    chatCommandTemplate: server.game?.chatCommandTemplate ?? "/say [Discord] {author}: {content}"
  };
}

function normalizeSatisfactoryGame(server) {
  const apiRequestTimeoutSeconds = normalizePositiveNumber(
    server.game?.apiRequestTimeoutSeconds,
    10
  );

  return {
    type: "satisfactory",
    apiUrl: deriveSatisfactoryApiUrl(server),
    apiToken: server.game?.apiToken ?? null,
    allowInsecureTls: server.game?.allowInsecureTls ?? true,
    apiRequestTimeoutMs: apiRequestTimeoutSeconds * 1000,
    chatCommandTemplate: server.game?.chatCommandTemplate ?? null
  };
}

function normalizeAutoStop(server) {
  const raw = server.autoStop;
  if (!raw?.enabled) return null;
  return {
    enabled: true,
    emptyTimeoutHours: Number.isFinite(Number(raw.emptyTimeoutHours)) ? Number(raw.emptyTimeoutHours) : 24,
    warningMinutesBefore: Number.isFinite(Number(raw.warningMinutesBefore)) ? Number(raw.warningMinutesBefore) : 60
  };
}

function normalizeServer(server) {
  const gameType = server.game?.type ?? "factorio";

  return {
    name: server.name,
    asciiTitle: normalizeAsciiTitle(server),
    description: normalizeDescription(server),
    publicAddress: server.publicAddress ?? "",
    publicPort: server.publicPort ?? null,
    maxPlayers: server.maxPlayers ?? null,
    discordChannelId: server.discordChannelId,
    pterodactylServerId: server.pterodactylServerId,
    game: gameType === "satisfactory"
      ? normalizeSatisfactoryGame(server)
      : gameType === "minecraft"
        ? normalizeMinecraftGame(server)
        : normalizeFactorioGame(server),
    autoStop: normalizeAutoStop(server)
  };
}

function validateConfig(config) {
  if (!config.discord?.guildId) {
    throw new Error("Config must include discord.guildId");
  }

  if (!config.discord?.statusChannelId) {
    throw new Error("Config must include discord.statusChannelId");
  }

  if (!config.pterodactyl?.baseUrl || !config.pterodactyl?.apiKey) {
    throw new Error("Config must include pterodactyl.baseUrl and pterodactyl.apiKey");
  }

  const scheme = config.pterodactyl?.wingsWsScheme;
  if (scheme !== null && scheme !== "ws" && scheme !== "wss") {
    throw new Error(`PTERODACTYL_WINGS_WS_SCHEME must be "ws" or "wss" if set. Received: ${scheme}`);
  }

  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    throw new Error("Config must include at least one server");
  }

  for (const server of config.servers) {
    if (!server.name || !server.discordChannelId || !server.pterodactylServerId) {
      throw new Error("Each server requires name, discordChannelId, and pterodactylServerId");
    }

    if (server.game?.type === "factorio" || server.game?.type === "minecraft") {
      continue;
    }

    if (server.game?.type === "satisfactory") {
      if (!server.game.apiUrl) {
        throw new Error(`Satisfactory server "${server.name}" requires game.apiUrl or publicAddress/publicPort so the API URL can be derived.`);
      }

      if (!server.game.apiToken) {
        throw new Error(`Satisfactory server "${server.name}" requires game.apiToken.`);
      }

      continue;
    }

    throw new Error(`Unsupported server type: ${server.game?.type}. Supported types are factorio, minecraft, and satisfactory.`);
  }
}

export function getConfigPath() {
  return path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./servers.json");
}

export function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  const rawConfig = readJsonFile(configPath);
  const config = {
    discord: {
      ...rawConfig.discord,
      displayTimeZone: resolveDisplayTimeZone(rawConfig.discord),
      serverAdminRoleId: normalizeOptionalString(rawConfig.discord?.serverAdminRoleId),
      serverAdminRoleName: normalizeOptionalString(rawConfig.discord?.serverAdminRoleName) ?? "server-admin"
    },
    pterodactyl: {
      ...rawConfig.pterodactyl,
      pollIntervalSeconds: resolvePollingInterval(
        rawConfig.pterodactyl?.pollIntervalSeconds,
        process.env.PANEL_UPDATE_INTERVAL_SECONDS,
        60
      ),
      activePlayerPollIntervalSeconds: resolvePollingInterval(
        rawConfig.pterodactyl?.activePlayerPollIntervalSeconds,
        process.env.ACTIVE_PLAYER_UPDATE_INTERVAL_SECONDS,
        15
      ),
      wingsFqdn: process.env.PTERODACTYL_WINGS_FQDN || null,
      wingsWsScheme: process.env.PTERODACTYL_WINGS_WS_SCHEME || null,
      wingsWsPort: process.env.PTERODACTYL_WINGS_WS_PORT || null
    },
    servers: rawConfig.servers.map(normalizeServer)
  };

  validateConfig(config);

  return {
    discordToken: assertRequiredEnv("DISCORD_TOKEN"),
    config
  };
}
