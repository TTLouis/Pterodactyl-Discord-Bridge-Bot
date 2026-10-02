export function orderServers(servers, savedOrder = []) {
  const positions = new Map(savedOrder.map((id, index) => [id, index]));
  return servers.map((server, index) => ({ server, index }))
    .sort((a, b) => (positions.get(a.server.pterodactylServerId) ?? Infinity)
      - (positions.get(b.server.pterodactylServerId) ?? Infinity) || a.index - b.index)
    .map(({ server }) => server);
}
