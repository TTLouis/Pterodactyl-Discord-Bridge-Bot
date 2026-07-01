import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  AutoStopService,
  CANCEL_AUTO_STOP_REACTION,
  RESTART_SERVER_REACTION,
  canRestartExternallyStoppedServer
} from "../src/services/auto-stop-service.js";
import { getStatusRefreshIntervalMs, StatusSyncService } from "../src/services/status-sync-service.js";

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
    discordBridge: {
      async replaceActionMessage() {}
    },
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
  const messages = [];
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
    discordBridge: {
      async replaceActionMessage(channelId, content, options = {}) {
        const message = { id: `message-${nextMessageId++}` };
        actionMessageId = message.id;
        messages.push({ channelId, content, options, messageId: message.id });
        return message;
      },
      async deleteMessage() {}
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
    messages,
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
  assert.equal(messages[0].channelId, "factory-channel");
  assert.deepEqual(messages[0].options.reactions, [CANCEL_AUTO_STOP_REACTION]);
  assert.equal(state.warningMessageId, "message-1");
  assert.equal(typeof state.warningSentAt, "number");
});

test("auto-stop sends a fresh restartable stopped message before stopping the server", async () => {
  const { service, messages, powerRequests, state } = createAutoStopService({
    autoStopState: { lastNonEmptyAt: Date.now() - 3600001 }
  });

  await service.onRunningSnapshot(autoStopServer, 0);

  assert.deepEqual(messages[0].options.reactions, [RESTART_SERVER_REACTION]);
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
  assert.equal(messages.at(-1).messageId, "message-2");
  assert.equal(messages.at(-1).options.reactions, undefined);
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
  assert.equal(messages.at(-1).channelId, "factory-channel");
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

  const onlineEmbed = messages.at(-1).content.embeds[0].toJSON();
  assert.equal(started, true);
  assert.match(onlineEmbed.description, /Started by \*\*Starter\*\*/);
  assert.match(onlineEmbed.description, /Start requested <t:\d+:R> \(<t:\d+:f>\)/);
});

function createStatusService(startRequested) {
  let interactionHandler = null;
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
  const discordBridge = {
    async upsertStatusPanel(channelId, panel) {
      panelSnapshots.push(panel.embeds[0].toJSON().fields[2].value);
    },
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

  assert.match(panelSnapshots[0], /\*\*Time:\*\* 1h 2m/);
  assert.match(panelSnapshots[1], /\*\*Last Known Time:\*\* 1h 2m/);
});

test("Satisfactory count changes emit generic join and leave notifications", async () => {
  let playerCount = 0;
  const messages = [];
  const discordBridge = {
    async upsertStatusPanel() {},
    async sendMessage(channelId, content) {
      messages.push({ channelId, content });
    },
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
    { channelId: "factory-channel", content: "2 players joined **Factory**. (2/8)" },
    { channelId: "factory-channel", content: "1 player left **Factory**. (1/8)" }
  ]);
});

test("Satisfactory power-state events trigger a debounced status refresh", async () => {
  let currentState = "running";
  let statusHandler = null;
  let resourceRequests = 0;
  const panelStates = [];
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
      async upsertStatusPanel(channelId, panel) {
        panelStates.push(panel.embeds[0].toJSON().fields[1].value);
      },
      async sendMessage() {},
      async replaceActionMessage() {},
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
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
      async upsertStatusPanel() {},
      async sendMessage() {},
      async replaceActionMessage() {},
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
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
      async upsertStatusPanel(channelId, panel) {
        panelStates.push(panel.embeds[0].toJSON().fields[1].value);
      },
      async sendMessage() {},
      async replaceActionMessage(channelId, payload, options = {}) {
        actionMessages.push({ channelId, payload, options });
      },
      setSlashCommands() {},
      onMessage() {},
      onInteraction() {},
      onReaction() {}
    },
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

  const startEmbed = actionMessages.at(-1).payload.embeds[0].toJSON();
  assert.match(startEmbed.title, /Server starting/);
  assert.deepEqual(actionMessages.at(-1).options, {});
  assert.match(panelStates.at(-1), /Starting/);
  assert.doesNotMatch(panelStates.at(-1), /Offline/);
  await service.stop();
});
