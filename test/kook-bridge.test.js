import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { KookBridge } from "../src/services/kook-bridge.js";

function createMemoryStateStore() {
  const state = {
    statusMessages: {},
    actionMessages: {}
  };

  return {
    filePath: "memory",
    load() {
      return state;
    },
    getStatusMessageIds(channelId) {
      return state.statusMessages[channelId] ?? [];
    },
    setStatusMessageIds(channelId, messageIds) {
      state.statusMessages[channelId] = messageIds;
    },
    getActionMessageId(channelId) {
      const value = state.actionMessages[channelId];
      return typeof value === "object" ? value.messageId : value ?? null;
    },
    setActionMessageId(channelId, messageId) {
      state.actionMessages[channelId] = messageId;
    },
    getActionMessage(channelId) {
      const value = state.actionMessages[channelId];
      if (typeof value === "string") {
        return { messageId: value };
      }
      return value ?? null;
    },
    setActionMessage(channelId, entry) {
      state.actionMessages[channelId] = entry;
    }
  };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function makeJsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { code: 0, data };
    }
  };
}

test("KOOK gateway text messages are normalized for message handlers", async () => {
  const originalFetch = globalThis.fetch;
  const sockets = [];
  const messages = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace("/api/v3", "");

    if (endpoint === "/user/me") {
      return makeJsonResponse({ id: "bot-user" });
    }

    if (endpoint === "/gateway/index") {
      assert.equal(parsed.searchParams.get("compress"), "0");
      return makeJsonResponse({ url: "wss://gateway.example.test" });
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  try {
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore: createMemoryStateStore(),
      apiBaseUrl: "https://example.test/api/v3",
      gatewayHeartbeatIntervalMs: 60_000,
      webSocketFactory(url) {
        assert.equal(url, "wss://gateway.example.test");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      logger: { info() {}, warn() {} }
    });
    bridge.onMessage((message) => {
      messages.push(message);
    });

    await bridge.start();
    sockets[0].emit("message", Buffer.from(JSON.stringify({ s: 1, d: { code: 0, session_id: "session" } })));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      s: 0,
      sn: 42,
      d: {
        channel_type: "GROUP",
        type: 9,
        target_id: "kook-channel",
        author_id: "user-1",
        content: "hello from kook",
        msg_id: "msg-1",
        extra: {
          guild_id: "guild",
          author: {
            nickname: "Kai"
          }
        }
      }
    })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await bridge.stop();

    assert.deepEqual(messages, [{
      sourcePlatform: "kook",
      authorId: "user-1",
      authorName: "Kai",
      channelId: "kook-channel",
      content: "hello from kook",
      messageId: "msg-1"
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK gateway ignores self-authored messages", async () => {
  const originalFetch = globalThis.fetch;
  const sockets = [];
  const messages = [];
  globalThis.fetch = async (url) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");

    if (endpoint === "/user/me") {
      return makeJsonResponse({ id: "bot-user" });
    }

    if (endpoint === "/gateway/index") {
      return makeJsonResponse({ url: "wss://gateway.example.test" });
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  try {
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore: createMemoryStateStore(),
      apiBaseUrl: "https://example.test/api/v3",
      gatewayHeartbeatIntervalMs: 60_000,
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      logger: { info() {}, warn() {} }
    });
    bridge.onMessage((message) => {
      messages.push(message);
    });

    await bridge.start();
    sockets[0].emit("message", JSON.stringify({
      s: 0,
      sn: 1,
      d: {
        channel_type: "GROUP",
        type: 9,
        target_id: "kook-channel",
        author_id: "bot-user",
        content: "self echo",
        extra: { guild_id: "guild" }
      }
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await bridge.stop();

    assert.deepEqual(messages, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK status panels update known messages and create when the known message is stale", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let nextCreateId = 1;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });

    if (endpoint === "/message/update" && payload.msg_id === "stale-message") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 40000, message: "message not found" };
        }
      };
    }

    if (endpoint === "/message/create") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, data: { msg_id: `created-${nextCreateId++}` } };
        }
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: {} };
      }
    };
  };

  try {
    const stateStore = createMemoryStateStore();
    stateStore.setStatusMessageIds("status-channel", ["stale-message", "old-message"]);
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore,
      apiBaseUrl: "https://example.test/api/v3",
      logger: { info() {}, warn() {} }
    });

    await bridge.upsertStatusPanel("status-channel", { type: 10, content: "[{}]" });

    assert.deepEqual(requests.map((request) => request.endpoint), [
      "/message/update",
      "/message/create",
      "/message/delete",
      "/message/delete"
    ]);
    assert.equal(requests[1].payload.target_id, "status-channel");
    assert.deepEqual(stateStore.getStatusMessageIds("status-channel"), ["created-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK action messages use the KOOK action state instead of Discord message IDs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: endpoint === "/message/create" ? { msg_id: "new-kook-action" } : {}
        };
      }
    };
  };

  try {
    const stateStore = createMemoryStateStore();
    stateStore.setActionMessageId("kook-server", "old-kook-action");
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore,
      apiBaseUrl: "https://example.test/api/v3",
      logger: { info() {}, warn() {} }
    });

    await bridge.replaceActionMessage("kook-server", { type: 10, content: "[{}]" });

    assert.deepEqual(requests.map((request) => request.endpoint), [
      "/message/delete",
      "/message/create"
    ]);
    assert.equal(requests[0].payload.msg_id, "old-kook-action");
    assert.equal(requests[1].payload.target_id, "kook-server");
    assert.equal(stateStore.getActionMessageId("kook-server"), "new-kook-action");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK action messages edit safe adjacent server transitions", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });

    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: {} };
      }
    };
  };

  try {
    const stateStore = createMemoryStateStore();
    stateStore.setActionMessage("kook-server", {
      messageId: "old-kook-action",
      serverId: "factory-id",
      serverName: "Factory",
      kind: "server-stopping-state",
      state: "stopping"
    });
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore,
      apiBaseUrl: "https://example.test/api/v3",
      logger: { info() {}, warn() {} }
    });

    await bridge.replaceActionMessage(
      "kook-server",
      { type: 10, content: "[{}]" },
      {
        preferEdit: true,
        meta: {
          serverId: "factory-id",
          serverName: "Factory",
          kind: "server-offline",
          state: "offline"
        }
      }
    );

    assert.deepEqual(requests.map((request) => request.endpoint), ["/message/update"]);
    assert.equal(requests[0].payload.msg_id, "old-kook-action");
    assert.equal(stateStore.getActionMessageId("kook-server"), "old-kook-action");
    assert.equal(stateStore.getActionMessage("kook-server").kind, "server-offline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK status panel updates retry once after request timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const warnings = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });

    if (requests.length === 1) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { code: 0, data: {} };
      }
    };
  };

  try {
    const stateStore = createMemoryStateStore();
    stateStore.setStatusMessageIds("status-channel", ["status-message"]);
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore,
      apiBaseUrl: "https://example.test/api/v3",
      requestRetryDelayMs: 0,
      logger: {
        info() {},
        warn(message) {
          warnings.push(message);
        }
      }
    });

    await bridge.upsertStatusPanel("status-channel", { type: 10, content: "[{}]" });

    assert.deepEqual(requests.map((request) => request.endpoint), [
      "/message/update",
      "/message/update"
    ]);
    assert.equal(requests[0].payload.msg_id, "status-message");
    assert.equal(requests[1].payload.msg_id, "status-message");
    assert.equal(warnings[0], "KOOK API /message/update timed out; retrying once.");
    assert.deepEqual(stateStore.getStatusMessageIds("status-channel"), ["status-message"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("KOOK message creates are not retried after request timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname.replace("/api/v3", "");
    const payload = JSON.parse(options.body);
    requests.push({ endpoint, payload });

    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  };

  try {
    const stateStore = createMemoryStateStore();
    const bridge = new KookBridge({
      token: "token",
      guildId: "guild",
      stateStore,
      apiBaseUrl: "https://example.test/api/v3",
      requestRetryDelayMs: 0,
      logger: { info() {}, warn() {} }
    });

    await assert.rejects(
      () => bridge.upsertStatusPanel("status-channel", { type: 10, content: "[{}]" }),
      { name: "AbortError" }
    );

    assert.deepEqual(requests.map((request) => request.endpoint), ["/message/create"]);
    assert.deepEqual(stateStore.getStatusMessageIds("status-channel"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
