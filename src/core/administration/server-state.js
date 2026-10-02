import { getDefaultChatCommandTemplate } from "../../lib/chat-relay-formatters.js";
/** Platform-independent policy for a retained administration record. */
export function getAdministrationState(server) {
  const state = server.deleted ? "deleted" : server.unavailable ? "unavailable" : server.archived ? "archived" : server.active ? "monitoring" : "inactive";
  const relaySupported = Boolean(server.game?.chatCommandTemplate || getDefaultChatCommandTemplate(server.game?.type));
  const relayEnabled = relaySupported && server.chatRelay !== false && server.chatRelay?.enabled !== false;
  return { relaySupported, relayEnabled, state, monitoring: state === "monitoring", published: server.published === true,
    canPublish: state === "monitoring",
    publicationBlocker: server.published ? "already-published" : state === "monitoring" ? null : state };
}
