import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayService } from "../src/services/relay-service.js";
import { StateStore } from "../src/lib/state-store.js";
import { CoreEventBus, CoreEvents } from "../src/core/core-events.js";
import { RELAY_QUEUE_TTL_MS } from "../src/lib/relay-limits.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async service => {
  for (let index = 0; index < 5; index++) {
    await new Promise(resolve => setImmediate(resolve));
    if (!service.workers.size) break;
  }
};
function fixture(t, { ready = true, platformSend = null, gameSend = null, game = "minecraft", store = null } = {}) {
  const server = { name: "World", pterodactylServerId: "world", discordChannelId: "discord",
    kookChannelId: "kook", game: { type: game, chatCommandTemplate: game === "factorio" ? "/shout {platform}<{author}>: {content}" : "/say [{platform}] {author}: {content}" } };
  const queues = new Map();
  const state = store ?? {
    outbox: {}, receipts: {},
    getRelayQueue: id => queues.get(id) ?? [],
    setRelayQueue: (id, entries) => queues.set(id, entries),
    getRelayOutbox() { return this.outbox; }, getRelayReceipts() { return this.receipts; },
    setRelayOutbox(outbox, receipts) { this.outbox = outbox; this.receipts = receipts; },
    flush() {}
  };
  const config = { servers: [server] };
  const eventBus = new CoreEventBus();
  const calls = [];
  const notices = [];
  let clock = 1000000;
  let service;
  for (const platform of ["discord", "kook"]) {
    const listener = async event => {
      if (event.destinationPlatform !== platform) return null;
      if (platformSend) return platformSend(platform, event, calls);
      event.onDispatch();
      calls.push({ platform, content: event.content, formattedContent: event.formattedContent });
      return { platform };
    };
    eventBus.on(CoreEvents.GAME_CHAT_RELAY, listener);
    eventBus.on(CoreEvents.GROUP_CHAT_RELAY, listener);
  }
  eventBus.on(CoreEvents.SERVER_NOTICE, event => notices.push(event));
  const client = {
    isConsoleSessionReady: () => ready,
    async runRelayCommand(id, command, options) {
      if (gameSend) return gameSend(command, options, calls);
      options.onDispatch();
      calls.push({ platform: "game", command });
      return { status: "dispatched" };
    }
  };
  const adapter = {};
  service = new RelayService({ config, stateStore: state, eventBus, pterodactylClient: client,
    getAdapter: () => adapter, isCurrent: () => true, logger: { info() {}, warn() {}, error() {} },
    kookEnabled: true, now: () => clock });
  service.start();
  t.after(() => service.stop());
  return { service, server, state, config, calls, notices, client, eventBus,
    queue: () => state.getRelayQueue("world"),
    advance: ms => { clock += ms; },
    send: (content, messageId = undefined, sourcePlatform = "discord") => service.accept({
      sourcePlatform, channelId: sourcePlatform === "discord" ? "discord" : "kook", authorName: "Alice", content, messageId
    }) };
}

test("new messages arriving during an in-flight send are retained and dispatched once", async t => {
  const hold = deferred();
  let first = true;
  const f = fixture(t, { gameSend: async (command, options, calls) => {
    options.onDispatch(); calls.push({ platform: "game", command });
    if (first) { first = false; await hold.promise; }
    return { status: "dispatched" };
  } });
  f.send("first");
  await new Promise(resolve => setImmediate(resolve));
  f.send("second");
  assert.equal(f.queue().length, 2);
  hold.resolve();
  await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "game").map(call => call.command), [
    "/say [Discord] Alice: first", "/say [Discord] Alice: second"
  ]);
  assert.equal(f.queue().length, 0);
});

test("accepting work while an empty worker finishes wakes it without a status poll", async t => {
  const f = fixture(t);
  await Promise.resolve();
  f.send("arrived at completion");
  await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "game").length, 1);
  assert.equal(f.queue().length, 0);
});

