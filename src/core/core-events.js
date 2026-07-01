export const CoreEvents = {
  STATUS_PANEL_UPDATED: "status-panel-updated",
  SERVER_ACTION_MESSAGE: "server-action-message",
  SERVER_ACTION_MESSAGE_DELETE: "server-action-message-delete",
  GAME_CHAT_RELAY: "game-chat-relay",
  SERVER_NOTICE: "server-notice"
};

export class CoreEventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, listener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventName);
      }
    };
  }

  async emit(eventName, payload) {
    const listeners = Array.from(this.listeners.get(eventName) ?? []);
    const results = [];

    for (const listener of listeners) {
      results.push(await listener(payload));
    }

    return results;
  }
}
