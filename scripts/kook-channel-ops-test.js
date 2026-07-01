import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { normalizeKookConfigId, requireKookEnabled } from "../src/lib/kook-config.js";

const API_BASE_URL = (process.env.KOOK_API_BASE_URL ?? "https://www.kookapp.cn/api/v3").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 10_000;
const TEST_EMOJIS = ["🟢", "[#128994;]"];

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

function getConfigPath() {
  return path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./servers.json");
}

function readConfig() {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
}

function uniqueServerChannels(servers) {
  const seen = new Set();
  const channels = [];
  for (const server of servers) {
    const channelId = normalizeKookConfigId(server.kookChannelId);
    if (!channelId || seen.has(channelId)) {
      continue;
    }

    seen.add(channelId);
    channels.push({
      channelId,
      serverName: server.name
    });
  }

  return channels;
}

async function kookRequest(token, method, endpoint, payload = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const options = {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Accept-Language": "en-US"
    },
    signal: controller.signal
  };

  if (payload) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
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

async function kookGet(token, endpoint, params = {}) {
  const url = new URL(`${API_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const relative = `${url.pathname.replace(/^\/api\/v3/, "")}${url.search}`;
  return kookRequest(token, "GET", relative);
}

async function kookPost(token, endpoint, payload) {
  return kookRequest(token, "POST", endpoint, payload);
}

async function tryReactionCycle(token, messageId) {
  const errors = [];
  for (const emoji of TEST_EMOJIS) {
    try {
      await kookPost(token, "/message/add-reaction", { msg_id: messageId, emoji });
      const reactions = await kookGet(token, "/message/reaction-list", { msg_id: messageId, emoji });
      await kookPost(token, "/message/delete-reaction", { msg_id: messageId, emoji });
      return {
        ok: true,
        emoji,
        reactionCount: Array.isArray(reactions) ? reactions.length : reactions?.items?.length ?? 0
      };
    } catch (error) {
      errors.push(`${emoji}: ${error.message}`);
    }
  }

  return {
    ok: false,
    error: errors.join(" | ")
  };
}

async function runChannelTest(token, { channelId, serverName }, { keepMessages }) {
  const created = await kookPost(token, "/message/create", {
    type: 9,
    target_id: channelId,
    content: [
      "**KOOK bridge channel test**",
      `Server: **${serverName}**`,
      "Step: create"
    ].join("\n")
  });
  const messageId = created.msg_id;
  console.log(`Create OK: ${serverName} -> ${messageId}`);

  try {
    const viewed = await kookGet(token, "/message/view", { msg_id: messageId });
    console.log(`View OK: ${viewed.id ?? messageId}`);

    await kookPost(token, "/message/update", {
      msg_id: messageId,
      content: [
        "**KOOK bridge channel test**",
        `Server: **${serverName}**`,
        "Step: update",
        "This validates the replace/edit path."
      ].join("\n")
    });
    console.log(`Update OK: ${messageId}`);

    const reaction = await tryReactionCycle(token, messageId);
    if (reaction.ok) {
      console.log(`Reaction cycle OK: ${messageId} using ${reaction.emoji} (${reaction.reactionCount} users listed)`);
    } else {
      console.log(`Reaction cycle skipped/failed: ${messageId} (${reaction.error})`);
    }
  } finally {
    if (keepMessages) {
      console.log(`Keeping test message: ${messageId}`);
    } else {
      await kookPost(token, "/message/delete", { msg_id: messageId });
      console.log(`Delete OK: ${messageId}`);
    }
  }
}

async function main() {
  requireKookEnabled();
  const keepMessages = getArgFlag("--keep");
  const token = requireEnv("KOOK_TOKEN");
  const config = readConfig();
  const channels = uniqueServerChannels(config.servers ?? []);
  if (channels.length === 0) {
    throw new Error("No server kookChannelId values found in servers.json.");
  }

  console.log(`Testing ${channels.length} KOOK server channel(s).`);
  for (const channel of channels) {
    await runChannelTest(token, channel, { keepMessages });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
