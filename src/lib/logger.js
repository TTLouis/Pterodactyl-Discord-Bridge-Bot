let discordSink = null;

function formatForDiscord(level, message, meta) {
  const timestamp = new Date().toISOString();
  let text = `[${timestamp}] ${level}: ${message}`;

  if (meta instanceof Error) {
    const detail = meta.stack ?? `${meta.name}: ${meta.message}`;
    text += `\n${detail}`;
  } else if (meta !== undefined) {
    try {
      text += `\n${JSON.stringify(meta, null, 2)}`;
    } catch {
      text += `\n${String(meta)}`;
    }
  }

  const block = `\`\`\`\n${text}\n\`\`\``;
  return block.length <= 2000 ? block : `\`\`\`\n${text.slice(0, 1950)}\n...(truncated)\n\`\`\``;
}

function log(level, message, meta) {
  const timestamp = new Date().toISOString();
  if (meta === undefined) {
    console.log(`[${timestamp}] ${level}: ${message}`);
  } else {
    console.log(`[${timestamp}] ${level}: ${message}`, meta);
  }

  if (discordSink) {
    discordSink(formatForDiscord(level, message, meta)).catch(() => {});
  }
}

export const logger = {
  info(message, meta) {
    log("INFO", message, meta);
  },
  warn(message, meta) {
    log("WARN", message, meta);
  },
  error(message, meta) {
    log("ERROR", message, meta);
  },
  attachDiscordSink(sendFn) {
    discordSink = sendFn;
  }
};
