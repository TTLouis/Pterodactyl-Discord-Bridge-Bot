import assert from "node:assert/strict";
import test from "node:test";
import { hydrateServerNetworkConfig } from "../src/services/server-network-config.js";

test("missing server network fields are resolved from Pterodactyl allocations", async () => {
  const config = {
    servers: [
      {
        name: "Factorio",
        pterodactylServerId: "factorio-id",
        publicAddress: "",
        publicPort: null,
        game: { type: "factorio" }
      },
      {
        name: "Satisfactory",
        pterodactylServerId: "satisfactory-id",
        publicAddress: "factory.example.com",
        publicPort: null,
        game: { type: "satisfactory", apiUrl: null }
      }
    ]
  };
  const pterodactylClient = {
    async getServerDefaultAllocation(serverId) {
      if (serverId === "factorio-id") {
        return {
          ip: "10.0.0.10",
          ipAlias: "factorio.example.com",
          port: 34197,
          isDefault: true
        };
      }

      return {
        ip: "10.0.0.20",
        ipAlias: "ignored.example.com",
        port: 7777,
        isDefault: true
      };
    }
  };

  await hydrateServerNetworkConfig({ config, pterodactylClient });

  assert.equal(config.servers[0].publicAddress, "factorio.example.com");
  assert.equal(config.servers[0].publicPort, 34197);
  assert.equal(config.servers[1].publicAddress, "factory.example.com");
  assert.equal(config.servers[1].publicPort, 7777);
  assert.equal(config.servers[1].game.apiUrl, "https://factory.example.com:7777/api/v1");
});

test("configured server network fields are not overwritten", async () => {
  const config = {
    servers: [{
      name: "Minecraft",
      pterodactylServerId: "minecraft-id",
      publicAddress: "manual.example.com",
      publicPort: 25565,
      game: { type: "minecraft" }
    }]
  };
  const pterodactylClient = {
    async getServerDefaultAllocation() {
      throw new Error("should not be called");
    }
  };

  await hydrateServerNetworkConfig({ config, pterodactylClient });

  assert.equal(config.servers[0].publicAddress, "manual.example.com");
  assert.equal(config.servers[0].publicPort, 25565);
});
