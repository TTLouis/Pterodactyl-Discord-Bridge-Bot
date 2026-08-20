import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PterodactylClient } from "../src/services/pterodactyl-client.js";

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
  const client = new PterodactylClient({
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
  const client = new PterodactylClient({
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
  const client = new PterodactylClient({
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
  const client = new PterodactylClient({
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
  const client = new PterodactylClient({
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
  const client = new PterodactylClient({
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
    const client = new PterodactylClient({
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