test("overflow protects the dispatched head and completion removes only that ID", async t => {
  const hold = deferred();
  let first = true;
  const f = fixture(t, { gameSend: async (command, options, calls) => {
    options.onDispatch(); calls.push({ platform: "game", command });
    if (first) { first = false; await hold.promise; }
    return { status: "dispatched" };
  } });
  f.send("in-flight");
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 105; index++) f.send(`new-${index}`);
  assert.equal(f.queue().length, 100);
  assert.equal(f.queue()[0].content, "in-flight");
  assert.equal(f.queue()[1].content, "new-6");
  hold.resolve();
  await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "game").length, 100);
  assert.equal(f.queue().length, 0);
});

test("expiry during a blocked send cannot restore expired entries or erase a fresh arrival", async t => {
  const hold = deferred();
  let first = true;
  const f = fixture(t, { gameSend: async (command, options, calls) => {
    options.onDispatch(); calls.push({ platform: "game", command });
    if (first) { first = false; await hold.promise; }
    return { status: "dispatched" };
  } });
  f.send("in-flight"); f.send("will expire");
  await new Promise(resolve => setImmediate(resolve));
  f.advance(RELAY_QUEUE_TTL_MS + 1);
  f.send("fresh");
  hold.resolve();
  await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "game").map(call => call.command), [
    "/say [Discord] Alice: in-flight", "/say [Discord] Alice: fresh"
  ]);
});

test("source IDs suppress repeated gateway events but identical text with distinct IDs is retained", async t => {
  const f = fixture(t);
  assert.equal(f.send("same", "id-1"), true);
  assert.equal(f.send("same", "id-1"), false);
  assert.equal(f.send("same", "id-2"), true);
  await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "game").length, 2);
  assert.equal(f.calls.filter(call => call.platform === "kook").length, 2);
});

test("a slow cross-post cannot delay game enqueue or dispatch", async t => {
  const hold = deferred();
  const f = fixture(t, { platformSend: async (platform, event, calls) => {
    event.onDispatch(); calls.push({ platform, content: event.content });
    await hold.promise;
    return { platform };
  } });
  f.send("hello");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.platform === "game").length, 1);
  hold.resolve();
  await settle(f.service);
});

test("one platform failure cannot block the other destination, and does not claim success", async t => {
  const f = fixture(t, { platformSend: async (platform, event, calls) => {
    event.onDispatch(); calls.push({ platform, content: event.content });
    if (platform === "discord") throw Object.assign(new Error("network timeout"), { deliveryStatus: "unknown" });
    return { platform };
  } });
  f.service.acceptGame(f.server, { authorName: "Player", content: "hello" });
  await settle(f.service);
  assert.deepEqual(f.calls.map(call => call.platform).sort(), ["discord", "kook"]);
  assert.equal(f.notices.filter(event => event.kind === "relay-uncertain").length, 1);
  assert.equal(Object.keys(f.state.getRelayOutbox()).length, 0);
});

test("definitely unsent commands retry with backoff; uncertain dispatches do not", async t => {
  let attempt = 0;
  const f = fixture(t, { gameSend: async (_command, options, calls) => {
    attempt++;
    if (attempt === 1) return { status: "not-sent" };
    options.onDispatch(); calls.push({ platform: "game" });
    return { status: "unknown" };
  } });
  f.send("hello"); await settle(f.service);
  assert.equal(f.queue().length, 1);
  assert.equal(f.queue()[0].attempts, 1);
  f.advance(1000);
  await f.service.flush(f.server); await settle(f.service);
  assert.equal(f.queue().length, 0);
  await f.service.flush(f.server);
  assert.equal(attempt, 2);
  assert.equal(f.notices.filter(event => event.kind === "relay-uncertain").length, 1);
});

test("temporary access uncertainty preserves pending jobs; explicit disable cancels them", async t => {
  const f = fixture(t, { ready: false });
  f.send("queued"); await settle(f.service);
  f.server.accessUncertain = true;
  f.service.reconcile();
  assert.equal(f.queue().length, 1);
  f.server.chatRelay = false;
  f.service.reconcile(); await settle(f.service);
  assert.equal(f.queue().length, 0);
  assert.ok(f.notices.some(event => event.kind === "relay-cancelled"));
});

