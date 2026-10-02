import { CHAT_RELAY_CAPTURE_MS } from "../lib/relay-limits.js";

function normalizeLine(line) {
  return String(line ?? "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

// Source 1 status responses vary between branches. Require a complete player
// table so truncated output can never establish a reliable empty server.
export function parseSourceStatus(lines) {
  const normalized = lines.flatMap(line => String(line ?? "").split(/\r?\n/)).map(normalizeLine);
  const headerIndex = normalized.findIndex(line => /^players\s*:/i.test(line));
  if (headerIndex < 0) return null;
  const header = normalized[headerIndex];
  const modern = header.match(/^players\s*:\s*(\d+) humans?,\s*(\d+) bots?\s*\((\d+) max\)/i);
  const legacy = header.match(/^players\s*:\s*(\d+)\s*\((\d+) max\)/i);
  if (!modern && !legacy) return null;
  const total = modern ? Number(modern[1]) + Number(modern[2]) : Number(legacy[1]);
  const maxPlayers = Number(modern ? modern[3] : legacy[2]);
  if (total > maxPlayers) return null;
  const entries = [];
  const ids = new Set();
  for (const line of normalized.slice(headerIndex + 1)) {
    // Some branches include an extra numeric slot before the quoted name.
    const match = line.match(/^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)(?:\s|$)/);
    if (!match) continue;
    if (ids.has(match[1]) || !match[2].trim()) return null;
    ids.add(match[1]);
    entries.push({ name: match[2], bot: match[3] === "BOT" });
    if (entries.length === total) break;
  }
  if (entries.length !== total) return null;
  const players = entries.filter(entry => !entry.bot).map(entry => entry.name);
  if (modern && players.length !== Number(modern[1])) return null;
  return { players, playerCount: players.length, maxPlayers };
}

const LOG_PREFIX = /^L \d{2}\/\d{2}\/\d{4} - \d{2}:\d{2}:\d{2}:\s*/;
const PLAYER_ID = '"(.*)<\\d+><[^<>]*><[^<>]*>"';
const CHAT = new RegExp(`^${PLAYER_ID} say "(.*)"$`);
const PLAYER_EVENT = new RegExp(`^${PLAYER_ID} (?:connected,|entered the game|disconnected|changed name to)`);

export class SourceAdapter {
  constructor({ serverConfig, pterodactylClient }) {
    this.serverConfig = serverConfig;
    this.pterodactylClient = pterodactylClient;
    this.onlinePlayers = null;
    this.playerCountReliable = false;
    this.maxPlayers = serverConfig.maxPlayers;
    this.playerEventRevision = 0;
    this.playerListRefreshPromise = null;
    this.backupRefreshHandle = null;
  }

  supportsConsoleSubscription() { return true; }
  supportsChatRelay() { return Boolean(this.serverConfig.game.chatCommandTemplate); }
  shouldRefreshOnlinePlayersOnConsoleConnect() { return true; }

  start() {
    if (this.backupRefreshHandle) return;
    const seconds = Number(this.serverConfig.game.playerListRefreshIntervalSeconds);
    this.backupRefreshHandle = setInterval(() => {
      if (this.onlinePlayers !== null) void this.refreshOnlinePlayers().catch(() => {});
    }, (Number.isFinite(seconds) && seconds > 0 ? seconds : 900) * 1000);
  }

  stop() {
    clearInterval(this.backupRefreshHandle);
    this.backupRefreshHandle = null;
    this.playerEventRevision += 1;
    this.playerCountReliable = false;
  }

  async refreshOnlinePlayers() {
    if (this.playerListRefreshPromise) return this.playerListRefreshPromise;
    this.playerListRefreshPromise = (async () => {
      const revision = this.playerEventRevision;
      const lines = await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, "status");
      const parsed = parseSourceStatus(lines);
      if (parsed && revision === this.playerEventRevision) {
        this.onlinePlayers = parsed.players;
        this.maxPlayers = parsed.maxPlayers;
        this.playerCountReliable = true;
      } else this.playerCountReliable = false;
      return this.onlinePlayers ?? [];
    })();
    try {
      return await this.playerListRefreshPromise;
    } catch (error) {
      this.playerCountReliable = false;
      throw error;
    } finally {
      this.playerListRefreshPromise = null;
    }
  }

  async fetchSnapshot(resources, { forcePlayerRefresh = false } = {}) {
    if (resources.currentState !== "running") {
      this.onlinePlayers = null;
      this.playerCountReliable = false;
      this.playerEventRevision += 1;
      this.maxPlayers = this.serverConfig.maxPlayers;
    } else {
      try {
        if (this.playerListRefreshPromise) await this.playerListRefreshPromise;
        else if (this.onlinePlayers === null || !this.playerCountReliable || forcePlayerRefresh) await this.refreshOnlinePlayers();
      } catch { this.playerCountReliable = false; }
    }
    const players = resources.currentState === "running" ? this.onlinePlayers ?? [] : [];
    return {
      name: this.serverConfig.name,
      asciiTitle: this.serverConfig.asciiTitle,
      description: this.serverConfig.description,
      publicAddress: this.serverConfig.publicAddress,
      publicPort: this.serverConfig.publicPort,
      maxPlayers: this.maxPlayers,
      channelId: this.serverConfig.discordChannelId,
      currentState: resources.currentState,
      simplifiedStatus: ({ running: "Online", starting: "Starting", stopping: "Stopping", offline: "Offline" })[resources.currentState] ?? resources.currentState,
      playerCount: players.length,
      playerCountReliable: resources.currentState !== "running" || this.playerCountReliable,
      onlinePlayers: [...players],
      cpuPercent: resources.cpuPercent,
      memoryBytes: resources.memoryBytes,
      uptimeMs: resources.uptimeMs,
      gameDurationMs: null
    };
  }

  shouldRefreshOnlinePlayers(line) {
    const value = normalizeLine(line).replace(LOG_PREFIX, "");
    return PLAYER_EVENT.test(value) || /^World triggered "(?:Round_Start|Game_Commencing)"/.test(value)
      || /^Started map "/.test(value);
  }

  applyPlayerEvent(line) {
    if (!this.shouldRefreshOnlinePlayers(line)) return false;
    // User IDs and bot identities differ between games; status remains the
    // authority. Invalidate any in-flight response when membership changes.
    this.playerEventRevision += 1;
    this.playerCountReliable = false;
    return true;
  }

  parseConsoleChatLine(line) {
    const match = normalizeLine(line).replace(LOG_PREFIX, "").match(CHAT);
    if (!match) return null;
    const authorName = match[1].trim();
    const content = match[2].trim();
    if (!authorName || !content) return null;
    if (/^(?:server|console|server console)$/i.test(authorName) && /^\[(?:discord|kook)\]\s/i.test(content)) return null;
    // Team chat is deliberately excluded from public platform channels.
    return { authorName, content };
  }

  async handleChatMessage(message) { return this.handleChatCommand(message.command); }
  async handleChatCommand(command) {
    if (command) await this.pterodactylClient.runCommand(this.serverConfig.pterodactylServerId, command, { captureMs: CHAT_RELAY_CAPTURE_MS });
    return null;
  }
}
