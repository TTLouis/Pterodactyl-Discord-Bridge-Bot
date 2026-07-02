import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { CoreEvents } from "../src/core/core-events.js";
import {
  AutoStopService,
  CANCEL_AUTO_STOP_REACTION,
  RESTART_SERVER_REACTION,
  canRestartExternallyStoppedServer
} from "../src/services/auto-stop-service.js";
import { getStatusRefreshIntervalMs, StatusSyncService } from "../src/services/status-sync-service.js";

function createRecordingEventBus({ returnDiscordMessages = false } = {}) {
  const events = [];
  let nextMessageId = 1;
  return {
    events,
    eventBus: {
      async emit(name, payload) {
        events.push({ name, payload });
        if (returnDiscordMessages && name === CoreEvents.SERVER_ACTION_MESSAGE) {
          return [{ platform: "discord", message: { id: `message-${nextMessageId++}` } }];
        }
        return [];
      }
    }
  };
}

function interactionWith({ administrator = false, roles = [] } = {}) {
  return {
    member: {
      permissions: {
        has(permission) {
          return permission === PermissionFlagsBits.Administrator && administrator;
        }
      },
      roles: {
        cache: new Map(roles.map((role) => [role.id, role]))
      }
    }
  };
}

test("Discord administrators can restart externally stopped servers", () => {
  const allowed = canRestartExternallyStoppedServer(interactionWith({ administrator: true }), {
    serverAdminRoleId: null,
    serverAdminRoleName: "server-admin"
  });

  assert.equal(allowed, true);
});

test("configured server-admin role ID can restart externally stopped servers", () => {
  const allowed = canRestartExternallyStoppedServer(interactionWith({
    roles: [{ id: "role-123", name: "Operators" }]
  }), {
    serverAdminRoleId: "role-123",
    serverAdminRoleName: "server-admin"
  });

  assert.equal(allowed, true);
});

test("server-admin role name matching is case-insensitive", () => {
  const allowed = canRestartExternallyStoppedServer(interactionWith({
    roles: [{ id: "role-456", name: "Server-Admin" }]
  }), {
    serverAdminRoleId: null,
    serverAdminRoleName: "server-admin"
  });

  assert.equal(allowed, true);
});

test("members without an authorized role cannot restart externally stopped servers", () => {
  const allowed = canRestartExternallyStoppedServer(interactionWith({
    roles: [{ id: "role-789", name: "Member" }]
  }), {
    serverAdminRoleId: "role-123",
    serverAdminRoleName: "server-admin"
  });

  assert.equal(allowed, false);
});

function createStartCommandService(autoStopState) {
  let powerRequests = 0;
  let clearedStates = 0;
  const { eventBus } = createRecordingEventBus();
  const service = new AutoStopService({
    config: {
      discord: {
        serverAdminRoleId: "role-123",
        serverAdminRoleName: "server-admin"
      }
    },
    pterodactylClient: {
      async getServerResources() {
        return { currentState: "offline" };
      },
      async setPowerState() {
        powerRequests += 1;
      }
    },
    eventBus,
    stateStore: {
      getAutoStopState() {
        return autoStopState;
      },
      getActionMessageId() {
        return null;
      },
      clearAutoStopState() {
        clearedStates += 1;
      }
    },
    logger: { error() {} }
  });

  return {
    service,
    getPowerRequests: () => powerRequests,
    getClearedStates: () => clearedStates
  };
}

function unauthorizedStartInteraction() {
  return {
    ...interactionWith({ roles: [{ id: "member-role", name: "Member" }] }),
    user: { username: "Test User" },
    async reply() {},
    async followUp() {}
  };
}

test("everyone can restart a server stopped by inactivity auto-stop", async () => {
  const { service, getPowerRequests, getClearedStates } = createStartCommandService({ stoppedByBot: true });

  const started = await service.handleStartCommand({
    name: "Test Server",
    pterodactylServerId: "server-id"
  }, unauthorizedStartInteraction());

  assert.equal(started, true);
  assert.equal(getPowerRequests(), 1);
  assert.equal(getClearedStates(), 1);
});

