export const DEFAULT_CHAT_COMMAND_TEMPLATES = Object.freeze({
  factorio: "/shout {platform}<{author}>: {content}",
  minecraft: "/say [{platform}] {author}: {content}",
  source: 'say "[{platform}] {author}: {content}"'
});

export function getDefaultChatCommandTemplate(gameType) {
  return DEFAULT_CHAT_COMMAND_TEMPLATES[gameType] ?? null;
}

import { MAX_RELAY_CONTENT_LENGTH, MAX_RELAY_AUTHOR_LENGTH, MAX_RELAY_COMMAND_BYTES, MAX_RELAY_FRAME_BYTES } from "./relay-limits.js";

/**
 * Bounds a single relayed message. Queued relays are persisted to disk, so an
 * unbounded message would grow runtime state as well as the game console line.
 */
export function truncateRelayContent(value) {
  const text = String(value ?? "");
  return text.length > MAX_RELAY_CONTENT_LENGTH
    ? `${safeSlice(text, MAX_RELAY_CONTENT_LENGTH - 1)}…`
    : text;
}

function safeSlice(text, length) {
  const sliced = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

export function normalizeRelayText(value, sourcePlatform) {
  let text = String(value ?? "");
  if (sourcePlatform === "discord") {
    text = text.replace(/<@!?\d+>/g, "@user").replace(/<@&\d+>/g, "@role")
      .replace(/<#\d+>/g, "#channel").replace(/<a?:([\w]+):\d+>/g, ":$1:");
  } else if (sourcePlatform === "kook") {
    text = text.replace(/\(met\)(.*?)\(met\)/g, "@user")
      .replace(/\(rol\)(.*?)\(rol\)/g, "@role").replace(/\(chn\)(.*?)\(chn\)/g, "#channel");
  }
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
}

export function escapeRelayMarkup(value) {
  return String(value ?? "").replace(/([\\*_~`|>\[\]()])/g, "\\$1")
    .replace(/@/g, "@\u200B").replace(/</g, "‹");
}

export function formatPlatformRelay(message, destinationPlatform, limit = 1900) {
  const platform = message.sourcePlatform === "discord" ? "Discord" : message.sourcePlatform === "kook" ? "KOOK" : null;
  const prefix = `${platform ? `[${platform}] ` : ""}**${escapeRelayMarkup(sanitizeAuthorName(message.authorName)) || "Player"}**: `;
  const content = escapeRelayMarkup(normalizeRelayText(message.content, message.sourcePlatform));
  const parts = [];
  // Split before escaping so a chunk cannot end in half an escape or surrogate.
  const raw = normalizeRelayText(message.content, message.sourcePlatform);
  let chunk = "";
  for (const character of raw) {
    if (prefix.length + escapeRelayMarkup(chunk + character).length > limit && chunk) {
      parts.push(prefix + escapeRelayMarkup(chunk));
      chunk = "";
    }
    chunk += character;
  }
  if (chunk || !parts.length) parts.push(prefix + (chunk ? escapeRelayMarkup(chunk) : content));
  return parts;
}

function sanitizeContent(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateRelayContent(normalized);
}

export function sanitizeAuthorName(value) {
  return safeSlice(String(value ?? "")
    .replace(/[\u0000-\u001F\u007F<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim(), MAX_RELAY_AUTHOR_LENGTH);
}

export const PLATFORM_CHAT_COLORS = Object.freeze({
  discord: "#5865F2",
  kook: "#00A1D6"
});

function sanitizeColor(value, fallback) {
  const normalized = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toUpperCase() : fallback;
}

function getPlatformName(sourcePlatform) {
  return sourcePlatform === "kook" ? "KOOK" : "Discord";
}

function getChatCommandTemplate(gameConfig) {
  return gameConfig.chatCommandTemplate;
}

function renderTemplate(template, values) {
  const substitutions = { author: values.authorName, content: values.content, platform: values.platformName };
  return template.replace(/\{(author|content|platform)\}/g, (_, key) => substitutions[key]);
}

export function hasChatCommandTemplate(gameConfig) {
  return Boolean(gameConfig?.chatCommandTemplate);
}

export function buildGameChatCommand(server, message) {
  const command = renderGameChatCommand(server, message);
  if (command && (Buffer.byteLength(command) > MAX_RELAY_COMMAND_BYTES
    || Buffer.byteLength(JSON.stringify({ event: "send command", args: [command] })) > MAX_RELAY_FRAME_BYTES)) {
    throw Object.assign(new Error("Rendered relay command exceeds the transport limit"), { deliveryStatus: "rejected", permanent: true });
  }
  return command;
}

function renderGameChatCommand(server, message) {
  const sourcePlatform = message.sourcePlatform === "kook" ? "kook" : "discord";
  const template = getChatCommandTemplate(server.game);
  if (!template) {
    return null;
  }

  const content = sanitizeContent(message.content);
  if (!content) {
    return null;
  }

  const platformName = getPlatformName(sourcePlatform);
  if (server.game?.type === "source") {
    // Source accepts semicolon-separated commands. User text must never close
    // the quoted say argument or introduce another console command.
    const safe = value => value.replace(/["\\;]/g, character => ({ '"': "＂", "\\": "／", ";": "；" })[character]);
    return renderTemplate(template, {
      authorName: safe(sanitizeAuthorName(message.authorName) || platformName),
      content: safe(content), platformName
    });
  }
  if (server.game?.type !== "factorio") {
    return renderTemplate(template, {
      authorName: sanitizeAuthorName(message.authorName) || platformName,
      content,
      platformName
    });
  }

  const platformColor = sanitizeColor(
    message.platformColor,
    PLATFORM_CHAT_COLORS[sourcePlatform]
  );
  const authorColor = sanitizeColor(message.authorColor, platformColor);
  const authorName = sanitizeAuthorName(message.authorName) || platformName;
  const coloredAuthorName = `[color=${authorColor}]${authorName}[/color]`;
  const rendered = renderTemplate(template, {
    authorName: coloredAuthorName,
    content,
    platformName: `[color=${platformColor}]${platformName}[/color]`
  });

  // The shipped Factorio templates use <{author}>. Move the name's color tag
  // around the brackets too, so they do not fall back to Factorio's default
  // chat color. Custom templates without those brackets retain their exact
  // formatting.
  return rendered.replaceAll(
    `<${coloredAuthorName}>`,
    () => `[color=${authorColor}]<${authorName}>[/color]`
  );
}
