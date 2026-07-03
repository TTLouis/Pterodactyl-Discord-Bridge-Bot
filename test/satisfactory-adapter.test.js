import assert from "node:assert/strict";
import test from "node:test";
import { SatisfactoryAdapter } from "../src/adapters/satisfactory-adapter.js";

function createAdapter(queryServerState) {
  return new SatisfactoryAdapter({
    serverConfig: {
      name: "Satisfactory Test",
      asciiTitle: null,
      description: "",
      publicAddress: "factory.example.com",
      publicPort: 7777,
      maxPlayers: 4,
      discordChannelId: "channel-id",
      game: { chatCommandTemplate: null }
    },
    satisfactoryClient: { queryServerState },
    logger: { warn() {} }
  });
}

const runningResources = {
  currentState: "running",
  cpuPercent: 10,
  memoryBytes: 1024,
  uptimeMs: 5000
};

test("Satisfactory snapshots use the API player count and mark names unavailable", async () => {
  const adapter = createAdapter(async () => ({
    numConnectedPlayers: 3,
    playerLimit: 8,
    techTier: 7,
    activeSchematic: "Schematic_7-3",
    gamePhase: "GamePhase_4",
    totalGameDuration: 42
  }));

  const snapshot = await adapter.fetchSnapshot(runningResources);

  assert.equal(snapshot.playerCount, 3);
  assert.equal(snapshot.maxPlayers, 8);
  assert.equal(snapshot.gameDurationMs, 42000);
  assert.equal(snapshot.onlinePlayers, null);
  assert.equal(snapshot.playerNamesAvailable, false);
  assert.deepEqual(snapshot.satisfactoryState, {
    techTier: 7,
    activeSchematic: "Schematic_7-3",
    gamePhase: "GamePhase_4"
  });
});

test("Satisfactory snapshots retain the last known count during transient API failures", async () => {
  let shouldFail = false;
  const adapter = createAdapter(async () => {
    if (shouldFail) {
      throw new Error("temporary failure");
    }

    return {
      numConnectedPlayers: 2,
      playerLimit: 6,
      techTier: 5,
      activeSchematic: "Schematic_5-2",
      gamePhase: "GamePhase_3",
      totalGameDuration: 100
    };
  });

  await adapter.fetchSnapshot(runningResources);
  shouldFail = true;
  const snapshot = await adapter.fetchSnapshot(runningResources);

  assert.equal(snapshot.playerCount, 2);
  assert.equal(snapshot.maxPlayers, 6);
  assert.equal(snapshot.gameDurationMs, 100000);
  assert.deepEqual(snapshot.satisfactoryState, {
    techTier: 5,
    activeSchematic: "Schematic_5-2",
    gamePhase: "GamePhase_3"
  });
});

test("Satisfactory snapshots reset the count when the server stops", async () => {
  const adapter = createAdapter(async () => ({
    numConnectedPlayers: 2,
    playerLimit: 4,
    techTier: 3,
    activeSchematic: "Schematic_3-1",
    gamePhase: "GamePhase_2",
    totalGameDuration: 100
  }));

  await adapter.fetchSnapshot(runningResources);
  const snapshot = await adapter.fetchSnapshot({ ...runningResources, currentState: "offline" });

  assert.equal(snapshot.playerCount, 0);
  assert.deepEqual(snapshot.onlinePlayers, []);
  assert.equal(snapshot.gameDurationMs, null);
  assert.deepEqual(snapshot.satisfactoryState, {
    techTier: null,
    activeSchematic: "",
    gamePhase: ""
  });
});

test("Satisfactory config reload clears cached API state", async () => {
  const adapter = createAdapter(async () => ({
    numConnectedPlayers: 2,
    playerLimit: 8,
    techTier: 6,
    activeSchematic: "Schematic_6-1",
    gamePhase: "GamePhase_3",
    totalGameDuration: 200
  }));

  await adapter.fetchSnapshot(runningResources);
  adapter.serverConfig.maxPlayers = 12;
  adapter.onConfigReloaded();
  const snapshot = await adapter.fetchSnapshot({ ...runningResources, currentState: "offline" });

  assert.equal(snapshot.playerCount, 0);
  assert.equal(snapshot.maxPlayers, 12);
  assert.equal(snapshot.gameDurationMs, null);
  assert.deepEqual(snapshot.satisfactoryState, {
    techTier: null,
    activeSchematic: "",
    gamePhase: ""
  });
});
