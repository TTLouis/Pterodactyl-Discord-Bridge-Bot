import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ApplicationCommandOptionType, ButtonBuilder, ButtonStyle,
  ChannelType, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle
} from "discord.js";
import { canRunBridgeSetup } from "./bridge-setup-controller.js";
import { normalizeServer } from "../lib/config.js";
import { MAX_STATUS_PANEL_SERVERS } from "../lib/formatters.js";
import { PterodactylClient } from "./pterodactyl-client.js";
import { hydrateServerNetworkConfig } from "./server-network-config.js";

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
      { name: "Factorio", value: "factorio" }, { name: "Minecraft", value: "minecraft" }, { name: "Satisfactory", value: "satisfactory" }
    ] },
    { type: ApplicationCommandOptionType.Boolean, name: "activate", description: "Start monitoring now (default: no)", required: false },
    channelOption
  ] },
  { type: ApplicationCommandOptionType.Subcommand, name: "activate", description: "Start monitoring a saved inactive server", options: [serverOption, channelOption] },
  { type: ApplicationCommandOptionType.Subcommand, name: "publish", description: "Show an active server on the shared panel and reveal its new channel", options: [serverOption] }
];

function safeName(value) {
  return String(value).replace(/[`\r\n<>@]/g, " ").slice(0, 80);
}

function connectModal(baseUrl) {
  const url = new TextInputBuilder().setCustomId("url").setLabel("Pterodactyl panel URL")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(250).setValue(baseUrl);
  const key = new TextInputBuilder().setCustomId("key").setLabel("Client API key (never shown in replies)")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
  return new ModalBuilder().setCustomId("bridge:connect").setTitle("Connect Pterodactyl")
    .addComponents(new ActionRowBuilder().addComponents(url), new ActionRowBuilder().addComponents(key));
}

function tokenModal(nonce) {
  const token = new TextInputBuilder().setCustomId("token").setLabel("Satisfactory game API token")
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
  return new ModalBuilder().setCustomId(`bridge:token:${nonce}`).setTitle("Activate Satisfactory")
    .addComponents(new ActionRowBuilder().addComponents(token));
}

export class BridgeAdminController {
  constructor({ discordBridge, configStore, config, pterodactylClient, syncService, guildId, logger = null }) {
    Object.assign(this, { discordBridge, configStore, config, pterodactylClient, syncService, guildId, logger });
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
      return interaction.guildId === this.guildId && canRunBridgeSetup(interaction)
        && interaction.channelId === this.configStore.getAdminChannelId(this.guildId);
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
      else await this.#reply(interaction, "Use this command as the guild owner or an administrator in the saved #bridge-admin channel.");
      return;
    }
    try {
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
    await interaction.deferReply({ flags: ephemeral });
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
    await interaction.deferReply({ flags: ephemeral });
    const id = interaction.options.getString("server", true);
    const game = interaction.options.getString("game", true);
    const activate = interaction.options.getBoolean("activate") === true;
    const channel = interaction.options.getChannel("channel");
    if (channel && !activate) return this.#reply(interaction, "Choose activate: true before binding a channel.");
    const discovered = (await this.#discover()).find((server) => server.identifier === id);
    if (!discovered) return this.#reply(interaction, "That server is not accessible through the configured Client API key.");
    if (this.#isLinked(discovered)) return this.#reply(interaction, "That server is already linked; no duplicate was created.");
    const server = {
      name: discovered.name, pterodactylServerId: id, pterodactylUuid: discovered.uuid, game: { type: game },
      active: false, published: false, channelManaged: false, discordChannelId: null,
      archived: false
    };
    this.configStore.addManagedServer(server);
    if (!activate) return this.#reply(interaction, `Saved ${safeName(server.name)} as inactive. It is hidden and has no Discord server channel.`);
    await this.#prepareActivation(interaction, server, channel);
  }

  async #activateCommand(interaction) {
    await interaction.deferReply({ flags: ephemeral });
    const id = interaction.options.getString("server", true);
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === id);
    if (!server || server.active) return this.#reply(interaction, "Choose a saved inactive imported server.");
    await this.#prepareActivation(interaction, server, interaction.options.getChannel("channel"));
  }

  async #prepareActivation(interaction, server, channel, token = null) {
    if (this.busy) return this.#reply(interaction, "Another bridge change is in progress. Try again shortly.");
    if (channel && !this.#validChannel(channel)) return this.#reply(interaction, "That channel cannot be bound to this server.");
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
      return this.#reply(interaction, `Bind ${safeName(server.name)} to <#${channel.id}>? This channel is currently ${visible ? "visible" : "hidden"} to @everyone. Binding will not change its permissions.`, {
        allowedMentions: { parse: [] },
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bridge:confirm:${nonce}`).setLabel("Confirm activation").setStyle(ButtonStyle.Primary))]
      });
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: ephemeral });
    return this.#performActivation(interaction, server, null, token);
  }

  #validChannel(channel) {
    return channel.type === ChannelType.GuildText
      && ![this.config.discord.statusChannelId, this.config.discord.logChannelId, this.configStore.getAdminChannelId(this.guildId)]
        .includes(channel.id)
      && !this.config.servers.some((server) => server.discordChannelId === channel.id);
  }

  async #modal(interaction) {
    if (interaction.customId === "bridge:connect") return this.#connect(interaction);
    if (!interaction.customId.startsWith("bridge:token:")) return;
    const nonce = interaction.customId.slice("bridge:token:".length);
    const pending = this.#takePending(nonce, interaction.user.id, "token");
    if (!pending) return this.#reply(interaction, "That activation request expired. Run /bridge activate again.");
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === pending.serverId);
    if (!server || server.active) return this.#reply(interaction, "That server is no longer inactive.");
    const channel = pending.channelId ? await interaction.guild.channels.fetch(pending.channelId) : null;
    await this.#prepareActivation(interaction, server, channel, interaction.fields.getTextInputValue("token"));
  }

  #takePending(nonce, userId, kind) {
    const pending = this.pending.get(nonce);
    this.pending.delete(nonce);
    return pending?.kind === kind && pending.userId === userId && Date.now() - pending.at < 10 * 60_000 ? pending : null;
  }

  async #button(interaction) {
    const [, kind, nonce] = interaction.customId.split(":");
    if (kind === "token-button") {
      const pending = this.pending.get(nonce);
      if (!pending || pending.userId !== interaction.user.id || Date.now() - pending.at >= 10 * 60_000) return this.#reply(interaction, "That activation request expired.");
      return interaction.showModal(tokenModal(nonce));
    }
    if (kind !== "confirm") return;
    const pending = this.#takePending(nonce, interaction.user.id, "confirm");
    if (!pending) return this.#reply(interaction, "That confirmation expired. Run /bridge activate again.");
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === pending.serverId);
    const channel = await interaction.guild.channels.fetch(pending.channelId);
    if (!server || server.active || !channel || !this.#validChannel(channel)) return this.#reply(interaction, "The server or channel changed. Run /bridge activate again.");
    await interaction.deferReply({ flags: ephemeral });
    await this.#performActivation(interaction, server, channel, pending.token);
  }

  async #connect(interaction) {
    await interaction.deferReply({ flags: ephemeral });
    const url = interaction.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
    const key = interaction.fields.getTextInputValue("key").trim();
    if (url !== this.config.pterodactyl.baseUrl.replace(/\/+$/, "")) return this.#reply(interaction, "This patch supports only the panel URL already configured in servers.json.");
    if (!key) return this.#reply(interaction, "A Client API key is required.");
    const candidate = new PterodactylClient({ ...this.config.pterodactyl, apiKey: key });
    let discovered;
    try {
      discovered = await candidate.listAccessibleServers();
      const ids = new Set(discovered.flatMap((server) => [server.identifier, server.uuid, server.legacyIdentifier].filter(Boolean)));
      const managed = this.configStore.getManagedServers();
      if ([...this.configStore.document.settings.servers, ...managed].some((server) => !ids.has(server.pterodactylServerId))) {
        return this.#reply(interaction, "The key cannot see every linked server. The current connection was kept.");
      }
      await Promise.all(this.config.servers.map((server) => candidate.getServerResources(server.pterodactylServerId)));
    } catch {
      return this.#reply(interaction, "Connection validation failed or the key lacks access to a linked server. The current connection was kept.");
    }
    this.configStore.setConnectionKey(key, url);
    this.config.pterodactyl.apiKey = key;
    this.pterodactylClient.apiKey = key;
    this.pterodactylClient.websocketCredentialCache.clear();
    this.discovery = { at: Date.now(), servers: discovered };
    await this.#reply(interaction, `Connection validated. ${discovered.length} accessible server(s); key stored privately.`);
  }

  async #performActivation(interaction, server, existingChannel, token) {
    if (this.busy) return this.#reply(interaction, "Another bridge change is in progress. Try again shortly.");
    this.busy = true;
    let created = null;
    let persisted = false;
    try {
      if (server.game.type === "satisfactory" && !server.game.apiToken && !token) return this.#reply(interaction, "Satisfactory needs a game API token.");
      const normalized = normalizeServer({ ...server, active: true, discordChannelId: existingChannel?.id ?? "pending",
        game: { ...server.game, apiToken: token ?? server.game.apiToken } });
      await hydrateServerNetworkConfig({ config: { servers: [normalized] }, pterodactylClient: this.pterodactylClient, logger: this.logger });
      const channel = existingChannel ?? (created = await interaction.guild.channels.create({
        name: `server-${server.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "server"}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          ...Array.from(new Set([interaction.client.user.id, interaction.user.id, interaction.guild.ownerId])).map((id) => ({
            id, type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          }))
        ]
      }));
      const changes = { active: true, published: false, discordChannelId: channel.id, channelManaged: Boolean(created) };
      this.configStore.updateManagedServer(server.pterodactylServerId, changes, { apiToken: token });
      persisted = true;
      normalized.discordChannelId = channel.id;
      normalized.channelManaged = Boolean(created);
      this.config.servers.push(normalized);
      this.syncService.onConfigReloaded();
      try { await this.syncService.syncOnce({ force: true, reason: "bridge-import" }); }
      catch { this.logger?.error("Initial poll for an imported server failed; periodic polling will retry."); }
      await this.#reply(interaction, `Activated ${safeName(server.name)} in <#${channel.id}>. It remains hidden from the shared status panel.`, { components: [], allowedMentions: { parse: [] } });
    } catch {
      if (created && !persisted) {
        try { await created.delete(); } catch { this.logger?.error("Could not remove an unused private server channel."); }
      }
      await this.#reply(interaction, persisted
        ? "Activation was saved, but the live runtime could not start it. Restart the bot to retry monitoring."
        : "Activation failed. Check channel permissions and persistent storage, then retry.", { components: [] });
    } finally { this.busy = false; }
  }

  async #publish(interaction) {
    await interaction.deferReply({ flags: ephemeral });
    const id = interaction.options.getString("server", true);
    const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === id);
    if (!server?.active || server.published) return this.#reply(interaction, "Choose an active, unpublished imported server.");
    if (this.config.servers.filter((entry) => !entry.archived && entry.published !== false).length >= MAX_STATUS_PANEL_SERVERS) {
      return this.#reply(interaction, `The shared live panel is full (${MAX_STATUS_PANEL_SERVERS} servers). Nothing was published.`);
    }
    const channel = await interaction.guild.channels.fetch(server.discordChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) return this.#reply(interaction, "The saved server channel is unavailable; nothing was published.");
    let revealed = false;
    let persisted = false;
    try {
      if (server.channelManaged) {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: true });
        revealed = true;
      }
      this.configStore.updateManagedServer(id, { published: true });
      persisted = true;
      const runtime = this.config.servers.find((entry) => entry.pterodactylServerId === id);
      if (runtime) runtime.published = true;
      try { await this.syncService.syncOnce({ force: true, reason: "bridge-publish" }); }
      catch { this.logger?.error("The first published status refresh failed; periodic polling will retry."); }
      await this.#reply(interaction, `Published ${safeName(server.name)} on the shared status panel${revealed ? " and revealed its channel" : ""}.`);
    } catch {
      if (revealed && !persisted) {
        try { await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }); } catch {}
      }
      await this.#reply(interaction, "Publishing failed. Check channel permissions and persistent storage, then retry.");
    }
  }
}
