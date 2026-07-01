import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { normalizeKookConfigId, requireKookEnabled } from "../src/lib/kook-config.js";

const API_BASE_URL = (process.env.KOOK_API_BASE_URL ?? "https://www.kookapp.cn/api/v3").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;
const GATEWAY_TIMEOUT_MS = 10_000;

function getArgFlag(name) {
  return process.argv.includes(name);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadRawConfig() {
  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./servers.json");
  if (!fs.existsSync(configPath)) {
    return { configPath, config: {} };
  }

  return {
    configPath,
    config: JSON.parse(fs.readFileSync(configPath, "utf8"))
  };
}

function unique(values) {
  return [...new Set(values.map(normalizeKookConfigId).filter(Boolean))];
}

function formatOptional(value) {
  return value || "(not configured)";
}

async function kookGet(token, endpoint, params = {}) {
  const url = new URL(`${API_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
        "Accept-Language": "en-US"
      },
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

async function testGateway(gatewayUrl) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(gatewayUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for KOOK gateway hello packet."));
    }, GATEWAY_TIMEOUT_MS);

    socket.once("message", (data) => {
      try {
        const payload = JSON.parse(data.toString("utf8"));
        if (payload.s !== 1 || payload.d?.code !== 0) {
          reject(new Error(`Unexpected gateway hello: ${JSON.stringify(payload)}`));
          return;
        }

        console.log(`Gateway hello OK: session ${payload.d.session_id}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        clearTimeout(timeout);
        socket.close();
      }
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  requireKookEnabled();
  const includeGateway = getArgFlag("--gateway");
  const token = requireEnv("KOOK_TOKEN");
  const { configPath, config } = loadRawConfig();
  const kookConfig = config.kook ?? {};
  const guildId = process.env.KOOK_GUILD_ID?.trim() || kookConfig.guildId || null;
  const configuredChannelIds = unique([
    process.env.KOOK_STATUS_CHANNEL_ID?.trim() || kookConfig.statusChannelId,
    kookConfig.logChannelId,
    ...(Array.isArray(config.servers) ? config.servers.map((server) => server.kookChannelId) : [])
  ]);

  console.log(`KOOK API base: ${API_BASE_URL}`);
  console.log(`Config path: ${configPath}`);
  console.log(`Configured guild: ${formatOptional(guildId)}`);
  console.log(`Configured channels: ${configuredChannelIds.length}`);

  const me = await kookGet(token, "/user/me");
  console.log(`Auth OK: ${me.username}#${me.identify_num} (${me.id})`);

  const guilds = await kookGet(token, "/guild/list", { page_size: 10 });
  console.log(`Guild list OK: ${guilds.items?.length ?? 0}/${guilds.meta?.total ?? "?"} returned`);

  if (guildId) {
    const guild = await kookGet(token, "/guild/view", { guild_id: guildId });
    console.log(`Guild view OK: ${guild.name} (${guild.id})`);

    const channels = await kookGet(token, "/channel/list", {
      guild_id: guildId,
      type: 1,
      page_size: 50
    });
    console.log(`Text channel list OK: ${channels.items?.length ?? 0}/${channels.meta?.total ?? "?"} returned`);
  }

  for (const channelId of configuredChannelIds) {
    try {
      const channel = await kookGet(token, "/channel/view", { target_id: channelId });
      console.log(`Channel view OK: ${channel.name} (${channel.id}, type ${channel.type})`);
    } catch (error) {
      throw new Error(`Channel view failed for ${channelId}: ${error.message}`);
    }
  }

  const gateway = await kookGet(token, "/gateway/index", { compress: 0 });
  console.log("Gateway URL fetch OK");

  if (includeGateway) {
    await testGateway(gateway.url);
  } else {
    console.log("Gateway WebSocket check skipped. Use --gateway to test the hello packet.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
