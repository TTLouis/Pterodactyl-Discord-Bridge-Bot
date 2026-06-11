import { FactorioAdapter } from "../adapters/factorio-adapter.js";
import { MinecraftAdapter } from "../adapters/minecraft-adapter.js";
import { SatisfactoryAdapter } from "../adapters/satisfactory-adapter.js";
import { buildStatusPanel } from "../lib/formatters.js";

const DEBOUNCE_MS = 500;
const CONSOLE_RELAY_WARMUP_MS = 5000;

function formatDiscordRelayMessage(message) {
  return `**${message.authorName}**: ${message.content}`;
}

function snapshotKey(snapshot) {
  const players = [...(snapshot.onlinePlayers ?? [])].sort().join(",");
  return `${snapshot.currentState}|${snapshot.playerCount}|${players}`;
}

function isConsoleRelayWarmingUp(connectedAt) {
  if (!connectedAt) {
    return false;
  }

  return Date.now() - connectedAt < CONSOLE_RELAY_WARMUP_MS;
}

const SLASH_COMMANDS = [
  { name: "start-server", description: "Start a stopped game server" },
  { name: "cancel-stop", description: "Cancel a pending auto-stop" }
];

export class StatusSyncService {
  constructor({ config, discordBridge, pterodactylClient, autoStopService, logger }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.pterodactylClient = pterodactylClient;
    this.autoStopService = autoStopService;
    this.logger = logger;
    this.intervalHandle = null;
    this.debounceHandle = null;
    this.consoleUnsubscribers = new Map();
    this.serverOnlineStates = new Map();
    this.lastSnapshotKeys = new Map();
    this.adapters = new Map(
      config.servers.map((server) => [
        server.pterodactylServerId,
        this.#createAdapter(server)
      ])
    );
  }

  async start() {
    this.discordBridge.setSlashCommands(SLASH_COMMANDS);

    this.discordBridge.onMessage(async (message) => {
      await this.#handleMessage(message);
    });

    this.discordBridge.onInteraction(async (interaction) => {
      await this.#handleInteraction(interaction);
    });

    for (const adapter of this.adapters.values()) {
      adapter.start?.();
    }

    await this.syncOnce();
    this.intervalHandle = setInterval(() => {
      void this.syncOnce({ force: true });
    }, 5 * 60 * 1000);
  }

