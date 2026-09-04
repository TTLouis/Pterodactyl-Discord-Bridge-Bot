import "dotenv/config";
import { CoreEventBus } from "./core/core-events.js";
import { getConfigPath, loadConfig } from "./lib/config.js";
import { isKookEnabled } from "./lib/kook-config.js";
import { logger } from "./lib/logger.js";
import { getHeartbeatPath, writeHeartbeat } from "./lib/heartbeat.js";
import { getSyncHealthPath, writeSyncHealth } from "./lib/sync-health.js";
import { getStatePath, StateStore } from "./lib/state-store.js";
import { AutoStopService } from "./services/auto-stop-service.js";
import { applyReloadedConfig, ConfigReloadService } from "./services/config-reload-service.js";
import { DiscordBridge } from "./services/discord-bridge.js";
import { KookBridge } from "./services/kook-bridge.js";
import { PterodactylClient } from "./services/pterodactyl-client.js";
import { hydrateServerNetworkConfig } from "./services/server-network-config.js";
import { StatusSyncService } from "./services/status-sync-service.js";
import { DiscordPlatformListener } from "./platforms/discord-platform-listener.js";
import { KookPlatformListener } from "./platforms/kook-platform-listener.js";

async function main() {
  const runtime = loadConfig();
  const stateStore = new StateStore(getStatePath(), { logger });
  stateStore.load();
  const eventBus = new CoreEventBus();
  const pterodactylClient = new PterodactylClient(runtime.config.pterodactyl);

  // Declared up front so shutdown() is safe to call at any point during startup,
  // including from the process-level error handlers registered below.
  let discordBridge = null;
  let kookBridge = null;
  let discordPlatformListener = null;
  let kookPlatformListener = null;
  let statusSyncService = null;
  let configReloadService = null;
  let shuttingDown = false;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}. Shutting down.`);

    try {
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

    process.exit(exitCode);
  }

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

  await hydrateServerNetworkConfig({
    config: runtime.config,
    pterodactylClient,
    logger
  });

  discordBridge = new DiscordBridge({
    token: runtime.discordToken,
    guildId: runtime.config.discord.guildId,
    stateStore,
    logger,
    isWatchedChannel: (channelId) => runtime.config.servers.some(
      (server) => !server.archived && server.discordChannelId === channelId
    )
  });
  kookBridge = isKookEnabled()
    ? new KookBridge({
      token: runtime.kookToken,
      guildId: runtime.config.kook.guildId,
      logger
    })
    : null;
  discordPlatformListener = new DiscordPlatformListener({
    eventBus,
    discordBridge,
    config: runtime.config,
    logger
  });
  kookPlatformListener = kookBridge
    ? new KookPlatformListener({
      eventBus,
      kookBridge,
      config: runtime.config,
      logger
    })
    : null;
  const autoStopService = new AutoStopService({
    config: runtime.config,
    pterodactylClient,
    eventBus,
    stateStore,
    logger
  });
  statusSyncService = new StatusSyncService({
    config: runtime.config,
    discordBridge,
    kookBridge,
    eventBus,
    pterodactylClient,
    autoStopService,
    stateStore,
    logger,
    onRestartRequested({ requestedBy }) {
      logger.info("Restarting bot after Discord command", { requestedBy });
      void shutdown("BOT_RESTART_REQUESTED");
    },
    onSyncCompleted(summary) {
      writeHeartbeat(getHeartbeatPath(), logger);
      writeSyncHealth(summary, getSyncHealthPath(), logger);
    }
  });

  discordPlatformListener.start();
  kookPlatformListener?.start();

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

  await statusSyncService.start();

  configReloadService = new ConfigReloadService({
    configPath: getConfigPath(),
    loadConfig,
    logger,
    async onReload(nextConfig) {
      await hydrateServerNetworkConfig({
        config: nextConfig,
        pterodactylClient,
        logger
      });
      applyReloadedConfig(runtime.config, nextConfig);
      statusSyncService.onConfigReloaded();
      await statusSyncService.syncOnce({ force: true });
      statusSyncService.refreshPeriodicSchedule();
    }
  });
  configReloadService.start();
}

main().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
