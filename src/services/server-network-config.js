import { deriveSatisfactoryApiUrl } from "../lib/config.js";

function hasConfiguredValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeAllocationAddress(allocation) {
  return allocation?.ipAlias || allocation?.ip || null;
}

function needsNetworkHydration(server) {
  return !hasConfiguredValue(server.publicAddress)
    || !hasConfiguredValue(server.publicPort)
    || (server.game?.type === "satisfactory" && !server.game.apiUrl);
}

function applyAllocation(server, allocation) {
  const changes = [];
  const address = normalizeAllocationAddress(allocation);

  if (!hasConfiguredValue(server.publicAddress) && address) {
    server.publicAddress = address;
    changes.push("publicAddress");
  }

  if (!hasConfiguredValue(server.publicPort) && allocation?.port !== null && allocation?.port !== undefined) {
    server.publicPort = allocation.port;
    changes.push("publicPort");
  }

  if (server.game?.type === "satisfactory" && !server.game.apiUrl) {
    const apiUrl = deriveSatisfactoryApiUrl(server);
    if (apiUrl) {
      server.game.apiUrl = apiUrl;
      changes.push("game.apiUrl");
    }
  }

  return changes;
}

function validateHydratedServer(server) {
  if (server.game?.type === "satisfactory" && !server.game.apiUrl) {
    throw new Error(
      `Satisfactory server "${server.name}" requires game.apiUrl, or a Pterodactyl allocation/address that can derive one.`
    );
  }
}

export async function hydrateServerNetworkConfig({ config, pterodactylClient, logger }) {
  const servers = config.servers.filter(needsNetworkHydration);
  if (servers.length === 0) {
    return;
  }

  await Promise.all(servers.map(async (server) => {
    let allocation;
    try {
      allocation = await pterodactylClient.getServerDefaultAllocation(server.pterodactylServerId);
    } catch (error) {
      throw new Error(
        `Could not resolve Pterodactyl allocation for "${server.name}". ` +
        `Set publicAddress/publicPort manually or make sure the Client API key can read allocations. ${error.message}`
      );
    }

    if (!allocation) {
      throw new Error(`Pterodactyl returned no allocations for "${server.name}". Set publicAddress/publicPort manually.`);
    }

    const changes = applyAllocation(server, allocation);
    validateHydratedServer(server);

    if (changes.length > 0) {
      logger?.info("Resolved server network config from Pterodactyl allocation", {
        server: server.name,
        serverId: server.pterodactylServerId,
        resolved: changes,
        allocation: {
          ip: allocation.ip,
          ipAlias: allocation.ipAlias,
          port: allocation.port,
          isDefault: allocation.isDefault
        }
      });
    }
  }));
}
