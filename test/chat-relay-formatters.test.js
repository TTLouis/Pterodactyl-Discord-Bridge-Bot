import assert from "node:assert/strict";
import test from "node:test";
import { buildGameChatCommand, hasChatCommandTemplate } from "../src/lib/chat-relay-formatters.js";

test("game chat command formatter renders platform-specific templates", () => {
  const server = {
    game: {
      chatCommandTemplate: "/shout {platform}<{author}>: {content}",
      kookChatCommandTemplate: "/shout KOOK<{author}>: {content}"
    }
  };

  assert.equal(hasChatCommandTemplate(server.game), true);
  assert.equal(
    buildGameChatCommand(server, {
      sourcePlatform: "kook",
      authorName: "Kai",
      content: "hello"
    }),
    "/shout KOOK<Kai>: hello"
  );
});

test("game chat command formatter sanitizes relay input", () => {
  const server = {
    game: {
      chatCommandTemplate: "/say [{platform}] {author}: {content}"
    }
  };

  assert.equal(
    buildGameChatCommand(server, {
      sourcePlatform: "discord",
      authorName: "<Lou\nis>",
      content: "hello\u0000  world"
    }),
    "/say [Discord] Lou is: hello world"
  );
  assert.equal(buildGameChatCommand(server, { content: "" }), null);
});
