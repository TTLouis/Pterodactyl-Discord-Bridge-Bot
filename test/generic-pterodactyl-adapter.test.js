import assert from "node:assert/strict";
import test from "node:test";
import { GenericPterodactylAdapter } from "../src/adapters/generic-pterodactyl-adapter.js";

test("generic adapter reports Pterodactyl resources without inventing player data", async () => {
  const adapter = new GenericPterodactylAdapter({
    serverConfig: {
      name: "Custom Game",
      description: "Unsupported game",
      publicAddress: "game.example.test",
      publicPort: 12345,
      discordChannelId: "channel"
    }
  });

  const snapshot = await adapter.fetchSnapshot({
    currentState: "running",
    cpuPercent: 12.5,
    memoryBytes: 512 * 1024 * 1024,
    uptimeMs: 3_600_000
  });

  assert.equal(snapshot.simplifiedStatus, "Online");
  assert.equal(snapshot.playerCount, null);
  assert.equal(snapshot.playerNamesAvailable, false);
  assert.equal(snapshot.onlinePlayers, null);
  assert.equal(snapshot.cpuPercent, 12.5);
  assert.equal(snapshot.memoryBytes, 512 * 1024 * 1024);
  assert.equal(snapshot.uptimeMs, 3_600_000);
  assert.equal(snapshot.genericPterodactyl, true);
  assert.equal(adapter.supportsConsoleSubscription(), false);
  assert.equal(adapter.supportsChatRelay(), false);
});
