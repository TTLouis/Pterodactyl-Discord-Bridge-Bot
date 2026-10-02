import { canAccessServer } from "../../core/administration/server-access.js";
import { getAdministrationState } from "../../core/administration/server-state.js";
import { getDefaultChatCommandTemplate } from "../../lib/chat-relay-formatters.js";
import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle,
  ChannelType, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits, PermissionsBitField,
  TextInputBuilder, TextInputStyle
} from "discord.js";
import { ensureBridgeCategory, ensurePublicBridgeCategory, bridgePrivateOverwrites } from "./bridge-category.js";
import { canRunBridgeSetup } from "./bridge-setup-controller.js";
import { normalizeServer } from "../../lib/config.js";
import { MAX_STATUS_PANEL_SERVERS } from "../../lib/formatters.js";
import { PterodactylClient } from "../../services/pterodactyl-client.js";
import { hydrateServerNetworkConfig } from "../../services/server-network-config.js";

const ephemeral = MessageFlags.Ephemeral;
const serverOption = { type: ApplicationCommandOptionType.String, name: "server", description: "Pterodactyl server ID", required: true, autocomplete: true };
const channelOption = { type: ApplicationCommandOptionType.Channel, name: "channel", description: "Bind an existing text channel; omit to create a private channel", required: false, channel_types: [ChannelType.GuildText] };

export const BRIDGE_ADMIN_COMMANDS = [
  { type: ApplicationCommandOptionType.Subcommand, name: "connect", description: "Validate a Client API key for the configured panel" },
  { type: ApplicationCommandOptionType.Subcommand, name: "servers", description: "List accessible Pterodactyl servers", options: [
    { type: ApplicationCommandOptionType.Integer, name: "page", description: "Results page (10 servers)", required: false, min_value: 1 }
  ] },
  { type: ApplicationCommandOptionType.Subcommand, name: "import", description: "Save an accessible server, inactive by default", options: [
    serverOption,
    { type: ApplicationCommandOptionType.String, name: "game", description: "Game type", required: true, choices: [
      { name: "Factorio", value: "factorio" }, { name: "Minecraft", value: "minecraft" }, { name: "Satisfactory", value: "satisfactory" }, { name: "Source engine", value: "source" }
    ] },
    { type: ApplicationCommandOptionType.Boolean, name: "activate", description: "Start monitoring now (default: no)", required: false },
    channelOption
  ] },
  { type: ApplicationCommandOptionType.Subcommand, name: "activate", description: "Enable monitoring and create or reuse a linked channel; publication is separate", options: [serverOption, channelOption] },
  { type: ApplicationCommandOptionType.Subcommand, name: "publish", description: "List a monitored server on the main status page and publish its private linked channel", options: [serverOption] }
];

/** Recreate a saved binding only after authoritative Discord absence. */
export async function fetchSavedServerChannel(guild, channelId) {
  if (!channelId) return null;
  let channel;
  try { channel = await guild.channels.fetch(channelId, { force: true }); }
  catch (error) {
    if (Number(error?.code) === 10003) return null;
    throw error;
  }
  if (channel && channel.type !== ChannelType.GuildText) throw new Error("Saved server binding is not a text channel");
  return channel;
}

function copyChannelOverwrites(channel) {
  const cache = channel.permissionOverwrites?.cache;
  if (!cache || typeof cache.values !== "function") throw new Error("Channel permissions unavailable");
  return Array.from(cache.values(), (overwrite) => ({
    id: overwrite.id, type: overwrite.type,
    allow: overwrite.allow?.bitfield ?? overwrite.allow ?? 0n,
    deny: overwrite.deny?.bitfield ?? overwrite.deny ?? 0n
  }));
}