test("rebinding a channel cancels old work and cannot overwrite new route jobs", async t => {
  const hold = deferred();
  let first = true;
  const f = fixture(t, { gameSend: async (command, options, calls) => {
    options.onDispatch(); calls.push({ platform: "game", command });
    if (first) { first = false; await hold.promise; }
    return { status: "dispatched" };
  } });
  f.send("old-route"); await new Promise(resolve => setImmediate(resolve));
  f.server.kookChannelId = "new-kook";
  f.service.reconcile();
  f.send("new-route");
  hold.resolve(); await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "game").map(call => call.command), [
    "/say [Discord] Alice: old-route", "/say [Discord] Alice: new-route"
  ]);
  assert.equal(f.queue().length, 0);
});

test("expired jobs are removed before capacity overflow is applied", async t => {
  const f = fixture(t, { ready: false });
  for (let index = 0; index < 100; index++) f.send(`old-${index}`);
  await settle(f.service);
  f.advance(RELAY_QUEUE_TTL_MS + 1);
  f.send("fresh"); await settle(f.service);
  assert.deepEqual(f.queue().map(entry => entry.content), ["fresh"]);
  assert.equal(f.notices.filter(event => event.kind === "relay-queue-overflow").length, 0);
});

test("live game repetitions survive while server-origin custom echoes are suppressed", async t => {
  const f = fixture(t);
  f.service.acceptGame(f.server, { authorName: "Player", content: "same" });
  f.service.acceptGame(f.server, { authorName: "Player", content: "same" });
  f.send("custom echo");
  await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "discord").length, 2);
  assert.equal(f.service.isEcho("world", { authorName: "Alice", content: "[Discord] Alice: custom echo" }), false);
  assert.equal(f.service.isEcho("world", { authorName: "Server", content: "[Discord] Alice: custom echo" }), true);
});

test("unsupported standard game relay still permits platform cross-posts", async t => {
  const f = fixture(t, { game: "satisfactory" });
  f.server.game.chatCommandTemplate = null;
  f.send("hello"); await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "game").length, 0);
  assert.equal(f.calls.filter(call => call.platform === "kook").length, 1);
});

test("persistent restart migrates old pending entries and withholds dispatching entries", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-restart-"));
  const file = path.join(directory, "state.json");
  const store = new StateStore(file); store.load();
  store.setRelayQueue("world", [
    { authorName: "Alice", content: "legacy", enqueuedAt: 999000, sourcePlatform: "discord" },
    { id: "uncertain", state: "dispatching", authorName: "Alice", content: "do not retry", enqueuedAt: 999000 },
    { content: 42, enqueuedAt: 999000 }
  ]);
  store.flush();
  const restored = new StateStore(file); restored.load();
  const f = fixture(t, { store: restored });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "game").map(call => call.command), ["/say [Discord] Alice: legacy"]);
  assert.ok(f.notices.some(event => event.kind === "relay-restored-discarded" && event.count === 2));
  restored.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).relayQueue, {});
});

test("storage failure before dispatch sends nothing and leaves a retryable pending entry", async t => {
  const f = fixture(t);
  await settle(f.service);
  const flush = f.state.flush;
  f.state.flush = () => { throw new Error("disk full"); };
  assert.throws(() => f.send("persist me", "storage-id"), /storage unavailable/);
  assert.equal(f.calls.length, 0);
  f.state.flush = flush;
  await f.service.flush(f.server); await settle(f.service);
  assert.equal(f.calls.filter(call => call.platform === "game").length, 1);
  assert.equal(f.send("persist me", "storage-id"), false);
});

