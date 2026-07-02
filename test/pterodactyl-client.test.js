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
