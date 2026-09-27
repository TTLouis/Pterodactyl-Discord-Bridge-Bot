import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

const SERVER_SELECT_ID = "bridge:server";
const GAME_SELECT_PREFIX = "bridge:game:";
const SATISFACTORY_MODAL_PREFIX = "bridge:satisfactory:";
const MAX_SELECT_OPTIONS = 25;
const MAX_DISCORD_MESSAGE_LENGTH = 1900;

function isAdministrator(interaction) {
  if (interaction.guild?.ownerId && interaction.user?.id === interaction.guild.ownerId) {
    return true;
  }

  const permissions = interaction.memberPermissions ?? interaction.member?.permissions;
  return Boolean(permissions?.has?.(PermissionFlagsBits.Administrator));
}

function gameLabel(type) {
  if (type === "factorio") return "Factorio";
  if (type === "minecraft") return "Minecraft";
  return type;
}

function formatAutoStop(server) {
  if (!server.autoStop?.enabled) return "off";
  const emptyHours = server.autoStop.emptyTimeoutHours ?? 24;
  const warningMinutes = server.autoStop.warningMinutesBefore ?? 60;
  return `on (${emptyHours}h empty, ${warningMinutes}m warning)`;
}

function safePanelHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(invalid panel URL)";
  }
}

function truncateMessage(value) {
  const text = String(value ?? "");
  return text.length <= MAX_DISCORD_MESSAGE_LENGTH
    ? text
    : `${text.slice(0, MAX_DISCORD_MESSAGE_LENGTH - 20)}\n… output truncated`;
}

export class DiscordOnboardingService {
  constructor({
    config,
    discordBridge,
    pterodactylClient,
    configStore,
    logger,
    onConfigChanged = null
  }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.pterodactylClient = pterodactylClient;
    this.configStore = configStore;
    this.logger = logger;
    this.onConfigChanged = onConfigChanged;
  }

  async handleInteraction(interaction) {
    if (interaction.isAutocomplete?.()) {
      await this.#handleAutocomplete(interaction);
      return;
    }

    if (!isAdministrator(interaction)) {
      await this.#replyEphemeral(interaction, "Bridge setup is restricted to the Discord server owner or administrators.");
      return;
    }

    if (interaction.isChatInputCommand()) {
      await this.#handleCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit?.()) {
      if (interaction.customId.startsWith(SATISFACTORY_MODAL_PREFIX)) {
        await this.#handleSatisfactoryModal(interaction);
      }
      return;
    }

    if (!interaction.isStringSelectMenu()) return;

    if (interaction.customId === SERVER_SELECT_ID) {
      await this.#handleServerSelection(interaction);
      return;
    }

    if (interaction.customId.startsWith(GAME_SELECT_PREFIX)) {
      await this.#handleGameSelection(interaction);
    }
  }

  async #handleAutocomplete(interaction) {
    if (!isAdministrator(interaction) || interaction.commandName !== "bridge") {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== "server") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const matches = this.config.servers
      .filter((server) => {
        if (!query) return true;
        return String(server.name).toLowerCase().includes(query)
          || String(server.pterodactylServerId).toLowerCase().includes(query);
      })
      .slice(0, MAX_SELECT_OPTIONS)
      .map((server) => ({
        name: `${server.name} · ${server.pterodactylServerId}`.slice(0, 100),
        value: server.pterodactylServerId
      }));

