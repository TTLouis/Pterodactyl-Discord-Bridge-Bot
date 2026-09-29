import fs from "node:fs";
import path from "node:path";
import { normalizeServer } from "./config.js";

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
    this.secrets = null;
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
          || !isRecord(document.settings) || !isRecord(document.administration)
          || (document.managed && (!isRecord(document.managed) || !Array.isArray(document.managed.servers)))) {
          throw new Error("Unsupported or invalid persistent configuration");
        }
        if (document.managed && (document.managed.connection !== null && document.managed.connection !== undefined
          && (typeof document.managed.connection.baseUrl !== "string" || !document.managed.connection.baseUrl)) ) {
          throw new Error("Invalid managed connection");
        }
        if (document.managed?.servers.some((server) => !isRecord(server)
          || typeof server.pterodactylServerId !== "string" || !server.pterodactylServerId
          || typeof server.name !== "string" || !isRecord(server.game)
          || !["factorio", "minecraft", "satisfactory"].includes(server.game.type)
          || typeof server.active !== "boolean" || typeof server.published !== "boolean"
          || server.archived !== false || (server.published && !server.active)
          || (server.active && (typeof server.discordChannelId !== "string" || !server.discordChannelId)))) {
          throw new Error("Invalid managed server");
        }
        this.document = document;
      }

      if (fs.existsSync(this.secretsPath)) {
        const secrets = readDocument(this.secretsPath);
        if (secrets.schemaVersion !== SCHEMA_VERSION || !isRecord(secrets.values)) {
          throw new Error("Unsupported or invalid persistent credentials");
        }
        if (this.document && typeof secrets.values["pterodactyl/default/client-api-key"] !== "string") {
          throw new Error("Persistent Pterodactyl credential is missing");
        }
        if (this.document?.managed?.servers.some((server) => server.active && server.game.type === "satisfactory"
          && (typeof server.game.apiTokenRef !== "string" || typeof secrets.values[server.game.apiTokenRef] !== "string"))) {
          throw new Error("Persistent Satisfactory credential is missing");
        }
        for (const server of this.document?.managed?.servers ?? []) {
          if (!server.active) continue;
          normalizeServer({ ...server, game: { ...server.game,
            apiToken: server.game.apiTokenRef ? secrets.values[server.game.apiTokenRef] : undefined
          } });
        }
        this.secrets = secrets;
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
    if (this.document?.managed?.connection?.baseUrl
      && this.document.managed.connection.baseUrl !== rawConfig.pterodactyl.baseUrl.replace(/\/+$/, "")) {
      this.available = false;
      this.logger?.error("Persistent connection panel differs from servers.json; continuing with legacy configuration.");
      return false;
    }
    const { settings, values } = splitLegacyConfig(rawConfig);
    const document = {
      schemaVersion: SCHEMA_VERSION,
      source: "legacy",
      settings,
      administration: this.document?.administration ?? {
        guildId: rawConfig.discord.guildId,
        channelId: null
      },
      managed: this.document?.managed ?? { connection: null, servers: [] }
    };

    try {
      const secrets = { schemaVersion: SCHEMA_VERSION, values: { ...this.secrets?.values, ...values } };
      if (document.managed.connection) {
        secrets.values["pterodactyl/default/client-api-key"] = this.secrets.values["pterodactyl/default/client-api-key"];
      }
      writePrivateJson(this.secretsPath, secrets);
      writePrivateJson(this.configPath, document);
      this.secrets = secrets;
      this.document = document;
      return true;
    } catch {
      this.available = false;
      this.logger?.error("Could not persist configuration; /bridge setup is disabled. Legacy configuration remains active.");
      return false;
    }
  }

  getConnectionKey() {
    this.#assertReady();
    return this.secrets.values["pterodactyl/default/client-api-key"];
  }

  getManagedServers() {
    this.#assertReady();
    return structuredClone((this.document.managed?.servers ?? []).map((server) => {
      const copy = { ...server, game: { ...server.game } };
      if (copy.game.apiTokenRef) {
        copy.game.apiToken = this.secrets.values[copy.game.apiTokenRef];
        delete copy.game.apiTokenRef;
      }
      return copy;
    }));
  }

  setConnectionKey(key, baseUrl) {
    this.#assertReady();
    const secrets = { schemaVersion: SCHEMA_VERSION, values: {
      ...this.secrets.values,
      "pterodactyl/default/client-api-key": key
    } };
    const document = { ...this.document, managed: {
      ...(this.document.managed ?? { servers: [] }), connection: { baseUrl }
    } };
    this.#save(document, secrets);
  }

  addManagedServer(server) {
    this.#assertReady();
    if (this.document.managed.servers.some((item) => item.pterodactylServerId === server.pterodactylServerId)
      || this.document.settings.servers.some((item) => item.pterodactylServerId === server.pterodactylServerId)) {
      throw new Error("Server already linked");
    }
    this.#save({ ...this.document, managed: { ...this.document.managed,
      servers: [...this.document.managed.servers, structuredClone(server)]
    } }, this.secrets);
  }

  updateManagedServer(serverId, changes, { apiToken = null } = {}) {
    this.#assertReady();
    const servers = this.document.managed.servers.map((server) => {
      if (server.pterodactylServerId !== serverId) return server;
      const next = { ...server, ...changes };
      if (apiToken) next.game = { ...server.game, apiTokenRef: `server/${serverId}/satisfactory-api-token` };
      return next;
    });
    if (!servers.some((server) => server.pterodactylServerId === serverId)) throw new Error("Managed server not found");
    const secrets = apiToken ? { schemaVersion: SCHEMA_VERSION, values: {
      ...this.secrets.values, [`server/${serverId}/satisfactory-api-token`]: apiToken
    } } : this.secrets;
    this.#save({ ...this.document, managed: { ...this.document.managed, servers } }, secrets);
  }

  #assertReady() {
    if (!this.available || !this.document || !this.secrets) throw new Error("Persistent configuration unavailable");
  }

  #save(document, secrets) {
    try {
      if (secrets !== this.secrets) writePrivateJson(this.secretsPath, secrets);
      writePrivateJson(this.configPath, document);
      this.document = document;
      this.secrets = secrets;
    } catch {
      this.available = false;
      this.logger?.error("Could not save persistent bridge configuration.");
      throw new Error("Persistent configuration unavailable");
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
