import { MAX_RELAY_CONTENT_LENGTH } from "./relay-limits.js";

/**
 * Bounds a single relayed message. Queued relays are persisted to disk, so an
 * unbounded message would grow runtime state as well as the game console line.
 */
export function truncateRelayContent(value) {
  const text = String(value ?? "");
  return text.length > MAX_RELAY_CONTENT_LENGTH
    ? `${text.slice(0, MAX_RELAY_CONTENT_LENGTH - 1)}…`
    : text;
}

function sanitizeContent(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return truncateRelayContent(normalized);
}

function sanitizeAuthorName(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return template
    .replaceAll("{author}", values.authorName)
    .replaceAll("{content}", values.content)
    .replaceAll("{platform}", values.platformName);
}

export function hasChatCommandTemplate(gameConfig) {
  return Boolean(gameConfig?.chatCommandTemplate);
}

export function buildGameChatCommand(server, message) {
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
    `[color=${authorColor}]<${authorName}>[/color]`
  );
}
