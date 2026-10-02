import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PterodactylClient } from "../src/services/pterodactyl-client.js";

test("server discovery follows Client API pagination and keeps bearer tokens out of results", async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, "Bearer private-key");
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, async json() { return {
      data: [{ attributes: { identifier: `server-${page}`, name: `World ${page}` } }],
      meta: { pagination: { total_pages: 2 } }
    }; } };
  };
  try {
    const client = new PterodactylClient({ commandIntervalMs: 0, baseUrl: "https://panel.example.test", apiKey: "private-key" });
    assert.deepEqual(await client.listAccessibleServers(), [
      { identifier: "server-1", name: "World 1", uuid: null, legacyIdentifier: null },
      { identifier: "server-2", name: "World 2", uuid: null, legacyIdentifier: null }
    ]);
    assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
  } finally { global.fetch = originalFetch; }
});

test("panel error bodies cannot leak a Client API key through thrown errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, async text() { return "private-key"; } });
  try {
    const client = new PterodactylClient({ commandIntervalMs: 0, baseUrl: "https://panel.example.test", apiKey: "private-key" });
    await assert.rejects(client.listAccessibleServers(), (error) =>
      error.message.includes("403") && !error.message.includes("private-key"));
  } finally { global.fetch = originalFetch; }
});

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.emit("close", 1000, Buffer.from(""));
  }
}

function emitMessage(socket, payload) {
  socket.emit("message", JSON.stringify(payload));
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("console subscriptions request logs only after reconnects", async () => {
  const sockets = [];
  const connectedEvents = [];
  const lines = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", {
    reconnectDelayMs: 0,
    sendLogs: true,
    onConnected(event) {
      connectedEvents.push(event);
    },
    onLine(line, metadata) {
      lines.push({ line, metadata });
    },
    onError() {}
  });

  await nextTick();
  sockets[0].emit("open");
  emitMessage(sockets[0], { event: "auth success", args: [] });

  assert.deepEqual(sockets[0].sent, [
    { event: "auth", args: ["token"] }
  ]);
  assert.deepEqual(connectedEvents, [{ isReconnect: false }]);

  sockets[0].emit("close", 1006, Buffer.from("lost"));
  await nextTick();
  await nextTick();

  sockets[1].emit("open");
  emitMessage(sockets[1], { event: "auth success", args: [] });
  emitMessage(sockets[1], {
    event: "console output",
    args: ["2026-07-02 13:55:11 [CHAT] TTLouis: message during gap"]
  });

  assert.deepEqual(sockets[1].sent, [
    { event: "auth", args: ["token"] },
    { event: "send logs", args: [null] }
  ]);
  assert.deepEqual(connectedEvents, [
    { isReconnect: false },
    { isReconnect: true }
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "2026-07-02 13:55:11 [CHAT] TTLouis: message during gap");
  assert.equal(lines[0].metadata.isBacklog, true);
  assert.equal(lines[0].metadata.isReconnect, true);

  unsubscribe();
});

test("runCommand reuses the subscribed console websocket and serializes commands", async () => {
  const sockets = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", {
    sendLogs: false,
    onError() {}
  });

  await nextTick();
  sockets[0].emit("open");
  emitMessage(sockets[0], { event: "auth success", args: [] });

  const first = client.runCommand("server-id", "/first", { captureMs: 10 });
  const second = client.runCommand("server-id", "/second", { captureMs: 10 });
  await nextTick();
  assert.deepEqual(sockets[0].sent, [
    { event: "auth", args: ["token"] },
    { event: "send command", args: ["/first"] }
  ]);

  emitMessage(sockets[0], { event: "console output", args: ["first output"] });
  assert.deepEqual(await first, ["first output"]);
  await nextTick();
  assert.deepEqual(sockets[0].sent, [
    { event: "auth", args: ["token"] },
    { event: "send command", args: ["/first"] },
    { event: "send command", args: ["/second"] }
  ]);

  emitMessage(sockets[0], { event: "console output", args: ["second output"] });
  assert.deepEqual(await second, ["second output"]);
  assert.equal(sockets.length, 1);
  unsubscribe();
});

