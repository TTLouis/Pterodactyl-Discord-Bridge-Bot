import "dotenv/config";
import fs from "node:fs";
import { FactorioAdapter } from "../src/adapters/factorio-adapter.js";
import { MinecraftAdapter } from "../src/adapters/minecraft-adapter.js";
import { SatisfactoryAdapter } from "../src/adapters/satisfactory-adapter.js";
import { getConfigPath, loadConfig } from "../src/lib/config.js";
import { normalizeKookConfigId, requireKookEnabled } from "../src/lib/kook-config.js";
import { buildKookStatusPanel } from "../src/lib/kook-card-formatters.js";
import { logger } from "../src/lib/logger.js";
import { PterodactylClient } from "../src/services/pterodactyl-client.js";
import { hydrateServerNetworkConfig } from "../src/services/server-network-config.js";

const API_BASE_URL = (process.env.KOOK_API_BASE_URL ?? "https://www.kookapp.cn/api/v3").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readRawConfig() {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
}

function resolveStatusChannelId(rawConfig) {
  return normalizeKookConfigId(process.env.KOOK_STATUS_CHANNEL_ID)
    || normalizeKookConfigId(rawConfig.kook?.statusChannelId);
}

function resolveLogChannelId(rawConfig) {
  return normalizeKookConfigId(rawConfig.kook?.logChannelId);
}

function resolveDisplayTimeZone(rawConfig) {
  return process.env.KOOK_DISPLAY_TIMEZONE
    ?? rawConfig.kook?.displayTimeZone
    ?? "Asia/Shanghai";
}

function createAdapter(server, pterodactylClient) {
  switch (server.game.type) {
    case "factorio":
      return new FactorioAdapter({ serverConfig: server, pterodactylClient });
    case "minecraft":
      return new MinecraftAdapter({ serverConfig: server, pterodactylClient });
    case "satisfactory":
      return new SatisfactoryAdapter({ serverConfig: server, logger });
    default:
      throw new Error(`Unsupported server type: ${server.game.type}`);
  }
}

async function fetchLiveSnapshots(config, pterodactylClient) {
  const snapshots = [];
  const failures = [];

  for (const server of config.servers) {
    const adapter = createAdapter(server, pterodactylClient);
    try {
      const resources = await pterodactylClient.getServerResources(server.pterodactylServerId);
      const snapshot = await adapter.fetchSnapshot(resources);
      snapshots.push(snapshot);
      console.log(`Snapshot OK: ${server.name} (${snapshot.simplifiedStatus}, ${snapshot.playerCount ?? 0}/${snapshot.maxPlayers ?? "?"})`);
    } catch (error) {
      failures.push({ server: server.name, message: error.message });
      console.log(`Snapshot failed: ${server.name}: ${error.message}`);
    } finally {
      adapter.stop?.();
    }
  }

  if (snapshots.length === 0) {
    throw new Error(`No live snapshots could be fetched. Failures: ${JSON.stringify(failures)}`);
  }

  return { snapshots, failures };
}

async function kookPost(token, endpoint, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Accept-Language": "en-US",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 0) {
      const message = body?.message ?? response.statusText;
      throw new Error(`${endpoint} failed (${response.status}): ${message}`);
    }

    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  requireKookEnabled();
  const token = requireEnv("KOOK_TOKEN");
  const rawConfig = readRawConfig();
  const statusChannelId = resolveStatusChannelId(rawConfig);
  const logChannelId = resolveLogChannelId(rawConfig);
  if (!statusChannelId) {
    throw new Error("Missing KOOK status channel id. Set kook.statusChannelId in servers.json or KOOK_STATUS_CHANNEL_ID in .env.");
  }

  const runtime = loadConfig();
  const pterodactylClient = new PterodactylClient(runtime.config.pterodactyl);
  await hydrateServerNetworkConfig({
    config: runtime.config,
    pterodactylClient,
    logger
  });
  const { snapshots, failures } = await fetchLiveSnapshots(runtime.config, pterodactylClient);
  const panel = buildKookStatusPanel(snapshots, {
    displayTimeZone: resolveDisplayTimeZone(rawConfig)
  });
  const result = await kookPost(token, "/message/create", {
    ...panel,
    target_id: statusChannelId
  });

  console.log(`KOOK live status message sent: ${result.msg_id}`);
  if (logChannelId) {
    await kookPost(token, "/message/create", {
      type: 9,
      target_id: logChannelId,
      content: `KOOK 实时状态已发布：${snapshots.length} 个服务器，${failures.length} 个失败，消息 ${result.msg_id}`
    });
    console.log("KOOK log summary sent.");
  }

  if (failures.length > 0) {
    console.log(`Completed with ${failures.length} snapshot failure(s).`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
