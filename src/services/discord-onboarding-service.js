import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder
} from "discord.js";

const SERVER_SELECT_ID = "bridge:server";
const GAME_SELECT_PREFIX = "bridge:game:";
const MAX_SELECT_OPTIONS = 25;

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

    if (!this.config.discord.statusChannelId) {
      try {
        const statusChannel = await this.discordBridge.createStatusChannel();
        this.config.discord.statusChannelId = statusChannel.id;
        this.configStore.updateDiscordChannels({
          adminChannelId: this.config.discord.adminChannelId,
          statusChannelId: statusChannel.id
        });
      } catch (error) {
        this.logger.error("Discord onboarding status channel creation failed", error);
        await interaction.editReply({
          content: `Could not create the status channel: ${error.message}. Make sure the bot has **Manage Channels** permission.`
        });
        return;
      }
    }

    let discovered;
    try {
      discovered = await this.pterodactylClient.listServers();
    } catch (error) {
      this.logger.error("Pterodactyl onboarding validation failed", error);
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
        }
      ]);

    const row = new ActionRowBuilder().addComponents(gameSelector);
    await interaction.update({
      content: `Importing **${server.name}** (${server.identifier}). Choose its game type. Satisfactory onboarding will be added separately because it also needs a game API token.`,
      components: [row]
    });
  }

  async #handleGameSelection(interaction) {
    if (!(await this.#requireAdminChannel(interaction))) return;

    const serverId = interaction.customId.slice(GAME_SELECT_PREFIX.length);
    const gameType = interaction.values?.[0];
    if (!serverId || !["factorio", "minecraft"].includes(gameType)) {
      await interaction.update({ content: "Invalid server or game selection.", components: [] });
      return;
    }

    if (this.config.servers.some((server) => server.pterodactylServerId === serverId)) {
      await interaction.update({ content: "That Pterodactyl server is already imported.", components: [] });
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
