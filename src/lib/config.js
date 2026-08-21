import fs from "node:fs";
import path from "node:path";
import { isKookEnabled, normalizeKookConfigId } from "./kook-config.js";

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

function resolveKookDisplayTimeZone(kookConfig) {
  const value = process.env.KOOK_DISPLAY_TIMEZONE ?? kookConfig?.displayTimeZone ?? "Asia/Shanghai";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    throw new Error(`Config must include a valid kook.displayTimeZone IANA value. Received: ${value}`);
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

// Like normalizePositiveNumber, but a present-but-invalid value is a hard error
// instead of a silent fallback. A typo such as `emptyTimeoutHours: 0` should stop
// startup (or be rejected by the config reload) rather than quietly become 24.
function requirePositiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number. Received: ${JSON.stringify(value)}`);
  }

  return number;
}

function normalizePublicPort(server) {
  const raw = server.publicPort;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Server "${server.name}" publicPort must be an integer between 1 and 65535. Received: ${JSON.stringify(raw)}`);
  }

  return port;
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
  return {
    type: "factorio",
    chatCommandTemplate: server.game?.chatCommandTemplate ?? "/shout DISCORD<{author}>: {content}",
    discordChatCommandTemplate: server.game?.discordChatCommandTemplate ?? null,
    kookChatCommandTemplate: server.game?.kookChatCommandTemplate ?? null,
    playerListRefreshIntervalSeconds: requirePositiveNumber(
      server.game?.playerListRefreshIntervalSeconds,
      900,
      `Server "${server.name}" game.playerListRefreshIntervalSeconds`
    )
  };
}

export function deriveSatisfactoryApiUrl(server) {
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
    chatCommandTemplate: server.game?.chatCommandTemplate ?? "/say [Discord] {author}: {content}",
    discordChatCommandTemplate: server.game?.discordChatCommandTemplate ?? null,
    kookChatCommandTemplate: server.game?.kookChatCommandTemplate ?? null,
    playerListRefreshIntervalSeconds: requirePositiveNumber(
      server.game?.playerListRefreshIntervalSeconds,
      900,
      `Server "${server.name}" game.playerListRefreshIntervalSeconds`
    )
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
    chatCommandTemplate: server.game?.chatCommandTemplate ?? null,
    discordChatCommandTemplate: server.game?.discordChatCommandTemplate ?? null,
    kookChatCommandTemplate: server.game?.kookChatCommandTemplate ?? null
  };
}

function validateFactorioRelayTemplate(serverName, template, label) {
  if (typeof template !== "string" || !template.trim().startsWith("/")) {
    throw new Error(`Factorio server "${serverName}" ${label} must start with a Factorio console command (for example, /shout).`);
  }

  if (!template.includes("{content}")) {
    throw new Error(`Factorio server "${serverName}" ${label} must include the {content} placeholder.`);
  }
}

function normalizeAutoStop(server) {
  const raw = server.autoStop;
  if (!raw?.enabled) return null;

  const emptyTimeoutHours = requirePositiveNumber(
    raw.emptyTimeoutHours,
    24,
    `Server "${server.name}" autoStop.emptyTimeoutHours`
  );
  const warningMinutesBefore = requirePositiveNumber(
    raw.warningMinutesBefore,
    60,
    `Server "${server.name}" autoStop.warningMinutesBefore`
  );

  // A warning window at least as wide as the idle window makes warningMs negative,
  // which fires the auto-stop warning on the very first empty poll.
  if (warningMinutesBefore >= emptyTimeoutHours * 60) {
    throw new Error(
      `Server "${server.name}" autoStop.warningMinutesBefore (${warningMinutesBefore}) must be less than autoStop.emptyTimeoutHours in minutes (${emptyTimeoutHours * 60}).`
    );
  }

  return { enabled: true, emptyTimeoutHours, warningMinutesBefore };
}

function normalizeServer(server) {
  const gameType = server.game?.type ?? "factorio";

  return {
    name: server.name,
    asciiTitle: normalizeAsciiTitle(server),
    description: normalizeDescription(server),
    publicAddress: server.publicAddress ?? "",
    publicPort: normalizePublicPort(server),
    maxPlayers: server.maxPlayers ?? null,
    discordChannelId: server.discordChannelId,
    kookChannelId: normalizeKookConfigId(server.kookChannelId),
    pterodactylServerId: server.pterodactylServerId,
    game: gameType === "satisfactory"
      ? normalizeSatisfactoryGame(server)
      : gameType === "minecraft"
        ? normalizeMinecraftGame(server)
        : normalizeFactorioGame(server),
    autoStop: normalizeAutoStop(server)
  };
}

function normalizeKookConfig(kookConfig) {
  return {
    guildId: normalizeKookConfigId(kookConfig?.guildId),
    statusChannelId: normalizeKookConfigId(kookConfig?.statusChannelId),
    logChannelId: normalizeKookConfigId(kookConfig?.logChannelId),
    serverAdminRoleId: normalizeKookConfigId(kookConfig?.serverAdminRoleId),
    serverAdminRoleName: normalizeOptionalString(kookConfig?.serverAdminRoleName) ?? "server-admin",
    displayTimeZone: resolveKookDisplayTimeZone(kookConfig)
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

  if (isKookEnabled()) {
    if (!config.kook?.guildId) {
      throw new Error("Config must include kook.guildId when KOOK_ENABLED=true");
    }

    if (!config.kook?.statusChannelId) {
      throw new Error("Config must include kook.statusChannelId when KOOK_ENABLED=true");
    }
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

    if (server.game?.type === "factorio") {
      validateFactorioRelayTemplate(server.name, server.game.chatCommandTemplate, "chatCommandTemplate");
      if (server.game.discordChatCommandTemplate !== null) {
        validateFactorioRelayTemplate(server.name, server.game.discordChatCommandTemplate, "discordChatCommandTemplate");
      }
      if (server.game.kookChatCommandTemplate !== null) {
        validateFactorioRelayTemplate(server.name, server.game.kookChatCommandTemplate, "kookChatCommandTemplate");
      }
      continue;
    }

    if (server.game?.type === "minecraft") {
      continue;
    }

    if (server.game?.type === "satisfactory") {
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
    kook: normalizeKookConfig(rawConfig.kook),
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
    kookToken: isKookEnabled() ? assertRequiredEnv("KOOK_TOKEN") : process.env.KOOK_TOKEN ?? null,
    config
  };
}
