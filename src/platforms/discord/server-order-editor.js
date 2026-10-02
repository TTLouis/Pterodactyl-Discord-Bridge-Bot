export function orderEditorRows(servers) {
  return servers.map((server, index) => ({ id: server.pterodactylServerId,
    label: `${String(server.name).replace(/[|\r\n<>@`]/g, " ").slice(0, 80)}${server.archived ? " [archived]" : server.deleted ? " [deleted]" : ""}`,
    number: index + 1 }));
}

export function parseOrderEditor(rows, text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== rows.length) throw new Error("Keep every server row, including archived servers.");
  const ranked = lines.map((line, index) => {
    const separator = line.lastIndexOf("|");
    const rank = line.slice(separator + 1).trim();
    if (separator < 0 || line.slice(0, separator).trim() !== rows[index].label || !/^[1-9]\d*$/.test(rank)) throw new Error("Keep names and rows unchanged; edit only the order numbers on the right.");
    return { id: rows[index].id, number: Number(rank) };
  }).sort((a, b) => a.number - b.number);
  if (ranked.some((row, index) => row.number !== index + 1)) throw new Error(`Use each number from 1 to ${rows.length} exactly once.`);
  return ranked.map(row => row.id);
}
