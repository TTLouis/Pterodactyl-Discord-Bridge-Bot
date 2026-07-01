import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(filePath = path.resolve(process.cwd(), process.env.STATE_PATH ?? "./runtime-state.json")) {
    this.filePath = filePath;
    this.state = {
      statusMessages: {},
      actionMessages: {},
      serverRuntime: {},
      autoStop: {}
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
    return this.state.actionMessages[channelId] ?? null;
  }

  setActionMessageId(channelId, messageId) {
    this.state.actionMessages[channelId] = messageId;
    this.save();
  }

  getServerRuntimeState(serverId) {
    return this.state.serverRuntime[serverId] ?? {};
  }

  setServerRuntimeState(serverId, updates) {
    this.state.serverRuntime[serverId] = { ...this.getServerRuntimeState(serverId), ...updates };
    this.save();
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
}
