import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { AutoStopService, canRestartExternallyStoppedServer } from "../src/services/auto-stop-service.js";
import { StatusSyncService } from "../src/services/status-sync-service.js";

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
