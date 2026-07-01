import { getKookStatePath } from "../lib/kook-config.js";
import { StateStore } from "../lib/state-store.js";

export class KookBridge {
  constructor({ token, guildId, stateStore = new StateStore(getKookStatePath()), logger }) {
    this.token = token;
    this.guildId = guildId;
    this.stateStore = stateStore;
    this.logger = logger;
    this.handlers = [];
    this.interactionHandlers = [];
    this.reactionHandlers = [];
    this.slashCommands = [];
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  onInteraction(handler) {
    this.interactionHandlers.push(handler);
  }

  onReaction(handler) {
    this.reactionHandlers.push(handler);
  }

  setSlashCommands(commands) {
    this.slashCommands = commands;
  }

  async start() {
    throw new Error("KookBridge is a placeholder and is not implemented yet.");
  }

  async stop() {}

  async sendMessage() {
    throw new Error("KookBridge.sendMessage is not implemented yet.");
  }

  async replaceActionMessage() {
    throw new Error("KookBridge.replaceActionMessage is not implemented yet.");
  }

  async deleteMessage() {
    throw new Error("KookBridge.deleteMessage is not implemented yet.");
  }

  async upsertStatusPanel() {
    throw new Error("KookBridge.upsertStatusPanel is not implemented yet.");
  }
}
