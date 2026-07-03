import "dotenv/config";
import { CoreEventBus } from "./core/core-events.js";
import { getConfigPath, loadConfig } from "./lib/config.js";
import { isKookEnabled } from "./lib/kook-config.js";
import { logger } from "./lib/logger.js";
import { StateStore } from "./lib/state-store.js";
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
  const stateStore = new StateStore();
  stateStore.load();
  const eventBus = new CoreEventBus();
  const pterodactylClient = new PterodactylClient(runtime.config.pterodactyl);
  await hydrateServerNetworkConfig({
    config: runtime.config,
    pterodactylClient,
    logger
  });

  const discordBridge = new DiscordBridge({
    token: runtime.discordToken,
    guildId: runtime.config.discord.guildId,
    stateStore,
    logger
  });
  const kookBridge = isKookEnabled()
    ? new KookBridge({
      token: runtime.kookToken,
      guildId: runtime.config.kook.guildId,
      logger
    })
    : null;
  const discordPlatformListener = new DiscordPlatformListener({
    eventBus,
    discordBridge,
    config: runtime.config
  });
  const kookPlatformListener = kookBridge
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
  const statusSyncService = new StatusSyncService({
    config: runtime.config,
    discordBridge,
    kookBridge,
    eventBus,
    pterodactylClient,
    autoStopService,
    stateStore,
    logger
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

  const configReloadService = new ConfigReloadService({
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
      await statusSyncService.syncOnce({ force: true });
      statusSyncService.refreshPeriodicSchedule();
    }
  });
  configReloadService.start();

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down.`);
    configReloadService.stop();
    await statusSyncService.stop();
    kookPlatformListener?.stop();
    discordPlatformListener.stop();
    await kookBridge?.stop();
    await discordBridge.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
