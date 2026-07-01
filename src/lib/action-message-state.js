const EDITABLE_TRANSITIONS = new Set([
  "server-starting-requested->server-starting-state",
  "server-starting-requested->server-online",
  "server-starting-state->server-online",
  "server-stopping-state->server-offline",
  "server-stopping-state->manual-stopped",
  "server-stopping-state->auto-stopped"
]);

const FAST_REVERSAL_TRANSITIONS = new Set([
  "server-online->server-stopping-state",
  "server-online->server-offline",
  "server-online->manual-stopped",
  "server-online->auto-stopped"
]);
const FAST_REVERSAL_MAX_AGE_MS = 5 * 60 * 1000;

const KIND_STATES = {
  "auto-stopped": "offline",
  "manual-stopped": "offline",
  "server-offline": "offline",
  "server-online": "running",
  "server-starting-requested": "starting",
  "server-starting-state": "starting",
  "server-stopping-state": "stopping"
};

export function buildActionMessageMeta(event) {
  return {
    serverId: event.server?.pterodactylServerId,
    serverName: event.server?.name,
    kind: event.kind,
    state: event.currentState ?? KIND_STATES[event.kind] ?? null
  };
}

export function getActionMessageEntry(stateStore, channelId) {
  if (typeof stateStore.getActionMessage === "function") {
    return stateStore.getActionMessage(channelId);
  }

  const messageId = stateStore.getActionMessageId?.(channelId);
  return messageId ? { messageId } : null;
}

export function setActionMessageEntry(stateStore, channelId, messageId, meta = {}) {
  const entry = {
    messageId,
    ...meta
  };

  if (typeof stateStore.setActionMessage === "function") {
    stateStore.setActionMessage(channelId, entry);
    return;
  }

  stateStore.setActionMessageId(channelId, messageId);
}

export function shouldEditActionMessage(previousEntry, nextMeta = {}, { preferEdit = false } = {}) {
  if (!preferEdit || !previousEntry?.messageId || !previousEntry.serverId || !nextMeta.serverId) {
    return false;
  }

  if (previousEntry.serverId !== nextMeta.serverId) {
    return false;
  }

  const transition = `${previousEntry.kind}->${nextMeta.kind}`;
  if (EDITABLE_TRANSITIONS.has(transition)) {
    return true;
  }

  if (!FAST_REVERSAL_TRANSITIONS.has(transition)) {
    return false;
  }

  return typeof previousEntry.updatedAt === "number" && Date.now() - previousEntry.updatedAt <= FAST_REVERSAL_MAX_AGE_MS;
}
