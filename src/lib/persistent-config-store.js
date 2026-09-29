import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;

export function getPersistentConfigPaths() {
  return {
    configPath: path.resolve(process.cwd(), process.env.PERSISTENT_CONFIG_PATH ?? "./persistent-config.json"),
    secretsPath: path.resolve(process.cwd(), process.env.PERSISTENT_SECRETS_PATH ?? "./persistent-secrets.json")
  };
}

function readDocument(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function splitLegacyConfig(rawConfig) {
  const settings = structuredClone(rawConfig);
  const values = {};

  if (settings.pterodactyl?.apiKey) {
    values["pterodactyl/default/client-api-key"] = settings.pterodactyl.apiKey;
    delete settings.pterodactyl.apiKey;
    settings.pterodactyl.apiKeyRef = "pterodactyl/default/client-api-key";
  }

  for (const server of settings.servers ?? []) {
    if (!server.game?.apiToken) continue;
    const reference = `server/${server.pterodactylServerId}/satisfactory-api-token`;
    values[reference] = server.game.apiToken;
    delete server.game.apiToken;
    server.game.apiTokenRef = reference;
  }

  return { settings, values };
}

export class PersistentConfigStore {
  constructor({ configPath, secretsPath, logger = null } = {}) {
    const defaults = getPersistentConfigPaths();
    this.configPath = configPath ?? defaults.configPath;
    this.secretsPath = secretsPath ?? defaults.secretsPath;
    this.logger = logger;
    this.document = null;
    this.available = true;
  }

  load() {
    try {
      if (this.configPath === this.secretsPath) {
        throw new Error("Persistent config and credentials paths must differ");
      }
      if (fs.existsSync(this.configPath)) {
        const document = readDocument(this.configPath);
        if (document.schemaVersion !== SCHEMA_VERSION || document.source !== "legacy"
          || !isRecord(document.settings) || !isRecord(document.administration)) {
          throw new Error("Unsupported or invalid persistent configuration");
        }
        this.document = document;
      }

      if (fs.existsSync(this.secretsPath)) {
        const secrets = readDocument(this.secretsPath);
        if (secrets.schemaVersion !== SCHEMA_VERSION || !isRecord(secrets.values)) {
          throw new Error("Unsupported or invalid persistent credentials");
        }
      } else if (this.document) {
        throw new Error("Persistent credentials are missing");
      }
      return true;
    } catch {
      this.available = false;
      this.logger?.error("Persistent configuration is unavailable; /bridge setup is disabled. Legacy configuration remains active.");
      return false;
    }
  }

  syncLegacyConfig(rawConfig) {
    if (!this.available) return false;
    const { settings, values } = splitLegacyConfig(rawConfig);
    const document = {
      schemaVersion: SCHEMA_VERSION,
      source: "legacy",
      settings,
      administration: this.document?.administration ?? {
        guildId: rawConfig.discord.guildId,
        channelId: null
      }
    };

    try {
      writePrivateJson(this.secretsPath, { schemaVersion: SCHEMA_VERSION, values });
      writePrivateJson(this.configPath, document);
      this.document = document;
      return true;
    } catch {
      this.available = false;
      this.logger?.error("Could not persist configuration; /bridge setup is disabled. Legacy configuration remains active.");
      return false;
    }
  }

  getAdminChannelId(guildId) {
    if (!this.available || !this.document) throw new Error("Persistent configuration unavailable");
    if (this.document.administration.guildId !== guildId) throw new Error("Guild does not match persistent configuration");
    return this.document.administration.channelId ?? null;
  }

  setAdminChannelId(guildId, channelId) {
    this.getAdminChannelId(guildId);
    const document = {
      ...this.document,
      administration: { guildId, channelId }
    };
    try {
      writePrivateJson(this.configPath, document);
      this.document = document;
    } catch {
      this.available = false;
      this.logger?.error("Could not save the bridge administration channel; /bridge setup is disabled.");
      throw new Error("Persistent configuration unavailable");
    }
  }
}
