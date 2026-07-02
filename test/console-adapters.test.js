import assert from "node:assert/strict";
import test from "node:test";
import { FactorioAdapter } from "../src/adapters/factorio-adapter.js";
import { MinecraftAdapter } from "../src/adapters/minecraft-adapter.js";

const runningResources = {
  currentState: "running",
  cpuPercent: 1,
  memoryBytes: 1024,
  uptimeMs: 5000
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createMinecraftAdapter(runCommand) {
  return new MinecraftAdapter({
    serverConfig: {
      name: "Minecraft Test",
      asciiTitle: null,
      description: "",
      publicAddress: "minecraft.example.com",
      publicPort: 25565,
      maxPlayers: 20,
      discordChannelId: "channel-id",
      pterodactylServerId: "minecraft-id",
      game: { chatCommandTemplate: "/say {content}" }
    },
    pterodactylClient: { runCommand }
  });
}

function createFactorioAdapter(runCommand) {
  return new FactorioAdapter({
    serverConfig: {
      name: "Factorio Test",
      asciiTitle: null,
      description: "",
      publicAddress: "factorio.example.com",
      publicPort: 34197,
      maxPlayers: 20,
      discordChannelId: "channel-id",
      pterodactylServerId: "factorio-id",
      game: { chatCommandTemplate: "DISCORD<{author}>: {content}" }
    },
    pterodactylClient: { runCommand }
  });
}

test("Minecraft snapshots wait for an in-flight player-list refresh", async () => {
  const refresh = deferred();
  const listResponses = [
    ["There are 1 of a max of 20 players online: Alice"],
    refresh.promise
  ];
  const adapter = createMinecraftAdapter(async (_serverId, command) => {
    if (command === "/list") {
      return await listResponses.shift();
    }

    if (command === "/time query gametime") {
      return ["The time is 0"];
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  const firstSnapshot = await adapter.fetchSnapshot(runningResources);
  assert.equal(firstSnapshot.playerCount, 1);

  const refreshPromise = adapter.refreshOnlinePlayers();
  let snapshotResolved = false;
  const snapshotPromise = adapter.fetchSnapshot(runningResources).then((snapshot) => {
    snapshotResolved = true;
    return snapshot;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(snapshotResolved, false);

  refresh.resolve(["There are 0 of a max of 20 players online:"]);
  const refreshedSnapshot = await snapshotPromise;
  await refreshPromise;

  assert.equal(refreshedSnapshot.playerCount, 0);
  assert.deepEqual(refreshedSnapshot.onlinePlayers, []);
});

test("Factorio snapshots wait for an in-flight player-list refresh", async () => {
  const refresh = deferred();
  const listResponses = [
    ["Players (1):", "Alice (online)"],
    refresh.promise
  ];
  const adapter = createFactorioAdapter(async (_serverId, command) => {
    if (command === "/players o") {
      return await listResponses.shift();
    }

    if (command === "/time") {
      return ["1 minutes"];
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  const firstSnapshot = await adapter.fetchSnapshot(runningResources);
  assert.equal(firstSnapshot.playerCount, 1);

  const refreshPromise = adapter.refreshOnlinePlayers();
  let snapshotResolved = false;
  const snapshotPromise = adapter.fetchSnapshot(runningResources).then((snapshot) => {
    snapshotResolved = true;
    return snapshot;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(snapshotResolved, false);

  refresh.resolve(["Players (0):"]);
  const refreshedSnapshot = await snapshotPromise;
  await refreshPromise;

  assert.equal(refreshedSnapshot.playerCount, 0);
  assert.deepEqual(refreshedSnapshot.onlinePlayers, []);
});
