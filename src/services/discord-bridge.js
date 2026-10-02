import { createHash } from "node:crypto";
import { classifyRelayError } from "../lib/relay-errors.js";
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { runHandlers } from "../lib/run-handlers.js";
import {
  getActionMessageEntry,
  setActionMessageEntry,
  shouldEditActionMessage
} from "../lib/action-message-state.js";

export class DiscordBridge {
  constructor({ token, guildId, stateStore, logger, isWatchedChannel = () => true, relayRequest = null }) {
    this.token = token;
    this.guildId = guildId;
    this.stateStore = stateStore;
    this.logger = logger;
    this.isWatchedChannel = isWatchedChannel;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
    });
    this.pendingRelayRequests = new Map();
    const request = relayRequest ?? this.client.rest.options.makeRequest;
    // A separate REST client avoids changing retry behavior for administration.
    // The guard runs after SDK rate-limit waits, at the actual network boundary.
    this.relayRest = new REST({ version: "10", retries: 0, timeout: 15000, rejectOnRateLimit: () => true,
      makeRequest: (url, options) => {
        const nonce = JSON.parse(options.body).nonce;
        const pending = this.pendingRelayRequests.get(nonce);
        if (options.signal?.aborted) throw Object.assign(new Error("Relay request cancelled before dispatch"), { deliveryStatus: "not-sent" });
        if (!pending?.isCurrent()) throw Object.assign(new Error("Relay route changed"), { deliveryStatus: "not-sent" });
        pending.onDispatch();
        pending.dispatched = true;
        return request(url, options);
      }
    }).setToken(token);
    this.handlers = [];
    this.interactionHandlers = [];
    this.reactionHandlers = [];
    this.slashCommands = [];
    this.channelQueues = new Map();
  }

  onMessage(handler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter(entry => entry !== handler); };
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
    this.client.once(Events.ClientReady, async () => {
      this.logger.info(`Discord client ready as ${this.client.user.tag}`);
      if (this.slashCommands.length > 0) {
        await this.#registerSlashCommands();
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!(interaction.isChatInputCommand() || interaction.isModalSubmit() || interaction.isButton() || interaction.isAutocomplete() || interaction.isAnySelectMenu?.())
        || (this.guildId && interaction.guildId !== this.guildId)) return;
      await runHandlers(this.interactionHandlers, interaction, {
        logger: this.logger,
        label: `Discord interaction /${interaction.commandName}`
      });
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || message.webhookId || !message.guild || message.guild.id !== this.guildId) {
        return;
      }

      const payload = {
        messageId: message.id,
        authorId: message.author.id,
        sourcePlatform: "discord",
        authorName: message.member?.displayName ?? message.author.username,
        authorColor: message.member?.roles?.highest?.color
          ? message.member.roles.highest.hexColor
          : null,
        channelId: message.channelId,
        content: String(message.content ?? "").trim()
      };

      await runHandlers(this.handlers, payload, {
        logger: this.logger,
        label: `Discord message in channel ${payload.channelId}`
      });
    });

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      await this.#handleReaction(reaction, user);
    });

    await this.client.login(this.token);
  }

  async stop() {
    for (const pending of this.pendingRelayRequests.values()) pending.controller?.abort();
    this.relayRest.clearHashSweeper();
    this.relayRest.clearHandlerSweeper();
    await this.client.destroy();
  }

  async sendRelayText(channelId, content, { id, isCurrent = () => true, onDispatch = () => {} } = {}) {
    try { await this.#getTextChannel(channelId); }
    catch (error) { throw classifyRelayError(error); }
    if (!isCurrent()) throw Object.assign(new Error("Relay route changed"), { deliveryStatus: "not-sent" });
    const nonce = createHash("sha256").update(id ?? `${channelId}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24);
    const pending = { isCurrent, onDispatch, dispatched: false };
    this.pendingRelayRequests.set(nonce, pending);
    const controller = new AbortController();
    pending.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      return await this.relayRest.post(Routes.channelMessages(channelId), {
        body: { content, allowed_mentions: { parse: [], replied_user: false }, nonce, enforce_nonce: true },
        signal: controller.signal
      });
    } catch (error) { throw classifyRelayError(error, { dispatched: pending.dispatched }); }
    finally {
      clearTimeout(timeout);
      this.pendingRelayRequests.delete(nonce);
    }
  }

  async sendMessage(channelId, content) {
    const channel = await this.#getTextChannel(channelId);
    return channel.send(content);
  }

  async replaceActionMessage(channelId, content, { reactions = [], meta = {}, preferEdit = false } = {}) {
    return this.#withChannelQueue(channelId, () => this.#replaceActionMessage(channelId, content, {
      reactions,
      meta,
      preferEdit
    }));
  }

  async #replaceActionMessage(channelId, content, { reactions = [], meta = {}, preferEdit = false } = {}) {
    const channel = await this.#getTextChannel(channelId);
    const previousEntry = getActionMessageEntry(this.stateStore, channelId);

    if (shouldEditActionMessage(previousEntry, meta, { preferEdit })) {
      try {
        const message = await channel.messages.edit(previousEntry.messageId, content);
        await this.#syncReactions(message, reactions, { clearExisting: true });
        setActionMessageEntry(this.stateStore, channelId, message.id, meta);
        this.logger.info("Edited Discord action message", {
          channelId,
          messageId: message.id,
          server: meta.serverName,
          previousKind: previousEntry.kind,
          nextKind: meta.kind
        });
        return message;
      } catch (error) {
        this.logger.warn(`Failed to edit Discord action message ${previousEntry.messageId}, sending a new one instead.`, error);
      }
    }

    if (previousEntry?.messageId) {
      try {
        await channel.messages.delete(previousEntry.messageId);
        this.logger.info("Deleted previous Discord action message", {
          channelId,
          messageId: previousEntry.messageId,
          server: previousEntry.serverName,
          previousKind: previousEntry.kind,
          nextKind: meta.kind
        });
      } catch (error) {
        this.logger.warn(`Failed to delete previous action message ${previousEntry.messageId}.`, error);
      }
    }

    const message = await channel.send(content);
    setActionMessageEntry(this.stateStore, channelId, message.id, meta);
    await this.#syncReactions(message, reactions);

    return message;
  }

  async #withChannelQueue(channelId, callback) {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.channelQueues.set(channelId, current);

    try {
      return await current;
    } finally {
      if (this.channelQueues.get(channelId) === current) {
        this.channelQueues.delete(channelId);
      }
    }
  }

  async deleteMessage(channelId, messageId) {
    const channel = await this.#getTextChannel(channelId);
    await channel.messages.delete(messageId);
  }

  async upsertStatusPanel(channelId, panel, { panelKey = "live" } = {}) {
    return this.#withChannelQueue(channelId, () => this.#upsertStatusPanel(channelId, panel, panelKey));
  }

  async #upsertStatusPanel(channelId, panel, panelKey) {
    const channel = await this.#getTextChannel(channelId);
    const knownMessageIds = this.stateStore.getStatusMessageIds(channelId, panelKey);
    const knownMessageId = knownMessageIds[0] ?? null;
    const payload = panel.content === undefined ? { ...panel, content: null } : panel;
    const migrateLivePanel = panelKey === "live" && this.#needsStatusPanelMigration(channelId, knownMessageIds);

    if (knownMessageId && !migrateLivePanel) {
      try {
        await channel.messages.edit(knownMessageId, payload);
        await this.#deleteStaleStatusMessages(channel, knownMessageIds.slice(1));
        this.stateStore.setStatusMessageIds(channelId, [knownMessageId], panelKey);
        return;
      } catch (error) {
        this.logger.warn(`Failed to edit status panel message ${knownMessageId}, sending a new one instead.`, error);
      }
    }

    const message = await channel.send(payload);
    await this.#deleteStaleStatusMessages(channel, knownMessageIds);
    this.stateStore.setStatusMessageIds(channelId, [message.id], panelKey);
    this.#finishStatusPanelMigration(channelId, panelKey);
  }

  #needsStatusPanelMigration(channelId, liveMessageIds) {
    if (typeof this.stateStore.getStatusPanelLayoutVersion !== "function") {
      return false;
    }

    return this.stateStore.getStatusPanelLayoutVersion(channelId) !== 2
      && liveMessageIds.length > 0
      && this.stateStore.getStatusMessageIds(channelId, "archive").length > 0;
  }

  #finishStatusPanelMigration(channelId, panelKey) {
    if (panelKey === "live" && this.stateStore.getStatusMessageIds(channelId, "archive").length > 0) {
      this.stateStore.setStatusPanelLayoutVersion?.(channelId, 2);
    }
  }

  async #deleteStaleStatusMessages(channel, messageIds) {
    for (const staleMessageId of messageIds) {
      try {
        await channel.messages.delete(staleMessageId);
      } catch (error) {
        this.logger.warn(`Failed to delete stale status panel message ${staleMessageId}.`, error);
      }
    }
  }

  async #syncReactions(message, reactions, { clearExisting = false } = {}) {
    if (clearExisting) {
      try {
        await message.reactions.removeAll();
      } catch (error) {
        this.logger.warn(`Failed to clear reactions from action message ${message.id}.`, error);
      }
    }

    for (const reaction of reactions) {
      try {
        await message.react(reaction);
      } catch (error) {
        this.logger.warn(`Failed to add reaction ${reaction} to action message ${message.id}.`, error);
      }
    }
  }

  async claimGuild(guildId) {
    if (this.guildId && this.guildId !== guildId) throw new Error("Installation already claimed");
    this.guildId = guildId;
    await this.#registerSlashCommands();
  }

  async #registerSlashCommands() {
    try {
      const rest = new REST().setToken(this.token);
      const appId = this.client.application.id;

      // Wipe any global (non-guild) commands so stale entries don't show in the client.
      await rest.put(Routes.applicationCommands(appId), { body: this.guildId ? [] : this.slashCommands.filter((command) => command.name === "bridge").map((command) => ({ ...command, options: command.options.filter((option) => option.name === "setup") })) });

      // PUT replaces the full guild command list, removing any previously registered commands.
      if (this.guildId) await rest.put(Routes.applicationGuildCommands(appId, this.guildId), { body: this.slashCommands });

      this.logger.info(`Registered ${this.slashCommands.length} slash commands`);
    } catch (error) {
      this.logger.error("Failed to register slash commands", error);
    }
  }

  async #handleReaction(reaction, user) {
    // Filter by channel before fetching anything. Reactions fire for the whole
    // guild, and resolving partials plus the guild member is an API call each.
    const channelId = reaction.message?.channelId ?? null;
    if (!channelId || !this.isWatchedChannel(channelId)) {
      return;
    }

    try {
      if (reaction.partial) {
        reaction = await reaction.fetch();
      }
      if (user.partial) {
        user = await user.fetch();
      }
    } catch (error) {
      this.logger.warn("Failed to fetch partial Discord reaction payload.", error);
      return;
    }

    const message = reaction.message;
    if (user.bot || !message.guild || message.guild.id !== this.guildId) {
      return;
    }

    let member = null;
    try {
      member = await message.guild.members.fetch(user.id);
    } catch (error) {
      this.logger.warn(`Failed to fetch guild member for reaction user ${user.id}.`, error);
    }

    const payload = {
      channelId: message.channelId,
      messageId: message.id,
      emoji: reaction.emoji.name,
      member,
      user,
      userId: user.id,
      displayName: member?.displayName ?? user.globalName ?? user.username,
      removeUserReaction: async () => {
        await reaction.users.remove(user.id);
      }
    };

    await runHandlers(this.reactionHandlers, payload, {
      logger: this.logger,
      label: `Discord reaction ${payload.emoji} in channel ${payload.channelId}`
    });
  }

  async #getTextChannel(channelId) {
    const channel = await this.client.channels.fetch(channelId);
    // Accept announcement channels and threads too, not just plain text channels.
    if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
      throw new Error(`Channel ${channelId} was not found or is not a guild text channel`);
    }

    return channel;
  }
}