test("unauthorized members cannot restart a manually stopped server", async () => {
  const { service, getPowerRequests, getClearedStates } = createStartCommandService({ manualStop: true });

  const started = await service.handleStartCommand({
    name: "Test Server",
    pterodactylServerId: "server-id"
  }, unauthorizedStartInteraction());

  assert.equal(started, false);
  assert.equal(getPowerRequests(), 0);
  assert.equal(getClearedStates(), 0);
});

function createAutoStopService({ autoStopState = {}, resources = { currentState: "offline" } } = {}) {
  const events = [];
  const powerRequests = [];
  let actionMessageId = null;
  let nextMessageId = 1;
  const state = { ...autoStopState };
  const runtimeState = {};
  const service = new AutoStopService({
    config: {
      discord: {
        serverAdminRoleId: "role-123",
        serverAdminRoleName: "server-admin"
      }
    },
    pterodactylClient: {
      async getServerResources() {
        return resources;
      },
      async setPowerState(serverId, powerState) {
        powerRequests.push({ serverId, powerState });
      }
    },
    eventBus: {
      async emit(name, payload) {
        events.push({ name, payload });
        if (name === CoreEvents.SERVER_ACTION_MESSAGE) {
        const message = { id: `message-${nextMessageId++}` };
        actionMessageId = message.id;
          return [{ platform: "discord", message }];
        }
        return [];
      }
    },
    stateStore: {
      getAutoStopState() {
        return state;
      },
      setAutoStopState(serverId, updates) {
        Object.assign(state, updates);
      },
      clearAutoStopState() {
        for (const key of Object.keys(state)) {
          delete state[key];
        }
      },
      getServerRuntimeState(serverId) {
        return runtimeState[serverId] ?? {};
      },
      setServerRuntimeState(serverId, updates) {
        runtimeState[serverId] = { ...(runtimeState[serverId] ?? {}), ...updates };
      },
      getActionMessageId() {
        return actionMessageId;
      }
    },
    logger: { error() {}, warn() {}, info() {} }
  });

  return {
    service,
    messages: events,
    powerRequests,
    state,
    runtimeState,
    setActionMessageId(value) {
      actionMessageId = value;
      const match = /^message-(\d+)$/.exec(value);
      if (match) {
        nextMessageId = Math.max(nextMessageId, Number(match[1]) + 1);
      }
    }
  };
}

const autoStopServer = {
  name: "Factory",
  discordChannelId: "factory-channel",
  pterodactylServerId: "factory-id",
  autoStop: {
    enabled: true,
    emptyTimeoutHours: 1,
    warningMinutesBefore: 60
  }
};

test("auto-stop warning replaces the action message and adds the red cancel reaction", async () => {
  const { service, messages, state } = createAutoStopService({
    autoStopState: { lastNonEmptyAt: Date.now() - 1000 }
  });

  await service.onRunningSnapshot(autoStopServer, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].name, CoreEvents.SERVER_ACTION_MESSAGE);
  assert.equal(messages[0].payload.kind, "auto-stop-warning");
  assert.equal(messages[0].payload.server, autoStopServer);
  assert.equal(state.warningMessageId, "message-1");
  assert.equal(typeof state.warningSentAt, "number");
});

test("auto-stop sends a fresh restartable stopped message before stopping the server", async () => {
  const { service, messages, powerRequests, state } = createAutoStopService({
    autoStopState: { lastNonEmptyAt: Date.now() - 3600001 }
  });

  await service.onRunningSnapshot(autoStopServer, 0);

  assert.equal(messages[0].payload.kind, "auto-stopped");
  assert.deepEqual(powerRequests, [{ serverId: "factory-id", powerState: "stop" }]);
  assert.equal(state.stoppedByBot, true);
  assert.equal(state.warningMessageId, null);
});

