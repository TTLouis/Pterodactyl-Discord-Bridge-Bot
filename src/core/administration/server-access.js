/** Validate one retained server; discovery is not required to modify it. */
export async function canAccessServer(panelClient, serverId) {
  try { await panelClient.getServerResources(serverId); return true; }
  catch { return false; }
}
