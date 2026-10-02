import fs from "node:fs";
import path from "node:path";
import { normalizeServer } from "./config.js";
import { orderServers } from "./server-display-order.js";

export const SCHEMA_VERSION = 2;

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
    const descriptor = fs.openSync(tempPath, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(tempPath, filePath);
    const directory = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
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

function validateDocuments(document, secrets) {
  if (![1, SCHEMA_VERSION].includes(document.schemaVersion) || !["legacy", "managed"].includes(document.source)
    || !isRecord(document.settings) || !isRecord(document.administration)
    || !Array.isArray(document.settings.servers) || !isRecord(document.managed)
    || !Array.isArray(document.managed.servers)
    || ![1, SCHEMA_VERSION].includes(secrets.schemaVersion) || !isRecord(secrets.values)) {
    throw new Error("Invalid persistent configuration transaction");
  }
  if ((document.managed.connection || document.settings.pterodactyl?.apiKeyRef)
    && typeof secrets.values["pterodactyl/default/client-api-key"] !== "string") throw new Error("Missing credential");
  if (document.managed.connection && (typeof document.managed.connection.baseUrl !== "string"
    || !document.managed.connection.baseUrl)) throw new Error("Invalid managed connection");
  for (const server of document.managed.servers) {
    if (!isRecord(server) || typeof server.name !== "string" || !server.name
      || typeof server.pterodactylServerId !== "string" || !server.pterodactylServerId
      || typeof server.active !== "boolean" || typeof server.published !== "boolean" || typeof server.archived !== "boolean"
      || !["factorio", "minecraft", "satisfactory", "source"].includes(server.game?.type)
      || (server.active && !server.discordChannelId)) throw new Error("Invalid managed server");
    if (server.active && server.game.type === "satisfactory" && typeof secrets.values[server.game.apiTokenRef] !== "string") throw new Error("Missing game credential");
    normalizeServer({ ...server, game: { ...server.game, apiToken: secrets.values[server.game.apiTokenRef] } });
  }
}

export class PersistentConfigStore {
  constructor({ configPath, secretsPath, logger = null } = {}) {
    const defaults = getPersistentConfigPaths();
    this.configPath = configPath ?? defaults.configPath;
    this.secretsPath = secretsPath ?? defaults.secretsPath;
    this.journalPath = `${this.configPath}.journal`;
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
      if (fs.existsSync(this.journalPath)) {
        const transaction = readDocument(this.journalPath);
        if (transaction.schemaVersion !== SCHEMA_VERSION || !isRecord(transaction.document)
          || !isRecord(transaction.secrets) || !isRecord(transaction.secrets.values)
          || transaction.document.schemaVersion !== SCHEMA_VERSION
          || !["legacy", "managed"].includes(transaction.document.source)
          || !isRecord(transaction.document.settings) || !isRecord(transaction.document.administration)
          || !Array.isArray(transaction.document.managed?.servers)) throw new Error("Invalid recovery journal");
        validateDocuments(transaction.document, transaction.secrets);
        writePrivateJson(this.secretsPath, transaction.secrets);
        writePrivateJson(this.configPath, transaction.document);
        fs.unlinkSync(this.journalPath);
      }
      if (fs.existsSync(this.configPath)) {
        const document = readDocument(this.configPath);
        if (![1, SCHEMA_VERSION].includes(document.schemaVersion) || !["legacy", "managed"].includes(document.source)
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
          || !["factorio", "minecraft", "satisfactory", "source"].includes(server.game.type)
          || typeof server.active !== "boolean" || typeof server.published !== "boolean"
          || typeof server.archived !== "boolean"
          || (server.deleted !== undefined && typeof server.deleted !== "boolean")
          || (server.active && (typeof server.discordChannelId !== "string" || !server.discordChannelId)))) {
          throw new Error("Invalid managed server");
        }
        this.document = { ...document, schemaVersion: SCHEMA_VERSION, managed: document.managed ?? { connection: null, servers: [] } };
      }

      if (fs.existsSync(this.secretsPath)) {
        const secrets = readDocument(this.secretsPath);
        if (![1, SCHEMA_VERSION].includes(secrets.schemaVersion) || !isRecord(secrets.values)) {
          throw new Error("Unsupported or invalid persistent credentials");
        }
        if ((this.document?.managed?.connection || this.document?.settings?.pterodactyl?.apiKeyRef) && typeof secrets.values["pterodactyl/default/client-api-key"] !== "string") {
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
        if (this.document) validateDocuments(this.document, secrets);
        this.secrets = { ...secrets, schemaVersion: SCHEMA_VERSION };
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
    if (this.document?.source === "managed") return true;
    if (this.document?.managed?.connection?.baseUrl
      && this.document.managed.connection.baseUrl !== rawConfig.pterodactyl.baseUrl.replace(/\/+$/, "")) {
      this.available = false;
      this.logger?.error("Persistent connection panel differs from servers.json; continuing with legacy configuration.");
      return false;
    }
    const { settings, values } = splitLegacyConfig(rawConfig);
    for (const key of ["privateCategoryId", "publicCategoryId", "linkedChannelRoleId", "bridgeAdminRoleId"]) {
      const saved = this.document?.settings?.discord?.[key];
      if (saved) settings.discord[key] = saved;
    }
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
      this.#save(document, secrets);
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
      if (changes.game) next.game = { ...server.game, ...changes.game };
      if (apiToken) next.game = { ...next.game, apiTokenRef: `server/${serverId}/satisfactory-api-token` };
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
    // Sanitize every write path, including imports/settings passed by UI callers.
    const cleanSettings = splitLegacyConfig(document.settings);
    const cleanManaged = splitLegacyConfig({ servers: document.managed?.servers ?? [] });
    document = { ...document, schemaVersion: SCHEMA_VERSION, settings: cleanSettings.settings,
      managed: { ...document.managed, servers: cleanManaged.settings.servers } };
    secrets = { schemaVersion: SCHEMA_VERSION, values: { ...secrets.values, ...cleanSettings.values, ...cleanManaged.values } };
    validateDocuments(document, secrets);
    try {
      writePrivateJson(this.journalPath, { schemaVersion: SCHEMA_VERSION, document, secrets });
      writePrivateJson(this.secretsPath, secrets);
      writePrivateJson(this.configPath, document);
      fs.unlinkSync(this.journalPath);
      this.document = document;
      this.secrets = secrets;
    } catch {
      this.available = false;
      this.logger?.error("Could not save persistent bridge configuration.");
      throw new Error("Persistent configuration unavailable");
    }
  }

  initialize() {
    if (!this.available) throw new Error("Persistent configuration unavailable");
    if (this.document) return false;
    this.#save({ schemaVersion: SCHEMA_VERSION, source: "managed",
      settings: { discord: {}, pterodactyl: {}, servers: [], publicDisplay: { archived: "marked", deleted: "marked" } },
      administration: { guildId: null, channelId: null, cards: {} },
      managed: { connection: null, servers: [] }, audit: []
    }, { schemaVersion: SCHEMA_VERSION, values: {} });
    return true;
  }

  getGuildId() { return this.document?.administration?.guildId ?? null; }

  claimGuild(guildId) {
    this.#assertReady();
    if (typeof guildId !== "string" || !guildId) throw new Error("Guild ID is required");
    if (this.getGuildId() && this.getGuildId() !== guildId) throw new Error("Guild does not match persistent configuration");
    if (this.getGuildId() === guildId) return false;
    this.#save({ ...this.document, administration: { ...this.document.administration, guildId },
      settings: { ...this.document.settings, discord: { ...this.document.settings.discord, guildId } }
    }, this.secrets);
    return true;
  }

  updateSettings(changes) {
    this.#assertReady();
    if (!isRecord(changes)) throw new Error("Settings must be an object");
    const settings = { ...this.document.settings, ...structuredClone(changes) };
    for (const key of ["discord", "pterodactyl", "publicDisplay"]) {
      if (changes[key]) settings[key] = { ...this.document.settings[key], ...changes[key] };
    }
    if (settings.discord?.guildId && settings.discord.guildId !== this.getGuildId()) throw new Error("Guild does not match persistent configuration");
    const split = splitLegacyConfig(settings);
    this.#save({ ...this.document, settings: split.settings }, { ...this.secrets, values: { ...this.secrets.values, ...split.values } });
  }

  getRuntimeConfig() {
    this.#assertReady();
    const settings = structuredClone(this.document.settings);
    settings.discord = { ...settings.discord, guildId: this.getGuildId() };
    settings.pterodactyl = { ...settings.pterodactyl, ...this.document.managed.connection };
    settings.pterodactyl.apiKey = this.getConnectionKey();
    settings.servers = orderServers([...(settings.servers ?? []), ...this.getManagedServers()], settings.discord.serverDisplayOrder);
    for (const server of settings.servers) {
      if (server.game?.apiTokenRef) { server.game.apiToken = this.secrets.values[server.game.apiTokenRef]; delete server.game.apiTokenRef; }
    }
    delete settings.pterodactyl.apiKeyRef;
    return settings;
  }

  getCardMessageId(serverId) { this.#assertReady(); return this.document.administration.cards?.[serverId] ?? null; }
  setCardMessageId(serverId, messageId) {
    this.#assertReady();
    this.#save({ ...this.document, administration: { ...this.document.administration,
      cards: { ...this.document.administration.cards, [serverId]: messageId }
    } }, this.secrets);
  }

  replaceCardMessages(cards, pendingDeletion) {
    this.#assertReady();
    this.#save({ ...this.document, administration: { ...this.document.administration,
      cards: { ...this.document.administration.cards, ...cards }, pendingCardDeletion: pendingDeletion
    } }, this.secrets);
  }

  recordAudit(action, { actorId = null, serverId = null } = {}) {
    this.#assertReady();
    // Only controlled action names and IDs are stored; modal values and credentials are never accepted.
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(action)) throw new Error("Invalid audit action");
    for (const id of [actorId, serverId]) if (id !== null && !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error("Invalid audit identifier");
    const event = { at: new Date().toISOString(), action, actorId, serverId };
    this.#save({ ...this.document, audit: [...(this.document.audit ?? []), event].slice(-500) }, this.secrets);
  }

  exportRedacted() {
    this.#assertReady();
    return JSON.parse(JSON.stringify(this.document, (key, value) =>
      /^(apiKey|apiToken|password|token|secret)$/i.test(key) ? "[REDACTED]" : value));
  }

  migrateLegacyConfig(rawConfig, { legacyPath = null } = {}) {
    this.#assertReady();
    const conflicts = [];
    if (this.getGuildId() && rawConfig.discord?.guildId !== this.getGuildId()) conflicts.push("guild");
    if (this.document.managed.connection && this.document.managed.connection.baseUrl !== rawConfig.pterodactyl?.baseUrl?.replace(/\/+$/, "")) conflicts.push("panel");
    const retained = this.document.managed.servers;
    const identities = (server) => [server.pterodactylServerId, server.pterodactylUuid].filter(Boolean);
    const ids = new Set(retained.flatMap(identities));
    const discordChannels = new Set(retained.map((server) => server.discordChannelId).filter(Boolean));
    const kookChannels = new Set(retained.map((server) => server.kookChannelId).filter(Boolean));
    for (const server of rawConfig.servers ?? []) {
      if (identities(server).some((id) => ids.has(id))) conflicts.push(`server:${server.pterodactylServerId}`);
      for (const id of identities(server)) ids.add(id);
      if (!server.archived && server.active !== false) {
        if (server.discordChannelId && discordChannels.has(server.discordChannelId)) conflicts.push(`discord-channel:${server.discordChannelId}`);
        if (server.kookChannelId && kookChannels.has(server.kookChannelId)) conflicts.push(`kook-channel:${server.kookChannelId}`);
        if (server.discordChannelId) discordChannels.add(server.discordChannelId);
        if (server.kookChannelId) kookChannels.add(server.kookChannelId);
      }
    }
    if (conflicts.length) return { migrated: false, conflicts, backupPath: null };
    const backupPath = `${this.configPath}.pre-migration-${Date.now()}.json`;
    writePrivateJson(backupPath, { document: this.document, secrets: this.secrets, legacy: rawConfig });
    if (legacyPath && fs.existsSync(legacyPath)) writePrivateJson(`${backupPath}.legacy`, readDocument(legacyPath));
    const { settings, values } = splitLegacyConfig(rawConfig);
    // Discord administration choices already saved by this installation must
    // survive the switch from the legacy file to managed configuration.
    settings.discord = { ...settings.discord, ...this.document.settings.discord };
    const servers = [...retained, ...settings.servers.map((server) => ({ ...server,
      active: server.active !== false && !server.archived && !server.deleted && !server.unavailable,
      published: server.published !== false, archived: server.archived === true }))];
    if (this.document.managed.connection) values["pterodactyl/default/client-api-key"] = this.getConnectionKey();
    this.#save({ ...this.document, source: "managed", settings: { ...settings, servers: [] },
      administration: { ...this.document.administration, guildId: settings.discord.guildId },
      managed: { connection: { baseUrl: settings.pterodactyl.baseUrl.replace(/\/+$/, "") }, servers }
    }, { schemaVersion: SCHEMA_VERSION, values: { ...this.secrets.values, ...values } });
    return { migrated: true, conflicts: [], backupPath };
  }

  configureCategories(guildId, { privateCategoryId, publicCategoryId, linkedChannelRoleId }) {
    this.getAdminChannelId(guildId);
    for (const id of [privateCategoryId, publicCategoryId, linkedChannelRoleId]) {
      if (typeof id !== "string" || !id.trim() || id !== id.trim()) throw new Error("Category and linked-channel role IDs are required");
    }
    if (privateCategoryId === publicCategoryId) throw new Error("Private and public categories must differ");
    this.#save({ ...this.document,
      administration: { ...this.document.administration, categoryId: privateCategoryId },
      settings: { ...this.document.settings, discord: { ...this.document.settings.discord,
        privateCategoryId, publicCategoryId, linkedChannelRoleId } }
    }, this.secrets);
  }

  getCategoryId(guildId) {
    this.getAdminChannelId(guildId);
    return this.document.administration.categoryId ?? null;
  }

  setCategoryId(guildId, categoryId) {
    this.getAdminChannelId(guildId);
    if (typeof categoryId !== "string" || !categoryId) throw new Error("Category ID is required");
    this.#save({ ...this.document, administration: { ...this.document.administration, categoryId } }, this.secrets);
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
      administration: { ...this.document.administration, guildId, channelId }
    };
    this.#save(document, this.secrets);
  }

}
