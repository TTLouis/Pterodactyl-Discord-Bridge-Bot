import { FactorioAdapter } from "../adapters/factorio-adapter.js";
import { MinecraftAdapter } from "../adapters/minecraft-adapter.js";
import { SatisfactoryAdapter } from "../adapters/satisfactory-adapter.js";
import { CoreEvents } from "../core/core-events.js";
import { buildGameChatCommand } from "../lib/chat-relay-formatters.js";
import { CANCEL_AUTO_STOP_REACTION, RESTART_SERVER_REACTION } from "./auto-stop-service.js";

const DEBOUNCE_MS = 500;
const CONSOLE_RELAY_WARMUP_MS = 5000;
const POWER_STATE_OVERRIDE_TTL_MS = 10 * 60 * 1000;
const RECENT_RELAY_LINE_TTL_MS = 10 * 60 * 1000;
const RELAY_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
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

function snapshotKey(snapshot) {
  const players = [...(snapshot.onlinePlayers ?? [])].sort().join(",");
  const satisfactoryState = snapshot.satisfactoryState
    ? `${snapshot.satisfactoryState.techTier}|${snapshot.satisfactoryState.activeSchematic}|${snapshot.satisfactoryState.gamePhase}|${snapshot.gameDurationMs}`
    : "";
  return `${snapshot.currentState}|${snapshot.autoStopped === true}|${snapshot.playerCount}|${players}|${satisfactoryState}`;
}

function isConsoleRelayWarmingUp(connectedAt) {
  if (!connectedAt) {
    return false;
  }

  return Date.now() - connectedAt < CONSOLE_RELAY_WARMUP_MS;
}

function summarizeSnapshot(snapshot) {
  return {
    name: snapshot.name,
    state: snapshot.currentState,
    status: snapshot.simplifiedStatus,
    players: `${snapshot.playerCount ?? 0}/${snapshot.maxPlayers ?? "?"}`,
    playerNamesAvailable: snapshot.playerNamesAvailable !== false,
    onlinePlayers: Array.isArray(snapshot.onlinePlayers) ? snapshot.onlinePlayers.slice(0, 10) : null
  };
}

function shouldApplyCachedPowerState(cachedState, resourceState) {
  if (cachedState === resourceState) {
    return false;
  }

  if (cachedState === "starting" && resourceState === "running") {
    return false;
  }

  if (cachedState === "stopping" && resourceState === "offline") {
    return false;
  }

  return true;
}

const SLASH_COMMANDS = [
  { name: "start-server", description: "Start a stopped game server" },
  { name: "cancel-stop", description: "Cancel a pending auto-stop" },
  { name: "refresh-status", description: "Force refresh all game server status panels" },
  { name: "restart-bot", description: "Restart the bot process" }
];

