export function orderEditorIncrement(count) {
  const lower = 10 ** Math.floor(Math.log10(Math.max(10, count)));
  const upper = lower * 10;
  return count - lower < upper - count ? lower : upper;
}

export function orderEditorRows(servers) {
  const increment = orderEditorIncrement(servers.length);
  return servers.map((server, index) => ({ id: server.pterodactylServerId,
    label: `${String(server.name).replace(/[|\r\n<>@`]/g, " ").slice(0, 80)}${server.archived ? " [archived]" : server.deleted ? " [deleted]" : ""}`,
    number: (index + 1) * increment }));
}

export function parseOrderEditor(rows, text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== rows.length) throw new Error("Keep every server row, including archived servers.");
  const ranked = lines.map((line, index) => {
    const separator = line.lastIndexOf("|");
    const rank = line.slice(separator + 1).trim();
    if (separator < 0 || line.slice(0, separator).trim() !== rows[index].label || !/^[+-]?\d+$/.test(rank)) throw new Error("Keep names and rows unchanged; edit only the order numbers on the right.");
    return { id: rows[index].id, number: BigInt(rank) };
  }).sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  return ranked.map(row => row.id);
}