test("red reaction cancels a pending auto-stop from the current action message", async () => {
  let removed = false;
  const { service, messages, state, setActionMessageId } = createAutoStopService({
    autoStopState: {
      lastNonEmptyAt: Date.now() - 1000,
      warningSentAt: Date.now() - 100,
      warningMessageId: "message-1"
    }
  });
  setActionMessageId("message-1");

  const cancelled = await service.handleCancelStopReaction(autoStopServer, {
    messageId: "message-1",
    emoji: CANCEL_AUTO_STOP_REACTION,
    userId: "user-1",
    displayName: "Tester",
    async removeUserReaction() {
      removed = true;
    }
  });

  assert.equal(cancelled, true);
  assert.equal(removed, true);
  assert.equal(state.warningSentAt, null);
  assert.equal(state.warningMessageId, null);
  assert.equal(messages.at(-1).payload.kind, "auto-stop-cancelled");
  assert.equal(messages.at(-1).payload.cancelledBy, "Tester");
});

test("green reaction starts an auto-stopped server from the current action message", async () => {
  let removed = false;
  const { service, messages, powerRequests, state, setActionMessageId } = createAutoStopService({
    autoStopState: { stoppedByBot: true }
  });
  setActionMessageId("message-1");

  const started = await service.handleStartReaction(autoStopServer, {
    messageId: "message-1",
    emoji: RESTART_SERVER_REACTION,
    userId: "user-1",
    displayName: "Tester",
    member: interactionWith(),
    async removeUserReaction() {
      removed = true;
    }
  });

  assert.equal(started, true);
  assert.equal(removed, true);
  assert.deepEqual(powerRequests, [{ serverId: "factory-id", powerState: "start" }]);
  assert.deepEqual(state, {});
  assert.equal(messages.at(-1).payload.kind, "server-starting-requested");
  assert.equal(messages.at(-1).payload.requestedBy, "Tester");
});

test("online action message includes the last successful start requester", async () => {
  const { service, messages } = createAutoStopService({
    autoStopState: { stoppedByBot: true }
  });

  const started = await service.handleStartCommand(autoStopServer, {
    member: {
      displayName: "Starter",
      permissions: { has() { return false; } },
      roles: { cache: new Map() }
    },
    user: { username: "Fallback" },
    async reply() {},
    async followUp() {}
  });
  await service.onCameOnline(autoStopServer);

  assert.equal(started, true);
  assert.equal(messages.at(-1).payload.kind, "server-online");
  assert.equal(messages.at(-1).payload.startInfo.startedBy, "Starter");
  assert.equal(typeof messages.at(-1).payload.startInfo.startedAt, "number");
});

function createStatusService(startRequested) {
  let interactionHandler = null;
  const { eventBus } = createRecordingEventBus();
  const discordBridge = {
    setSlashCommands() {},
    onMessage() {},
    onInteraction(handler) {
      interactionHandler = handler;
    },
    onReaction() {}
  };
  const autoStopService = {
    async handleStartCommand() {
      return startRequested;
    }
  };
  const logger = {
    error() {},
    warn() {},
    info() {}
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      servers: [{
        name: "Test Server",
        discordChannelId: "server-channel",
        pterodactylServerId: "server-id",
        game: { type: "minecraft", chatCommandTemplate: "/say {content}" },
        autoStop: null
      }]
    },
    discordBridge,
    eventBus,
    pterodactylClient: {},
    autoStopService,
    logger
  });

  return {
    service,
    getInteractionHandler() {
      return interactionHandler;
    }
  };
}

test("accepted start requests trigger an immediate forced status sync", async () => {
  const { service, getInteractionHandler } = createStatusService(true);
  const syncCalls = [];
  service.syncOnce = async (options) => syncCalls.push(options);

  await service.start();
  await getInteractionHandler()({ commandName: "start-server", channelId: "server-channel" });
  await service.stop();

  assert.deepEqual(syncCalls, [undefined, { force: true }]);
});

