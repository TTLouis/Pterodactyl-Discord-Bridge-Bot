import { getDefaultChatCommandTemplate } from "../../lib/chat-relay-formatters.js";
import { normalizeServer } from "../../lib/config.js";

export class RelaySettingsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Game relay policy and persistence; no platform interaction or presentation. */
export class RelaySettingsService {
  constructor(configStore) { this.configStore = configStore; }
  record(id) {
    const server = this.configStore.getManagedServers().find(server => server.pterodactylServerId === id);
    if (!server) throw new RelaySettingsError("missing-record");
    return server;
  }
  setEnabled(id, enabled) {
    const server = this.record(id);
    const template = server.game.chatCommandTemplate || getDefaultChatCommandTemplate(server.game.type);
    if (enabled && !template) throw new RelaySettingsError("unsupported-relay");
    this.configStore.updateManagedServer(id, { chatRelay: enabled, ...(enabled ? { game: { chatCommandTemplate: template } } : {}) });
  }
  setCustomTemplate(id, input) {
    const server = this.record(id);
    if (typeof input !== "string" || /[\r\n\u0000-\u001F\u007F]/.test(input)) throw new RelaySettingsError("invalid-template");
    const template = input.trim() || getDefaultChatCommandTemplate(server.game.type);
    if (template && !template.includes("{content}")) throw new RelaySettingsError("missing-content-placeholder");
    if (template && server.game.type === "factorio" && !template.startsWith("/")) throw new RelaySettingsError("invalid-factorio-command");
    const changes = { game: { ...server.game, chatCommandTemplate: template }, chatRelay: Boolean(template) };
    normalizeServer({ ...server, ...changes });
    this.configStore.updateManagedServer(id, { game: { chatCommandTemplate: template }, chatRelay: Boolean(template) });
    return Boolean(template);
  }
}
