import { ChannelType, Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";

export class DiscordBridge {
  constructor({ token, guildId, stateStore, logger }) {
    this.token = token;
    this.guildId = guildId;
    this.stateStore = stateStore;
    this.logger = logger;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
    this.handlers = [];
    this.interactionHandlers = [];
    this.slashCommands = [];
  }

  onMessage(handler) {
    this.handlers.push(handler);
  }

  onInteraction(handler) {
    this.interactionHandlers.push(handler);
  }

  setSlashCommands(commands) {
    this.slashCommands = commands;
  }

  async start() {
    this.client.once(Events.ClientReady, async () => {
      this.logger.info(`Discord client ready as ${this.client.user.tag}`);
      if (this.slashCommands.length > 0) {
        await this.#registerSlashCommands();
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.guildId !== this.guildId) return;
      for (const handler of this.interactionHandlers) {
        await handler(interaction);
      }
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !message.guild || message.guild.id !== this.guildId) {
        return;
      }

      const payload = {
        authorName: message.member?.displayName ?? message.author.username,
        channelId: message.channelId,
        content: message.content.trim()
      };

      for (const handler of this.handlers) {
        await handler(payload);
      }
    });

    await this.client.login(this.token);
  }

  async stop() {
    await this.client.destroy();
  }

  async sendMessage(channelId, content) {
    const channel = await this.#getTextChannel(channelId);
    return channel.send(content);
  }

  async deleteMessage(channelId, messageId) {
    const channel = await this.#getTextChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  }

  async upsertStatusPanel(channelId, panel) {
    const channel = await this.#getTextChannel(channelId);
    const knownMessageIds = this.stateStore.getStatusMessageIds(channelId);
    const knownMessageId = knownMessageIds[0] ?? null;
    const payload = panel.content === undefined ? { ...panel, content: null } : panel;

    if (knownMessageId) {
      try {
        const message = await channel.messages.fetch(knownMessageId);
        await message.edit(payload);
        await this.#deleteStaleStatusMessages(channel, knownMessageIds.slice(1));
        this.stateStore.setStatusMessageIds(channelId, [message.id]);
        return;
      } catch (error) {
        this.logger.warn(`Failed to edit status panel message ${knownMessageId}, sending a new one instead.`, error);
      }
    }

    const message = await channel.send(payload);
    await this.#deleteStaleStatusMessages(channel, knownMessageIds);
    this.stateStore.setStatusMessageIds(channelId, [message.id]);
  }

  async #deleteStaleStatusMessages(channel, messageIds) {
    for (const staleMessageId of messageIds) {
      try {
        const staleMessage = await channel.messages.fetch(staleMessageId);
        await staleMessage.delete();
      } catch (error) {
        this.logger.warn(`Failed to delete stale status panel message ${staleMessageId}.`, error);
      }
    }
  }

  async #registerSlashCommands() {
    try {
      const rest = new REST().setToken(this.token);
      const appId = this.client.application.id;

      // Wipe any global (non-guild) commands so stale entries don't show in the client.
      await rest.put(Routes.applicationCommands(appId), { body: [] });

      // PUT replaces the full guild command list, removing any previously registered commands.
      await rest.put(Routes.applicationGuildCommands(appId, this.guildId), { body: this.slashCommands });

      this.logger.info(`Registered ${this.slashCommands.length} slash commands`);
    } catch (error) {
      this.logger.error("Failed to register slash commands", error);
    }
  }

  async #getTextChannel(channelId) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Channel ${channelId} was not found or is not a text channel`);
    }

    return channel;
  }
}
