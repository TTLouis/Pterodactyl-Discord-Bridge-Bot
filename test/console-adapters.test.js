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

test("Minecraft parses alternate dedicated-server list and time output", async () => {
  const adapter = createMinecraftAdapter(async (_serverId, command) => {
    if (command === "/list") {
      return [
        "[05:30:52] [Server thread/INFO] [minecraft/DedicatedServer]: There are 1/20 players online:",
        "[05:30:52] [Server thread/INFO] [minecraft/DedicatedServer]: TTLouis"
      ];
    }

    if (command === "/time query gametime") {
      return ["[05:31:48] [Server thread/INFO] [minecraft/DedicatedServer]: Usage: /time <set|add> <value> [dim]"];
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  const snapshot = await adapter.fetchSnapshot(runningResources);

  assert.equal(snapshot.playerCount, 1);
  assert.deepEqual(snapshot.onlinePlayers, ["TTLouis"]);
  assert.equal(snapshot.gameDurationMs, null);
});

test("Minecraft detects joins from modded dedicated-server log prefixes", async () => {
  const adapter = createMinecraftAdapter(async (_serverId, command) => {
    if (command === "/list") {
      return ["There are 0/20 players online:"];
    }
    if (command === "/time query gametime") {
      return [];
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  await adapter.fetchSnapshot(runningResources);

  const joinLine = "[06:09:14] [Server thread/INFO] [minecraft/DedicatedServer]: TTLouis joined the game";

  assert.equal(adapter.shouldRefreshOnlinePlayers(joinLine), true);
  assert.equal(adapter.applyPlayerEvent(joinLine), true);

  const snapshot = await adapter.fetchSnapshot(runningResources);
  assert.equal(snapshot.playerCount, 1);
  assert.deepEqual(snapshot.onlinePlayers, ["TTLouis"]);
});

test("Minecraft preserves joins that race with an initial stale list response", async () => {
  const listResponse = deferred();
  const adapter = createMinecraftAdapter(async (_serverId, command) => {
    if (command === "/list") return listResponse.promise;
    if (command === "/time query gametime") return [];
    throw new Error(`Unexpected command: ${command}`);
  });

  const snapshotPromise = adapter.fetchSnapshot(runningResources);
  const joinLine = "[06:09:14] [Server thread/INFO] [minecraft/DedicatedServer]: TTLouis joined the game";
  assert.equal(adapter.applyPlayerEvent(joinLine), true);
  listResponse.resolve(["There are 0/20 players online:"]);

  const snapshot = await snapshotPromise;
  assert.equal(snapshot.playerCount, 1);
  assert.deepEqual(snapshot.onlinePlayers, ["TTLouis"]);
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

test("Factorio chat parser forwards player chat and ignores Discord relay echoes", () => {
  const adapter = createFactorioAdapter(async () => []);

  assert.deepEqual(
    adapter.parseConsoleChatLine("2026-07-02 10:52:00 [CHAT] TTLouis: 你天天用别人的蓝图当然挤了"),
    { authorName: "TTLouis", content: "你天天用别人的蓝图当然挤了" }
  );
  assert.deepEqual(
    adapter.parseConsoleChatLine("[CHAT] <TTLouis>: 那里了"),
    { authorName: "TTLouis", content: "那里了" }
  );
  assert.equal(
    adapter.parseConsoleChatLine("2026-07-02 10:52:00 [CHAT] <server>: DISCORD<Louis的弟弟>: 还有1个小时"),
    null
  );
  assert.equal(
    adapter.parseConsoleChatLine("2026-07-02 10:52:03 Info ServerMultiplayerManager.cpp:900: updateTick"),
    null
  );
});

test("Factorio chat relay executes formatted commands", async () => {
  const commands = [];
  const adapter = new FactorioAdapter({
    serverConfig: {
      name: "Factorio Test",
      asciiTitle: null,
      description: "",
      publicAddress: "factorio.example.com",
      publicPort: 34197,
      maxPlayers: 20,
      discordChannelId: "discord-channel",
      kookChannelId: "kook-channel",
      pterodactylServerId: "factorio-id",
      game: {
        chatCommandTemplate: "/shout {platform}<{author}>: {content}",
        kookChatCommandTemplate: "/shout KOOK<{author}>: {content}"
      }
    },
    pterodactylClient: {
      async runCommand(serverId, command) {
        commands.push({ serverId, command });
      }
    }
  });

  await adapter.handleChatCommand("/shout KOOK<Kai>: hello");

  assert.deepEqual(commands, [{
    serverId: "factorio-id",
    command: "/shout KOOK<Kai>: hello"
  }]);
  assert.equal(
    adapter.parseConsoleChatLine("2026-07-02 10:52:00 [CHAT] <server>: KOOK<Kai>: hello"),
    null
  );
});
