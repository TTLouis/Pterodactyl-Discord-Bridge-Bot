import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes
} from "discord.js";
import { runHandlers } from "../lib/run-handlers.js";
import {
  getActionMessageEntry,
  setActionMessageEntry,
  shouldEditActionMessage
} from "../lib/action-message-state.js";

export class DiscordBridge {
  constructor({ token, guildId, stateStore, logger, isWatchedChannel = () => true }) {
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
    this.handlers = [];
    this.interactionHandlers = [];
    this.reactionHandlers = [];
    this.slashCommands = [];
    this.channelQueues = new Map();
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
    if (this.client.isReady?.()) {
      void this.#registerSlashCommands();
    }
  }

  async start() {
    this.client.once(Events.ClientReady, async () => {
      this.logger.info(`Discord client ready as ${this.client.user.tag}`);
      if (this.slashCommands.length > 0) {
        await this.#registerSlashCommands();
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.guildId !== this.guildId) return;
      if (
        !interaction.isChatInputCommand()
        && !interaction.isStringSelectMenu()
        && !interaction.isModalSubmit()
        && !interaction.isAutocomplete()
      ) return;

      const label = interaction.isAutocomplete()
        ? `Discord autocomplete /${interaction.commandName}`
        : interaction.isChatInputCommand()
          ? `Discord interaction /${interaction.commandName}`
          : interaction.isModalSubmit()
            ? `Discord modal ${interaction.customId}`
            : `Discord component ${interaction.customId}`;
      await runHandlers(this.interactionHandlers, interaction, {
        logger: this.logger,
        label
      });
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot || !message.guild || message.guild.id !== this.guildId) {
        return;
      }

      const payload = {
        authorName: message.member?.displayName ?? message.author.username,
        authorColor: message.member?.roles?.highest?.color
          ? message.member.roles.highest.hexColor
          : null,
        channelId: message.channelId,
        content: message.content.trim()
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
    await this.client.destroy();
  }

  async createPrivateAdminChannel({ requestedByUserId, name = "bridge-admin" }) {
    const guild = await this.client.guilds.fetch(this.guildId);
    const baseName = name;
    let channelName = baseName;
    let suffix = 2;
    while (guild.channels.cache.some(
      (channel) => channel.type === ChannelType.GuildText && channel.name === channelName
    )) {
      channelName = `${baseName.slice(0, 90)}-${suffix++}`;
    }

    return guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: "Private administration channel for Pterodactyl Platform Bridge.",
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: requestedByUserId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
        {
          id: this.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages
          ]
        }
      ]
    });
  }

  async createStatusChannel({ name = "bridge-status", parentId = null } = {}) {
    const guild = await this.client.guilds.fetch(this.guildId);
    const existing = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === name
    );
    if (existing) {
      if (parentId && existing.parentId !== parentId) {
        await existing.setParent(parentId, {
          lockPermissions: true,
          reason: "Pterodactyl Platform Bridge active status category"
        });
      }
      return existing;
    }

    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      topic: "Live Pterodactyl Platform Bridge server status."
    });
  }

  async ensureServerCategories({
    activeCategoryId = null,
    archiveCategoryId = null,
    activeName = "Game Servers",
    archiveName = "Archived Game Servers"
  } = {}) {
    const guild = await this.client.guilds.fetch(this.guildId);

    const resolveCategory = async (channelId, name) => {
      let category = null;
      if (channelId) {
        try {
          category = await guild.channels.fetch(channelId);
        } catch {}
        if (category?.type !== ChannelType.GuildCategory) {
          category = null;
        }
      }

      category ??= guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === name
      ) ?? null;

      if (!category) {
        category = await guild.channels.create({
          name,
          type: ChannelType.GuildCategory
        });
      }

      return category;
    };

    const activeCategory = await resolveCategory(activeCategoryId, activeName);
    const archiveCategory = await resolveCategory(archiveCategoryId, archiveName);

    await archiveCategory.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false
    });
    await archiveCategory.permissionOverwrites.edit(this.client.user.id, {
      ViewChannel: true,
      ManageChannels: true,
      SendMessages: true,
      ReadMessageHistory: true
    });

    return {
      activeCategoryId: activeCategory.id,
      archiveCategoryId: archiveCategory.id
    };
  }

  async fetchGuildChannel(channelId) {
    if (!channelId) return null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || channel.guildId !== this.guildId) {
        return null;
      }
      return channel;
    } catch {
      return null;
    }
  }

  async deleteChannel(channelId, reason = "Pterodactyl Platform Bridge removed managed server") {
    const channel = await this.fetchGuildChannel(channelId);
    if (!channel) return false;
    await channel.delete(reason);
    return true;
  }

  async setChannelCategory(channelId, categoryId, reason = "Pterodactyl Platform Bridge channel placement") {
    if (!categoryId) {
      throw new Error("Discord category is not configured.");
    }

    const channel = await this.#getTextChannel(channelId);
    if (channel.parentId !== categoryId) {
      await channel.setParent(categoryId, {
        lockPermissions: true,
        reason
      });
    }
    return channel;
  }

  async setServerChannelArchived(channelId, archived, {
    activeCategoryId,
    archiveCategoryId
  }) {
    const targetCategoryId = archived ? archiveCategoryId : activeCategoryId;
    return this.setChannelCategory(
      channelId,
      targetCategoryId,
      archived
        ? "Pterodactyl Platform Bridge archived server"
        : "Pterodactyl Platform Bridge restored server"
    );
  }

  async createServerChannel(serverName, { parentId = null } = {}) {
    const guild = await this.client.guilds.fetch(this.guildId);
    const slug = String(serverName ?? "game-server")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "game-server";
    let name = slug;
    let suffix = 2;
    while (guild.channels.cache.some((channel) => channel.type === ChannelType.GuildText && channel.name === name)) {
      name = `${slug.slice(0, 86)}-${suffix++}`;
    }

    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      topic: `Pterodactyl Platform Bridge: ${serverName}`
    });
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