function publicationSnapshot(channel, { guild, configStore, botUserId, actorId }) {
  try {
    if (!("parentId" in channel)) throw new Error("Channel parent unavailable");
    return { parent: channel.parentId, permissionOverwrites: copyChannelOverwrites(channel) };
  } catch {
    const privateCategoryId = configStore.getCategoryId(guild.id);
    if (!privateCategoryId) throw new Error("Private rollback category unavailable");
    return { parent: privateCategoryId, permissionOverwrites: bridgePrivateOverwrites({ guild, botUserId, actorId }) };
  }
}

function verifyPublicationChannel(channel, expected) {
  if (!channel || channel.type !== ChannelType.GuildText || channel.parentId !== expected.parent) {
    throw new Error("Published channel did not reach its selected category");
  }
  const actual = copyChannelOverwrites(channel);
  if (actual.length !== expected.permissionOverwrites.length) throw new Error("Published channel access differs from the selected policy");
  for (const overwrite of expected.permissionOverwrites) {
    const saved = actual.find((item) => item.id === overwrite.id && item.type === overwrite.type);
    if (!saved || new PermissionsBitField(saved.allow).bitfield !== new PermissionsBitField(overwrite.allow ?? 0n).bitfield
      || new PermissionsBitField(saved.deny).bitfield !== new PermissionsBitField(overwrite.deny ?? 0n).bitfield) {
      throw new Error("Published channel permissions were not applied");
    }
  }
}

