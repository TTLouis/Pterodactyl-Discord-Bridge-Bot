import { buildKookActionMessage, buildKookStatusPanel } from "../lib/kook-card-formatters.js";

export class PlatformBridge {
  constructor({ discordBridge, kookBridge, config, logger }) {
    this.discordBridge = discordBridge;
    this.kookBridge = kookBridge;
    this.config = config;
    this.logger = logger;
  }

  setSlashCommands(commands) {
    this.discordBridge.setSlashCommands(commands);
  }

  onMessage(handler) {
    this.discordBridge.onMessage(handler);
  }

  onInteraction(handler) {
    this.discordBridge.onInteraction(handler);
  }

  onReaction(handler) {
    this.discordBridge.onReaction(handler);
  }

  async start() {
    await this.discordBridge.start();
    await this.kookBridge.start();
  }

  async stop() {
    await Promise.allSettled([
      this.kookBridge.stop(),
      this.discordBridge.stop()
    ]);
  }

  async sendMessage(channelId, content) {
    const message = await this.discordBridge.sendMessage(channelId, content);
    const kookChannelId = this.#findKookChannelId(channelId);

    if (kookChannelId) {
      await this.#mirrorToKook("send server message", async () => {
        await this.kookBridge.sendMessage(kookChannelId, content);
      });
    }

    return message;
  }

  async replaceActionMessage(channelId, payload, options = {}) {
    const message = await this.discordBridge.replaceActionMessage(channelId, payload, options);
    const kookChannelId = this.#findKookChannelId(channelId);

    if (kookChannelId) {
      await this.#mirrorToKook("replace action message", async () => {
        await this.kookBridge.replaceActionMessage(
          kookChannelId,
          buildKookActionMessage(payload, { reactions: options.reactions ?? [] })
        );
      });
    }

    return message;
  }

  async deleteMessage(channelId, messageId) {
    await this.discordBridge.deleteMessage(channelId, messageId);
  }

  async upsertStatusPanel(channelId, panel, { snapshots = null } = {}) {
    await this.discordBridge.upsertStatusPanel(channelId, panel);

    if (channelId !== this.config.discord.statusChannelId || !this.config.kook?.statusChannelId) {
      return;
    }

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      this.logger.warn("Skipping KOOK status panel update because no snapshots were provided.");
      return;
    }

    await this.#mirrorToKook("upsert status panel", async () => {
      await this.kookBridge.upsertStatusPanel(
        this.config.kook.statusChannelId,
        buildKookStatusPanel(snapshots, {
          displayTimeZone: this.config.kook.displayTimeZone ?? "Asia/Shanghai"
        })
      );
    });
  }

  #findKookChannelId(discordChannelId) {
    const server = this.config.servers.find((entry) => entry.discordChannelId === discordChannelId);
    return server?.kookChannelId ?? null;
  }

  async #mirrorToKook(action, callback) {
    try {
      await callback();
    } catch (error) {
      this.logger.warn(`Failed to ${action} on KOOK. Discord update was already sent.`, error);
    }
  }
}
