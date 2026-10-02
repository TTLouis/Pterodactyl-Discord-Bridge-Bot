import assert from "node:assert/strict";
import test from "node:test";
import { SourceAdapter, parseSourceStatus } from "../src/adapters/source-adapter.js";
import { buildGameChatCommand, getDefaultChatCommandTemplate } from "../src/lib/chat-relay-formatters.js";

const resources = { currentState: "running", uptimeMs: 1000 };
const status = [
  'players : 1 humans, 1 bots (24 max)',
  '# userid name uniqueid connected ping loss state',
  '# 7 "Alice Smith" [U:1:123] 00:15 49 0 active',
  '# 8 "Bot" BOT active', '#end'
];
const config = { name: "Source", pterodactylServerId: "source-id", game: {
  type: "source", chatCommandTemplate: getDefaultChatCommandTemplate("source")
} };
const log = value => `L 10/01/2026 - 12:00:00: ${value}`;

test("Source status counts humans and parses modern and legacy tables", () => {
  assert.deepEqual(parseSourceStatus(status), { playerCount: 1, players: ["Alice Smith"], maxPlayers: 24 });
  assert.deepEqual(parseSourceStatus(["players : 2 (24 max)", ...status.slice(1)]), parseSourceStatus(status));
  assert.deepEqual(parseSourceStatus(['players : 1 humans, 0 bots (16 max)', '# 2 7 "Bob" STEAM_0:1:123 00:10 20 0 active']),
    { playerCount: 1, players: ["Bob"], maxPlayers: 16 });
  assert.deepEqual(parseSourceStatus(['players : 0 humans, 1 bots (16 max)', '# 7 "Bot" BOT active']),
    { playerCount: 0, players: [], maxPlayers: 16 });
  assert.deepEqual(parseSourceStatus(['players : 0 (16 max)']), { playerCount: 0, players: [], maxPlayers: 16 });
});

test("Source rejects missing, truncated, mismatched and duplicate status rows", () => {
  for (const lines of [[], ['Unknown command "status"'], status.slice(0, 3),
    ['players : 1 humans, 1 bots (24 max)', '# 7 "Bot" BOT active', '# 8 "Other" BOT active'],
    ['players : 2 (24 max)', '# 7 "Alice" STEAM_0:1:123 active', '# 7 "Alice" STEAM_0:1:123 active']]) {
    assert.equal(parseSourceStatus(lines), null);
  }
});

test("Source snapshots retain last known players on query failure and reset offline", async () => {
  let response = status;
  const adapter = new SourceAdapter({ serverConfig: config, pterodactylClient: { async runCommand(id, command) {
    assert.equal(id, "source-id"); assert.equal(command, "status");
    if (response instanceof Error) throw response;
    return response;
  } } });
  const initial = await adapter.fetchSnapshot(resources);
  assert.equal(initial.playerCountReliable, true);
  assert.equal(initial.playerCount, 1);
  assert.equal(initial.maxPlayers, 24);
  response = [];
  const incomplete = await adapter.fetchSnapshot(resources, { forcePlayerRefresh: true });
  assert.equal(incomplete.playerCountReliable, false);
  assert.deepEqual(incomplete.onlinePlayers, ["Alice Smith"]);
  response = new Error("Disconnected");
  assert.equal((await adapter.fetchSnapshot(resources)).playerCountReliable, false);
  await adapter.fetchSnapshot({ currentState: "offline" });
  assert.equal((await adapter.fetchSnapshot(resources)).playerCount, 0);
  assert.equal((await adapter.fetchSnapshot(resources)).playerCountReliable, false);
});

test("Source invalidates status responses when membership changes or server stops", async () => {
  let resolve;
  let calls = 0;
  const adapter = new SourceAdapter({ serverConfig: config, pterodactylClient: { runCommand() {
    calls++;
    return new Promise(done => { resolve = done; });
  } } });
  const first = adapter.refreshOnlinePlayers();
  const second = adapter.fetchSnapshot(resources);
  assert.equal(calls, 1);
  assert.equal(adapter.applyPlayerEvent(log('"Bob<8><STEAM_0:1:456><Red>" entered the game')), true);
  resolve(status);
  await first;
  assert.equal((await second).playerCountReliable, false);
  const next = adapter.refreshOnlinePlayers();
  await adapter.fetchSnapshot({ currentState: "offline" });
  resolve(status);
  await next;
  assert.equal(adapter.playerCountReliable, false);
  assert.equal(adapter.onlinePlayers, null);
});

test("Source relays public log chat without leaking Steam IDs, team chat or server echoes", () => {
  const adapter = new SourceAdapter({ serverConfig: config });
  assert.deepEqual(adapter.parseConsoleChatLine(log('"Alice Smith<7><[U:1:123]><Red>" say "hello"')),
    { authorName: "Alice Smith", content: "hello" });
  assert.deepEqual(adapter.parseConsoleChatLine('\u001b[32m' + log('"Alice<7><STEAM_0:1:123><Blue>" say "hello \"there\""') + '\u001b[0m'),
    { authorName: "Alice", content: 'hello "there"' });
  for (const value of ['"Alice<7><STEAM_0:1:123><Red>" say_team "private"',
    'server say "[Discord] Alice: hello"', 'Console: hello', '"Alice<7><STEAM_0:1:123><Red>" killed "Bob"']) {
    assert.equal(adapter.parseConsoleChatLine(log(value)), null);
  }
  assert.equal(adapter.shouldRefreshOnlinePlayers(log('"Alice<7><STEAM_0:1:123><Red>" disconnected (reason "quit")')), true);
});

test("Source substitutions cannot close the say argument or append console commands", () => {
  const command = buildGameChatCommand(config, { sourcePlatform: "discord", authorName: 'Alice";quit', content: 'hello\\"; changelevel bad\nnext' });
  assert.equal(command, 'say "[Discord] Alice＂；quit: hello／＂； changelevel bad next"');
  assert.equal((command.match(/"/g) ?? []).length, 2);
  const custom = { ...config, game: { type: "source", chatCommandTemplate: 'say {author}: {content}' } };
  assert.equal(buildGameChatCommand(custom, { authorName: "Alice", content: ';quit' }), 'say Alice: ；quit');
});
