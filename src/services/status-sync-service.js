import { FactorioAdapter } from "../adapters/factorio-adapter.js";
import { SourceAdapter } from "../adapters/source-adapter.js";
import { MinecraftAdapter } from "../adapters/minecraft-adapter.js";
import { SatisfactoryAdapter } from "../adapters/satisfactory-adapter.js";
import { CoreEvents } from "../core/core-events.js";
import { RelayService } from "./relay-service.js";
import { isServerMonitoringEnabled, isServerRelayEnabled } from "../lib/server-lifecycle.js";
import { DiscordInputController } from "./discord-input-controller.js";

const DEBOUNCE_MS = 500;
const POWER_STATE_OVERRIDE_TTL_MS = 10 * 60 * 1000;
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

function adapterConfigKey(server) {
  const { lastSuccessAt, unavailableReason, lastDiscoveryAt, accessUncertain, ...settings } = server;
  return JSON.stringify(settings);
}

function snapshotKey(snapshot) {
  const players = [...(snapshot.onlinePlayers ?? [])].sort().join(",");
  const satisfactoryState = snapshot.satisfactoryState
    ? `${snapshot.satisfactoryState.techTier}|${snapshot.satisfactoryState.activeSchematic}|${snapshot.satisfactoryState.gamePhase}|${snapshot.gameDurationMs}`
    : "";
  return `${snapshot.currentState}|${snapshot.autoStopped === true}|${snapshot.playerCountReliable !== false}|${snapshot.playerCount}|${players}|${satisfactoryState}`;
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

function mergeSyncOptions(current, next) {
  if (!current) {
    return { force: Boolean(next.force), reason: next.reason ?? null };
  }

  return {
    force: Boolean(current.force || next.force),
    reason: next.reason ?? current.reason ?? null
  };
}

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
    onSyncCompleted = null,
    onServerUnavailable = null,
    restartDelayMs = 1000
  }) {
    this.config = config;
    this.discordBridge = discordBridge;
    this.kookBridge = kookBridge;
    this.eventBus = eventBus;
    this.pterodactylClient = pterodactylClient;
    this.autoStopService = autoStopService;
    this.stateStore = stateStore;
    for (const server of config.servers.filter((record) => !isServerMonitoringEnabled(record))) {
      this.stateStore?.clearAutoStopState?.(server.pterodactylServerId);
    }
    this.logger = logger;
    this.onSyncCompleted = onSyncCompleted;
    this.onServerUnavailable = onServerUnavailable;
    this.lastSnapshots = new Map();
    this.adapterConfigKeys = new Map();
    this.runtimeGeneration = 0;
    this.intervalHandle = null;
    this.debounceHandle = null;
    this.activeSync = null;
    this.queuedSyncOptions = null;
    this.started = false;
    this.hasActivePlayers = false;
    this.serverPlayerCounts = new Map();
    this.consoleUnsubscribers = new Map();
    this.serverOnlineStates = new Map();
    this.serverPowerStates = new Map();
    this.lastSnapshotKeys = new Map();
    this.messageUnsubscribers = [];
    this.messageInputsRegistered = false;
    this.relayService = new RelayService({ config, stateStore, eventBus, pterodactylClient, logger,
      kookEnabled: Boolean(kookBridge), getAdapter: id => this.adapters.get(id),
      isCurrent: (server, adapter) => this.#isCurrentRuntime(server, adapter) });
    this.relayOverflowNotified = this.relayService.overflowNotified;
    this.initialSnapshotLogged = false;
    this.livePanelInitialized = false;
    this.lastArchivePanelKey = null;
    this.discordInputController = new DiscordInputController({
      config,
      discordBridge,
      autoStopService,
      syncService: this,
      logger,
      onRestartRequested,
      restartDelayMs
    });
    this.adapters = new Map(
      config.servers.filter(isServerMonitoringEnabled).map((server) => [
        server.pterodactylServerId,
        this.#createAdapter(server)
      ])
    );
    for (const server of config.servers.filter(isServerMonitoringEnabled)) {
      this.adapterConfigKeys.set(server.pterodactylServerId, adapterConfigKey(server));
    }
  }

  async start() {
    if (this.started) return;
    this.stopped = false;
    this.started = true;
    this.registerDiscordInputs();

    this.relayService.start();
    if (!this.messageInputsRegistered) {
      this.messageInputsRegistered = true;
      for (const [bridge, sourcePlatform] of [[this.discordBridge, "discord"], [this.kookBridge, "kook"]]) {
        if (!bridge) continue;
        const unsubscribe = bridge.onMessage(message => {
          if (this.started && !this.stopped) return this.relayService.accept({ ...message, sourcePlatform });
        });
        if (typeof unsubscribe === "function") this.messageUnsubscribers.push(unsubscribe);
      }
    }

    for (const adapter of this.adapters.values()) {
      adapter.start?.();
    }

    await this.syncOnce();
    this.#scheduleNextPeriodicSync();
  }

  registerDiscordInputs() {
    this.discordInputController.start();
  }

  async stop() {
    this.stopped = true;
    this.runtimeGeneration += 1;
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
    if (this.messageUnsubscribers.length) {
      for (const unsubscribe of this.messageUnsubscribers) unsubscribe();
      this.messageUnsubscribers = [];
      this.messageInputsRegistered = false;
    }
    await this.relayService.stop();
  }

  refreshPeriodicSchedule() {
    this.#scheduleNextPeriodicSync();
  }

  onConfigReloaded() {
    this.runtimeGeneration += 1;
    const enabledServers = this.config.servers.filter(isServerMonitoringEnabled);
    const enabledIds = new Set(enabledServers.map((server) => server.pterodactylServerId));
    const pausedIds = new Set(this.config.servers.filter((server) => !isServerMonitoringEnabled(server))
      .map((server) => server.pterodactylServerId));
    for (const serverId of this.adapters.keys()) if (!enabledIds.has(serverId)) pausedIds.add(serverId);
    for (const serverId of pausedIds) this.stateStore?.clearAutoStopState?.(serverId);
    for (const [serverId, adapter] of this.adapters) {
      const server = enabledServers.find((entry) => entry.pterodactylServerId === serverId);
      if (enabledIds.has(serverId) && this.adapterConfigKeys.get(serverId) === adapterConfigKey(server)) {
        adapter.onConfigReloaded?.(server);
        continue;
      }
      adapter.stop?.();
      this.consoleUnsubscribers.get(serverId)?.();
      this.consoleUnsubscribers.delete(serverId);
      this.adapters.delete(serverId);
      this.adapterConfigKeys.delete(serverId);
      this.serverPlayerCounts.delete(serverId);
      this.serverOnlineStates.delete(serverId);
      this.serverPowerStates.delete(serverId);
      this.lastSnapshotKeys.delete(serverId);
    }
    for (const server of enabledServers) {
      const id = server.pterodactylServerId;
      if (this.adapters.has(id)) continue;
      const adapter = this.#createAdapter(server);
      this.adapters.set(id, adapter);
      this.adapterConfigKeys.set(id, adapterConfigKey(server));
      if (this.started) adapter.start?.();
    }
    this.relayService.reconcile();
    this.livePanelInitialized = false;
    this.lastArchivePanelKey = null;
    this.hasActivePlayers = Array.from(this.serverPlayerCounts.values()).some((count) => count > 0);
    this.refreshPeriodicSchedule();
  }

  #isCurrentRuntime(server, adapter) {
    const current = this.config.servers.find((entry) => entry.pterodactylServerId === server.pterodactylServerId);
    return !this.stopped && Boolean(current) && isServerMonitoringEnabled(current)
      && this.adapters.get(server.pterodactylServerId) === adapter;
  }

  #staleSnapshot(server) {
    const id = server.pterodactylServerId;
    const cached = this.lastSnapshots.get(id) ?? this.stateStore?.getServerRuntimeState?.(id)?.lastSnapshot;
    return {
      ...cached,
      name: server.name,
      description: server.description,
      publicAddress: server.publicAddress,
      publicPort: server.publicPort,
      maxPlayers: server.maxPlayers,
      currentState: "unavailable",
      simplifiedStatus: "Unavailable",
      unavailable: true,
      stale: true,
      retrying: server.accessUncertain === true,
      lastSeenAt: cached?.lastSeenAt ?? null,
      onlinePlayers: cached?.onlinePlayers ?? [],
      playerNamesAvailable: false
    };
  }

  /**
   * Runs one sync, coalescing concurrent callers. The periodic timer, the
   * console debounce, /refresh-status, /start-server and config reload can all
   * fire at once; overlapping runs raced each other over the status panel's
   * stored message IDs.
   */
  requestSync(options = {}) {
    if (this.stopped) return;
    queueMicrotask(() => { if (!this.stopped) void this.syncOnce(options).catch(error => this.logger.error("Scheduled status refresh failed", error)); });
  }

  async syncOnce(options = {}) {
    if (this.activeSync) {
      // Fold into a single follow-up run rather than building an unbounded chain.
      this.queuedSyncOptions = mergeSyncOptions(this.queuedSyncOptions, options);
      return this.activeSync;
    }

    this.activeSync = this.#runSync(options);
    try {
      return await this.activeSync;
    } finally {
      this.activeSync = null;
      const queued = this.queuedSyncOptions;
      this.queuedSyncOptions = null;
      if (queued) void this.syncOnce(queued);
    }
  }

  async #runSync({ force = false, reason = null } = {}) {
    const startedAt = Date.now();
    let anyChanged = force || !this.livePanelInitialized;
    let snapshotChanged = !this.livePanelInitialized;
    const failedServers = [];

    const activeServers = this.config.servers.filter(isServerMonitoringEnabled);
    const unavailableServers = this.config.servers.filter((server) => server.unavailable && !server.archived && !server.deleted);
    const archivedServers = this.config.servers.filter((server) =>
      server.published !== false && (server.deleted
        ? this.config.publicDisplay?.deleted !== "hidden"
        : server.archived && this.config.publicDisplay?.archived !== "hidden"));
    const archivePanelKey = JSON.stringify(archivedServers.map((server) => [server.name, server.archiveNote, server.deleted]));
    const generation = this.runtimeGeneration;
    const archivePanelChanged = archivePanelKey !== this.lastArchivePanelKey;
    this.lastArchivePanelKey = archivePanelKey;

    // Poll servers concurrently. With per-request timeouts in place, a slow
    // panel response should delay only its own server, not every other panel.
    const results = await Promise.all(activeServers.map(async (server) => {
      const adapter = this.adapters.get(server.pterodactylServerId);

      let fetchingResources = true;
      try {
        const rawResources = await this.pterodactylClient.getServerResources(server.pterodactylServerId);
        fetchingResources = false;
        server.accessUncertain = false;
        if (!this.#isCurrentRuntime(server, adapter)) return null;
        const resources = this.#applyCachedPowerState(server, rawResources);
        this.#syncConsoleBridge(server, adapter, resources.currentState);
        this.relayService.expire(server);
        if (resources.currentState === "running") {
          void this.relayService.flush(server);
        }
        // A forced sync is used for both manual refreshes and the configured
        // active/idle polling cadence. Refresh game-derived state alongside
        // the panel so player lists cannot remain stale between polls.
        const rawSnapshot = await adapter.fetchSnapshot(resources, { forcePlayerRefresh: force });
        if (!this.#isCurrentRuntime(server, adapter)) return null;
        const snapshot = {
          ...this.#hydrateAutoStopStatus(server, this.#hydrateCachedSnapshot(server, rawSnapshot)),
          lastSeenAt: new Date().toISOString()
        };
        this.lastSnapshots.set(server.pterodactylServerId, snapshot);
        this.stateStore?.setServerRuntimeState?.(server.pterodactylServerId, { lastSnapshot: snapshot });
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
          if (snapshot.playerCountReliable !== false && typeof snapshot.playerCount === "number"
            && Number.isFinite(snapshot.playerCount) && snapshot.playerCount >= 0) {
            await this.autoStopService.onRunningSnapshot(server, snapshot.playerCount);
          } else {
            // Unknown player counts break the evidence of continuous inactivity.
            this.stateStore?.clearAutoStopState?.(server.pterodactylServerId);
          }
        }

        return snapshot;
      } catch (error) {
        failedServers.push(server.name);
        this.logger.error(`Failed syncing ${server.name}`, error);
        if (fetchingResources && error.retryable && this.#isCurrentRuntime(server, adapter)) {
          server.accessUncertain = true;
          this.lastSnapshotKeys.delete(server.pterodactylServerId);
          this.stateStore?.clearAutoStopState?.(server.pterodactylServerId);
          this.consoleUnsubscribers.get(server.pterodactylServerId)?.();
          this.consoleUnsubscribers.delete(server.pterodactylServerId);
        }
        if (fetchingResources && !error.retryable && this.#isCurrentRuntime(server, adapter)) {
          server.unavailable = true;
          this.stateStore?.clearAutoStopState?.(server.pterodactylServerId);
          adapter.stop?.();
          this.consoleUnsubscribers.get(server.pterodactylServerId)?.();
          this.consoleUnsubscribers.delete(server.pterodactylServerId);
          this.adapters.delete(server.pterodactylServerId);
          this.adapterConfigKeys.delete(server.pterodactylServerId);
          this.serverPlayerCounts.delete(server.pterodactylServerId);
          this.serverOnlineStates.delete(server.pterodactylServerId);
          this.serverPowerStates.delete(server.pterodactylServerId);
          this.lastSnapshotKeys.delete(server.pterodactylServerId);
          try {
            await this.onServerUnavailable?.(server, { reason: "Panel access failed; check connectivity and permissions, then reactivate." });
          } catch (persistError) {
            this.logger.error("Failed persisting unavailable server state", persistError);
          }
        }
        anyChanged = true;
        return this.#staleSnapshot(server);
      }
    }));

    if (generation !== this.runtimeGeneration) { if (!this.stopped) this.queuedSyncOptions = { force: true }; return; }
    const snapshots = results.filter((snapshot) => snapshot !== null && !snapshot.stale);
    let publishedSnapshots = results.flatMap((snapshot, index) =>
      snapshot && activeServers[index].published !== false ? [snapshot] : []);
    publishedSnapshots.push(...unavailableServers.filter((server) => server.published !== false).map((server) => this.#staleSnapshot(server)));
    if (this.config.discord.serverDisplayOrder?.length) {
      const byId = new Map(activeServers.map((server, index) => [server.pterodactylServerId,
        server.published !== false ? results[index] : null]));
      for (const server of unavailableServers) if (server.published !== false) byId.set(server.pterodactylServerId, this.#staleSnapshot(server));
      publishedSnapshots = this.config.servers.flatMap(server => byId.get(server.pterodactylServerId) ? [byId.get(server.pterodactylServerId)] : []);
    }
    // The loop finished, which is the liveness signal a healthcheck needs.
    // Per-server failures do not change that the bot is running and polling.
    const syncSummary = {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      configuredServerCount: activeServers.length + unavailableServers.length,
      successfulServerCount: snapshots.length,
      failedServers,
      unavailableServerCount: this.config.servers.filter((server) => server.unavailable).length,
      degraded: activeServers.length + unavailableServers.length > 0 && snapshots.length === 0
    };
    this.onSyncCompleted?.(syncSummary);

    if (failedServers.length > 0) {
      this.logger.warn("Server sync completed with failures", syncSummary);
    }

    const hadActivePlayers = this.hasActivePlayers;
    this.hasActivePlayers = Array.from(this.serverPlayerCounts.values()).some((count) => count > 0);
    if (hadActivePlayers !== this.hasActivePlayers && this.intervalHandle) {
      this.#scheduleNextPeriodicSync();
    }

    if (snapshots.length > 0 && !this.initialSnapshotLogged) {
      this.initialSnapshotLogged = true;
      this.logger.info("Initial server snapshot", {
          durationMs: syncSummary.durationMs,
        activePlayersPresent: this.hasActivePlayers,
        failedServers,
        servers: snapshots.map(summarizeSnapshot)
      });
    }

    if (!anyChanged && !archivePanelChanged) {
      return;
    }

    await this.eventBus.emit(CoreEvents.STATUS_PANEL_UPDATED, {
      snapshots: publishedSnapshots,
      archivedServers,
      livePanelChanged: anyChanged,
      archivePanelChanged
    });
    this.livePanelInitialized = true;

    const refreshReason = reason ?? (force ? "scheduled" : snapshotChanged ? "state-change" : "manual");
    if (refreshReason !== "scheduled") {
      this.logger.info("Status panels refreshed", {
        reason: refreshReason,
        durationMs: syncSummary.durationMs,
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
          pterodactylClient: this.pterodactylClient,
          logger: this.logger
        });
      case "minecraft":
        return new MinecraftAdapter({
          serverConfig: server,
          pterodactylClient: this.pterodactylClient
        });
      case "source":
        return new SourceAdapter({ serverConfig: server, pterodactylClient: this.pterodactylClient });
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
    if (!this.#isCurrentRuntime(server, adapter)) return;
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
      requestedInitialLogs: false
    });

    const unsubscribe = this.pterodactylClient.subscribeToConsole(serverId, {
      onReady: () => {
        this.logger.info("Console session ready", {
          server: server.name,
          serverId,
          game: server.game?.type ?? "unknown"
        });
        // Relay listens only to live output. Player queries refresh state after
        // authentication; relay dispatch also requires a running-state event.
        void this.#handleConsoleConnected(server, adapter);
        void this.relayService.flush(server);
      },
      onLine: supportsConsole
        ? (line, metadata) => {
            void this.#handleConsoleLine(server, adapter, line, metadata);
          }
        : undefined,
      onStatusChange: (newState) => {
        if (!this.#isCurrentRuntime(server, adapter)) return;
        this.logger.info(`${server.name} power state changed to: ${newState}`);
        this.#syncConsoleBridge(server, adapter, newState);
        void this.#handlePowerStateEvent(server, newState);
        this.#scheduleUpdate();
      },
      onError: (error) => {
        this.logger.warn(`Console bridge issue for ${server.name}`, error);
      },
      sendLogs: false
    });

    this.consoleUnsubscribers.set(serverId, unsubscribe);
  }

  async #handleConsoleConnected(server, adapter) {
    if (!this.#isCurrentRuntime(server, adapter) || !adapter.shouldRefreshOnlinePlayersOnConsoleConnect?.()) {
      return;
    }

    try {
      await adapter.refreshOnlinePlayers();
      if (this.#isCurrentRuntime(server, adapter)) this.#scheduleUpdate();
    } catch (error) {
      this.logger.warn(`Failed refreshing online players after console reconnect for ${server.name}`, error);
    }
  }

  async #handleConsoleLine(server, adapter, line, { isBacklog = false } = {}) {
    if (!this.#isCurrentRuntime(server, adapter) || isBacklog) return;
    if (adapter.shouldRefreshOnlinePlayers(line)) {
      adapter.applyPlayerEvent?.(line);
      this.#scheduleUpdate();
      adapter.refreshOnlinePlayers().catch(error => {
        this.logger.warn(`Failed refreshing online players for ${server.name}`, error);
      });
    }
    if (!isServerRelayEnabled(server)) return;
    const message = adapter.parseConsoleChatLine(line);
    if (!message || this.relayService.isEcho(server.pterodactylServerId, message)) return;
    try {
      this.relayService.acceptGame(server, message);
    } catch (error) {
      this.logger.error(`Failed accepting game chat for ${server.name}`, error);
    }
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
    server = this.config.servers.find((entry) => entry.pterodactylServerId === server.pterodactylServerId);
    if (!server || this.stopped || !isServerMonitoringEnabled(server)) return;
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

}