test("runCommand rejects while the console subscription is not ready without opening another websocket", async () => {
  const sockets = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", { onError() {} });
  await nextTick();

  await assert.rejects(client.runCommand("server-id", "/queued-by-relay"), /not ready/);
  assert.equal(sockets.length, 1);
  unsubscribe();
});

test("onReady waits for reconnect backlog before allowing persistent commands", async () => {
  const sockets = [];
  const readyEvents = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", {
    reconnectDelayMs: 0,
    sendLogs: true,
    onError() {},
    onReady(event) { readyEvents.push(event); }
  });
  await nextTick();
  sockets[0].emit("open");
  emitMessage(sockets[0], { event: "auth success", args: [] });
  sockets[0].emit("close", 1006, Buffer.from("lost"));
  await nextTick();
  await nextTick();
  sockets[1].emit("open");
  emitMessage(sockets[1], { event: "auth success", args: [] });

  await assert.rejects(client.runCommand("server-id", "/wait-for-backlog"), /not ready/);
  assert.equal(sockets.length, 2);
  emitMessage(sockets[1], { event: "console output", args: ["backlog"] });
  assert.deepEqual(readyEvents, [{ isReconnect: false }, { isReconnect: true }]);

  const command = client.runCommand("server-id", "/after-backlog", { captureMs: 10 });
  await nextTick();
  assert.deepEqual(sockets[1].sent.at(-1), { event: "send command", args: ["/after-backlog"] });
  emitMessage(sockets[1], { event: "console output", args: ["command output"] });
  assert.deepEqual(await command, ["command output"]);
  unsubscribe();
});

test("console subscriptions report authentication timeouts instead of leaving commands blocked", async () => {
  const sockets = [];
  const errors = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    subscriptionAuthTimeoutMs: 5,
    reconnectDelayMs: 1000,
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", {
    reconnectDelayMs: 1000,
    onError(error) { errors.push(error); }
  });
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sockets.length, 1);
  assert.match(errors[0].message, /authentication timed out/);
  unsubscribe();
});

test("console subscriptions tolerate malformed websocket payloads and remain connected", async () => {
  const sockets = [];
  const client = new PterodactylClient({ commandIntervalMs: 0,
    baseUrl: "https://panel.example.test",
    apiKey: "api-key",
    webSocketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    }
  });
  client.getServerWebsocket = async () => ({
    socket: "wss://wings.example.test/api/servers/server-id/ws",
    token: "token",
    origin: "https://panel.example.test"
  });

  const unsubscribe = client.subscribeToConsole("server-id", { onError() {} });
  await nextTick();
  sockets[0].emit("open");
  sockets[0].emit("message", "not-json");
  emitMessage(sockets[0], { event: "auth success", args: [] });
  assert.equal(client.isConsoleSessionReady("server-id"), true);
  unsubscribe();
});