function safeName(value) {
  return String(value).replace(/[`\r\n<>@]/g, " ").slice(0, 80);
}

function connectModal(baseUrl) {
  const url = new TextInputBuilder().setCustomId("url").setLabel("Pterodactyl panel URL")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(250);
  if (baseUrl) url.setValue(baseUrl);
  if (!baseUrl) url.setValue("https://");
  const key = new TextInputBuilder().setCustomId("key").setLabel("Client API key (never shown in replies)")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
  return new ModalBuilder().setCustomId("bridge:connect").setTitle("Connect Pterodactyl")
    .addComponents(new ActionRowBuilder().addComponents(url), new ActionRowBuilder().addComponents(key));
}

function tokenModal(nonce) {
  const token = new TextInputBuilder().setCustomId("token").setLabel("Satisfactory game API token")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
  return new ModalBuilder().setCustomId(`bridge:token:${nonce}`).setTitle("Enable Satisfactory monitoring")
    .addComponents(new ActionRowBuilder().addComponents(token));
}

export class BridgeAdminController {
  constructor({ discordBridge, configStore, config, pterodactylClient, syncService, guildId, onConfigurationChanged = null, logger = null }) {
    Object.assign(this, { discordBridge, configStore, config, pterodactylClient, syncService, guildId, onConfigurationChanged, logger });
    this.pending = new Map();
    this.discovery = null;
    this.busy = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.discordBridge.onInteraction((interaction) => this.handleInteraction(interaction));
  }

  #authorized(interaction) {
    try {
      return interaction.guildId === (this.config.discord.guildId ?? this.guildId) && canRunBridgeSetup(interaction, this.config.discord.bridgeAdminRoleId ?? this.config.discord.serverAdminRoleId)
        && interaction.channelId === this.configStore.getAdminChannelId(this.config.discord.guildId ?? this.guildId);
    } catch { return false; }
  }

  async #reply(interaction, content, extra = {}) {
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content, ...extra });
    return interaction.reply({ content, flags: ephemeral, ...extra });
  }

  async handleInteraction(interaction) {
    const isCommand = interaction.isChatInputCommand?.() && interaction.commandName === "bridge";
    const isOurs = interaction.customId?.startsWith("bridge:");
    const isAutocomplete = interaction.isAutocomplete?.() && interaction.commandName === "bridge";
    if (!isCommand && !isOurs && !isAutocomplete) return;
    const subcommand = isCommand || isAutocomplete ? interaction.options.getSubcommand(false) : null;
    if (subcommand === "setup") return;
    if (!this.#authorized(interaction)) {
      if (isAutocomplete) await interaction.respond([]);
      else await this.#reply(interaction, "Use this command as the guild owner, an administrator, or a member with the configured bridge administration role in the saved #bridge-admin channel.");
      return;
    }
    try {
      for (const [id, pending] of this.pending) if (Date.now() - pending.at >= 10 * 60_000) this.pending.delete(id);
      if (isAutocomplete) return await this.#autocomplete(interaction);
      if (interaction.isModalSubmit?.()) return await this.#modal(interaction);
      if (interaction.isButton?.()) return await this.#button(interaction);
      if (subcommand === "connect") return await interaction.showModal(connectModal(this.config.pterodactyl.baseUrl));
      if (subcommand === "servers") return await this.#servers(interaction);
      if (subcommand === "import") return await this.#import(interaction);
      if (subcommand === "activate") return await this.#activateCommand(interaction);
      if (subcommand === "publish") return await this.#publish(interaction);
    } catch {
      this.logger?.error("Bridge administration operation failed; credentials and panel response were omitted.");
      if (isAutocomplete) {
        try { await interaction.respond([]); } catch {}
        return;
      }
      try { await this.#reply(interaction, "Bridge operation failed. Check the bot log and persistent storage, then retry."); } catch {}
    }
  }

  async #discover() {
    if (this.discovery && Date.now() - this.discovery.at < 60_000) return this.discovery.servers;
    const servers = await this.pterodactylClient.listAccessibleServers();
    this.discovery = { at: Date.now(), servers };
    return servers;
  }

  #linkedIds() {
    return new Set([
      ...this.configStore.document.settings.servers.map((server) => server.pterodactylServerId),
      ...this.configStore.getManagedServers().map((server) => server.pterodactylServerId)
    ]);
  }

  #isLinked(discovered, linked = this.#linkedIds()) {
    return [discovered.identifier, discovered.uuid, discovered.legacyIdentifier].some((id) => id && linked.has(id));
  }

  async #autocomplete(interaction) {
    const choices = interaction.options.getSubcommand(false) === "activate" || interaction.options.getSubcommand(false) === "publish"
      ? this.configStore.getManagedServers().filter((server) => interaction.options.getSubcommand(false) === "activate" ? !server.active : server.active && !server.published)
        .map((server) => ({ identifier: server.pterodactylServerId, name: server.name }))
      : await this.#discover();
    const query = String(interaction.options.getFocused() ?? "").toLowerCase();
    await interaction.respond(choices.filter((server) => `${server.name} ${server.identifier}`.toLowerCase().includes(query))
      .slice(0, 25).map((server) => ({ name: `${safeName(server.name)} (${server.identifier})`.slice(0, 100), value: server.identifier })));
  }

  async #servers(interaction) {
    await this.#defer(interaction);
    const servers = await this.#discover();
    const page = interaction.options.getInteger("page") ?? 1;
    const count = Math.max(1, Math.ceil(servers.length / 10));
    if (page > count) return this.#reply(interaction, `Only ${count} page(s) are available.`);
    const linked = this.#linkedIds();
    const lines = servers.slice((page - 1) * 10, page * 10).map((server) =>
      `• ${safeName(server.name)} — \`${server.identifier}\` ${this.#isLinked(server, linked) ? "(linked)" : "(available)"}`);
    await this.#reply(interaction, `Accessible servers, page ${page}/${count}:\n${lines.join("\n") || "None"}\nUse /bridge import to save an available server.`, { allowedMentions: { parse: [] } });
  }

  async #import(interaction) {
    await this.#defer(interaction);
    const id = interaction.options.getString("server", true);
    const game = interaction.options.getString("game", true);
    const activate = interaction.options.getBoolean("activate") === true;
    const channel = interaction.options.getChannel("channel");
    if (channel && !activate) return this.#reply(interaction, "Choose activate: true before binding a channel.");
    const discovered = (await this.#discover()).find((server) => server.identifier === id);
    if (!discovered) return this.#reply(interaction, "That server is not accessible through the configured Client API key.");
    if (this.#isLinked(discovered)) return this.#reply(interaction, "That server is already linked; no duplicate was created.");
    const server = {
      name: discovered.name, pterodactylServerId: id, pterodactylUuid: discovered.uuid, game: { type: game, chatCommandTemplate: getDefaultChatCommandTemplate(game) },
      chatRelay: Boolean(getDefaultChatCommandTemplate(game)),
      active: false, published: false, channelManaged: false, discordChannelId: null,
      archived: false
    };
    this.configStore.addManagedServer(server);
    if (!activate) return this.#reply(interaction, `Saved ${safeName(server.name)} as inactive. It is hidden and has no Discord server channel.`);
    await this.#prepareActivation(interaction, server, channel);
  }

  async #activateCommand(interaction) {
    await this.#defer(interaction);
    const id = interaction.options.getString("server", true);
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === id);
    if (!server) return this.#reply(interaction, "Choose a saved imported server.");
    const savedChannel = await fetchSavedServerChannel(interaction.guild, server.discordChannelId);
    if (server.active && savedChannel && !server.unavailable && !server.archived && !server.deleted) {
      return this.#reply(interaction, "Monitoring is already enabled and the linked channel exists. Use Publish status & channel to list this server on the main status page.");
    }
    if (!await canAccessServer(this.pterodactylClient, server.pterodactylServerId)) return this.#reply(interaction, "This server is unavailable through the current key. Check panel access before activation.");
    const channel = interaction.options.getChannel("channel") ?? savedChannel;
    await this.#prepareActivation(interaction, server, channel);
  }

  async #prepareActivation(interaction, server, channel, token = null) {
    if (!this.config.discord.statusChannelId) return this.#reply(interaction, "Choose a status channel in bridge setup before activation.");
    if (this.busy) return this.#reply(interaction, "Another bridge change is in progress. Try again shortly.");
    if (!channel) channel = await fetchSavedServerChannel(interaction.guild, server.discordChannelId);
    if (channel && !this.#validChannel(channel, server.pterodactylServerId)) return this.#reply(interaction, "That channel cannot be bound to this server.");
    if (server.game.type === "satisfactory" && !server.game.apiToken && !token) {
      const nonce = randomUUID();
      this.pending.set(nonce, { kind: "token", userId: interaction.user.id, serverId: server.pterodactylServerId, channelId: channel?.id ?? null, at: Date.now() });
      // A modal must be opened from an unacknowledged interaction. The import and
      // activate commands have already deferred, so use an ephemeral button.
      return this.#reply(interaction, "Satisfactory needs its game API token before activation.", {
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bridge:token-button:${nonce}`).setLabel("Enter game API token").setStyle(ButtonStyle.Primary))]
      });
    }
    if (channel) {
      const visible = Boolean(channel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
      const nonce = randomUUID();
      this.pending.set(nonce, { kind: "confirm", userId: interaction.user.id, serverId: server.pterodactylServerId, channelId: channel.id, token, at: Date.now() });
      return this.#reply(interaction, `Start monitoring ${safeName(server.name)} using <#${channel.id}> as its linked channel. This does not list the server on the main status page. Existing channel permissions stay unchanged.`, {
        embeds: [{ title: "Confirm monitoring & linked channel", color: 0x5865f2,
          fields: [
            { name: "Server", value: safeName(server.name) },
            { name: "Linked channel", value: `${server.discordChannelId ? `<#${server.discordChannelId}>` : "Not linked"} → <#${channel.id}>${server.discordChannelId === channel.id ? " (same channel)" : ""}` },
            { name: "Monitoring", value: `${server.unavailable ? "Paused: unavailable" : server.archived ? "Archived" : server.deleted ? "Marked deleted" : server.active ? "Active" : "Inactive"} → Active`, inline: true },
            { name: "Main status page", value: `${server.published ? "Listed" : "Not listed"} → Not listed (use Publish status & channel separately)`, inline: true },
            { name: "Channel access", value: `${visible ? "Visible" : "Hidden"} to @everyone; existing permissions retained.` },
            { name: "Actions", value: "Check panel access, save this binding, and start monitoring. No server start/stop command is sent." },
            ...((server.unavailable || server.archived || server.deleted) ? [{ name: "Record recovery", value: "Clear unavailable, archived, and deleted markers." }] : [])
          ], footer: { text: "Only your confirmation applies these changes" } }],
        allowedMentions: { parse: [] },
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bridge:confirm:${nonce}`).setLabel("Start monitoring with this channel").setStyle(ButtonStyle.Primary))]
      });
    }
    if (!interaction.deferred && !interaction.replied) await this.#defer(interaction);
    return this.#performActivation(interaction, server, null, token);
  }

  #validChannel(channel, serverId = null) {
    return channel.type === ChannelType.GuildText
      && ![this.config.discord.statusChannelId, this.config.discord.logChannelId, this.configStore.getAdminChannelId(this.guildId)]
        .includes(channel.id)
      && !this.config.servers.some((server) => server.pterodactylServerId !== serverId && server.discordChannelId === channel.id);
  }

  async #defer(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: ephemeral });
  }

  async #modal(interaction) {
    if (interaction.customId === "bridge:connect") return this.#connect(interaction);
    if (!interaction.customId.startsWith("bridge:token:")) return;
    const nonce = interaction.customId.slice("bridge:token:".length);
    const pending = this.#takePending(nonce, interaction.user.id, "token");
    if (!pending) return this.#reply(interaction, "That activation request expired. Run /bridge activate again.");
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === pending.serverId);
    if (!server) return this.#reply(interaction, "That server record is no longer available.");
    await this.#defer(interaction);
    if (server.active && await fetchSavedServerChannel(interaction.guild, server.discordChannelId)) return this.#reply(interaction, "That server is already active and its saved channel still exists.");
    const channel = await fetchSavedServerChannel(interaction.guild, pending.channelId);
    await this.#prepareActivation(interaction, server, channel, interaction.fields.getTextInputValue("token"));
  }

  #takePending(nonce, userId, kind) {
    const pending = this.pending.get(nonce);
    if (!pending || pending.kind !== kind || pending.userId !== userId) return null;
    this.pending.delete(nonce);
    return Date.now() - pending.at < 10 * 60_000 ? pending : null;
  }

  async #button(interaction) {
    const [, kind, nonce] = interaction.customId.split(":");
    if (kind === "token-button") {
      const pending = this.pending.get(nonce);
      if (!pending || pending.userId !== interaction.user.id || Date.now() - pending.at >= 10 * 60_000) return this.#reply(interaction, "That activation request expired.");
      return interaction.showModal(tokenModal(nonce));
    }
    if (kind === "publish-confirm") {
      const pending = this.#takePending(nonce, interaction.user.id, "publish");
      if (!pending) return this.#reply(interaction, "That publication confirmation expired.");
      interaction.options = { getString: () => pending.serverId };
      interaction.bridgePublishConfirmed = true;
      return this.#publish(interaction);
    }
    if (kind !== "confirm") return;
    const pending = this.#takePending(nonce, interaction.user.id, "confirm");
    if (!pending) return this.#reply(interaction, "That confirmation expired. Run /bridge activate again.");
    await this.#defer(interaction);
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === pending.serverId);
    const channel = await fetchSavedServerChannel(interaction.guild, pending.channelId);
    if (!server || (channel && !this.#validChannel(channel, server.pterodactylServerId))
      || (!channel && pending.channelId !== server.discordChannelId)) return this.#reply(interaction, "The server or channel changed. Run /bridge activate again.");
    if (server.active && await fetchSavedServerChannel(interaction.guild, server.discordChannelId)) return this.#reply(interaction, "The server is already active and its saved channel still exists.");
    await this.#defer(interaction);
    await this.#performActivation(interaction, server, channel, pending.token);
  }

  async #connect(interaction) {
    await this.#defer(interaction);
    const url = interaction.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
    const key = interaction.fields.getTextInputValue("key").trim();
    let parsed;
    try { parsed = new URL(url); } catch { return this.#reply(interaction, "Enter a valid panel URL."); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return this.#reply(interaction, "Use an HTTP(S) panel URL without credentials, query, or fragment.");
    if (this.config.pterodactyl.baseUrl && url !== this.config.pterodactyl.baseUrl.replace(/\/+$/, "") && this.#linkedIds().size) return this.#reply(interaction, "Migrate or disable linked records before replacing the panel URL. The current connection was kept.");
    if (!key) return this.#reply(interaction, "A Client API key is required.");
    const candidate = new PterodactylClient({ ...this.config.pterodactyl, baseUrl: url, apiKey: key });
    let discovered;
    try {
      discovered = await candidate.listAccessibleServers();
      const ids = new Set(discovered.flatMap((server) => [server.identifier, server.uuid, server.legacyIdentifier].filter(Boolean)));
      const managed = this.configStore.getManagedServers();
      if ([...this.configStore.document.settings.servers, ...managed.filter((server) => server.active && !server.archived && !server.deleted && !server.unavailable)].some((server) => !ids.has(server.pterodactylServerId))) {
        return this.#reply(interaction, "The key cannot see every linked server. The current connection was kept.");
      }
      await Promise.all(this.config.servers.filter((server) => server.active !== false && !server.archived && !server.deleted && !server.unavailable).map((server) => candidate.getServerResources(server.pterodactylServerId)));
    } catch {
      return this.#reply(interaction, "Connection validation failed or the key lacks access to a linked server. The current connection was kept.");
    }
    this.configStore.setConnectionKey(key, url);
    this.config.pterodactyl.baseUrl = url;
    this.pterodactylClient.baseUrl = url;
    this.config.pterodactyl.apiKey = key;
    this.pterodactylClient.apiKey = key;
    this.pterodactylClient.websocketCredentialCache.clear();
    this.discovery = { at: Date.now(), servers: discovered };
    await this.onConfigurationChanged?.();
    await this.#reply(interaction, `Connection validated. ${discovered.length} accessible server(s); key stored privately.`);
  }

  async #performActivation(interaction, server, existingChannel, token) {
    if (this.busy) return this.#reply(interaction, "Another bridge change is in progress. Try again shortly.");
    this.busy = true;
    let created = null;
    let persisted = false;
    try {
      if (server.game.type === "satisfactory" && !server.game.apiToken && !token) return this.#reply(interaction, "Satisfactory needs a game API token.");
      if (!await canAccessServer(this.pterodactylClient, server.pterodactylServerId)) return this.#reply(interaction, "Server access changed. Check panel access before activation.");
      const normalized = normalizeServer({ ...server, active: true, discordChannelId: existingChannel?.id ?? "pending",
        game: { ...server.game, apiToken: token ?? server.game.apiToken } });
      await hydrateServerNetworkConfig({ config: { servers: [normalized] }, pterodactylClient: this.pterodactylClient, logger: this.logger });
      if (!existingChannel) {
        const retained = await fetchSavedServerChannel(interaction.guild, server.discordChannelId);
        if (retained) {
          // A binding may reappear during panel validation; reuse it only after confirmation.
          this.busy = false;
          return this.#prepareActivation(interaction, server, retained, token);
        }
      }
      const category = existingChannel ? null : await ensureBridgeCategory({ guild: interaction.guild, configStore: this.configStore, botUserId: interaction.client.user.id, actorId: interaction.user.id });
      const channel = existingChannel ?? (created = await interaction.guild.channels.create({
        name: `server-${server.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "server"}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: interaction.guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          ...Array.from(new Set([interaction.client.user.id, interaction.user.id, interaction.guild.ownerId])).map((id) => ({
            id, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          }))
        ]
      }));
      const changes = { active: true, unavailable: false, deleted: false, archived: false, published: false, discordChannelId: channel.id, channelManaged: existingChannel ? server.channelManaged === true && server.discordChannelId === channel.id : Boolean(created),
        publicAddress: normalized.publicAddress, publicPort: normalized.publicPort,
        game: { ...server.game, ...(normalized.game.apiUrl ? { apiUrl: normalized.game.apiUrl } : {}) } };
      this.configStore.updateManagedServer(server.pterodactylServerId, changes, { apiToken: token });
      persisted = true;
      normalized.discordChannelId = channel.id;
      normalized.channelManaged = Boolean(created);
      const normalizedGame = normalized.game;
      Object.assign(normalized, changes);
      normalized.game = normalizedGame;
      const previousIndex = this.config.servers.findIndex((entry) => entry.pterodactylServerId === server.pterodactylServerId);
      if (previousIndex >= 0) this.config.servers.splice(previousIndex, 1, normalized);
      else this.config.servers.push(normalized);
      this.syncService.onConfigReloaded();
      try { this.syncService.requestSync?.({ force: true, reason: "bridge-import" }); }
      catch { this.logger?.error("Initial poll for an imported server failed; periodic polling will retry."); }
      await this.#reply(interaction, `Monitoring enabled for ${safeName(server.name)}. Linked channel: <#${channel.id}>. Main status page: not listed. Use Publish status & channel when ready.`, { components: [], allowedMentions: { parse: [] } });
    } catch {
      if (created && !persisted) {
        try { await created.delete(); } catch { this.logger?.error("Could not remove an unused private server channel."); }
      }
      await this.#reply(interaction, persisted
        ? "Monitoring settings were saved, but monitoring could not resume. Restart the bot to retry."
        : "Could not enable monitoring. Check linked-channel permissions and persistent storage, then retry.", { components: [] });
    } finally { this.busy = false; }
  }

  async #publish(interaction) {
    await this.#defer(interaction);
    const id = interaction.options.getString("server", true);
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === id);
    if (!server || !getAdministrationState(server).canPublish) return this.#reply(interaction, "Choose a monitored server to publish or repair its linked-channel access.");
    if (!server.published && this.config.servers.filter((entry) => !entry.archived && entry.published !== false).length >= MAX_STATUS_PANEL_SERVERS) {
      return this.#reply(interaction, `The shared live panel is full (${MAX_STATUS_PANEL_SERVERS} servers). Nothing was published.`);
    }
    const channel = await interaction.guild.channels.fetch(server.discordChannelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText) return this.#reply(interaction, "The saved server channel is unavailable; nothing was published.");
    if (!this.config.discord.publicCategoryId || !this.config.discord.linkedChannelRoleId) {
      return this.#reply(interaction, "Choose Categories / access role in Bridge administration before publishing. Select the private category, public or semi-public destination, and linked-channel access role.");
    }
    if (!interaction.bridgePublishConfirmed) {
      const nonce = randomUUID();
      this.pending.set(nonce, { kind: "publish", userId: interaction.user.id, serverId: id, at: Date.now() });
      return this.#reply(interaction, `Publish ${safeName(server.name)} to the main status page in <#${this.config.discord.statusChannelId}>? Its linked channel <#${channel.id}> will be checked in <#${this.config.discord.publicCategoryId}> for access by <@&${this.config.discord.linkedChannelRoleId}> and the bot. Incorrect category or permissions will be corrected; other individual and role grants will be replaced. Already-correct settings stay in place.`, { components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bridge:publish-confirm:${nonce}`).setLabel("Publish status & channel").setStyle(ButtonStyle.Primary))] });
    }
    if (this.busy) return this.#reply(interaction, "Another bridge change is in progress. Try again shortly.");
    this.busy = true;
    const mutations = [];
    let persisted = false;
    try {
      const publicCategory = await ensurePublicBridgeCategory({ guild: interaction.guild, configStore: this.configStore });
      const requiredRole = this.config.discord.linkedChannelRoleId
        ? await interaction.guild.roles.fetch(this.config.discord.linkedChannelRoleId) : null;
      if (!requiredRole || requiredRole.id === interaction.guild.id || requiredRole.id === interaction.guild.roles.everyone.id || requiredRole.managed) {
        throw new Error("Select an existing unmanaged linked-channel role other than everyone");
      }
      const botAccess = {
        id: interaction.client.user.id, type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
      };
      const options = { guild: interaction.guild, configStore: this.configStore,
        botUserId: interaction.client.user.id, actorId: interaction.user.id };
      const planned = [];
      planned.push({ channel, before: publicationSnapshot(channel, options),
          after: { parent: publicCategory.id, permissionOverwrites: [
            { id: interaction.guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
            { id: requiredRole.id, type: OverwriteType.Role,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            botAccess
          ] } });
      if (this.config.discord.statusChannelManaged) {
        const statusChannel = await interaction.guild.channels.fetch(this.config.discord.statusChannelId);
        if (!statusChannel || statusChannel.type !== ChannelType.GuildText || statusChannel.id === channel.id) throw new Error("Status channel missing or overlaps server channel");
        planned.push({ channel: statusChannel, before: publicationSnapshot(statusChannel, options),
          after: { parent: publicCategory.id,
            permissionOverwrites: [...copyChannelOverwrites(publicCategory).filter((overwrite) => overwrite.id !== botAccess.id), botAccess] } });
      }
      let linkedAlreadyCorrect = false;
      for (const change of planned) {
        for (const target of [change.channel, publicCategory]) {
          if (typeof target.permissionsFor !== "function") continue;
          const access = target.permissionsFor(interaction.client.user.id);
          if (!access?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
            throw new Error("Bot needs View Channel, Manage Channels and Manage Roles on both channels and the destination category");
          }
        }
        const current = await interaction.guild.channels.fetch(change.channel.id, { force: true });
        let alreadyCorrect = false;
        try {
          verifyPublicationChannel(current, change.after);
          alreadyCorrect = change.channel.id !== channel.id || typeof current.permissionsFor !== "function"
            || current.permissionsFor(requiredRole)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]) === true;
        } catch { /* Differences are corrected and verified below. */ }
        if (change.channel.id === channel.id) linkedAlreadyCorrect = alreadyCorrect;
        if (!alreadyCorrect) {
          mutations.push(change);
          await change.channel.edit(change.after);
        }
        const verified = await interaction.guild.channels.fetch(change.channel.id, { force: true });
        verifyPublicationChannel(verified, change.after);
        if (change.channel.id === channel.id && typeof verified.permissionsFor === "function"
          && !verified.permissionsFor(requiredRole)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) {
          throw new Error("Linked role cannot view, send messages and read history after publication");
        }
      }
      this.configStore.updateManagedServer(id, { published: true });
      persisted = true;
      const runtime = this.config.servers.find((entry) => entry.pterodactylServerId === id);
      if (runtime) runtime.published = true;
      try { this.syncService.requestSync?.({ force: true, reason: "bridge-publish" }); }
      catch { this.logger?.error("The first published status refresh failed; periodic polling will retry."); }
      await this.#reply(interaction, `Listed ${safeName(server.name)} on the main status page in <#${this.config.discord.statusChannelId}>. Its linked channel <#${channel.id}> ${linkedAlreadyCorrect ? "is already configured correctly" : "was configured"} in <#${publicCategory.id}> for <@&${requiredRole.id}>. Its category, permissions and linked-role access were verified.${this.config.discord.statusChannelManaged ? ` The managed status channel is in <#${publicCategory.id}>.` : ""}`, { allowedMentions: { parse: [] } });
    } catch {
      if (!persisted) {
        for (const change of mutations.reverse()) {
          try { await change.channel.edit(change.before); }
          catch { this.logger?.error("Could not restore private channel permissions after publication failed; administrator recovery required."); }
        }
      }
      await this.#reply(interaction, "Publishing failed. Check the selected public category, linked role, bot permissions, and persistent storage, then retry.");
    } finally { this.busy = false; }
  }
}
