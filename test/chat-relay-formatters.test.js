import assert from "node:assert/strict";
import test from "node:test";
import { buildGameChatCommand, hasChatCommandTemplate, truncateRelayContent } from "../src/lib/chat-relay-formatters.js";
import { MAX_RELAY_CONTENT_LENGTH } from "../src/lib/relay-limits.js";

test("game chat command formatter renders platform-specific templates", () => {
  const server = {
    game: {
      chatCommandTemplate: "/shout {platform}<{author}>: {content}"
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

test("Factorio chat formatter colors the platform and Discord role", () => {
  const server = {
    game: {
      type: "factorio",
      chatCommandTemplate: "{platform}<{author}>: {content}"
    }
  };

  assert.equal(
    buildGameChatCommand(server, {
      sourcePlatform: "discord",
      authorName: "Louis",
      authorColor: "#12ab34",
      content: "hello"
    }),
    "[color=#5865F2]Discord[/color][color=#12AB34]<Louis>[/color]: hello"
  );
  assert.equal(
    buildGameChatCommand(server, {
      sourcePlatform: "kook",
      authorName: "Kai",
      content: "hello"
    }),
    "[color=#00A1D6]KOOK[/color][color=#00A1D6]<Kai>[/color]: hello"
  );
});

test("relay content longer than the limit is truncated with an ellipsis", () => {
  const long = "x".repeat(MAX_RELAY_CONTENT_LENGTH * 2);
  const truncated = truncateRelayContent(long);

  assert.equal(truncated.length, MAX_RELAY_CONTENT_LENGTH);
  assert.ok(truncated.endsWith("…"));
});

test("relay content within the limit is returned unchanged", () => {
  assert.equal(truncateRelayContent("hello"), "hello");
  assert.equal(truncateRelayContent(""), "");
  assert.equal(truncateRelayContent(null), "");
});

test("built game chat commands are bounded even for oversized input", () => {
  const command = buildGameChatCommand(
    { game: { type: "minecraft", chatCommandTemplate: "/say {content}" } },
    { sourcePlatform: "discord", authorName: "Louis", content: "y".repeat(5000) }
  );

  assert.ok(command.length < 5000);
  assert.ok(command.startsWith("/say "));
  assert.equal(command.slice("/say ".length).length, MAX_RELAY_CONTENT_LENGTH);
});

test("relay replacements treat dollars and placeholder-like user values literally", () => {
  const server = { game: { type: "minecraft", chatCommandTemplate: "/say [{platform}] {author}: {content}" } };
  for (const content of ["$&", "$`", "$'", "{author} {platform} {content}"]) {
    assert.equal(buildGameChatCommand(server, { authorName: "{content}", content }), `/say [Discord] {content}: ${content}`);
  }
  const factorio = { game: { type: "factorio", chatCommandTemplate: "/shout {platform}<{author}>: {content}" } };
  assert.match(buildGameChatCommand(factorio, { authorName: "$&", content: "$&" }), /<\$&>/);
});

test("Unicode truncation never cuts a surrogate pair and rendered commands have byte limits", () => {
  const content = "x".repeat(498) + "😀" + "tail";
  const truncated = truncateRelayContent(content);
  assert.equal(truncated, "x".repeat(498) + "…");
  assert.throws(() => buildGameChatCommand({ game: { type: "minecraft", chatCommandTemplate: "/say " + "x".repeat(2048) + "{content}" } }, { content: "hello" }), /transport limit/);
  assert.throws(() => buildGameChatCommand({ game: { type: "minecraft", chatCommandTemplate: "/say " + "{content}".repeat(10) } }, { content: "😀".repeat(250) }), /transport limit/);
});

test("platform formatting escapes mentions and names and safely splits long Unicode text", async () => {
  const { formatPlatformRelay, normalizeRelayText } = await import("../src/lib/chat-relay-formatters.js");
  assert.equal(normalizeRelayText("<@123> <@&456> <#789> <:wave:123>", "discord"), "@user @role #channel :wave:");
  assert.equal(normalizeRelayText("(met)123(met) (rol)456(rol) (chn)789(chn)", "kook"), "@user @role #channel");
  const parts = formatPlatformRelay({ authorName: "**@everyone**", content: "😀".repeat(2000) + " @everyone (met)all(met)", sourcePlatform: "discord" }, "kook");
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 1900);
    assert.equal(/@everyone|\(met\)all\(met\)/.test(part), false);
    assert.equal(/[\uD800-\uDBFF]$/.test(part), false);
  }
  assert.equal(parts.join("").split("😀").length - 1, 2000);
});