test("server allocations are normalized from the client API", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          data: [
            {
              attributes: {
                id: 1,
                ip: "10.0.0.1",
                ip_alias: "play.example.com",
                port: 34197,
                is_default: false
              }
            },
            {
              attributes: {
                id: 2,
                ip: "10.0.0.2",
                ip_alias: null,
                port: "25565",
                is_default: true
              }
            }
          ]
        };
      }
    };
  };

  try {
    const client = new PterodactylClient({ commandIntervalMs: 0,
      baseUrl: "https://panel.example.test/",
      apiKey: "api-key"
    });

    const allocation = await client.getServerDefaultAllocation("server-id");

    assert.equal(requests[0].url, "https://panel.example.test/api/client/servers/server-id/network/allocations");
    assert.equal(requests[0].options.headers.Authorization, "Bearer api-key");
    assert.deepEqual(allocation, {
      id: 2,
      ip: "10.0.0.2",
      ipAlias: null,
      port: 25565,
      notes: null,
      isDefault: true
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("panel requests time out with a clear error instead of hanging forever", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new Promise((_resolve, reject) => {
    // AbortSignal.timeout() uses an unref'd timer in Node. Keep the mocked
    // request alive so the test process cannot exit before the abort fires.
    const keepAlive = setTimeout(() => {}, 1000);
    options.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(options.signal.reason);
    }, { once: true });
  });

  try {
    const client = new PterodactylClient({ commandIntervalMs: 0,
      baseUrl: "https://panel.example.test",
      apiKey: "ptlc_test",
      apiRequestTimeoutMs: 25
    });

    await assert.rejects(
      () => client.getServerResources("server-id"),
      /Pterodactyl resources request timed out after 25ms/
    );
    await assert.rejects(
      () => client.setPowerState("server-id", "stop"),
      /Pterodactyl power request timed out after 25ms/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("power requests carry the API credentials and abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, async json() { return {}; }, async text() { return ""; } };
  };

  try {
    const client = new PterodactylClient({ commandIntervalMs: 0, baseUrl: "https://panel.example.test/", apiKey: "ptlc_test" });
    await client.setPowerState("server-id", "stop");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://panel.example.test/api/client/servers/server-id/power");
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers.Authorization, "Bearer ptlc_test");
    assert.equal(requests[0].options.body, JSON.stringify({ signal: "stop" }));
    assert.ok(requests[0].options.signal, "expected an abort signal on the request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("requests normalize trailing slashes restored by runtime configuration", async () => {
  const previous = global.fetch;
  const urls = [];
  global.fetch = async (url) => { urls.push(url); return { ok: true, async json() { return { attributes: { current_state: "offline" }, data: [], meta: { pagination: { total_pages: 1 } } }; } }; };
  try {
    const client = new PterodactylClient({ commandIntervalMs: 0, baseUrl: "https://panel.example/", apiKey: "private" });
    client.baseUrl = "https://panel.example///";
    await client.getServerResources("server"); await client.listAccessibleServers();
    assert.equal(urls[0], "https://panel.example/api/client/servers/server/resources");
    assert.equal(new URL(urls[1]).pathname, "/api/client");
  } finally { global.fetch = previous; }
});

for (const event of ["token expiring", "token expired", "jwt error"]) {
  test(event + " invalidates console readiness and obtains fresh credentials before resuming commands", async () => {
    const sockets = [];
    let credentials = 0;
    let readyEvents = 0;
    const client = new PterodactylClient({ commandIntervalMs: 0,baseUrl:"https://panel.example.test",apiKey:"private-key",
      webSocketFactory() { const socket=new FakeWebSocket(); sockets.push(socket); return socket; }});
    client.getServerWebsocket = async () => {
      credentials++;
      return {socket:"wss://wings.example.test/ws",token:`token-${credentials}`,origin:"https://panel.example.test"};
    };
    const unsubscribe=client.subscribeToConsole("server-id",{sendLogs:false,reconnectDelayMs:0,onReady(){readyEvents++;},onError(){}});
    try {
      await nextTick(); sockets[0].emit("open"); emitMessage(sockets[0],{event:"auth success",args:[]});
      client.websocketCredentialCache.set("server-id",{token:"old-token"});
      const pending=client.runCommand("server-id","/players o",{captureMs:10000});
      const rejected=assert.rejects(pending,/credentials need renewal/);
      await nextTick(); emitMessage(sockets[0],{event,args:["private-token-error-must-not-be-logged"]});
      assert.equal(client.isConsoleSessionReady("server-id"),false);
      assert.equal(client.websocketCredentialCache.has("server-id"),false);
      await rejected;
      await nextTick(); await nextTick();
      assert.equal(credentials,2);
      sockets[1].emit("open"); emitMessage(sockets[1],{event:"auth success",args:[]});
      assert.deepEqual(sockets[1].sent[0],{event:"auth",args:["token-2"]});
      assert.equal(readyEvents,2);
      // A late expiry event from the retired socket must not tear down its replacement.
      emitMessage(sockets[0],{event:"token expired",args:[]});
      sockets[0].emit("close",1000,Buffer.from("late close"));
      assert.equal(client.isConsoleSessionReady("server-id"),true);
      const recovered=client.runCommand("server-id","/players o",{captureMs:10});
      await nextTick(); emitMessage(sockets[1],{event:"console output",args:["Online players (0):"]});
      assert.deepEqual(await recovered,["Online players (0):"]);
    } finally {unsubscribe();}
  });
}

async function relayTransport(t, overrides = {}) {
  const socket = new FakeWebSocket();
  const client = new PterodactylClient({ baseUrl: "https://panel.example.test", apiKey: "key", commandIntervalMs: 0,
    webSocketFactory: () => socket, ...overrides });
  client.getServerWebsocket = async () => ({ socket: "wss://wings.example.test/ws", token: "token", origin: "https://panel.example.test" });
  const unsubscribe = client.subscribeToConsole("world", { onError() {} });
  t.after(unsubscribe);
  await nextTick(); socket.emit("open"); emitMessage(socket, { event: "auth success" });
  return { client, socket };
}

test("relay transport requires running status and rechecks policy after command queue waits", async t => {
  const { client, socket } = await relayTransport(t);
  let checkpoints = 0;
  assert.equal((await client.runRelayCommand("world", "/say offline", { onDispatch() { checkpoints++; } })).status, "not-sent");
  emitMessage(socket, { event: "status", args: ["running"] });
  const query = client.runCommand("world", "/list", { captureMs: 10 });
  let current = true;
  const relay = client.runRelayCommand("world", "/say obsolete", { isCurrent: () => current, onDispatch() { checkpoints++; } });
  current = false;
  await query;
  assert.equal((await relay).status, "not-sent");
  assert.equal(checkpoints, 0);
  assert.equal(socket.sent.some(event => event.args?.[0] === "/say obsolete"), false);
});

test("relay transport distinguishes a close after send from explicit throttling and daemon rejection", async t => {
  for (const [event, expected] of [["throttled", "not-sent"], ["daemon error", "rejected"], ["close", "unknown"]]) {
    const { client, socket } = await relayTransport(t);
    emitMessage(socket, { event: "status", args: ["running"] });
    let checkpoints = 0;
    const relay = client.runRelayCommand("world", "/say hello", { onDispatch() { checkpoints++; } });
    await nextTick();
    if (event === "close") socket.emit("close", 1006, Buffer.from("lost"));
    else emitMessage(socket, { event, args: ["send command"] });
    assert.equal((await relay).status, expected);
    assert.equal(checkpoints, 1);
  }
});

test("relay checkpoint failure prevents the network send", async t => {
  const { client, socket } = await relayTransport(t);
  emitMessage(socket, { event: "status", args: ["running"] });
  const outcome = await client.runRelayCommand("world", "/say cannot persist", { onDispatch() { throw new Error("disk failed"); } });
  assert.equal(outcome.status, "not-sent");
  assert.equal(socket.sent.some(event => event.event === "send command"), false);
});

test("all console commands share dispatch pacing", async t => {
  const { client, socket } = await relayTransport(t, { commandIntervalMs: 30 });
  const sentAt = [];
  const originalSend = socket.send.bind(socket);
  socket.send = payload => { if (JSON.parse(payload).event === "send command") sentAt.push(Date.now()); originalSend(payload); };
  await Promise.all([client.runCommand("world", "/one", { captureMs: 1 }), client.runCommand("world", "/two", { captureMs: 1 })]);
  assert.ok(sentAt[1] - sentAt[0] >= 25);
});

test("default live console subscriptions never request history after reconnect", async t => {
  const sockets = [];
  const client = new PterodactylClient({ baseUrl: "https://panel.example.test", apiKey: "key", commandIntervalMs: 0,
    webSocketFactory() { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } });
  client.getServerWebsocket = async () => ({ socket: "wss://wings.example.test/ws", token: "token", origin: "https://panel.example.test" });
  const ready = [];
  const unsubscribe = client.subscribeToConsole("world", { reconnectDelayMs: 0, onReady: event => ready.push(event), onError() {} });
  t.after(unsubscribe);
  await nextTick(); sockets[0].emit("open"); emitMessage(sockets[0], { event: "auth success" });
  sockets[0].emit("close", 1006, Buffer.from("lost")); await nextTick(); await nextTick();
  sockets[1].emit("open"); emitMessage(sockets[1], { event: "auth success" });
  assert.equal(sockets.flatMap(socket => socket.sent).some(event => event.event === "send logs"), false);
  assert.deepEqual(ready, [{ isReconnect: false }, { isReconnect: true }]);
});
