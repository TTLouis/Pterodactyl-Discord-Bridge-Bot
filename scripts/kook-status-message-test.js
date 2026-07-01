import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { buildKookStatusPanel } from "../src/lib/kook-card-formatters.js";
import { normalizeKookConfigId, requireKookEnabled } from "../src/lib/kook-config.js";
import { normalizeDescription } from "../src/lib/config.js";

const API_BASE_URL = (process.env.KOOK_API_BASE_URL ?? "https://www.kookapp.cn/api/v3").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getConfigPath() {
  return path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./servers.json");
}

function normalizeAsciiTitle(server) {
  if (typeof server.asciiTitle === "string") {
    const value = server.asciiTitle.trim();
    return value ? value : null;
  }

  if (Array.isArray(server.asciiTitleLines)) {
    const value = server.asciiTitleLines.map((line) => String(line ?? "")).join("\n").trim();
    return value ? value : null;
  }

  return null;
}

function resolveDisplayTimeZone(config) {
  return process.env.KOOK_DISPLAY_TIMEZONE
    ?? config.kook?.displayTimeZone
    ?? "Asia/Shanghai";
}

function resolveStatusChannelId(config) {
  return process.env.KOOK_STATUS_CHANNEL_ID?.trim()
    || normalizeKookConfigId(config.kook?.statusChannelId)
    || null;
}

function buildSampleSnapshots(servers) {
  const statuses = ["Online", "Starting", "Offline", "Stopping"];
  return servers.map((server, index) => {
    const status = statuses[index % statuses.length];
    const maxPlayers = server.maxPlayers ?? (server.game?.type === "satisfactory" ? 16 : 20);
    const playerCount = status === "Online" ? Math.max(1, Math.min(3, maxPlayers)) : 0;

    return {
      name: server.name,
      asciiTitle: normalizeAsciiTitle(server),
      description: normalizeDescription(server),
      publicAddress: server.publicAddress ?? "",
      publicPort: server.publicPort ?? null,
      maxPlayers,
      currentState: status.toLowerCase(),
      simplifiedStatus: status,
      playerCount,
      playerNamesAvailable: server.game?.type !== "satisfactory",
      onlinePlayers: status === "Online" && server.game?.type !== "satisfactory"
        ? ["Ada", "Grace", "Linus"].slice(0, playerCount)
        : [],
      memoryBytes: (1024 + index * 384) * 1024 * 1024,
      cpuPercent: Number((8.5 + index * 5.25).toFixed(2)),
      gameDurationMs: (index + 1) * 3 * 3600 * 1000 + 42 * 60 * 1000,
      satisfactoryState: server.game?.type === "satisfactory"
        ? {
            techTier: 5,
            gamePhase: "第三阶段",
            activeSchematic: "多功能框架"
          }
        : null
    };
  });
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
  const dryRun = getArgFlag("--dry-run");
  if (!dryRun) {
    requireKookEnabled();
  }
  const token = dryRun ? process.env.KOOK_TOKEN?.trim() : requireEnv("KOOK_TOKEN");
  const configPath = getConfigPath();
  const config = readJsonFile(configPath);
  const statusChannelId = resolveStatusChannelId(config);
  if (!statusChannelId) {
    throw new Error("Missing KOOK status channel id. Set kook.statusChannelId in servers.json or KOOK_STATUS_CHANNEL_ID in .env.");
  }

  const snapshots = buildSampleSnapshots(config.servers ?? []);
  const panel = buildKookStatusPanel(snapshots, {
    displayTimeZone: resolveDisplayTimeZone(config)
  });
  const payload = {
    ...panel,
    target_id: statusChannelId
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const result = await kookPost(token, "/message/create", payload);
  console.log(`KOOK status test message sent: ${result.msg_id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
