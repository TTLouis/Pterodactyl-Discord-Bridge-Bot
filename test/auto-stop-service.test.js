import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { AutoStopService, canRestartExternallyStoppedServer } from "../src/services/auto-stop-service.js";
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
    discordBridge: {},
    stateStore: {
      getAutoStopState() {
        return autoStopState;
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

function createStatusService(startRequested) {
  let interactionHandler = null;
  const discordBridge = {
    setSlashCommands() {},
    onMessage() {},
    onInteraction(handler) {
      interactionHandler = handler;
    }
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
    onInteraction() {}
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
    onInteraction() {}
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