test("rejected or no-op start requests do not trigger an extra status sync", async () => {
  const { service, getInteractionHandler } = createStatusService(false);
  const syncCalls = [];
  service.syncOnce = async (options) => syncCalls.push(options);

  await service.start();
  await getInteractionHandler()({ commandName: "start-server", channelId: "server-channel" });
  await service.stop();

  assert.deepEqual(syncCalls, [undefined]);
});

function createRefreshCommandService() {
  let interactionHandler = null;
  const { eventBus } = createRecordingEventBus();
  const discordBridge = {
    setSlashCommands() {},
    onMessage() {},
    onInteraction(handler) {
      interactionHandler = handler;
    },
    onReaction() {}
  };
  const service = new StatusSyncService({
    config: {
      discord: {
        statusChannelId: "status",
        logChannelId: "logs",
        displayTimeZone: "UTC"
      },
      servers: [{
        name: "Test Server",
        discordChannelId: "server-channel",
        pterodactylServerId: "server-id",
        game: { type: "minecraft", chatCommandTemplate: "/say {content}" },
        autoStop: null
      }]
    },
    discordBridge,
    eventBus,
    pterodactylClient: {},
    autoStopService: {},
    logger: { error() {}, warn() {}, info() {} }
  });

  return {
    service,
    getInteractionHandler() {
      return interactionHandler;
    }
  };
}

test("refresh-status command in the log channel forces a manual status sync", async () => {
  const { service, getInteractionHandler } = createRefreshCommandService();
  const syncCalls = [];
  let deferred = false;
  let editReply = null;
  service.syncOnce = async (options) => syncCalls.push(options);

  await service.start();
  await getInteractionHandler()({
    commandName: "refresh-status",
    channelId: "logs",
    member: { displayName: "Operator" },
    user: { username: "operator" },
    async deferReply(options) {
      deferred = options.ephemeral;
    },
    async editReply(payload) {
      editReply = payload;
    }
  });
  await service.stop();

  assert.equal(deferred, true);
  assert.deepEqual(editReply, { content: "Status refresh completed for all configured game servers." });
  assert.deepEqual(syncCalls, [undefined, { force: true, reason: "manual" }]);
});

test("refresh-status command outside the log channel is rejected", async () => {
  const { service, getInteractionHandler } = createRefreshCommandService();
  const syncCalls = [];
  let reply = null;
  service.syncOnce = async (options) => syncCalls.push(options);

  await service.start();
  await getInteractionHandler()({
    commandName: "refresh-status",
    channelId: "server-channel",
    async reply(payload) {
      reply = payload;
    }
  });
  await service.stop();

  assert.deepEqual(reply, {
    content: "This command can only be used in the configured log channel.",
    ephemeral: true
  });
  assert.deepEqual(syncCalls, [undefined]);
});

test("status refresh uses a faster interval while players are online", () => {
  const config = {
    pterodactyl: {
      pollIntervalSeconds: 60,
      activePlayerPollIntervalSeconds: 15
    }
  };

  assert.equal(getStatusRefreshIntervalMs(config, false), 60000);
  assert.equal(getStatusRefreshIntervalMs(config, true), 15000);
});

