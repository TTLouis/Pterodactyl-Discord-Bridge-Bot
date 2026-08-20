function sanitizeContent(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function getChatCommandTemplate(gameConfig, sourcePlatform) {
  if (sourcePlatform === "kook" && typeof gameConfig.kookChatCommandTemplate === "string") {
    return gameConfig.kookChatCommandTemplate;
  }

  if (sourcePlatform === "discord" && typeof gameConfig.discordChatCommandTemplate === "string") {
    return gameConfig.discordChatCommandTemplate;
  }

  return gameConfig.chatCommandTemplate;
}

function renderTemplate(template, values) {
  return template
    .replaceAll("{author}", values.authorName)
    .replaceAll("{content}", values.content)
    .replaceAll("{platform}", values.platformName);
}

export function hasChatCommandTemplate(gameConfig) {
  return Boolean(
    gameConfig?.chatCommandTemplate
    || gameConfig?.discordChatCommandTemplate
    || gameConfig?.kookChatCommandTemplate
  );
}

export function buildGameChatCommand(server, message) {
  const sourcePlatform = message.sourcePlatform === "kook" ? "kook" : "discord";
  const template = getChatCommandTemplate(server.game, sourcePlatform);
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
  return renderTemplate(template, {
    authorName: `[color=${authorColor}]${sanitizeAuthorName(message.authorName) || platformName}[/color]`,
    content,
    platformName: `[color=${platformColor}]${platformName}[/color]`
  });
}
