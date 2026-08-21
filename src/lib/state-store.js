import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(filePath = path.resolve(process.cwd(), process.env.STATE_PATH ?? "./runtime-state.json")) {
    this.filePath = filePath;
    this.state = {
      statusMessages: {},
      actionMessages: {},
      serverRuntime: {},
      autoStop: {},
      relayQueue: {}
    };
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return this.state;
    }

    this.state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    this.state.statusMessages ??= {};
    this.state.actionMessages ??= {};
    this.state.serverRuntime ??= {};
    this.state.autoStop ??= {};
    this.state.relayQueue ??= {};
    return this.state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  getStatusMessageIds(channelId) {
    const value = this.state.statusMessages[channelId];

    if (Array.isArray(value)) {
      return value.filter(Boolean);
    }

    if (typeof value === "string" && value) {
      return [value];
    }

    return [];
  }

  setStatusMessageIds(channelId, messageIds) {
    this.state.statusMessages[channelId] = messageIds;
    this.save();
  }

  getActionMessageId(channelId) {
    return this.getActionMessage(channelId)?.messageId ?? null;
  }

  setActionMessageId(channelId, messageId) {
    this.state.actionMessages[channelId] = messageId;
    this.save();
  }

  getActionMessage(channelId) {
    const value = this.state.actionMessages[channelId];

    if (typeof value === "string" && value) {
      return { messageId: value };
    }

    if (value && typeof value === "object" && typeof value.messageId === "string" && value.messageId) {
      return value;
    }

    return null;
  }

  setActionMessage(channelId, entry) {
    this.state.actionMessages[channelId] = {
      ...entry,
      updatedAt: Date.now()
    };
    this.save();
  }

  getServerRuntimeState(serverId) {
    return this.state.serverRuntime[serverId] ?? {};
  }

  setServerRuntimeState(serverId, updates) {
    this.state.serverRuntime[serverId] = { ...this.getServerRuntimeState(serverId), ...updates };
    this.save();
  }

  setPendingStartAttribution(serverId, attribution) {
    this.setServerRuntimeState(serverId, {
      pendingStartAttribution: {
        ...attribution,
        source: attribution.source ?? "discord"
      }
    });
  }

  getPendingStartAttribution(serverId) {
    const attribution = this.getServerRuntimeState(serverId).pendingStartAttribution;
    return attribution && typeof attribution === "object" ? attribution : null;
  }

  consumePendingStartAttribution(serverId) {
    const attribution = this.getPendingStartAttribution(serverId);
    if (!attribution) return null;

    const runtimeState = this.getServerRuntimeState(serverId);
    delete runtimeState.pendingStartAttribution;
    this.setServerRuntimeState(serverId, runtimeState);
    return attribution;
  }

  clearPendingStartAttribution(serverId) {
    const runtimeState = this.getServerRuntimeState(serverId);
    if (!Object.hasOwn(runtimeState, "pendingStartAttribution")) return;

    delete runtimeState.pendingStartAttribution;
    this.setServerRuntimeState(serverId, runtimeState);
  }

  getAutoStopState(serverId) {
    return this.state.autoStop[serverId] ?? {};
  }

  setAutoStopState(serverId, updates) {
    this.state.autoStop[serverId] = { ...this.getAutoStopState(serverId), ...updates };
    this.save();
  }

  clearAutoStopState(serverId) {
    delete this.state.autoStop[serverId];
    this.save();
  }

  getRelayQueue(serverId) {
    const queue = this.state.relayQueue[serverId];
    return Array.isArray(queue) ? queue : [];
  }

  setRelayQueue(serverId, entries) {
    if (Array.isArray(entries) && entries.length > 0) {
      this.state.relayQueue[serverId] = entries;
    } else {
      delete this.state.relayQueue[serverId];
    }
    this.save();
  }
}