test("status sync tracks whether any configured server has players", async () => {
  let playerCount = 2;
  const { eventBus } = createRecordingEventBus();
  const discordBridge = {
    async upsertStatusPanel() {},
    setSlashCommands() {},
    onMessage() {},
    onInteraction() {},
    onReaction() {}
  };
  const server = {
    name: "Test Server",
    discordChannelId: "server-channel",
    pterodactylServerId: "server-id",
    game: { type: "minecraft", chatCommandTemplate: "/say {content}" },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge,
    eventBus,
    pterodactylClient: {
      subscribeToConsole() {
        return () => {};
      },
      async getServerResources() {
        return { currentState: "running", cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("server-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: "Online",
        playerCount,
        onlinePlayers: playerCount > 0 ? ["Player One", "Player Two"].slice(0, playerCount) : [],
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes
      };
    }
  });

  await service.syncOnce({ force: true });
  assert.equal(service.hasActivePlayers, true);

  playerCount = 0;
  await service.syncOnce({ force: true });
  assert.equal(service.hasActivePlayers, false);
});

test("status sync caches latest known game duration for offline snapshots", async () => {
  let currentState = "running";
  const panelSnapshots = [];
  const runtimeState = {};
  const eventBus = {
    async emit(name, payload) {
      if (name === CoreEvents.STATUS_PANEL_UPDATED) {
        panelSnapshots.push(payload.snapshots[0]);
      }
      return [];
    }
  };
  const discordBridge = {
    setSlashCommands() {},
    onMessage() {},
    onInteraction() {},
    onReaction() {}
  };
  const server = {
    name: "Test Server",
    discordChannelId: "server-channel",
    pterodactylServerId: "server-id",
    game: { type: "minecraft", chatCommandTemplate: "/say {content}" },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge,
    eventBus,
    pterodactylClient: {
      subscribeToConsole() {
        return () => {};
      },
      async getServerResources() {
        return { currentState, cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    stateStore: {
      getServerRuntimeState(serverId) {
        return runtimeState[serverId] ?? {};
      },
      setServerRuntimeState(serverId, updates) {
        runtimeState[serverId] = { ...(runtimeState[serverId] ?? {}), ...updates };
      }
    },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("server-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: resources.currentState === "running" ? "Online" : "Offline",
        playerCount: 0,
        onlinePlayers: [],
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        gameDurationMs: resources.currentState === "running" ? 3720000 : null
      };
    }
  });

  await service.syncOnce({ force: true });
  currentState = "offline";
  await service.syncOnce({ force: true });

  assert.equal(panelSnapshots[0].gameDurationMs, 3720000);
  assert.equal(panelSnapshots[0].gameDurationCached, undefined);
  assert.equal(panelSnapshots[1].gameDurationMs, 3720000);
  assert.equal(panelSnapshots[1].gameDurationCached, true);
});

test("Satisfactory count changes emit generic join and leave notifications", async () => {
  let playerCount = 0;
  const messages = [];
  const eventBus = {
    async emit(name, payload) {
      if (name === CoreEvents.SERVER_NOTICE) {
        messages.push(payload);
      }
      return [];
    }
  };
  const discordBridge = {
    setSlashCommands() {},
    onMessage() {},
    onInteraction() {},
    onReaction() {}
  };
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    maxPlayers: 8,
    game: {
      type: "satisfactory",
      apiUrl: "https://factory.example.com:7777/api/v1",
      apiToken: "token",
      allowInsecureTls: true,
      chatCommandTemplate: null
    },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge,
    eventBus,
    pterodactylClient: {
      subscribeToConsole() {
        return () => {};
      },
      async getServerResources() {
        return { currentState: "running", cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: "Online",
        playerCount,
        maxPlayers: 8,
        onlinePlayers: null,
        playerNamesAvailable: false,
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes
      };
    }
  });

  await service.syncOnce({ force: true });
  playerCount = 2;
  await service.syncOnce({ force: true });
  playerCount = 1;
  await service.syncOnce({ force: true });

  assert.deepEqual(messages, [
    {
      kind: "satisfactory-player-count",
      server,
      changedPlayers: 2,
      action: "joined",
      playerCount: 2,
      maxPlayers: 8
    },
    {
      kind: "satisfactory-player-count",
      server,
      changedPlayers: 1,
      action: "left",
      playerCount: 1,
      maxPlayers: 8
    }
  ]);
});

test("console relay forwards live chat during websocket warmup", async () => {
  let lineHandler = null;
  const relayedMessages = [];
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    game: { type: "factorio", chatCommandTemplate: "DISCORD<{author}>: {content}" },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
    eventBus: {
      async emit(name, payload) {
        if (name === CoreEvents.GAME_CHAT_RELAY) {
          relayedMessages.push(payload);
        }
        return [];
      }
    },
    pterodactylClient: {
      subscribeToConsole(serverId, options) {
        assert.equal(serverId, "factory-id");
        lineHandler = options.onLine;
        return () => {};
      },
      async getServerResources() {
        return { currentState: "running", cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return true; },
    shouldRefreshOnlinePlayersOnConsoleConnect() { return false; },
    shouldRefreshOnlinePlayers() { return false; },
    parseConsoleChatLine(line) {
      const match = String(line).match(/\[CHAT\]\s+([^:]+):\s*(.+)$/);
      return match ? { authorName: match[1], content: match[2] } : null;
    },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: "Online",
        playerCount: 1,
        onlinePlayers: ["TTLouis"],
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes
      };
    }
  });

  await service.start();
  assert.equal(typeof lineHandler, "function");

  const connectedAt = Date.now();
  lineHandler("2026-07-02 10:52:00 [CHAT] TTLouis: 那里了", {
    connectedAt,
    isBacklog: false
  });
  lineHandler("2026-07-02 10:52:01 [CHAT] TTLouis: old message", {
    connectedAt,
    isBacklog: true
  });
  lineHandler("2026-07-02 10:52:02 [CHAT] TTLouis: reconnect message", {
    connectedAt,
    isBacklog: true,
    isReconnect: true
  });
  lineHandler("2026-07-02 10:52:02 [CHAT] TTLouis: reconnect message", {
    connectedAt,
    isBacklog: true,
    isReconnect: true
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(relayedMessages.length, 2);
  assert.deepEqual(relayedMessages[0], {
    server,
    authorName: "TTLouis",
    content: "那里了"
  });
  assert.deepEqual(relayedMessages[1], {
    server,
    authorName: "TTLouis",
    content: "reconnect message"
  });
  await service.stop();
});

test("Satisfactory power-state events trigger a debounced status refresh", async () => {
  let currentState = "running";
  let statusHandler = null;
  let resourceRequests = 0;
  const panelStates = [];
  const eventBus = {
    async emit(name, payload) {
      if (name === CoreEvents.STATUS_PANEL_UPDATED) {
        panelStates.push(payload.snapshots[0].simplifiedStatus);
      }
      return [];
    }
  };
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    maxPlayers: 8,
    game: {
      type: "satisfactory",
      apiUrl: "https://factory.example.com:7777/api/v1",
      apiToken: "token",
      allowInsecureTls: true,
      chatCommandTemplate: null
    },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
    eventBus,
    pterodactylClient: {
      subscribeToConsole(serverId, options) {
        assert.equal(serverId, "factory-id");
        assert.equal(options.sendLogs, false);
        statusHandler = options.onStatusChange;
        return () => {};
      },
      async getServerResources() {
        resourceRequests += 1;
        return { currentState, cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: resources.currentState === "running" ? "Online" : "Offline",
        playerCount: 0,
        maxPlayers: 8,
        onlinePlayers: [],
        playerNamesAvailable: false,
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        gameDurationMs: null
      };
    }
  });

  await service.start();
  assert.equal(typeof statusHandler, "function");
  assert.equal(resourceRequests, 1);

  currentState = "offline";
  statusHandler("offline");
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(resourceRequests, 2);
  assert.match(panelStates.at(-1), /Offline/);
  await service.stop();
});

