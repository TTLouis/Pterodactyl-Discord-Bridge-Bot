import { AdministrationConfigurationCoordinator } from "./core/administration/configuration-coordinator.js";
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Events } from "discord.js";
import { CoreEventBus } from "./core/core-events.js";
import { getConfigPath, loadConfig, normalizeServer } from "./lib/config.js";
import { isKookEnabled } from "./lib/kook-config.js";
import { logger as defaultLogger } from "./lib/logger.js";
import { getHeartbeatPath, writeHeartbeat } from "./lib/heartbeat.js";
import { getSyncHealthPath, writeSyncHealth } from "./lib/sync-health.js";
import { getStatePath, StateStore } from "./lib/state-store.js";
import { PersistentConfigStore } from "./lib/persistent-config-store.js";
import { AutoStopService } from "./services/auto-stop-service.js";
import { BRIDGE_SETUP_COMMAND, BridgeSetupController } from "./platforms/discord/bridge-setup-controller.js";
import { BRIDGE_ADMIN_COMMANDS } from "./platforms/discord/bridge-admin-controller.js";
import { GUIDED_ADMIN_COMMANDS, GuidedAdminController } from "./platforms/discord/guided-admin-controller.js";
import { applyReloadedConfig, ConfigReloadService } from "./services/config-reload-service.js";
import { DiscordBridge } from "./services/discord-bridge.js";
import { DISCORD_SLASH_COMMANDS } from "./services/discord-input-controller.js";
import { KookBridge } from "./services/kook-bridge.js";
import { PterodactylClient } from "./services/pterodactyl-client.js";
import { hydrateServerNetworkConfig } from "./services/server-network-config.js";
import { StatusSyncService } from "./services/status-sync-service.js";
import { DiscordPlatformListener } from "./platforms/discord-platform-listener.js";
import { KookPlatformListener } from "./platforms/kook-platform-listener.js";