    await interaction.respond(matches);
  }

  async #handleCommand(interaction) {
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand !== "setup") {
      if (!(await this.#requireAdminChannel(interaction))) return;

      if (subcommand === "add") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await this.#ensureStatusChannel(interaction))) return;
        await this.#showDiscovery(interaction);
        return;
      }

      if (subcommand === "servers") {
        await this.#handleServersCommand(interaction);
        return;
      }

      if (subcommand === "connection") {
        await this.#handleConnectionCommand(interaction);
        return;
      }

      if (subcommand === "configure") {
        await this.#handleConfigureCommand(interaction);
        return;
      }

      await this.#replyEphemeral(interaction, "Unknown bridge administration command.");
      return;
    }

    if (!this.config.discord.adminChannelId) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const adminChannel = await this.discordBridge.createPrivateAdminChannel({
          requestedByUserId: interaction.user.id
        });
        const statusChannel = this.config.discord.statusChannelId
          ? { id: this.config.discord.statusChannelId }
          : await this.discordBridge.createStatusChannel();

        this.config.discord.adminChannelId = adminChannel.id;
        this.config.discord.statusChannelId = statusChannel.id;
        this.configStore.updateDiscordChannels({
          adminChannelId: adminChannel.id,
          statusChannelId: statusChannel.id
        });

        await this.discordBridge.sendMessage(
          adminChannel.id,
          "Pterodactyl Platform Bridge administration is ready here. Run **/bridge setup** in this channel to validate Pterodactyl and import your first server."
        );
        await interaction.editReply({
          content: `Created private admin channel <#${adminChannel.id}> and status channel <#${statusChannel.id}>. Continue by running **/bridge setup** in the admin channel.`
        });
      } catch (error) {
        this.logger.error("Discord onboarding channel creation failed", error);
        await interaction.editReply({
          content: `Could not create the onboarding channels: ${error.message}. Make sure the bot has **Manage Channels**, **View Channels**, **Send Messages**, and **Read Message History** permissions.`
        });
      }
      return;
    }

    if (interaction.channelId !== this.config.discord.adminChannelId) {
      await this.#replyEphemeral(
        interaction,
        `Run bridge administration commands in <#${this.config.discord.adminChannelId}>.`
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await this.#ensureStatusChannel(interaction))) return;
    await this.#showDiscovery(interaction);
  }

  async #handleServersCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let discovered = [];
    let discoveryError = null;
    try {
      discovered = await this.pterodactylClient.listServers();
    } catch (error) {
      discoveryError = error;
      this.logger.warn("Could not refresh discoverable Pterodactyl servers", error);
    }

    const managedIds = new Set(this.config.servers.map((server) => server.pterodactylServerId));
    const unmanaged = discovered.filter((server) => !managedIds.has(server.identifier));
    const managedLines = this.config.servers.length === 0
      ? ["- none"]
      : this.config.servers.slice(0, 20).map((server) => {
          const state = server.archived ? "archived" : "active";
          return `- **${server.name}** · ${gameLabel(server.game?.type)} · ${state} · auto-stop ${formatAutoStop(server)} · <#${server.discordChannelId}>`;
        });
    const unmanagedLines = discoveryError
      ? [`- discovery unavailable: ${discoveryError.message}`]
      : unmanaged.length === 0
        ? ["- none"]
        : unmanaged.slice(0, 20).map((server) => `- **${server.name}** · \`${server.identifier}\``);
    const managedSuffix = this.config.servers.length > 20
      ? `\n- … and ${this.config.servers.length - 20} more managed server(s)`
      : "";
    const unmanagedSuffix = unmanaged.length > 20
      ? `\n- … and ${unmanaged.length - 20} more discoverable server(s)`
      : "";

    await interaction.editReply({
      content: truncateMessage(
        `**Managed servers (${this.config.servers.length})**\n${managedLines.join("\n")}${managedSuffix}\n\n`
        + `**Available to import (${unmanaged.length})**\n${unmanagedLines.join("\n")}${unmanagedSuffix}`
      )
    });
  }

  async #handleConnectionCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const discovered = await this.pterodactylClient.listServers();
      const managedAccessible = this.config.servers.filter((server) =>
        discovered.some((remote) => remote.identifier === server.pterodactylServerId)
      ).length;

      await interaction.editReply({
        content:
          `**Pterodactyl connection: healthy**\n`
          + `Panel: \`${safePanelHost(this.config.pterodactyl.baseUrl)}\`\n`
          + "Authentication: Client API key configured (value hidden)\n"
          + `Accessible servers: ${discovered.length}\n`
          + `Managed servers still accessible: ${managedAccessible}/${this.config.servers.length}\n`
          + `Game chat relay: ${this.config.features?.gameChatRelayEnabled ? "enabled (experimental)" : "disabled"}`
      });
    } catch (error) {
      this.logger.error("Pterodactyl connection diagnostics failed", error);
      await interaction.editReply({
        content:
          `**Pterodactyl connection: failed**\n`
          + `Panel: \`${safePanelHost(this.config.pterodactyl.baseUrl)}\`\n`
          + "Authentication credential: configured (value hidden)\n"
          + `Error: ${error.message}`
      });
    }
  }

  async #handleConfigureCommand(interaction) {
    const serverRef = interaction.options.getString("server", true);
    const server = this.config.servers.find(
      (entry) => entry.pterodactylServerId === serverRef
        || entry.name.toLowerCase() === String(serverRef).toLowerCase()
    );

    if (!server) {
      await this.#replyEphemeral(interaction, "That managed server was not found. Use **/bridge servers** to review managed servers.");
      return;
    }

    const name = interaction.options.getString("name");
    const archived = interaction.options.getBoolean("archived");
    const autoStopEnabled = interaction.options.getBoolean("auto-stop");
    const emptyHours = interaction.options.getNumber("empty-hours");
    const warningMinutes = interaction.options.getNumber("warning-minutes");
    const values = [name, archived, autoStopEnabled, emptyHours, warningMinutes];
    const hasMutation = values.some((value) => value !== null && value !== undefined);

    if (!hasMutation) {
      await this.#replyEphemeral(
        interaction,
        `**${server.name}**\n`
        + `Pterodactyl ID: \`${server.pterodactylServerId}\`\n`
        + `Game: ${gameLabel(server.game?.type)}\n`
        + `Channel: <#${server.discordChannelId}>\n`
        + `Archived: ${server.archived ? "yes" : "no"}\n`
        + `Auto-stop: ${formatAutoStop(server)}`
      );
      return;
    }

    const updates = {};
    if (name !== null && name !== undefined) {
      const normalizedName = String(name).trim();
      if (!normalizedName || normalizedName.length > 100) {
        await this.#replyEphemeral(interaction, "Display name must be between 1 and 100 characters.");
        return;
      }
      updates.name = normalizedName;
    }
    if (archived !== null && archived !== undefined) {
      updates.archived = archived;
    }

    if (autoStopEnabled !== null || emptyHours !== null || warningMinutes !== null) {
      const current = server.autoStop ?? {};
      const nextAutoStop = {
        enabled: autoStopEnabled ?? Boolean(current.enabled),
        emptyTimeoutHours: emptyHours ?? current.emptyTimeoutHours ?? 24,
        warningMinutesBefore: warningMinutes ?? current.warningMinutesBefore ?? 60
      };
      if (nextAutoStop.enabled && nextAutoStop.warningMinutesBefore >= nextAutoStop.emptyTimeoutHours * 60) {
        await this.#replyEphemeral(interaction, "Auto-stop warning time must be shorter than the empty timeout.");
        return;
      }
      updates.autoStop = nextAutoStop;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      this.configStore.updateServer(server.pterodactylServerId, updates);
      const reloaded = this.onConfigChanged ? await this.onConfigChanged() : false;
      if (!reloaded) {
        await interaction.editReply({
          content: `Saved changes for **${server.name}**, but live reload failed. Restart the bot once to apply them.`
        });
        return;
      }

      const updated = this.config.servers.find(
        (entry) => entry.pterodactylServerId === server.pterodactylServerId
      );
      await interaction.editReply({
        content:
          `Updated **${updated?.name ?? server.name}**.\n`
          + `Archived: ${updated?.archived ? "yes" : "no"}\n`
          + `Auto-stop: ${formatAutoStop(updated ?? server)}`
      });
      this.logger.info("Discord administration updated managed server", {
        serverId: server.pterodactylServerId,
        updates: Object.keys(updates),
        requestedBy: interaction.user?.id ?? null
      });
    } catch (error) {
      this.logger.error("Discord server configuration update failed", error);
      await interaction.editReply({ content: `Could not update that server: ${error.message}` });
    }
  }

  async #ensureStatusChannel(interaction) {
    if (this.config.discord.statusChannelId) return true;

    try {
      const statusChannel = await this.discordBridge.createStatusChannel();
      this.config.discord.statusChannelId = statusChannel.id;
      this.configStore.updateDiscordChannels({
        adminChannelId: this.config.discord.adminChannelId,
        statusChannelId: statusChannel.id
      });
      return true;
    } catch (error) {
      this.logger.error("Discord onboarding status channel creation failed", error);
      await interaction.editReply({
        content: `Could not create the status channel: ${error.message}. Make sure the bot has **Manage Channels** permission.`
      });
      return false;
    }
  }

  async #showDiscovery(interaction) {
    let discovered;
    try {
      discovered = await this.pterodactylClient.listServers();
    } catch (error) {
      this.logger.error("Pterodactyl server discovery failed", error);
      await interaction.editReply({
        content: `Could not validate the Pterodactyl Client API connection: ${error.message}`
      });
      return;
    }

    const importedIds = new Set(this.config.servers.map((server) => server.pterodactylServerId));
    const available = discovered.filter((server) => !importedIds.has(server.identifier));
    if (available.length === 0) {
      await interaction.editReply({
        content: discovered.length === 0
          ? "Pterodactyl connection succeeded, but this Client API account does not expose any servers."
          : `Pterodactyl connection succeeded. All ${discovered.length} accessible server(s) are already imported.`,
        components: []
      });
      return;
    }

    const shown = available.slice(0, MAX_SELECT_OPTIONS);
    const selector = new StringSelectMenuBuilder()
      .setCustomId(SERVER_SELECT_ID)
      .setPlaceholder("Choose a Pterodactyl server to import")
      .addOptions(shown.map((server) => ({
        label: String(server.name).slice(0, 100),
        description: String(server.description || server.identifier).slice(0, 100),
        value: server.identifier
      })));
    const row = new ActionRowBuilder().addComponents(selector);
    const suffix = available.length > shown.length
      ? ` Showing the first ${shown.length} of ${available.length} available servers.`
      : "";

    await interaction.editReply({
      content: `Pterodactyl connection validated. Found ${discovered.length} accessible server(s); ${available.length} are not yet imported.${suffix}`,
      components: [row]
    });
  }

  async #handleServerSelection(interaction) {
    if (!(await this.#requireAdminChannel(interaction))) return;

    const serverId = interaction.values?.[0];
    if (!serverId) {
      await interaction.update({ content: "No Pterodactyl server was selected.", components: [] });
      return;
    }

    let discovered;
    try {
      discovered = await this.pterodactylClient.listServers();
    } catch (error) {
      this.logger.error("Pterodactyl onboarding discovery refresh failed", error);
      await interaction.update({
        content: `Could not refresh the Pterodactyl server list: ${error.message}`,
        components: []
      });
      return;
    }

    const server = discovered.find((entry) => entry.identifier === serverId);
    if (!server) {
      await interaction.update({
        content: "That Pterodactyl server is no longer accessible to this Client API account.",
        components: []
      });
      return;
    }

    const gameSelector = new StringSelectMenuBuilder()
      .setCustomId(`${GAME_SELECT_PREFIX}${serverId}`)
      .setPlaceholder("Choose the game adapter")
      .addOptions([
        {
          label: "Factorio",
          description: "Status, players, power controls and Factorio console integration.",
          value: "factorio"
        },
        {
          label: "Minecraft",
          description: "Status, players, power controls and Minecraft console integration.",
          value: "minecraft"
        },
        {
          label: "Satisfactory",
          description: "Status and player counts using the Satisfactory game API.",
          value: "satisfactory"
        }
      ]);

    const row = new ActionRowBuilder().addComponents(gameSelector);
    await interaction.update({
      content: `Importing **${server.name}** (${server.identifier}). Choose its game type.`,
      components: [row]
    });
  }

  async #handleGameSelection(interaction) {
    if (!(await this.#requireAdminChannel(interaction))) return;

    const serverId = interaction.customId.slice(GAME_SELECT_PREFIX.length);
    const gameType = interaction.values?.[0];
    if (!serverId || !["factorio", "minecraft", "satisfactory"].includes(gameType)) {
      await interaction.update({ content: "Invalid server or game selection.", components: [] });
      return;
    }

    if (this.config.servers.some((server) => server.pterodactylServerId === serverId)) {
      await interaction.update({ content: "That Pterodactyl server is already imported.", components: [] });
      return;
    }

    if (gameType === "satisfactory") {
      const tokenInput = new TextInputBuilder()
        .setCustomId("api-token")
        .setLabel("Satisfactory API token")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(512);
      const urlInput = new TextInputBuilder()
        .setCustomId("api-url")
        .setLabel("API URL override (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("https://host:7777/api/v1")
        .setMaxLength(500);
      const modal = new ModalBuilder()
        .setCustomId(`${SATISFACTORY_MODAL_PREFIX}${serverId}`)
        .setTitle("Connect Satisfactory API")
        .addComponents(
          new ActionRowBuilder().addComponents(tokenInput),
          new ActionRowBuilder().addComponents(urlInput)
        );
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferUpdate();

    try {
      const discovered = await this.pterodactylClient.listServers();
      const remote = discovered.find((entry) => entry.identifier === serverId);
      if (!remote) {
        await interaction.editReply({
          content: "That Pterodactyl server is no longer accessible to this Client API account.",
          components: []
        });
        return;
      }

      const serverChannel = await this.discordBridge.createServerChannel(remote.name);
      this.configStore.addServer({
        name: remote.name,
        pterodactylServerId: remote.identifier,
        discordChannelId: serverChannel.id,
        game: {
          type: gameType
        },
        autoStop: {
          enabled: false
        }
      });

      const reloaded = this.onConfigChanged ? await this.onConfigChanged() : false;
      if (!reloaded) {
        await interaction.editReply({
          content: `Saved **${remote.name}** and created <#${serverChannel.id}>, but the live configuration did not reload. Restart the bot once before using this server.`,
          components: []
        });
        return;
      }

      await interaction.editReply({
        content: `Imported **${remote.name}** as ${gameLabel(gameType)} and created <#${serverChannel.id}>. The server is now managed by the bridge.`,
        components: []
      });
      this.logger.info("Discord onboarding imported Pterodactyl server", {
        serverId: remote.identifier,
        serverName: remote.name,
        gameType,
        discordChannelId: serverChannel.id,
        requestedBy: interaction.user?.id ?? null
      });
    } catch (error) {
      this.logger.error("Discord onboarding server import failed", error);
      await interaction.editReply({
        content: `Could not import that server: ${error.message}`,
        components: []
      });
    }
  }

  async #requireAdminChannel(interaction) {
    const adminChannelId = this.config.discord.adminChannelId;
    if (adminChannelId && interaction.channelId === adminChannelId) {
      return true;
    }

    await this.#replyEphemeral(
      interaction,
      adminChannelId
        ? `Continue setup in <#${adminChannelId}>.`
        : "Run /bridge setup first so the private admin channel can be created."
    );
    return false;
  }

  async #replyEphemeral(interaction, content) {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
