import fs from "node:fs";
import path from "node:path";

const SAVE_DEBOUNCE_MS = 250;

export function getStatePath() {
  return path.resolve(process.cwd(), process.env.STATE_PATH ?? "./runtime-state.json");
}

function createDefaultState() {
  return {
    statusMessages: {},
    actionMessages: {},
    serverRuntime: {},
    autoStop: {},
    relayQueue: {}
  };
}

export class StateStore {
  constructor(
    filePath = getStatePath(),
    { logger = null, saveDebounceMs = SAVE_DEBOUNCE_MS } = {}
  ) {
    this.filePath = filePath;
    this.logger = logger;
    this.saveDebounceMs = saveDebounceMs;
    this.state = createDefaultState();
    this.pendingSaveHandle = null;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return this.state;
    }

    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      parseError = error;
    }

    // A truncated write or a hand-edited file must not turn into a permanent
    // crash loop: quarantine it and start clean instead of throwing at startup.
    if (parseError || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.#quarantineUnreadableState(parseError);
      this.state = createDefaultState();
      this.save();
      return this.state;
    }

    this.state = parsed;
    this.state.statusMessages ??= {};
    this.state.actionMessages ??= {};
    this.state.serverRuntime ??= {};
    this.state.autoStop ??= {};
    this.state.relayQueue ??= {};
    return this.state;
  }

  #quarantineUnreadableState(error) {
    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
    let quarantined = false;
    try {
      fs.renameSync(this.filePath, quarantinePath);
      quarantined = true;
    } catch {
      // Keeping a copy is best effort; resetting state matters more.
    }

    this.logger?.error(
      `Runtime state at ${this.filePath} was unreadable and has been reset. `
      + (quarantined ? `The previous file was kept at ${quarantinePath}. ` : "")
      + "Status and action message IDs are gone, so the bot will post fresh messages "
      + "and any earlier ones must be removed by hand.",
      error ?? undefined
    );
  }

  /** Persists immediately, superseding any debounced write. */
  save() {
    this.#cancelPendingSave();
    this.#writeStateFile();
  }

  /**
   * Persists on a short debounce, coalescing bursts into one write. Used for
   * high-frequency mutations such as the relay queue, where writing the whole
   * file per message turns a queue drain into O(n^2) disk writes.
   */
  saveSoon() {
    if (this.pendingSaveHandle) {
      return;
    }

    this.pendingSaveHandle = setTimeout(() => {
      this.pendingSaveHandle = null;
      try {
        this.#writeStateFile();
      } catch (error) {
        // Runs detached from any caller, so it must never reject into the timer.
        this.logger?.error(`Failed to persist runtime state to ${this.filePath}`, error);
      }
    }, this.saveDebounceMs);
    this.pendingSaveHandle.unref?.();
  }

  /** Writes any debounced state now. Call before the process exits. */
  flush() {
    if (!this.pendingSaveHandle) {
      return;
    }

    this.#cancelPendingSave();
    this.#writeStateFile();
  }

  #cancelPendingSave() {
    if (this.pendingSaveHandle) {
      clearTimeout(this.pendingSaveHandle);
      this.pendingSaveHandle = null;
    }
  }

  // Write-then-rename so a process death mid-write leaves the previous state
  // intact rather than a half-written file.
  #writeStateFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
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
    this.saveSoon();
  }
}