export async function main({ services = {}, registerProcessHandlers = true } = {}) {
  const logger = services.logger ?? defaultLogger;
  const configStore = new (services.PersistentConfigStore ?? PersistentConfigStore)({ logger });
  configStore.load();
  let runtime;
  if (configStore.available && configStore.document?.source === "managed") {
    runtime = loadConfig({ rawConfig: configStore.getRuntimeConfig(), managed: true });
  } else {
    runtime = loadConfig();
    if (runtime.managed) {
      if (!configStore.available) throw new Error("Restore persistent storage before starting an unconfigured installation");
      configStore.initialize();
      runtime = loadConfig({ rawConfig: configStore.getRuntimeConfig(), managed: true });
    } else {
      configStore.syncLegacyConfig(runtime.rawConfig);
      if (configStore.available) {
        runtime.config.pterodactyl.apiKey = configStore.getConnectionKey();
        for (const key of ["privateCategoryId", "publicCategoryId", "linkedChannelRoleId", "bridgeAdminRoleId"]) {
          const saved = configStore.document.settings.discord?.[key];
          if (saved) runtime.config.discord[key] = saved;
        }
        runtime.config.servers.push(...configStore.getManagedServers().map(normalizeServer));
      }
    }
  }
  const stateStore = new (services.StateStore ?? StateStore)(getStatePath(), { logger });
  stateStore.load();
  const eventBus = new CoreEventBus();
  const pterodactylClient = new (services.PterodactylClient ?? PterodactylClient)({ ...runtime.config.pterodactyl, baseUrl: runtime.config.pterodactyl.baseUrl ?? "https://not-configured.invalid" });

  // Declared up front so shutdown() is safe to call at any point during startup,
  // including from the process-level error handlers registered below.
  let discordBridge = null;
  let kookBridge = null;
  let discordPlatformListener = null;
  let kookPlatformListener = null;
  let statusSyncService = null;
  let configReloadService = null;
  let shuttingDown = false;
  let setupHeartbeat = null;
  let bridgeAdminController = null;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}. Shutting down.`);

    try {
      clearInterval(setupHeartbeat);
      bridgeAdminController?.stop();
      configReloadService?.stop();
      await statusSyncService?.stop();
      kookPlatformListener?.stop();
      discordPlatformListener?.stop();
      await kookBridge?.stop();
      await discordBridge?.stop();
    } catch (error) {
      logger.error("Error while shutting down; exiting anyway", error);
    }

    try {
      stateStore.flush();
    } catch (error) {
      logger.error("Failed to flush runtime state during shutdown", error);
    }

    if (registerProcessHandlers) process.exit(exitCode);
  }

  if (registerProcessHandlers) {
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    // A rejected Discord/KOOK/panel call should degrade that one operation,
    // not take the whole bot down.
    process.on("unhandledRejection", (reason) => {
      logger.error(
        "Unhandled promise rejection",
        reason instanceof Error ? reason : new Error(String(reason))
      );
    });

    // An uncaught exception leaves process state unknown. Exit non-zero so the
    // container runtime restarts us instead of treating it as a clean stop.
    process.on("uncaughtException", (error) => {
      logger.error("Uncaught exception", error);
      void shutdown("UNCAUGHT_EXCEPTION", 1);
    });
  }

  if (!runtime.config.setupMode) {
    for (const server of runtime.config.servers) {
      try { await hydrateServerNetworkConfig({ config: { servers: [server] }, pterodactylClient, logger }); }
      catch {
        server.unavailable = true;
        server.active = false;
        persistUnavailable(server);
        logger.error("Server network discovery failed; check panel allocation access before reactivation.");
      }
    }
  }

  discordBridge = new (services.DiscordBridge ?? DiscordBridge)({
    token: runtime.discordToken,
    guildId: runtime.config.discord.guildId,
    stateStore,
    logger,
    isWatchedChannel: (channelId) => runtime.config.servers.some(
      (server) => !server.archived && server.discordChannelId === channelId
    )
  });
  kookBridge = isKookEnabled()
    ? new (services.KookBridge ?? KookBridge)({
      token: runtime.kookToken,
      guildId: runtime.config.kook.guildId,
      logger
    })
    : null;
  discordPlatformListener = new (services.DiscordPlatformListener ?? DiscordPlatformListener)({
    eventBus,
    discordBridge,
    config: runtime.config,
    logger
  });
  kookPlatformListener = kookBridge
    ? new (services.KookPlatformListener ?? KookPlatformListener)({
      eventBus,
      kookBridge,
      config: runtime.config,
      logger
    })
    : null;
  function persistUnavailable(server) {
    if (configStore.available && configStore.getManagedServers().some((record) => record.pterodactylServerId === server.pterodactylServerId)) {
      configStore.updateManagedServer(server.pterodactylServerId, { active: false, unavailable: true, lastSuccessAt: server.lastSuccessAt ?? null });
      configStore.recordAudit("server.unavailable", { serverId: server.pterodactylServerId });
    }
    server.active = false;
    statusSyncService?.onConfigReloaded();
    const guild = discordBridge?.client?.guilds.cache.get(runtime.config.discord.guildId);
    if (guild) void bridgeAdminController?.refreshCards(guild).catch(() => logger.error("Could not refresh unavailable server card."));
  }
  const autoStopService = new (services.AutoStopService ?? AutoStopService)({
    config: runtime.config,
    pterodactylClient,
    eventBus,
    stateStore,
    logger,
    onServerUnavailable: persistUnavailable,
    onAudit(event) {
      if (configStore.available) configStore.recordAudit(`power.${event.action}.${event.outcome}`, { actorId: event.user ?? null, serverId: event.server ?? null });
    }
  });
  statusSyncService = new (services.StatusSyncService ?? StatusSyncService)({
    config: runtime.config,
    discordBridge,
    kookBridge,
    eventBus,
    pterodactylClient,
    autoStopService,
    stateStore,
    logger,
    onServerUnavailable: persistUnavailable,
    onRestartRequested({ requestedBy }) {
      logger.info("Restarting bot after Discord command", { requestedBy });
      void shutdown("BOT_RESTART_REQUESTED");
    },
    onSyncCompleted(summary) {
      writeHeartbeat(getHeartbeatPath(), logger);
      writeSyncHealth({ ...summary, mode: "monitoring" }, getSyncHealthPath(), logger);
    }
  });
  async function reconcile({ waitForStatus = true } = {}) {
    if (!configStore.available) return;
    const next = loadConfig({ rawConfig: configStore.getRuntimeConfig(), managed: true });
    Object.assign(runtime.config.discord, next.config.discord);
    Object.assign(runtime.config.pterodactyl, next.config.pterodactyl);
    runtime.config.publicDisplay = next.config.publicDisplay;
    runtime.config.setupMode = next.config.setupMode;
    const previousServers = new Map(runtime.config.servers.map((server) => [server.pterodactylServerId, server]));
    runtime.config.servers = next.config.servers.map((server) => {
      const previous = previousServers.get(server.pterodactylServerId);
      if (!previous) return server;
      if (!server.publicAddress) server.publicAddress = previous.publicAddress;
      if (!server.publicPort) server.publicPort = previous.publicPort;
      if (server.game.type === "satisfactory" && !server.game.apiUrl) server.game.apiUrl = previous.game.apiUrl;
      return Object.assign(previous, server);
    });
    pterodactylClient.baseUrl = (next.config.pterodactyl.baseUrl ?? "https://not-configured.invalid").replace(/\/+$/, "");
    pterodactylClient.apiKey = next.config.pterodactyl.apiKey;
    bridgeAdminController.guildId = next.config.discord.guildId;
    statusSyncService.onConfigReloaded();
    if (!runtime.config.setupMode && discordBridge.client.isReady()) {
      if (waitForStatus) {
        if (!statusSyncService.started) await statusSyncService.start();
        else if (!statusSyncService.activeSync) await statusSyncService.syncOnce({ force: true, reason: "bridge-settings" });
      } else if (!statusSyncService.started) {
        void statusSyncService.start().catch(error => logger.error("Monitoring startup failed", error));
      } else statusSyncService.requestSync({ force: true, reason: "bridge-settings" });
    }
  }
  const bridgeSetupController = new BridgeSetupController({
    discordBridge, configStore, guildId: runtime.config.discord.guildId, logger,
    async onSetup(guild) {
      await reconcile({ waitForStatus: false });
      await bridgeAdminController.updateOverview(guild);
      void bridgeAdminController.refreshCards(guild).catch(error => logger.error("Initial administration discovery failed", error));
    }
  });
  const administrationCoordinator = new AdministrationConfigurationCoordinator({ eventBus, applyRuntime: () => reconcile({ waitForStatus: false }) });
  bridgeAdminController = new GuidedAdminController({
    discordBridge, configStore, config: runtime.config, pterodactylClient,
    syncService: statusSyncService, guildId: runtime.config.discord.guildId, logger,
    stateStore, eventBus, administrationCoordinator, reconcile: () => reconcile({ waitForStatus: false }), onConfigurationChanged: () => reconcile({ waitForStatus: false })
  });

  discordPlatformListener.start();
  kookPlatformListener?.start();
  statusSyncService.registerDiscordInputs();
  bridgeSetupController.start();
  bridgeAdminController.start();
  discordBridge.setSlashCommands([...DISCORD_SLASH_COMMANDS, {
    ...BRIDGE_SETUP_COMMAND,
    options: [...BRIDGE_SETUP_COMMAND.options, ...BRIDGE_ADMIN_COMMANDS, ...GUIDED_ADMIN_COMMANDS]
  }]);

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  discordBridge.client.once(Events.ClientReady, () => {
    void (async () => {
      if (!runtime.config.setupMode) await statusSyncService.start();
      await bridgeAdminController.ready();
      const reportSetup = () => {
        if (runtime.config.setupMode && discordBridge.client.isReady()) {
          writeHeartbeat(getHeartbeatPath(), logger);
          writeSyncHealth({ mode: "setup", healthy: true, completedAt: new Date().toISOString(), servers: [] }, getSyncHealthPath(), logger);
        }
      };
      reportSetup();
      setupHeartbeat = setInterval(reportSetup, 30_000);
      setupHeartbeat.unref();
      logger.info("Bridge ready");
    })().then(resolveReady).catch((error) => { rejectReady(error); logger.error("Discord initialization failed", error); void shutdown("STARTUP_FAILED", 1); });
  });
  await discordBridge.start();
  await kookBridge?.start();

  const logChannelId = runtime.config.discord.logChannelId;
  if (logChannelId) {
    logger.attachDiscordSink((content) => discordBridge.sendMessage(logChannelId, content));
    logger.info("Discord log sink attached", {
      guildId: runtime.config.discord.guildId,
      statusChannelId: runtime.config.discord.statusChannelId,
      logChannelId,
      kookEnabled: Boolean(kookBridge),
      kookGuildId: runtime.config.kook?.guildId ?? null,
      kookStatusChannelId: runtime.config.kook?.statusChannelId ?? null,
      serverCount: runtime.config.servers.length,
      pollIntervalSeconds: runtime.config.pterodactyl.pollIntervalSeconds,
      activePlayerPollIntervalSeconds: runtime.config.pterodactyl.activePlayerPollIntervalSeconds,
      servers: runtime.config.servers.map((server) => ({
        name: server.name,
        type: server.game.type,
        discordChannelId: server.discordChannelId,
        kookChannelId: server.kookChannelId,
        pterodactylServerId: server.pterodactylServerId,
        autoStopEnabled: Boolean(server.autoStop?.enabled),
        discordRelayEnabled: Boolean(server.game.chatCommandTemplate)
      }))
    });
  }

  const context = { runtime, configStore, discordBridge, bridgeSetupController, bridgeAdminController, statusSyncService, reconcile, ready, shutdown };
  if (runtime.managed || configStore.document?.source === "managed") return context;

  configReloadService = new (services.ConfigReloadService ?? ConfigReloadService)({
    configPath: getConfigPath(),
    loadConfig,
    logger,
    async onReload(nextConfig, nextRawConfig) {
      if (configStore.document?.source === "managed") return;
      if (configStore.available) {
        nextConfig.pterodactyl.apiKey = configStore.getConnectionKey();
        nextConfig.servers.push(...configStore.getManagedServers()
          .map(normalizeServer));
      }
      await hydrateServerNetworkConfig({
        config: nextConfig,
        pterodactylClient,
        logger
      });
      applyReloadedConfig(runtime.config, nextConfig);
      statusSyncService.onConfigReloaded();
      configStore.syncLegacyConfig(nextRawConfig);
      await statusSyncService.syncOnce({ force: true });
      statusSyncService.refreshPeriodicSchedule();
    }
  });
  configReloadService.start();
  return context;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  defaultLogger.error("Fatal startup error", error);
  process.exit(1);
});
