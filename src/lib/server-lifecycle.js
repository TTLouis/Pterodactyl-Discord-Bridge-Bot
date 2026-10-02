/** Legacy configurations omit active and remain enabled. */
export function isServerMonitoringEnabled(server) {
  return server.active !== false && !server.archived && !server.deleted && !server.unavailable;
}

export function isServerActionsEnabled(server) {
  return isServerMonitoringEnabled(server) && !server.accessUncertain;
}

export function isServerRelayEnabled(server) {
  return isServerActionsEnabled(server) && server.chatRelay !== false && server.chatRelay?.enabled !== false;
}