test("external power-state stop events notify before the debounced status refresh", async () => {
  let currentState = "running";
  let statusHandler = null;
  const offlineNotifications = [];
  const { eventBus } = createRecordingEventBus();
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    maxPlayers: 8,
    game: {
      type: "satisfactory",
      apiUrl: "https://factory.example.com:7777/api/v1",
      apiToken: "token",
      allowInsecureTls: true,
      chatCommandTemplate: null
    },
    autoStop: { enabled: true }
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
    eventBus,
    pterodactylClient: {
      subscribeToConsole(serverId, options) {
        assert.equal(serverId, "factory-id");
        statusHandler = options.onStatusChange;
        return () => {};
      },
      async getServerResources() {
        return { currentState, cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: {
      async onRunningSnapshot() {},
      async onWentOffline(notifiedServer) {
        offlineNotifications.push(notifiedServer.name);
      },
      async onCameOnline() {}
    },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: resources.currentState === "running" ? "Online" : "Offline",
        playerCount: 0,
        maxPlayers: 8,
        onlinePlayers: [],
        playerNamesAvailable: false,
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        gameDurationMs: null
      };
    }
  });

  await service.start();
  assert.equal(typeof statusHandler, "function");

  currentState = "offline";
  statusHandler("offline");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(offlineNotifications, ["Factory"]);
  await service.stop();
});

