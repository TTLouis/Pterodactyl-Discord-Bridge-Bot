import { orderEditorRows, parseOrderEditor } from "./server-order-editor.js";
import { DiscordRelaySettingsController } from "./relay-settings-controller.js";
import { buildServerSetupCard, buildAdministrationOverview } from "./administration-cards.js";
import { CoreEventBus, CoreEvents } from "../../core/core-events.js";
import { AdministrationConfigurationCoordinator } from "../../core/administration/configuration-coordinator.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags, ModalBuilder, StringSelectMenuBuilder, RoleSelectMenuBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, ApplicationCommandOptionType } from "discord.js";
import { ensureBridgeCategory, privateBridgeOverwrites, assertPrivateBridgeCategory } from "./bridge-category.js";
import { BridgeAdminController } from "./bridge-admin-controller.js";
import { canAccessServer } from "../../core/administration/server-access.js";
import { DiscordCategoryLayout } from "./category-layout.js";
import { canRunBridgeSetup } from "./bridge-setup-controller.js";
import { getConfigPath, loadConfig, normalizeServer } from "../../lib/config.js";

export const GUIDED_ADMIN_COMMANDS = [
  { type: ApplicationCommandOptionType.Subcommand, name: "categories", description: "Choose private/public categories and the linked-channel access role", options: [
    { type: ApplicationCommandOptionType.Channel, name: "private", description: "Private category for setup and unpublished channels", required: true, channel_types: [ChannelType.GuildCategory] },
    { type: ApplicationCommandOptionType.Channel, name: "public", description: "Category for published status and linked channels", required: true, channel_types: [ChannelType.GuildCategory] },
    { type: ApplicationCommandOptionType.Role, name: "linked-role", description: "Role required to view dedicated linked channels", required: true }
  ] },
  { type: ApplicationCommandOptionType.Subcommand, name: "status-channel", description: "Choose or create the public status channel", options: [{ type: ApplicationCommandOptionType.Channel, name: "channel", description: "Existing text channel; omit to create one", channel_types: [ChannelType.GuildText] }] },
  ...["diagnostics", "export"].map((name) => ({ type: ApplicationCommandOptionType.Subcommand, name, description: name === "export" ? "Download configuration without credentials" : "Check bridge health and recovery steps" })),
  { type: ApplicationCommandOptionType.Subcommand, name: "migrate", description: "Back up and migrate legacy servers.json into Discord administration", options: [{ type: ApplicationCommandOptionType.Boolean, name: "confirm", description: "Confirm migration after reviewing conflicts", required: true }] }
];
const privateReply = MessageFlags.Ephemeral;
const label = (value) => String(value).replace(/[`\r\n<>@]/g, " ").slice(0, 80);
const button = (id, text, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(text).setEmoji(emoji).setStyle(style);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
function commandInteraction(interaction, command, values = {}) {
  const overrides = { commandName: "bridge", options: { getSubcommand: () => command, getString: (name) => values[name] ?? null, getBoolean: (name) => values[name] ?? null, getChannel: (name) => values[name] ?? null, getInteger: (name) => values[name] ?? null },
    isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false, isAutocomplete: () => false, isAnySelectMenu: () => false, customId: undefined };
  return new Proxy(interaction, { get(target, name) { if (name in overrides) return overrides[name]; const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }, set(target, name, value) { target[name] = value; return true; } });
}
export { buildServerSetupCard } from "./administration-cards.js";

export class GuidedAdminController extends BridgeAdminController {
  constructor(options) { super(options); this.reconcile = options.reconcile ?? (async () => {}); this.discoveryRefresh = null; this.locked = false; this.stateStore = options.stateStore; this.categoryDrafts = new Map(); this.cardWrites = new Map();
    this.relaySettings = new DiscordRelaySettingsController({ configStore: this.configStore, reply: (...args) => this.reply(...args), audit: (...args) => this.audit(...args) });
    const eventBus = options.eventBus ?? new CoreEventBus();
    this.eventBus = eventBus;
    this.cardDisplayOrder = JSON.stringify([this.config.discord.serverDisplayOrder ?? [], this.config.discord.adminDisplayOrderRevision]);
    this.categoryLayout = new DiscordCategoryLayout({ config: this.config, configStore: this.configStore, botUserId: () => this.discordBridge.client.user.id });
    this.administrationCoordinator = options.administrationCoordinator ?? new AdministrationConfigurationCoordinator({ eventBus, applyRuntime: () => this.reconcile() });
    this.unsubscribeAdministration = eventBus.on(CoreEvents.ADMINISTRATION_CONFIGURATION_CHANGED, async ({ serverId }) => {
      const guild = this.discordBridge.client?.guilds.cache.get(this.config.discord.guildId);
      if (guild) {
        if (this.cardDisplayOrder !== JSON.stringify([this.config.discord.serverDisplayOrder ?? [], this.config.discord.adminDisplayOrderRevision])) { if (this.discoveryRefresh) await this.discoveryRefresh; await this.refreshCards(guild); this.cardDisplayOrder = JSON.stringify([this.config.discord.serverDisplayOrder ?? [], this.config.discord.adminDisplayOrderRevision]); }
        else { await this.refreshChangedCard(guild, serverId); await this.categoryLayout.sync(guild); }
      }
    });
  }
  stop() { clearInterval(this.discoveryTimer); this.discoveryTimer = null; this.unsubscribeAdministration?.(); }
  async ready() {
    const guild = this.discordBridge.client?.guilds.cache.get(this.config.discord.guildId);
    if (guild && this.configStore.available) await this.refreshCards(guild);
    this.discoveryTimer = setInterval(() => {
      const guild = this.discordBridge.client?.guilds.cache.get(this.config.discord.guildId);
      Promise.resolve(guild ? this.refreshCards(guild, { checkAvailability: true }) : null).catch(() => this.logger?.error("Discovery refresh failed; check panel access and storage."));
    }, 300_000);
    this.discoveryTimer.unref?.();
  }
  configurationKey() {
    const { settings, managed, administration } = this.configStore.document;
    return JSON.stringify([settings, managed, administration.guildId, administration.channelId, administration.categoryId, this.configStore.secrets]);
  }
  operationServerId(interaction) {
    const parts = interaction.customId?.split(":") ?? [];
    return parts[1] === "card" ? parts[2] : this.pending.get(parts[2])?.serverId ?? interaction.options?.getString?.("server") ?? null;
  }
  async refreshChangedCard(guild, serverId) {
    if (!serverId) return this.updateOverview(guild);
    const channel = await guild.channels.fetch(this.configStore.getAdminChannelId(guild.id));
    if (channel) await this.upsert(channel, serverId, () => {
      const server = this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === serverId);
      return server ? buildServerSetupCard({ identifier: serverId, name: server.name }, server) : null;
    });
  }
  async applyChangedConfiguration(_guild, serverId) {
    await this.administrationCoordinator.apply(serverId);
  }
  operationDescription(interaction) {
    const parts = interaction.customId?.split(":") ?? [];
    const pending = parts[0] === "bridge" ? this.pending.get(parts[2]) : null;
    const id = parts[1] === "card" ? parts[2] : pending?.serverId ?? interaction.options?.getString?.("server");
    const server = id ? this.configStore.getManagedServers().find((entry) => entry.pterodactylServerId === id) : null;
    const action = parts[1] === "card" ? parts[3] : parts[1] === "guide" ? parts[2] : pending ? pending.kind === "publish" ? "publish" : "activate" : interaction.options?.getSubcommand?.(false) ?? parts[1];
    const descriptions = { activate: "Starting monitoring", confirm: "Starting monitoring", publish: "Publishing status and linked-channel access", settings: "Updating settings", disable: "Disabling monitoring", archive: "Updating archive state", refresh: "Refreshing discovery", relay: "Updating chat relay", "relay-set": "Updating chat relay", "relay-custom-save": "Updating custom relay command", "save-settings": "Updating server settings", connect: "Validating panel connection", import: "Importing server", "status-create": "Creating status channel", "status-channel": "Updating status channel", categories: "Updating channel categories" };
    return `${descriptions[action] ?? "Updating bridge configuration"}${server ? ` for **${label(server.name)}**` : ""}`;
  }
  busyMessage() { return `${this.currentOperation ?? "Refreshing discovery and administration cards"} is in progress. Wait for its result, then retry.`; }
  authorized(interaction) {
    try { return interaction.guildId === this.config.discord.guildId && canRunBridgeSetup(interaction, this.config.discord.bridgeAdminRoleId ?? this.config.discord.serverAdminRoleId) && interaction.channelId === this.configStore.getAdminChannelId(interaction.guildId); } catch { return false; }
  }
  async acknowledge(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: privateReply });
  }
  async reply(interaction, content, extra = {}) {
    return interaction.deferred || interaction.replied ? interaction.editReply({ content, ...extra }) : interaction.reply({ content, flags: privateReply, ...extra });
  }
  async refreshCards(guild, { checkAvailability = false } = {}) {
    if (this.discoveryRefresh) return this.discoveryRefresh;
    const task = this.updateCards(guild, checkAvailability);
    this.discoveryRefresh = task;
    try { const result = await task; await this.categoryLayout.sync(guild); return result; } finally { if (this.discoveryRefresh === task) this.discoveryRefresh = null; }
  }
  async upsert(channel, id, payload) {
    const task = (this.cardWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const current = typeof payload === "function" ? payload() : payload;
      if (!current) return;
      const messageId = this.configStore.getCardMessageId(id);
      if (messageId) {
        try { await channel.messages.edit(messageId, current); return; }
        catch (error) { if (error.code !== 10008) throw error; }
      }
      const message = await channel.send(current);
      this.configStore.setCardMessageId(id, message.id);
    });
    this.cardWrites.set(id, task);
    try { await task; } finally { if (this.cardWrites.get(id) === task) this.cardWrites.delete(id); }
  }
  async updateOverview(guild) {
    const channelId = this.configStore.getAdminChannelId(guild.id);
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return;
    await this.upsert(channel, "overview", buildAdministrationOverview(this.config));
  }
  async updateCards(guild, checkAvailability) {
    const channelId = this.configStore.getAdminChannelId(guild.id);
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId);
    if (!channel) return;
    await this.updateOverview(guild);
    const connected = Boolean(this.config.pterodactyl.baseUrl && this.config.pterodactyl.apiKey);
    if (!connected) return;
    let discovered;
    try { discovered = await this.pterodactylClient.listAccessibleServers(); }
    catch {
      if (checkAvailability && !this.locked) await this.markUnavailable(this.configStore.getManagedServers().filter((server) => server.active));
      await this.upsert(channel, "connection-health", { content: "⚠️ Panel discovery failed. Check the panel URL, Client API access, and connectivity. Servers are not assumed deleted; inspect Diagnostics before reactivation.", components: [], allowedMentions: { parse: [] } });
      return;
    }
    this.discovery = { at: Date.now(), servers: discovered };
    if (this.configStore.getCardMessageId("connection-health")) await this.upsert(channel, "connection-health", { content: "✅ Panel discovery succeeded. Unavailable records need explicit reactivation.", components: [] });
    const identities = new Set(discovered.flatMap((server) => [server.identifier, server.uuid, server.legacyIdentifier].filter(Boolean)));
    if (checkAvailability && !this.locked) await this.markUnavailable(this.configStore.getManagedServers().filter((server) => server.active && !identities.has(server.pterodactylServerId) && !identities.has(server.pterodactylUuid)));
    const managed = this.configStore.getManagedServers();
    const shown = new Set();
    const cards = new Map();
    for (const server of discovered) {
      const saved = managed.find((record) => [server.identifier, server.uuid, server.legacyIdentifier].includes(record.pterodactylServerId) || (record.pterodactylUuid && record.pterodactylUuid === server.uuid));
      const legacy = !saved && this.configStore.document.settings.servers.some((record) => [server.identifier, server.uuid, server.legacyIdentifier].includes(record.pterodactylServerId));
      const id = saved?.pterodactylServerId ?? server.identifier;
      shown.add(id);
      cards.set(id, buildServerSetupCard({ ...server, identifier: id }, this.configStore.getManagedServers().find(record => record.pterodactylServerId === id) ?? saved, legacy));
    }
    for (const saved of managed.filter((record) => !shown.has(record.pterodactylServerId))) cards.set(saved.pterodactylServerId, buildServerSetupCard({ identifier: saved.pterodactylServerId, name: saved.name }, saved));
    const desired = [...new Set([...this.config.servers.map(server => server.pterodactylServerId), ...cards.keys()])].filter(id => cards.has(id));
    await this.cleanOldCards(channel);
    const current = desired.filter(id => this.configStore.getCardMessageId(id)).sort((a, b) => this.configStore.getCardMessageId(a).localeCompare(this.configStore.getCardMessageId(b), undefined, { numeric: true }));
    const reorder = this.config.discord.serverDisplayOrder?.length && (this.cardDisplayOrder !== JSON.stringify([this.config.discord.serverDisplayOrder ?? [], this.config.discord.adminDisplayOrderRevision]) || current.length !== desired.length || desired.some((id, index) => id !== current[index]));
    if (!reorder) { for (const id of desired) await this.upsert(channel, id, cards.get(id)); return; }
    // Stage every replacement before switching bindings and deleting old cards.
    const replacements = {}, staged = [];
    const payloads = new Map([["overview", buildAdministrationOverview(this.config)], ...desired.map(id => [id, cards.get(id)])]);
    for (const [id, payload] of payloads) {
      const replacement = await channel.send(payload);
      try { this.configStore.replaceCardMessages({}, [...(this.configStore.document.administration.pendingCardDeletion ?? []), replacement.id]); }
      catch (error) { await channel.messages.delete(replacement.id).catch(() => {}); throw error; }
      replacements[id] = replacement.id; staged.push(replacement.id);
    }
    const old = Object.keys(replacements).map(id => this.configStore.getCardMessageId(id)).filter(Boolean);
    this.configStore.replaceCardMessages(replacements, [...this.configStore.document.administration.pendingCardDeletion.filter(id => !staged.includes(id)), ...old]);
    await this.cleanOldCards(channel);
    this.cardDisplayOrder = JSON.stringify([this.config.discord.serverDisplayOrder ?? [], this.config.discord.adminDisplayOrderRevision]);
  }
  async cleanOldCards(channel) {
    for (const messageId of [...(this.configStore.document.administration.pendingCardDeletion ?? [])]) {
      try { await channel.messages.delete(messageId); }
      catch (error) { if (error.code !== 10008) throw error; }
      this.configStore.replaceCardMessages({}, this.configStore.document.administration.pendingCardDeletion.filter(id => id !== messageId));
    }
  }
  async markUnavailable(servers) {
    for (const server of servers) {
      this.configStore.updateManagedServer(server.pterodactylServerId, { active: false, unavailable: true });
      this.configStore.recordAudit("server.unavailable", { serverId: server.pterodactylServerId });
    }
    if (servers.length) await this.reconcile();
  }
  async handleInteraction(interaction) {
    const command = interaction.commandName === "bridge" && interaction.isChatInputCommand?.() ? interaction.options.getSubcommand(false) : null;
    const guided = interaction.customId?.startsWith("bridge:guide:") || interaction.customId?.startsWith("bridge:card:") || GUIDED_ADMIN_COMMANDS.some((item) => item.name === command);
    if (command === "setup") return;
    if (!guided) {
      const ours = interaction.commandName === "bridge" || interaction.customId?.startsWith("bridge:");
      if (!ours) return;
      if (!this.authorized(interaction) || interaction.isAutocomplete?.()) return super.handleInteraction(interaction);
      if (this.locked) return this.reply(interaction, this.busyMessage());
      this.locked = true;
      this.currentOperation = this.operationDescription(interaction);
      try {
        const previous = this.configurationKey();
        const serverId = this.operationServerId(interaction);
        await super.handleInteraction(interaction);
        if (previous !== this.configurationKey()) {
          const name = ["connect", "import", "activate", "publish"].includes(command) ? command : "update";
          this.audit(`bridge.${name}`, interaction);
        }
        if (previous !== this.configurationKey()) await this.applyChangedConfiguration(interaction.guild, serverId);
      } catch {
        this.logger?.error("Bridge administration recovery failed; sensitive values omitted.");
        await this.reply(interaction, "The change may be saved. Check Diagnostics and persistent storage before retrying.");
      } finally { this.locked = false; this.currentOperation = null; }
      return;
    }
    if (!this.authorized(interaction)) return this.reply(interaction, "Only the guild owner or an administrator in the saved #bridge-admin channel can use these controls.");
    if (interaction.customId === "bridge:guide:refresh") return this.guideAction(interaction, "refresh");
    if (this.locked) return this.reply(interaction, this.busyMessage());
    this.locked = true;
    this.currentOperation = this.operationDescription(interaction);
    const previous = this.configurationKey();
    const serverId = this.operationServerId(interaction);
    let lifecycleNotice;
    try {
      if (command) await this.guideAction(interaction, command);
      else if (interaction.customId.startsWith("bridge:guide:")) await this.guideAction(interaction, interaction.customId.split(":")[2]);
      else lifecycleNotice = await this.serverAction(interaction);
      if (!interaction.isModalSubmit?.() && !interaction.deferred && !interaction.replied) return;
      if (previous !== this.configurationKey()) await this.applyChangedConfiguration(interaction.guild, serverId);
      if (["server-archived", "server-unarchived"].includes(lifecycleNotice?.kind)) {
        if (lifecycleNotice.stopRequested) {
          try {
            await this.pterodactylClient.setPowerState(lifecycleNotice.server.pterodactylServerId, "stop");
            lifecycleNotice.stopOutcome = "accepted";
          } catch {
            lifecycleNotice.stopOutcome = "failed";
            this.logger?.error("Server archived, but its optional stop request could not be confirmed.");
          }
          try { this.audit("server.archive-stop", interaction, serverId); }
          catch { this.logger?.error("Could not record the optional archive stop audit."); }
          await this.reply(interaction, lifecycleNotice.stopOutcome === "accepted"
            ? "Server archived. Monitoring, chat relay and idle auto-stop are paused. A stop request was accepted; the server may still be shutting down. The linked channel and message history are retained."
            : "Server archived, but the stop request could not be confirmed. Check its power state in Pterodactyl before retrying. The linked channel and message history are retained.", { components: [] });
        }
        const deliveries = await this.eventBus.emitSettled(CoreEvents.SERVER_NOTICE, lifecycleNotice);
        if (deliveries.some((delivery) => delivery.status === "rejected")) {
          this.logger?.error("Archive state saved, but a linked-channel announcement failed.");
          await this.reply(interaction, "Archive state saved and administration updated, but a linked-channel announcement failed. Check channel permissions; the saved change remains applied.", { components: [] });
        }
      }
    } catch {
      this.logger?.error("Guided administration failed; sensitive values omitted.");
      await this.reply(interaction, "Could not complete this change. Check Diagnostics, Discord permissions, and persistent storage; settings already saved will remain available.");
    } finally { this.locked = false; this.currentOperation = null; }
  }
  audit(action, interaction, serverId = null) { this.configStore.recordAudit(action, { actorId: interaction.user.id, serverId }); }
  async guideAction(interaction, action) {
    if (action === "order") {
      const rows = orderEditorRows(this.config.servers);
      if (!rows.length) return this.reply(interaction, "Import servers before setting their display order.");
      const chunks = [];
      for (const item of rows) {
        const line = `${item.label} | ${item.number}`;
        if (!chunks.length || chunks.at(-1).length + line.length + 1 > 4000) chunks.push(line);
        else chunks[chunks.length - 1] += `\n${line}`;
      }
      if (chunks.length > 5) return this.reply(interaction, "Too many servers for Discord's ordering popup.");
      const nonce = randomUUID();
      this.pending.set(nonce, { kind: "order", userId: interaction.user.id, guildId: interaction.guildId, at: Date.now(), rows, fieldCount: chunks.length });
      const modal = new ModalBuilder().setCustomId(`bridge:guide:order-save-${nonce}`).setTitle("Set server display order");
      for (const [index, value] of chunks.entries()) modal.addComponents(row(new TextInputBuilder().setCustomId(`order-${index}`).setLabel("Server name | desired order (1, 2, ...)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(value)));
      return interaction.showModal(modal);
    }
    if (action.startsWith("order-save-")) {
      await this.acknowledge(interaction);
      const nonce = action.slice("order-save-".length), draft = this.pending.get(nonce);
      if (!draft || draft.kind !== "order" || draft.userId !== interaction.user.id || draft.guildId !== interaction.guildId || Date.now() - draft.at > 600_000) return this.reply(interaction, "Ordering popup expired. Open Set display order again.");
      const current = new Set(this.config.servers.map(server => server.pterodactylServerId));
      if (current.size !== draft.rows.length || draft.rows.some(item => !current.has(item.id))) return this.reply(interaction, "The server list changed. Open Set display order again.");
      let order;
      try { order = parseOrderEditor(draft.rows, Array.from({ length: draft.fieldCount }, (_, index) => interaction.fields.getTextInputValue(`order-${index}`)).join("\n")); }
      catch (error) { return this.reply(interaction, `${error.message} Open Set display order to try again.`); }
      this.pending.delete(nonce);
      this.configStore.updateSettings({ discord: { serverDisplayOrder: order, adminDisplayOrderRevision: Date.now(), channelOrderingEnabled: true } });
      this.audit("server.order", interaction);
      return this.reply(interaction, "Order saved. Refreshing admin control cards, status messages and linked channels together.", { components: [] });
    }
    if (action === "arrange") {
      await this.acknowledge(interaction);
      if (this.config.discord.channelOrderingEnabled) await this.categoryLayout.sync(interaction.guild);
      else this.configStore.updateSettings({ discord: { channelOrderingEnabled: true } });
      return this.reply(interaction, "Category arrangement enabled: main status channel, game channels in status order, archive divider, archived channels, then remaining channels. Use Set display order to change the shared display order.");
    }
    if (action === "categories") {
      const privateCategory = interaction.options?.getChannel?.("private");
      const publicCategory = interaction.options?.getChannel?.("public");
      const role = interaction.options?.getRole?.("linked-role");
      if (privateCategory && publicCategory && role) return this.saveCategories(interaction, { privateCategoryId: privateCategory.id, publicCategoryId: publicCategory.id, linkedChannelRoleId: role.id });
      this.categoryDrafts.set(interaction.user.id, { at: Date.now(), guildId: interaction.guildId });
      return this.reply(interaction, "Choose the PRIVATE category first. New channels stay here until publication is confirmed.", { components: [row(new ChannelSelectMenuBuilder().setCustomId("bridge:guide:category-private").setChannelTypes(ChannelType.GuildCategory))] });
    }
    if (["category-private", "category-public", "category-role"].includes(action)) {
      const draft = this.categoryDrafts.get(interaction.user.id);
      if (!draft || draft.guildId !== interaction.guildId || Date.now() - draft.at > 600_000) return this.reply(interaction, "Category selection expired. Open Categories / access role again.");
      await this.acknowledge(interaction);
      if (action === "category-private") {
        const selected = await interaction.guild.channels.fetch(interaction.values[0]);
        assertPrivateBridgeCategory(selected, interaction.guildId);
        draft.privateCategoryId = selected.id;
        return this.reply(interaction, "Choose the PUBLIC category for status updates and published linked channels. Its permissions will remain unchanged.", { components: [row(new ChannelSelectMenuBuilder().setCustomId("bridge:guide:category-public").setChannelTypes(ChannelType.GuildCategory))] });
      }
      if (action === "category-public") {
        const selected = await interaction.guild.channels.fetch(interaction.values[0]);
        if (!draft.privateCategoryId || !selected || selected.type !== ChannelType.GuildCategory || selected.id === draft.privateCategoryId) return this.reply(interaction, "Choose a separate existing public category.");
        draft.publicCategoryId = selected.id;
        return this.reply(interaction, "Choose the role required to view dedicated linked channels. Publishing will not grant @everyone access to those channels.", { components: [row(new RoleSelectMenuBuilder().setCustomId("bridge:guide:category-role"))] });
      }
      if (!draft.privateCategoryId || !draft.publicCategoryId) return this.reply(interaction, "Choose private and public categories first.");
      await this.saveCategories(interaction, { ...draft, linkedChannelRoleId: interaction.values[0] });
      this.categoryDrafts.delete(interaction.user.id);
      return;
    }
    if (action === "connect") return super.handleInteraction(commandInteraction(interaction, "connect"));
    if (action === "status-select") return this.reply(interaction, "Choose the public status channel. Its permissions will stay unchanged.", { components: [row(new ChannelSelectMenuBuilder().setCustomId("bridge:guide:status-bind").setChannelTypes(ChannelType.GuildText))] });
    if (["status-channel", "status-create", "status-bind"].includes(action)) {
      await interaction.deferReply({ flags: privateReply });
      const selected = action === "status-bind" ? await interaction.guild.channels.fetch(interaction.values[0]) : interaction.options?.getChannel?.("channel");
      if (action === "status-bind" && !selected) return this.reply(interaction, "The selected channel is unavailable. Select another channel.");
      if (selected && (selected.type !== ChannelType.GuildText || selected.id === this.configStore.getAdminChannelId(interaction.guildId) || this.config.servers.some((server) => server.discordChannelId === selected.id))) return this.reply(interaction, "Choose a text channel separate from administration and server channels.");
      if (!selected && this.config.discord.statusChannelId) {
        let existing;
        try { existing = await interaction.guild.channels.fetch(this.config.discord.statusChannelId, { force: true }); }
        catch (error) { if (Number(error.code) !== 10003) throw error; }
        if (existing) {
          if (existing.type !== ChannelType.GuildText) throw new Error("Saved status channel is not a text channel");
          return this.reply(interaction, `A status channel is already configured: <#${existing.id}>.`);
        }
      }
      const category = selected ? null : await ensureBridgeCategory({ guild: interaction.guild, configStore: this.configStore, botUserId: interaction.client.user.id, actorId: interaction.user.id });
      const channel = selected ?? await interaction.guild.channels.create({ name: "server-status", type: ChannelType.GuildText, parent: category.id, permissionOverwrites: privateBridgeOverwrites({ guild: interaction.guild, botUserId: interaction.client.user.id, actorId: interaction.user.id }) });
      try { this.configStore.updateSettings({ discord: { statusChannelId: channel.id, statusChannelManaged: !selected } }); }
      catch (error) { if (!selected) await channel.delete(); throw error; }
      this.audit("status-channel.update", interaction);
      return this.reply(interaction, `Status channel saved: <#${channel.id}>. ${selected ? "Its existing permissions were retained." : "It is private inside the bridge category; confirming server publication makes its shared status visible."}`, { components: [] });
    }
    if (action === "refresh") {
      await interaction.deferReply({ flags: privateReply });
      await this.reply(interaction, "Refreshing administration panels and server discovery in the background. Other controls remain available.");
      try {
        await this.refreshCards(interaction.guild, { checkAvailability: true });
        return this.reply(interaction, "Administration panels refreshed. Missing or inaccessible servers are marked unavailable, never automatically deleted.");
      } catch {
        this.logger?.error("Discovery refresh failed; credentials omitted.");
        return this.reply(interaction, "Discovery refresh failed. Check panel access and Discord permissions; other controls remain available.");
      }
    }
    if (action === "export") return this.reply(interaction, "Configuration export excludes credentials. Keep a private data-volume backup for full recovery.", { files: [new AttachmentBuilder(Buffer.from(JSON.stringify(this.configStore.exportRedacted(), null, 2)), { name: "bridge-config-redacted.json" })] });
    if (action === "diagnostics") {
      const bot = interaction.guild.members.me;
      const permissions = bot?.permissions;
      const servers = this.config.servers;
      const problems = servers.filter((server) => server.unavailable || server.deleted);
      return this.reply(interaction, `**Bridge diagnostics**\nStorage: ${this.configStore.available ? "available" : "unavailable — restore the private volume"}\nMode: ${this.config.setupMode ? "setup — connect panel and choose status channel" : "monitoring"}\nPanel: ${this.config.pterodactyl.baseUrl ? "configured" : "not connected"}\nBot Manage Channels: ${permissions?.has?.("ManageChannels") ? "yes" : "missing/unknown — needed to create channels"}\nBot Manage Roles: ${permissions?.has?.("ManageRoles") ? "yes" : "missing/unknown — needed to change channel access"}\nManaged records: ${this.configStore.getManagedServers().length}\nUnavailable/deleted: ${problems.length}\n${problems.map((server) => `${label(server.name)}: ${server.deleted ? "Deleted" : "Unavailable"}; last successful poll ${server.lastSuccessAt ?? this.stateStore?.getServerRuntimeState?.(server.pterodactylServerId)?.lastSnapshot?.lastSeenAt ?? "unknown"}`).join("\n").slice(0, 900)}\nRecovery: check panel/key access and channel permissions, restore damaged private storage, then explicitly reactivate affected records.`, { allowedMentions: { parse: [] } });
    }
    if (action === "display") return this.reply(interaction, "Choose public presentation independently. Administration records and channels are retained.", { components: ["archived", "deleted"].map((kind) => row(new StringSelectMenuBuilder().setCustomId(`bridge:guide:display-${kind}`).setPlaceholder(`${kind}: ${this.config.publicDisplay?.[kind] ?? "marked"}`).addOptions([{ label: "Show marked", value: "marked" }, { label: "Hide publicly", value: "hidden" }]))) });
    if (action.startsWith("display-")) {
      const kind = action.slice(8); const value = interaction.values[0];
      if (!["archived", "deleted"].includes(kind) || !["marked", "hidden"].includes(value)) throw new Error("Invalid display setting");
      this.configStore.updateSettings({ publicDisplay: { [kind]: value } }); this.audit("display.update", interaction);
      return this.reply(interaction, `${kind} records will be ${value === "marked" ? "shown marked" : "hidden"} publicly.`, { components: [] });
    }
    if (action === "migrate") {
      if (interaction.options?.getBoolean?.("confirm") !== true) return this.reply(interaction, "Migration backs up private state and makes Discord settings authoritative. Run /bridge migrate confirm:true to apply; future servers.json edits will no longer administer this installation.");
      await interaction.deferReply({ flags: privateReply });
      const legacyPath = getConfigPath();
      const raw = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      loadConfig({ rawConfig: raw, requireRuntimeTokens: false });
      const result = this.configStore.migrateLegacyConfig(raw, { legacyPath });
      if (!result.migrated) return this.reply(interaction, `Migration kept current configuration. Resolve these conflicts first: ${result.conflicts.map(label).join(", ")}`);
      this.audit("config.migrate", interaction);
      return this.reply(interaction, "Migration complete. A private backup was saved alongside persistent configuration. Discord administration now owns server settings.");
    }
  }
  async saveCategories(interaction, selection) {
    await this.acknowledge(interaction);
    const privateCategory = await interaction.guild.channels.fetch(selection.privateCategoryId);
    const publicCategory = await interaction.guild.channels.fetch(selection.publicCategoryId);
    const role = await interaction.guild.roles.fetch(selection.linkedChannelRoleId);
    assertPrivateBridgeCategory(privateCategory, interaction.guildId);
    if (!publicCategory || publicCategory.type !== ChannelType.GuildCategory || publicCategory.id === privateCategory.id
      || (publicCategory.guildId && publicCategory.guildId !== interaction.guildId)) return this.reply(interaction, "Choose a separate public category in this guild.");
    if (!role || role.id === interaction.guildId || role.managed || (role.guild?.id && role.guild.id !== interaction.guildId)) return this.reply(interaction, "Choose an ordinary guild role for linked-channel access.");
    this.configStore.configureCategories(interaction.guildId, { privateCategoryId: privateCategory.id, publicCategoryId: publicCategory.id, linkedChannelRoleId: role.id });
    this.audit("categories.configure", interaction);
    return this.reply(interaction, `Category routing saved. New channels use <#${privateCategory.id}> privately; published status and linked channels use <#${publicCategory.id}>. Dedicated linked channels require <@&${role.id}>. Category permissions were not changed.`, { components: [], allowedMentions: { parse: [] } });
  }
  async serverAction(interaction) {
    const [, , id, action] = interaction.customId.split(":");
    let server = this.configStore.getManagedServers().find((record) => record.pterodactylServerId === id);
    if (action === "import") {
      const game = interaction.values?.[0];
      if (!["factorio", "minecraft", "satisfactory", "source"].includes(game)) throw new Error("Invalid game");
      await super.handleInteraction(commandInteraction(interaction, "import", { server: id, game }));
      this.audit("server.import-request", interaction, id); return;
    }
    if (!server) return this.reply(interaction, "This record has changed. Refresh discovery.");
    if (action === "game-api" && server.game.type === "satisfactory") {
      const token = new TextInputBuilder().setCustomId("token").setLabel("Replacement game API token (private)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255);
      const url = new TextInputBuilder().setCustomId("url").setLabel("API URL; blank uses the server allocation").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(250);
      if (server.game.apiUrl) url.setValue(server.game.apiUrl);
      const tls = new TextInputBuilder().setCustomId("tls").setLabel("Allow self-signed TLS: true or false").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(server.game.allowInsecureTls ?? true));
      return interaction.showModal(new ModalBuilder().setCustomId(`bridge:card:${id}:save-game-api`).setTitle("Satisfactory API settings").addComponents(row(token), row(url), row(tls)));
    }
    if (action === "save-game-api" && server.game.type === "satisfactory") {
      const token = interaction.fields.getTextInputValue("token").trim();
      const url = interaction.fields.getTextInputValue("url").trim();
      const tls = interaction.fields.getTextInputValue("tls").trim();
      if (!token || !["true", "false"].includes(tls)) return this.reply(interaction, "Enter the game API token and true or false for self-signed TLS.");
      if (url) {
        let parsed; try { parsed = new URL(url); } catch { return this.reply(interaction, "Enter a valid HTTP(S) game API URL."); }
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return this.reply(interaction, "Use an HTTP(S) API URL without embedded credentials or query parameters.");
      }
      this.configStore.updateManagedServer(id, { game: { apiUrl: url || null, allowInsecureTls: tls === "true" } }, { apiToken: token });
      this.audit("server.game-api", interaction, id);
      return this.reply(interaction, "Game API settings saved privately. Reactivate if this record is paused.");
    }
    if (await this.relaySettings.handle(interaction, server, action)) return;
    if (action === "settings") {
      const fields = [ ["name", "Display name", server.name, TextInputStyle.Short], ["description", "Description (one line per entry)", (server.description ?? []).join("\n"), TextInputStyle.Paragraph], ["idle", "Idle hours; blank disables auto-stop", server.autoStop?.enabled ? String(server.autoStop.emptyTimeoutHours) : "", TextInputStyle.Short], ["warning", "Auto-stop warning in minutes", String(server.autoStop?.warningMinutesBefore ?? 60), TextInputStyle.Short] ];
      const modal = new ModalBuilder().setCustomId(`bridge:card:${id}:save-settings`).setTitle("Server settings");
      for (const [key, text, value, style] of fields) { const field = new TextInputBuilder().setCustomId(key).setLabel(text).setStyle(style).setRequired(key === "name").setMaxLength(key === "description" ? 1000 : 200); if (value) field.setValue(value); modal.addComponents(row(field)); }
      return interaction.showModal(modal);
    }
    if (action === "save-settings") {
      const value = (key) => interaction.fields.getTextInputValue(key).trim();
      const hours = value("idle"); const warning = value("warning");
      if (!value("name")) return this.reply(interaction, "A display name is required.");
      const changes = { name: value("name"), description: value("description").split("\n"), autoStop: hours ? { enabled: true, emptyTimeoutHours: Number(hours), warningMinutesBefore: Number(warning) } : { enabled: false } };
      if (hours && (!Number.isFinite(Number(hours)) || Number(hours) <= 0 || !Number.isFinite(Number(warning)) || Number(warning) <= 0 || Number(warning) >= Number(hours) * 60)) return this.reply(interaction, "Idle timeout must be positive and the positive warning shorter than the timeout.");
      normalizeServer({ ...server, ...changes });
      this.configStore.updateManagedServer(id, changes); this.audit("server.settings", interaction, id);
      return this.reply(interaction, "Server settings saved.");
    }
    if (action === "bind") return this.reply(interaction, "Choose the existing channel to link to this server. Review its access before confirming. Linking a channel does not publish the server on the main status page.", { components: [row(new ChannelSelectMenuBuilder().setCustomId(`bridge:card:${id}:bind-selected`).setChannelTypes(ChannelType.GuildText))] });
    if (["activate", "bind-selected"].includes(action)) {
      await this.acknowledge(interaction);
      if (action === "bind-selected" && server.active && !server.unavailable && !server.archived && !server.deleted) {
        const channel = await interaction.guild.channels.fetch(interaction.values[0]);
        if (!channel || channel.type !== ChannelType.GuildText || [this.config.discord.statusChannelId, this.configStore.getAdminChannelId(interaction.guildId)].includes(channel.id) || this.config.servers.some((record) => record.pterodactylServerId !== id && record.discordChannelId === channel.id)) return this.reply(interaction, "Choose a separate, available server channel.");
        return this.reply(interaction, `Bind to <#${channel.id}>? This channel is ${channel.permissionsFor(interaction.guild.roles.everyone)?.has("ViewChannel") ? "visible" : "hidden"} to @everyone. Its permissions stay unchanged.`, { components: [row(button(`bridge:card:${id}:rebind-${channel.id}`, "Confirm channel change", "🔗", ButtonStyle.Primary))] });
      }
      const channel = action === "bind-selected" ? await interaction.guild.channels.fetch(interaction.values[0], { force: true }) : null;
      await super.handleInteraction(commandInteraction(interaction, "activate", { server: id, channel }));
      this.audit("server.activate-request", interaction, id); return;
    }
    if (action.startsWith("rebind-")) {
      await this.acknowledge(interaction);
      const channelId = action.slice(7); const channel = await interaction.guild.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText || [this.config.discord.statusChannelId, this.config.discord.logChannelId, this.configStore.getAdminChannelId(interaction.guildId)].includes(channelId) || this.config.servers.some((record) => record.pterodactylServerId !== id && record.discordChannelId === channelId)) return this.reply(interaction, "Channel no longer available. Retry binding.");
      this.configStore.updateManagedServer(id, { discordChannelId: channelId, channelManaged: false }); this.audit("server.bind", interaction, id);
      return this.reply(interaction, "Channel binding saved; permissions retained.", { components: [] });
    }
    if (action === "publish") return super.handleInteraction(commandInteraction(interaction, "publish", { server: id }));
    if (action === "deleted") {
      if (!server.unavailable) return this.reply(interaction, "Only unavailable records can be marked deleted. Check deletion in your Pterodactyl panel first.");
      return this.reply(interaction, "Confirm you checked that this server was deleted in Pterodactyl. This only marks the local record and retains its settings and channel.", { components: [row(button(`bridge:card:${id}:confirm-deleted`, "Confirm record is deleted", "🗂️"))] });
    }
    let changes;
    let stopRequested = false;
    if (action === "confirm-deleted" && server.unavailable) changes = { deleted: true, active: false };
    const archiveConfirmation = action.match(/^archive-confirm-(keep|stop)-(.+)$/);
    if (action === "archive" || archiveConfirmation) {
      await this.acknowledge(interaction);
      if (archiveConfirmation) {
        const [, choice, nonce] = archiveConfirmation;
        const pending = this.pending.get(nonce);
        if (!pending || pending.kind !== "archive" || pending.userId !== interaction.user.id || pending.serverId !== id
          || Date.now() - pending.at > 300_000) {
          return this.reply(interaction, "This archive confirmation expired or belongs to another administrator. Select Archive server again.");
        }
        this.pending.delete(nonce);
        const currentState = JSON.stringify([server.active, server.published, server.archived, server.unavailable, server.deleted, server.discordChannelId]);
        if (pending.state !== currentState || server.archived) return this.reply(interaction, "This server changed since the archive review. Select Archive server again.");
        stopRequested = choice === "stop";
        if (stopRequested && (server.unavailable || server.deleted || !await canAccessServer(this.pterodactylClient, id))) {
          return this.reply(interaction, "Panel access is unavailable; nothing was archived or stopped. Check access, or select Archive — do not stop.");
        }
        changes = { archived: true, active: false, archiveResumeState: { active: server.active === true, published: server.published === true } };
      } else if (server.archived) {
        // Older archives did not capture their previous monitoring state.
        // Resume them by default, while retaining their publication setting.
        const previous = server.archiveResumeState ?? { active: true, published: server.published };
        if (previous.active && (server.unavailable || server.deleted
          || !await canAccessServer(this.pterodactylClient, id))) {
          return this.reply(interaction, "Could not restore monitoring because panel access is unavailable or this record is marked deleted. The server remains archived. Check access and reactivate the record before retrying.");
        }
        changes = { archived: false, active: previous.active === true, published: previous.published === true, archiveResumeState: null };
      } else {
        for (const [key, pending] of this.pending) {
          if (Date.now() - pending.at > 300_000 || (pending.kind === "archive" && pending.userId === interaction.user.id && pending.serverId === id)) this.pending.delete(key);
        }
        const nonce = randomUUID().replaceAll("-", "").slice(0, 24);
        this.pending.set(nonce, { kind: "archive", userId: interaction.user.id, serverId: id, at: Date.now(),
          state: JSON.stringify([server.active, server.published, server.archived, server.unavailable, server.deleted, server.discordChannelId]) });
        return this.reply(interaction, `Archive ${label(server.name)}? Monitoring, chat relay and idle auto-stop will pause. The linked channel and history stay intact. Unarchive restores its previous settings. Default: keep the game server's current power state.`, { components: [row(
          button(`bridge:card:${id}:archive-confirm-keep-${nonce}`, "Archive — do not stop", "📦", ButtonStyle.Primary),
          button(`bridge:card:${id}:archive-confirm-stop-${nonce}`, "Archive & stop server", "⏹️", ButtonStyle.Danger)
        )] });
      }
    }
    if (action === "disable") changes = { active: false };
    if (!changes) throw new Error("Unknown server action");
    this.configStore.updateManagedServer(id, changes); this.audit(archiveConfirmation ? "server.archive" : `server.${action}`, interaction, id);
    if (action === "archive" || archiveConfirmation) {
      await this.reply(interaction, changes.archived
        ? `Server archived. Monitoring, chat relay and idle auto-stop are paused. The linked channel and message history are retained. ${stopRequested ? "The requested stop will be sent after monitoring is paused." : "The game server's power state is unchanged."}`
        : `Server unarchived. Previous state restored: monitoring ${changes.active ? "enabled" : "paused"}; main status page ${changes.published ? "listed" : "not listed"}. Linked channel access and message history are retained. The game server's power state is unchanged.`, { components: [] });
      return { kind: changes.archived ? "server-archived" : "server-unarchived", server: { ...server, ...changes }, stopRequested };
    }
    return this.reply(interaction, "Monitoring paused. Settings and linked channels are retained; use Start monitoring when ready to resume.", { components: [] });
  }
}