  async stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }

    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }

    for (const adapter of this.adapters.values()) {
      adapter.stop?.();
    }

    for (const unsubscribe of this.consoleUnsubscribers.values()) {
      unsubscribe();
    }

    this.consoleUnsubscribers.clear();
  }

  async syncOnce({ force = false } = {}) {
    const snapshots = [];
    let anyChanged = force || this.lastSnapshotKeys.size === 0;

    for (const server of this.config.servers) {
      const adapter = this.adapters.get(server.pterodactylServerId);

      try {
        const resources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
        this.#syncConsoleBridge(server, adapter, resources.currentState);
        const snapshot = await adapter.fetchSnapshot(resources);
        snapshots.push(snapshot);

        const key = snapshotKey(snapshot);
        if (key !== this.lastSnapshotKeys.get(server.pterodactylServerId)) {
          anyChanged = true;
          this.lastSnapshotKeys.set(server.pterodactylServerId, key);
        }

        await this.#checkServerStateChange(server, snapshot.currentState);
        if (snapshot.currentState === "running") {
          await this.autoStopService.onRunningSnapshot(server, snapshot.playerCount ?? 0);
        }
      } catch (error) {
        this.logger.error(`Failed syncing ${server.name}`, error);
      }
    }

    if (snapshots.length === 0 || !anyChanged) {
      return;
    }

    await this.discordBridge.upsertStatusPanel(
      this.config.discord.statusChannelId,
      buildStatusPanel(snapshots, {
        displayTimeZone: this.config.discord.displayTimeZone
      })
    );
  }

  #scheduleUpdate() {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      void this.syncOnce();
    }, DEBOUNCE_MS);
  }

  #createAdapter(server) {
    switch (server.game.type) {
      case "factorio":
        return new FactorioAdapter({
          serverConfig: server,
          pterodactylClient: this.pterodactylClient
        });
      case "minecraft":
        return new MinecraftAdapter({
          serverConfig: server,
          pterodactylClient: this.pterodactylClient
        });
      case "satisfactory":
        return new SatisfactoryAdapter({
          serverConfig: server,
          logger: this.logger
        });
      default:
        throw new Error(`Unsupported server type: ${server.game.type}`);
    }
  }

  #syncConsoleBridge(server, adapter, currentState) {
    const serverId = server.pterodactylServerId;
    const existing = this.consoleUnsubscribers.get(serverId);
    const shouldSubscribe = currentState === "running" && adapter?.supportsConsoleSubscription();

    if (!shouldSubscribe) {
      if (existing) {
        existing();
        this.consoleUnsubscribers.delete(serverId);
      }
      return;
    }

    if (existing) {
      return;
    }

    const unsubscribe = this.pterodactylClient.subscribeToConsole(serverId, {
      onConnected: () => {
        void this.#handleConsoleConnected(server, adapter);
      },
      onLine: (line, metadata) => {
        void this.#handleConsoleLine(server, adapter, line, metadata);
      },
      onStatusChange: (newState) => {
        this.logger.info(`${server.name} power state changed to: ${newState}`);
        if (newState !== "running") {
          this.#syncConsoleBridge(server, adapter, newState);
        }
        this.#scheduleUpdate();
      },
      onError: (error) => {
        this.logger.warn(`Console bridge issue for ${server.name}`, error);
      }
    });

    this.consoleUnsubscribers.set(serverId, unsubscribe);
  }

  async #handleConsoleConnected(server, adapter) {
    if (!adapter.shouldRefreshOnlinePlayersOnConsoleConnect?.()) {
      return;
    }

    try {
      await adapter.refreshOnlinePlayers();
    } catch (error) {
      this.logger.warn(`Failed refreshing online players after console reconnect for ${server.name}`, error);
    }
  }

  async #handleConsoleLine(server, adapter, line, { connectedAt = null, isBacklog = false } = {}) {
    if (isBacklog || isConsoleRelayWarmingUp(connectedAt)) {
      return;
    }

    if (adapter.shouldRefreshOnlinePlayers(line)) {
      adapter.applyPlayerEvent?.(line);
      this.#scheduleUpdate();
      adapter.refreshOnlinePlayers().catch((error) => {
        this.logger.warn(`Failed refreshing online players for ${server.name}`, error);
      });
    }

    const relayMessage = adapter.parseConsoleChatLine(line);
    if (!relayMessage) {
      return;
    }

    try {
      await this.discordBridge.sendMessage(server.discordChannelId, formatDiscordRelayMessage(relayMessage));
    } catch (error) {
      this.logger.error(`Failed forwarding game chat for ${server.name}`, error);
    }
  }

  async #checkServerStateChange(server, currentState) {
    const isOnline = currentState === "running";
    const previouslyOnline = this.serverOnlineStates.get(server.pterodactylServerId);
    this.serverOnlineStates.set(server.pterodactylServerId, isOnline);

    if (previouslyOnline === undefined) return;

    const wentOffline = previouslyOnline && !isOnline;
    const cameOnline = !previouslyOnline && isOnline;

    if (!wentOffline && !cameOnline) return;

    if (server.autoStop?.enabled) {
      if (wentOffline) {
        await this.autoStopService.onWentOffline(server);
      } else {
        await this.autoStopService.onCameOnline(server);
      }
      return;
    }

    // Generic notifications for servers without auto-stop.
    try {
      if (wentOffline) {
        await this.discordBridge.sendMessage(server.discordChannelId, `Server went offline (status: ${currentState}).`);
      } else {
        await this.discordBridge.sendMessage(server.discordChannelId, "Server is back online.");
      }
    } catch (error) {
      this.logger.warn(`Failed sending state-change notification for ${server.name}`, error);
    }
  }

  async #handleInteraction(interaction) {
    const server = this.config.servers.find((s) => s.discordChannelId === interaction.channelId);
    if (!server) {
      await interaction.reply({ content: "This command can only be used in a configured server channel.", ephemeral: true });
      return;
    }

    try {
      if (interaction.commandName === "start-server") {
        await this.autoStopService.handleStartCommand(server, interaction);
      } else if (interaction.commandName === "cancel-stop") {
        await this.autoStopService.handleCancelStopCommand(server, interaction);
      }
    } catch (error) {
      this.logger.error(`Failed handling /${interaction.commandName} for ${server.name}`, error);
      try {
        const replyMethod = interaction.replied || interaction.deferred ? "followUp" : "reply";
        await interaction[replyMethod]({ content: "Something went wrong. Try again later.", ephemeral: true });
      } catch {}
    }
  }

  async #handleMessage(message) {
    const server = this.config.servers.find((entry) => entry.discordChannelId === message.channelId);
    if (!server || !message.content) {
      return;
    }

    try {
      const adapter = this.adapters.get(server.pterodactylServerId);
      if (!adapter?.supportsDiscordRelay()) {
        return;
      }

      await adapter.handleDiscordMessage(message);
    } catch (error) {
      this.logger.error(`Failed processing Discord message for ${server.name}`, error);
      try {
        await this.discordBridge.sendMessage(server.discordChannelId, `Relay failed: ${error.message}`);
      } catch (sendError) {
        this.logger.warn(`Failed sending relay error to Discord for ${server.name}`, sendError);
      }
    }
  }
}