test("starting power-state events do not offer restart and override stale offline panel state", async () => {
  const currentState = "offline";
  let statusHandler = null;
  const actionMessages = [];
  const panelStates = [];
  const runtimeState = {};
  const eventBus = {
    async emit(name, payload) {
      if (name === CoreEvents.SERVER_ACTION_MESSAGE) {
        actionMessages.push(payload);
      }
      if (name === CoreEvents.STATUS_PANEL_UPDATED) {
        panelStates.push(payload.snapshots[0].simplifiedStatus);
      }
      return [];
    }
  };
  const server = {
    name: "Factory",
    discordChannelId: "factory-channel",
    pterodactylServerId: "factory-id",
    maxPlayers: 8,
    game: {
      type: "satisfactory",
      apiUrl: "https://factory.example.com:7777/api/v1",
      apiToken: "token",
      allowInsecureTls: true,
      chatCommandTemplate: null
    },
    autoStop: null
  };
  const service = new StatusSyncService({
    config: {
      discord: { statusChannelId: "status", displayTimeZone: "UTC" },
      pterodactyl: { pollIntervalSeconds: 60, activePlayerPollIntervalSeconds: 15 },
      servers: [server]
    },
    discordBridge: {
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
    eventBus,
    pterodactylClient: {
      subscribeToConsole(serverId, options) {
        assert.equal(serverId, "factory-id");
        statusHandler = options.onStatusChange;
        return () => {};
      },
      async getServerResources() {
        return { currentState, cpuPercent: 1, memoryBytes: 1024 };
      }
    },
    autoStopService: { async onRunningSnapshot() {} },
    stateStore: {
      getServerRuntimeState(serverId) {
        return runtimeState[serverId] ?? {};
      },
      setServerRuntimeState(serverId, updates) {
        runtimeState[serverId] = { ...(runtimeState[serverId] ?? {}), ...updates };
      }
    },
    logger: { error() {}, warn() {}, info() {} }
  });
  service.adapters.set("factory-id", {
    supportsConsoleSubscription() { return false; },
    async fetchSnapshot(resources) {
      return {
        name: server.name,
        description: "",
        currentState: resources.currentState,
        simplifiedStatus: resources.currentState === "starting" ? "Starting" : "Offline",
        playerCount: 0,
        maxPlayers: 8,
        onlinePlayers: [],
        playerNamesAvailable: false,
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        gameDurationMs: null
      };
    }
  });

  await service.start();
  assert.equal(typeof statusHandler, "function");

  statusHandler("starting");
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(actionMessages.at(-1).kind, "server-starting-state");
  assert.match(panelStates.at(-1), /Starting/);
  assert.doesNotMatch(panelStates.at(-1), /Offline/);
  await service.stop();
});
