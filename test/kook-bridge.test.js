import assert from "node:assert/strict";
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
      return state.actionMessages[channelId] ?? null;
    },
    setActionMessageId(channelId, messageId) {
      state.actionMessages[channelId] = messageId;
    }
  };
}

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