test("settled relay fan-out attempts every listener while regular events keep their existing contract", async () => {
  const bus = new CoreEventBus();
  let second = 0;
  bus.on("event", () => { throw new Error("first failed"); });
  bus.on("event", () => { second++; return "ok"; });
  const outcomes = await bus.emitSettled("event", {});
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].value, "ok");
  await assert.rejects(bus.emit("event", {}), /first failed/);
  assert.equal(second, 1);
});

test("pending platform deliveries and source receipts survive a real state-file restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-platform-restart-"));
  const file = path.join(directory, "state.json");
  const store = new StateStore(file); store.load();
  const first = fixture(t, { store, ready: false, platformSend: async () => {
    throw Object.assign(new Error("not connected"), { deliveryStatus: "not-sent" });
  } });
  first.send("persisted", "persistent-source-id");
  await settle(first.service); await first.service.stop();
  const restored = new StateStore(file); restored.load();
  const second = fixture(t, { store: restored });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  second.advance(1000);
  second.service.reconcile(); await settle(second.service);
  assert.equal(second.send("persisted", "persistent-source-id"), false);
  assert.equal(second.calls.filter(call => call.platform === "kook").length, 1);
  assert.equal(second.calls.filter(call => call.platform === "game").length, 1);
  assert.deepEqual(restored.getRelayOutbox(), {});
});

test("platform workers preserve FIFO order during a blocked first send", async t => {
  const hold = deferred();
  const f = fixture(t, { platformSend: async (platform, event, calls) => {
    event.onDispatch(); calls.push({ platform, content: event.content });
    if (event.content === "first") await hold.promise;
    return { platform };
  } });
  f.send("first"); await new Promise(resolve => setImmediate(resolve));
  f.send("second"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(call => call.platform === "kook").map(call => call.content), ["first"]);
  hold.resolve(); await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "kook").map(call => call.content), ["first", "second"]);
});

test("invalid restored outbox records are discarded instead of posting oversized payloads", async t => {
  const state = { outbox: { "kook:world": [{ content: "bad", formattedContent: "x".repeat(2000), channelId: "kook", enqueuedAt: 999000 }] },
    getRelayQueue: () => [], setRelayQueue() {}, getRelayOutbox() { return this.outbox; }, getRelayReceipts: () => ({}),
    setRelayOutbox(outbox) { this.outbox = outbox; }, flush() {} };
  const f = fixture(t, { store: state }); await settle(f.service);
  assert.equal(f.calls.length, 0);
  assert.ok(f.notices.some(event => event.kind === "relay-restored-discarded"));
});

test("removing a server cancels queued work even with a custom state-store interface", async t => {
  const f = fixture(t, { ready: false });
  f.send("pending"); await settle(f.service);
  f.config.servers = [];
  f.service.reconcile(); await settle(f.service);
  assert.equal(f.queue().length, 0);
  assert.ok(f.notices.some(event => event.kind === "relay-cancelled"));
});

test("source receipts remain bounded after restoring a full receipt map and accepting a new ID", async t => {
  const queues = new Map();
  const state = { receipts: Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`receipt-${index}`, { at: 999000, id: `${index}` }])),
    outbox: {}, getRelayReceipts() { return this.receipts; }, getRelayOutbox() { return this.outbox; },
    getRelayQueue: id => queues.get(id) ?? [], setRelayQueue: (id, entries) => queues.set(id, entries),
    setRelayOutbox(outbox, receipts) { this.outbox = outbox; this.receipts = receipts; }, flush() {} };
  const f = fixture(t, { store: state, ready: false });
  f.send("new", "new-id");
  assert.equal(Object.keys(state.receipts).length, 10000);
  assert.equal(f.send("new", "new-id"), false);
});

test("Source chat reaches the game queue with safe console substitutions", async t => {
  const f = fixture(t, { game: "source" });
  f.server.game.chatCommandTemplate = 'say "[{platform}] {author}: {content}"';
  assert.equal(f.send('hello";quit'), true);
  await settle(f.service);
  assert.deepEqual(f.calls.filter(call => call.platform === "game"),
    [{ platform: "game", command: 'say "[Discord] Alice: hello＂；quit"' }]);
});