export class StatusSyncService {
  constructor({
    config,
    discordBridge,
    kookBridge = null,
    eventBus,
    pterodactylClient,
    autoStopService,
    stateStore,
    logger,
    onRestartRequested = null,
    restartDelayMs = 1000
  }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.kookBridge = kookBridge;
    this.eventBus = eventBus;
    this.pterodactylClient = pterodactylClient;
    this.autoStopService = autoStopService;
    this.stateStore = stateStore;
    this.logger = logger;
    this.onRestartRequested = onRestartRequested;
    this.restartDelayMs = restartDelayMs;
    this.intervalHandle = null;
    this.debounceHandle = null;
    this.started = false;
    this.hasActivePlayers = false;
    this.serverPlayerCounts = new Map();
    this.consoleUnsubscribers = new Map();
    this.serverOnlineStates = new Map();
    this.serverPowerStates = new Map();
    this.lastSnapshotKeys = new Map();
    this.recentRelayLines = new Map();
    this.relayFlushPromises = new Map();
    this.inMemoryRelayQueues = new Map();
    this.initialSnapshotLogged = false;
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
      await this.#handleMessage({ sourcePlatform: "discord", ...message });
    });

    this.kookBridge?.onMessage(async (message) => {
      await this.#handleMessage({ sourcePlatform: "kook", ...message });
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

  onConfigReloaded() {
    for (const [serverId, adapter] of this.adapters.entries()) {
      const server = this.config.servers.find((entry) => entry.pterodactylServerId === serverId);
      adapter.onConfigReloaded?.(server);
    }
  }

  async syncOnce({ force = false, reason = null } = {}) {
    const startedAt = Date.now();
    const snapshots = [];
    let anyChanged = force || this.lastSnapshotKeys.size === 0;
    let snapshotChanged = this.lastSnapshotKeys.size === 0;
    const failedServers = [];

    for (const server of this.config.servers) {
      const adapter = this.adapters.get(server.pterodactylServerId);

      try {
        const rawResources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
        const resources = this.#applyCachedPowerState(server, rawResources);
        this.#syncConsoleBridge(server, adapter, resources.currentState);
        await this.#expireQueuedRelays(server);
        if (resources.currentState === "running") {
          void this.#flushQueuedRelays(server, adapter);
        }
        const rawSnapshot = await adapter.fetchSnapshot(resources);
        const snapshot = this.#hydrateAutoStopStatus(server, this.#hydrateCachedSnapshot(server, rawSnapshot));
        snapshots.push(snapshot);
        const previousPlayerCount = this.serverPlayerCounts.get(server.pterodactylServerId);
        const previouslyOnline = this.serverOnlineStates.get(server.pterodactylServerId);
        this.serverPlayerCounts.set(server.pterodactylServerId, Number(snapshot.playerCount ?? 0));

        const key = snapshotKey(snapshot);
        if (key !== this.lastSnapshotKeys.get(server.pterodactylServerId)) {
          anyChanged = true;
          snapshotChanged = true;
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
        failedServers.push(server.name);
        this.logger.error(`Failed syncing ${server.name}`, error);
      }
    }

    const hadActivePlayers = this.hasActivePlayers;
    this.hasActivePlayers = Array.from(this.serverPlayerCounts.values()).some((count) => count > 0);
    if (hadActivePlayers !== this.hasActivePlayers && this.intervalHandle) {
      this.#scheduleNextPeriodicSync();
    }

    if (snapshots.length > 0 && !this.initialSnapshotLogged) {
      this.initialSnapshotLogged = true;
      this.logger.info("Initial server snapshot", {
        durationMs: Date.now() - startedAt,
        activePlayersPresent: this.hasActivePlayers,
        failedServers,
        servers: snapshots.map(summarizeSnapshot)
      });
    }

    if (snapshots.length === 0 || !anyChanged) {
      return;
    }

    await this.eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, { snapshots });

    const refreshReason = reason ?? (force ? "scheduled" : snapshotChanged ? "state-change" : "manual");
    if (refreshReason !== "scheduled") {
      this.logger.info("Status panels refreshed", {
        reason: refreshReason,
        durationMs: Date.now() - startedAt,
        activePlayersPresent: this.hasActivePlayers,
        failedServers,
        servers: snapshots.map(summarizeSnapshot)
      });
    }
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

  #hydrateCachedSnapshot(server, snapshot) {
    if (!this.stateStore) {
      return snapshot;
    }

    if (typeof snapshot.gameDurationMs === "number" && Number.isFinite(snapshot.gameDurationMs) && snapshot.gameDurationMs >= 0) {
      this.stateStore.setServerRuntimeState(server.pterodactylServerId, {
        lastGameDurationMs: snapshot.gameDurationMs,
        lastGameDurationState: snapshot.currentState,
        lastGameDurationSeenAt: Date.now()
      });
      return snapshot;
    }

    const runtimeState = this.stateStore.getServerRuntimeState(server.pterodactylServerId);
    if (typeof runtimeState.lastGameDurationMs !== "number") {
      return snapshot;
    }

    return {
      ...snapshot,
      gameDurationMs: runtimeState.lastGameDurationMs,
      gameDurationCached: true,
      gameDurationCachedAt: runtimeState.lastGameDurationSeenAt ?? null
    };
  }

  #hydrateAutoStopStatus(server, snapshot) {
    if (snapshot.currentState !== "offline") {
      return snapshot;
    }

    const autoStopState = this.stateStore?.getAutoStopState?.(server.pterodactylServerId);
    if (autoStopState?.stoppedByBot !== true) {
      return snapshot;
    }

    return {
      ...snapshot,
      autoStopped: true
    };
  }

  #applyCachedPowerState(server, resources) {
    if (!this.stateStore) {
      return resources;
    }

    const runtimeState = this.stateStore.getServerRuntimeState(server.pterodactylServerId);
    const cachedState = runtimeState.lastPowerState;
    const cachedAt = runtimeState.lastPowerStateSeenAt;
    if (!cachedState || typeof cachedAt !== "number") {
      return resources;
    }

    const cacheAgeMs = Date.now() - cachedAt;
    if (
      cacheAgeMs < 0
      || cacheAgeMs > POWER_STATE_OVERRIDE_TTL_MS
      || !shouldApplyCachedPowerState(cachedState, resources.currentState)
    ) {
      return resources;
    }

    return {
      ...resources,
      currentState: cachedState,
      rawCurrentState: resources.currentState,
      powerStateCached: true
    };
  }

  #cachePowerState(server, currentState) {
    if (!this.stateStore) {
      return;
    }

    this.stateStore.setServerRuntimeState(server.pterodactylServerId, {
      lastPowerState: currentState,
      lastPowerStateSeenAt: Date.now()
    });
  }

  #consumeStartAttribution(server) {
    const pending = this.stateStore?.consumePendingStartAttribution?.(server.pterodactylServerId);
    if (pending?.source === "discord" && pending.startedBy) {
      return {
        source: "discord",
        startedBy: pending.startedBy,
        startedAt: pending.startedAt ?? null
      };
    }

    return {
      source: "pterodactyl-panel",
      startedBy: null,
      startedAt: null
    };
  }

  #syncConsoleBridge(server, adapter, currentState) {
    const serverId = server.pterodactylServerId;
    const existing = this.consoleUnsubscribers.get(serverId);
    const supportsConsole = Boolean(adapter?.supportsConsoleSubscription());
    // Satisfactory uses this channel for power-state events but not console relay.
    // Console-capable games only keep the socket while their server is running.
    const shouldSubscribe = supportsConsole ? currentState === "running" : Boolean(adapter);

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

    this.logger.info("Console bridge subscribing", {
      server: server.name,
      serverId,
      consoleRelayEnabled: supportsConsole,
      requestedInitialLogs: supportsConsole
    });

    const unsubscribe = this.pterodactylClient.subscribeToConsole(serverId, {
      onConnected: () => {
        void this.#handleConsoleConnected(server, adapter);
      },
      onReady: () => {
        void this.#flushQueuedRelays(server, adapter);
      },
      onLine: supportsConsole
        ? (line, metadata) => {
            void this.#handleConsoleLine(server, adapter, line, metadata);
          }
        : undefined,
      onStatusChange: (newState) => {
        this.logger.info(`${server.name} power state changed to: ${newState}`);
        this.#syncConsoleBridge(server, adapter, newState);
        void this.#handlePowerStateEvent(server, newState);
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

  async #handleConsoleLine(server, adapter, line, { connectedAt = null, isBacklog = false, isReconnect = false } = {}) {
    if (isBacklog && !isReconnect) {
      return;
    }

    const isWarmingUp = isConsoleRelayWarmingUp(connectedAt);
    if (!isBacklog && !isWarmingUp && adapter.shouldRefreshOnlinePlayers(line)) {
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

    if (this.#isDuplicateRelayLine(server, line)) {
      return;
    }
    this.#rememberRelayLine(server, line);

    try {
      await this.eventBus.emit(CoreEvents.GAME_CHAT_RELAY, {
        server,
        ...relayMessage
      });
    } catch (error) {
      this.logger.error(`Failed forwarding game chat for ${server.name}`, error);
    }
  }

  #relayLineKey(server, line) {
    return `${server.pterodactylServerId}|${String(line ?? "").trim()}`;
  }

  #pruneRecentRelayLines(now = Date.now()) {
    for (const [key, seenAt] of this.recentRelayLines.entries()) {
      if (now - seenAt > RECENT_RELAY_LINE_TTL_MS) {
        this.recentRelayLines.delete(key);
      }
    }
  }

  #isDuplicateRelayLine(server, line) {
    this.#pruneRecentRelayLines();
    return this.recentRelayLines.has(this.#relayLineKey(server, line));
  }

  #rememberRelayLine(server, line) {
    this.#pruneRecentRelayLines();
    this.recentRelayLines.set(this.#relayLineKey(server, line), Date.now());
  }

  async #checkServerStateChange(server, currentState) {
    this.serverOnlineStates.set(server.pterodactylServerId, this.#isServerRunning(currentState));
    const previousState = this.serverPowerStates.get(server.pterodactylServerId);
    this.serverPowerStates.set(server.pterodactylServerId, currentState);

    if (previousState === undefined || previousState === currentState) return;

    this.logger.info("Polling detected power-state transition", {
      server: server.name,
      serverId: server.pterodactylServerId,
      previousState,
      currentState
    });
    await this.#notifyServerStateChange(server, currentState, { previousState });
  }

  async #handlePowerStateEvent(server, currentState) {
    this.#cachePowerState(server, currentState);
    this.serverOnlineStates.set(server.pterodactylServerId, this.#isServerRunning(currentState));
    const previousState = this.serverPowerStates.get(server.pterodactylServerId);
    this.serverPowerStates.set(server.pterodactylServerId, currentState);

    if (previousState === undefined || previousState === currentState) return;

    try {
      this.logger.info("Power-state event detected transition", {
        server: server.name,
        serverId: server.pterodactylServerId,
        previousState,
        currentState
      });
      await this.#notifyServerStateChange(server, currentState, { previousState });
    } catch (error) {
      this.logger.warn(`Failed handling power-state event for ${server.name}`, error);
    }
  }

  #isServerRunning(currentState) {
    return currentState === "running";
  }

  async #notifyServerStateChange(server, currentState, { previousState }) {
    if (currentState === "starting") {
      await this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, {
        kind: "server-starting-state",
        server,
        previousState,
        currentState
      });
      return;
    }

    if (currentState === "stopping") {
      await this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, {
        kind: "server-stopping-state",
        server,
        previousState,
        currentState
      });
      return;
    }

    if (server.autoStop?.enabled) {
      if (currentState === "offline") {
        await this.autoStopService.onWentOffline(server);
      } else if (currentState === "running") {
        await this.autoStopService.onCameOnline(server, this.#consumeStartAttribution(server));
      }
      return;
    }

    // Generic notifications for servers without auto-stop.
    try {
      if (currentState === "offline") {
        await this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, {
          kind: "server-offline",
          server,
          previousState,
          currentState
        });
      } else if (currentState === "running") {
        await this.eventBus.emit(CoreEvents.SERVER_ACTION_MESSAGE, {
          kind: "server-online",
          server,
          previousState,
          currentState,
          startInfo: this.#consumeStartAttribution(server)
        });
      } else {
        this.logger.info(`No action message for unhandled ${server.name} state transition`, {
          previousState,
          currentState
        });
      }
    } catch (error) {
      this.logger.warn(`Failed publishing state-change notification for ${server.name}`, error);
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
    const maxPlayers = snapshot.maxPlayers ?? server.maxPlayers ?? "?";

    try {
      await this.eventBus.emit(CoreEvents.SERVER_NOTICE, {
        kind: "satisfactory-player-count",
        server,
        changedPlayers,
        action,
        playerCount: currentPlayerCount,
        maxPlayers
      });
    } catch (error) {
      this.logger.warn(`Failed publishing Satisfactory player-count event for ${server.name}`, error);
    }
  }

  async #handleInteraction(interaction) {
    if (interaction.commandName === "refresh-status") {
      await this.#handleRefreshStatusCommand(interaction);
      return;
    }

    if (interaction.commandName === "restart-bot") {
      await this.#handleRestartBotCommand(interaction);
      return;
    }

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

  async #handleRefreshStatusCommand(interaction) {
    const logChannelId = this.config.discord.logChannelId;
    if (!logChannelId) {
      await interaction.reply({ content: "No Discord log channel is configured for this bot.", ephemeral: true });
      return;
    }

    if (interaction.channelId !== logChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured log channel.", ephemeral: true });
      return;
    }

    const requestedBy = interaction.member?.displayName ?? interaction.user?.username ?? "Unknown";
    this.logger.info("Manual status refresh requested", {
      requestedBy,
      channelId: interaction.channelId
    });

    await interaction.deferReply({ ephemeral: true });
    await this.syncOnce({ force: true, reason: "manual" });
    await interaction.editReply({ content: "Status refresh completed for all configured game servers." });
  }

  async #handleRestartBotCommand(interaction) {
    const logChannelId = this.config.discord.logChannelId;
    if (!logChannelId) {
      await interaction.reply({ content: "No Discord log channel is configured for this bot.", ephemeral: true });
      return;
    }

    if (interaction.channelId !== logChannelId) {
      await interaction.reply({ content: "This command can only be used in the configured log channel.", ephemeral: true });
      return;
    }

    if (!this.onRestartRequested) {
      await interaction.reply({ content: "Bot restart is not available in this runtime.", ephemeral: true });
      return;
    }

    const requestedBy = interaction.member?.displayName ?? interaction.user?.username ?? "Unknown";
    this.logger.info("Bot restart requested", {
      requestedBy,
      channelId: interaction.channelId
    });

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: "Restarting bot process. It should come back online shortly." });

    const request = () => {
      void this.onRestartRequested({
        requestedBy,
        channelId: interaction.channelId
      });
    };

    if (this.restartDelayMs <= 0) {
      request();
      return;
    }

    setTimeout(request, this.restartDelayMs);
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
    const sourcePlatform = message.sourcePlatform === "kook" ? "kook" : "discord";
    const server = this.config.servers.find((entry) => (
      sourcePlatform === "kook"
        ? entry.kookChannelId === message.channelId
        : entry.discordChannelId === message.channelId
    ));
    if (!server || !message.content) {
      return;
    }

    try {
      await this.eventBus.emit(CoreEvents.GROUP_CHAT_RELAY, {
        server,
        sourcePlatform,
        authorName: message.authorName,
        content: message.content
      });
    } catch (error) {
      this.logger.warn(`Failed cross-posting ${sourcePlatform.toUpperCase()} message for ${server.name}`, error);
    }

    const adapter = this.adapters.get(server.pterodactylServerId);
    if (!adapter) return;

    const relay = {
      sourcePlatform,
      authorName: message.authorName,
      authorColor: message.authorColor ?? null,
      platformColor: message.platformColor ?? null,
      content: message.content,
      enqueuedAt: Date.now()
    };
    const command = buildGameChatCommand(server, relay);
    if (!command) return;

    const gameType = server.type ?? server.game?.type;
    if (gameType === "factorio" || gameType === "minecraft") {
      const queue = this.#getRelayQueue(server.pterodactylServerId);
      queue.push(relay);
      this.#setRelayQueue(server.pterodactylServerId, queue);
      this.logger.info("Game relay queued", { server: server.name, serverId: server.pterodactylServerId, queueLength: queue.length });
      await this.#expireQueuedRelays(server);
      void this.#flushQueuedRelays(server, adapter);
      return;
    }

    try {
      await this.#deliverRelay(adapter, command, relay);
    } catch (error) {
      await this.#publishRelayFailure(server, sourcePlatform, error);
    }
  }

  #getRelayQueue(serverId) {
    if (typeof this.stateStore?.getRelayQueue === "function") {
      return [...this.stateStore.getRelayQueue(serverId)];
    }
    return [...(this.inMemoryRelayQueues.get(serverId) ?? [])];
  }

  #setRelayQueue(serverId, queue) {
    if (typeof this.stateStore?.setRelayQueue === "function") {
      this.stateStore.setRelayQueue(serverId, queue);
      return;
    }
    if (queue.length > 0) this.inMemoryRelayQueues.set(serverId, queue);
    else this.inMemoryRelayQueues.delete(serverId);
  }

  async #expireQueuedRelays(server, now = Date.now()) {
    const queue = this.#getRelayQueue(server.pterodactylServerId);
    const retained = queue.filter((relay) => Number(relay.enqueuedAt) + RELAY_QUEUE_TTL_MS > now);
    const expiredCount = queue.length - retained.length;
    if (!expiredCount) return;

    this.#setRelayQueue(server.pterodactylServerId, retained);
    this.logger.warn("Queued game relays expired", { server: server.name, serverId: server.pterodactylServerId, expiredCount });
    try {
      await this.eventBus.emit(CoreEvents.SERVER_NOTICE, {
        kind: "relay-queue-expired",
        server,
        expiredCount
      });
    } catch (error) {
      this.logger.warn(`Failed publishing relay queue expiry for ${server.name}`, error);
    }
  }

  async #flushQueuedRelays(server, adapter) {
    const serverId = server.pterodactylServerId;
    if (this.relayFlushPromises.has(serverId)) return this.relayFlushPromises.get(serverId);
    if (!this.pterodactylClient.isConsoleSessionReady?.(serverId)) return;

    const flush = (async () => {
      await this.#expireQueuedRelays(server);
      let sent = 0;
      while (this.pterodactylClient.isConsoleSessionReady?.(serverId)) {
        const queue = this.#getRelayQueue(serverId);
        const relay = queue[0];
        if (!relay) break;
        const command = buildGameChatCommand(server, relay);
        if (!command) {
          queue.shift();
          this.#setRelayQueue(serverId, queue);
          continue;
        }
        try {
          await this.#deliverRelay(adapter, command, relay);
        } catch (error) {
          this.logger.warn("Queued game relay delivery will retry when the console is ready", {
            server: server.name,
            serverId,
            error: error.message
          });
          break;
        }
        queue.shift();
        this.#setRelayQueue(serverId, queue);
        sent += 1;
      }
      if (sent) this.logger.info("Queued game relays flushed", { server: server.name, serverId, sent, remaining: this.#getRelayQueue(serverId).length });
    })();
    this.relayFlushPromises.set(serverId, flush);
    try {
      await flush;
    } finally {
      if (this.relayFlushPromises.get(serverId) === flush) this.relayFlushPromises.delete(serverId);
    }
  }

  async #deliverRelay(adapter, command, relay) {
    if (typeof adapter.handleChatCommand === "function") return adapter.handleChatCommand(command);
    if (typeof adapter.handleChatMessage === "function") return adapter.handleChatMessage({ ...relay, command });
    return adapter.handleDiscordMessage({ ...relay, command });
  }

  async #publishRelayFailure(server, sourcePlatform, error) {
    this.logger.error(`Failed processing ${sourcePlatform.toUpperCase()} message for ${server.name}`, error);
    try {
      await this.eventBus.emit(CoreEvents.SERVER_NOTICE, { kind: "relay-failed", server, message: error.message });
    } catch (sendError) {
      this.logger.warn(`Failed publishing relay error for ${server.name}`, sendError);
    }
  }
}
