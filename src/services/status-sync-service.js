import { FactorioAdapter } from "../adapters/factorio-adapter.js";
import { MinecraftAdapter } from "../adapters/minecraft-adapter.js";
import { SatisfactoryAdapter } from "../adapters/satisfactory-adapter.js";
import { buildStatusPanel } from "../lib/formatters.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "./auto-stop-service.js";

const DEBOUNCE_MS = 500;
const CONSOLE_RELAY_WARMUP_MS = 5000;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_ACTIVE_PLAYER_POLL_INTERVAL_SECONDS = 15;

export function getStatusRefreshIntervalMs(config, hasActivePlayers) {
  const configuredSeconds = hasActivePlayers
    ? config.pterodactyl?.activePlayerPollIntervalSeconds
    : config.pterodactyl?.pollIntervalSeconds;
  const fallbackSeconds = hasActivePlayers
    ? DEFAULT_ACTIVE_PLAYER_POLL_INTERVAL_SECONDS
    : DEFAULT_POLL_INTERVAL_SECONDS;
  const seconds = Number(configuredSeconds);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
}

function formatDiscordRelayMessage(message) {
  return `**${message.authorName}**: ${message.content}`;
}

function snapshotKey(snapshot) {
  const players = [...(snapshot.onlinePlayers ?? [])].sort().join(",");
  const satisfactoryState = snapshot.satisfactoryState
    ? `${snapshot.satisfactoryState.techTier}|${snapshot.satisfactoryState.activeSchematic}|${snapshot.satisfactoryState.gamePhase}|${snapshot.gameDurationMs}`
    : "";
  return `${snapshot.currentState}|${snapshot.playerCount}|${players}|${satisfactoryState}`;
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
    this.started = false;
    this.hasActivePlayers = false;
    this.serverPlayerCounts = new Map();
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
    this.started = true;
    this.discordBridge.setSlashCommands(SLASH_COMMANDS);

    this.discordBridge.onMessage(async (message) => {
      await this.#handleMessage(message);
    });

    this.discordBridge.onInteraction(async (interaction) => {
      await this.#handleInteraction(interaction);
    });

    this.discordBridge.onReaction(async (reaction) => {
      await this.#handleReaction(reaction);
    });

    for (const adapter of this.adapters.values()) {
      adapter.start?.();
    }

    await this.syncOnce();
    this.#scheduleNextPeriodicSync();
  }

  async stop() {
    this.started = false;
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle);
      this.intervalHandle = null;
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

  refreshPeriodicSchedule() {
    this.#scheduleNextPeriodicSync();
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
        const previousPlayerCount = this.serverPlayerCounts.get(server.pterodactylServerId);
        const previouslyOnline = this.serverOnlineStates.get(server.pterodactylServerId);
        this.serverPlayerCounts.set(server.pterodactylServerId, Number(snapshot.playerCount ?? 0));

        const key = snapshotKey(snapshot);
        if (key !== this.lastSnapshotKeys.get(server.pterodactylServerId)) {
          anyChanged = true;
          this.lastSnapshotKeys.set(server.pterodactylServerId, key);
        }

        await this.#checkSatisfactoryPlayerCountChange(server, snapshot, {
          previousPlayerCount,
          previouslyOnline
        });
        await this.#checkServerStateChange(server, snapshot.currentState);
        if (snapshot.currentState === "running") {
          await this.autoStopService.onRunningSnapshot(server, snapshot.playerCount ?? 0);
        }
      } catch (error) {
        this.logger.error(`Failed syncing ${server.name}`, error);
      }
    }

    const hadActivePlayers = this.hasActivePlayers;
    this.hasActivePlayers = Array.from(this.serverPlayerCounts.values()).some((count) => count > 0);
    if (hadActivePlayers !== this.hasActivePlayers && this.intervalHandle) {
      this.#scheduleNextPeriodicSync();
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

  #scheduleNextPeriodicSync() {
    if (!this.started) return;
    if (this.intervalHandle) clearTimeout(this.intervalHandle);

    const delayMs = getStatusRefreshIntervalMs(this.config, this.hasActivePlayers);
    this.intervalHandle = setTimeout(async () => {
      this.intervalHandle = null;
      try {
        await this.syncOnce({ force: true });
      } finally {
        this.#scheduleNextPeriodicSync();
      }
    }, delayMs);
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
    const supportsConsole = Boolean(adapter?.supportsConsoleSubscription());
    const shouldSubscribe = Boolean(adapter);

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
        if (supportsConsole && currentState === "running") {
          void this.#handleConsoleConnected(server, adapter);
        }
      },
      onLine: supportsConsole
        ? (line, metadata) => {
            void this.#handleConsoleLine(server, adapter, line, metadata);
          }
        : undefined,
      onStatusChange: (newState) => {
        this.logger.info(`${server.name} power state changed to: ${newState}`);
        this.#scheduleUpdate();
      },
      onError: (error) => {
        this.logger.warn(`Console bridge issue for ${server.name}`, error);
      },
      sendLogs: supportsConsole
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
        await this.discordBridge.replaceActionMessage(
          server.discordChannelId,
          `Server went offline (status: ${currentState}).\n\nReact ${RESTART_SERVER_REACTION} to restart the server.`,
          { reactions: [RESTART_SERVER_REACTION] }
        );
      } else {
        await this.discordBridge.replaceActionMessage(server.discordChannelId, "Server is back online.");
      }
    } catch (error) {
      this.logger.warn(`Failed sending state-change notification for ${server.name}`, error);
    }
  }

  async #checkSatisfactoryPlayerCountChange(server, snapshot, { previousPlayerCount, previouslyOnline }) {
    if (
      server.game.type !== "satisfactory"
      || snapshot.currentState !== "running"
      || previouslyOnline !== true
      || previousPlayerCount === undefined
    ) {
      return;
    }

    const currentPlayerCount = Number(snapshot.playerCount ?? 0);
    const delta = currentPlayerCount - previousPlayerCount;
    if (delta === 0) {
      return;
    }

    const changedPlayers = Math.abs(delta);
    const action = delta > 0 ? "joined" : "left";
    const noun = changedPlayers === 1 ? "player" : "players";
    const maxPlayers = snapshot.maxPlayers ?? server.maxPlayers ?? "?";

    try {
      await this.discordBridge.sendMessage(
        server.discordChannelId,
        `${changedPlayers} ${noun} ${action} **${server.name}**. (${currentPlayerCount}/${maxPlayers})`
      );
    } catch (error) {
      this.logger.warn(`Failed sending Satisfactory player-count event for ${server.name}`, error);
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
        const startRequested = await this.autoStopService.handleStartCommand(server, interaction);
        if (startRequested) {
          await this.syncOnce({ force: true });
        }
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

  async #handleReaction(reaction) {
    const server = this.config.servers.find((s) => s.discordChannelId === reaction.channelId);
    if (!server) {
      return;
    }

    try {
      if (reaction.emoji === RESTART_SERVER_REACTION) {
        const startRequested = await this.autoStopService.handleStartReaction(server, reaction);
        if (startRequested) {
          await this.syncOnce({ force: true });
        }
      } else if (reaction.emoji === CANCEL_AUTO_STOP_REACTION) {
        await this.autoStopService.handleCancelStopReaction(server, reaction);
      }
    } catch (error) {
      this.logger.error(`Failed handling ${reaction.emoji} reaction for ${server.name}`, error);
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
