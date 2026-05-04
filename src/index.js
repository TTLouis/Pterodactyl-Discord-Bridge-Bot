import "dotenv/config";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { StateStore } from "./lib/state-store.js";
import { AutoStopService } from "./services/auto-stop-service.js";
import { DiscordBridge } from "./services/discord-bridge.js";
import { PterodactylClient } from "./services/pterodactyl-client.js";
import { StatusSyncService } from "./services/status-sync-service.js";

async function main() {
  const runtime = loadConfig();
  const stateStore = new StateStore();
  stateStore.load();

  const discordBridge = new DiscordBridge({
    token: runtime.discordToken,
    guildId: runtime.config.discord.guildId,
    stateStore,
    logger
  });
  const pterodactylClient = new PterodactylClient(runtime.config.pterodactyl);
  const autoStopService = new AutoStopService({
    config: runtime.config,
    pterodactylClient,
    discordBridge,
    stateStore,
    logger
  });
  const statusSyncService = new StatusSyncService({
    config: runtime.config,
    discordBridge,
    pterodactylClient,
    autoStopService,
    logger
  });

  await discordBridge.start();

  const logChannelId = runtime.config.discord.logChannelId;
  if (logChannelId) {
    logger.attachDiscordSink((content) => discordBridge.sendMessage(logChannelId, content));
    logger.info("Discord log sink attached");
  }

  await statusSyncService.start();

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down.`);
    await statusSyncService.stop();
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
