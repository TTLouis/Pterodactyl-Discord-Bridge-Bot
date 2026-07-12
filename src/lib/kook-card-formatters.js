const STATUS_COLORS = {
  Online: "#22c55e",
  Starting: "#eab308",
  Stopping: "#f97316",
  Offline: "#ef4444"
};
const STATUS_THEMES = {
  Online: "success",
  Starting: "warning",
  Stopping: "warning",
  Offline: "danger"
};
const STATUS_META = {
  Online: { emoji: "🟢", label: "在线" },
  Starting: { emoji: "🟡", label: "启动中" },
  Stopping: { emoji: "🟠", label: "关闭中" },
  Offline: { emoji: "🔴", label: "离线" }
};
const MAX_CARD_COUNT = 5;
const MAX_HEADER_LENGTH = 100;
const MAX_KMARKDOWN_LENGTH = 5000;
const MAX_PLAIN_TEXT_LENGTH = 2000;
const PLAYER_NAMES_MAX_LENGTH = 700;
const DESCRIPTION_MAX_LENGTH = 850;
const ACTION_TITLE_MAX_LENGTH = 100;
const ACTION_DESCRIPTION_MAX_LENGTH = 1800;

function truncate(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function kmarkdown(content) {
  return {
    type: "kmarkdown",
    content: truncate(content, MAX_KMARKDOWN_LENGTH)
  };
}

function plainText(content) {
  return {
    type: "plain-text",
    content: truncate(content, MAX_PLAIN_TEXT_LENGTH)
  };
}

function formatAddress(snapshot) {
  if (!snapshot.publicAddress || !snapshot.publicPort) {
    return "未配置";
  }

  const address = `${snapshot.publicAddress}:${snapshot.publicPort}`.replace(/```/g, "'''");
  return ["```text", address, "```"].join("\n");
}

function formatPlayers(snapshot) {
  const maxPlayers = snapshot.maxPlayers ?? "?";
  return `${snapshot.playerCount}/${maxPlayers}`;
}

function formatPlayerCountLabel(snapshot) {
  const playerCount = Number(snapshot.playerCount ?? 0);
  const maxPlayers = typeof snapshot.maxPlayers === "number" ? snapshot.maxPlayers : null;

  if (playerCount <= 0) {
    return `😴 ${formatPlayers(snapshot)}`;
  }

  if (maxPlayers !== null && playerCount >= maxPlayers) {
    return `🎉 ${formatPlayers(snapshot)}`;
  }

  return `🏃 ${formatPlayers(snapshot)}`;
}

function formatOnlinePlayers(snapshot) {
  if (snapshot.playerNamesAvailable === false) {
    return "API 暂不可用";
  }

  if (!Array.isArray(snapshot.onlinePlayers)) {
    return "不适用";
  }

  if (snapshot.onlinePlayers.length === 0) {
    return "无";
  }

  return snapshot.onlinePlayers.join(", ");
}

function formatMemory(bytes) {
  if (typeof bytes !== "number") {
    return "未知";
  }

  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function formatCpu(percent) {
  if (typeof percent !== "number") {
    return "未知";
  }

  return `${percent}%`;
}

function formatDuration(uptimeMs) {
  if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return "不可用";
  }

  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}天 ${hours}小时 ${minutes}分`;
  }

  if (hours > 0) {
    return `${hours}小时 ${minutes}分`;
  }

  return `${minutes}分`;
}

function formatDescription(snapshot) {
  if (!snapshot.description) {
    return "暂无简介";
  }

  return truncate(snapshot.description, DESCRIPTION_MAX_LENGTH);
}

function formatTimestamp(value, options) {
  return new Intl.DateTimeFormat("zh-CN", options).format(value);
}

function formatFixedTime(value, timeZone) {
  return formatTimestamp(value, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });
}

function formatAsciiBlock(snapshot) {
  if (!snapshot.asciiTitle) {
    return null;
  }

  const safeAsciiTitle = String(snapshot.asciiTitle).replace(/```/g, "'''");
  return ["```text", safeAsciiTitle, "```"].join("\n");
}

function getStatusMeta(status) {
  return STATUS_META[status] ?? { emoji: "⚪", label: status };
}

function buildServerInfoText(snapshot) {
  const durationLabel = snapshot.gameDurationCached ? "上次已知时间" : "时间";
  const lines = [
    "**服务器信息**",
    `**内存:** ${formatMemory(snapshot.memoryBytes)}`,
    `**CPU:** ${formatCpu(snapshot.cpuPercent)}`,
    "",
    "**总游戏时长**",
    `**${durationLabel}:** ${formatDuration(snapshot.gameDurationMs)}`
  ];

  if (snapshot.satisfactoryState) {
    const { techTier, activeSchematic, gamePhase } = snapshot.satisfactoryState;
    lines.push(
      `**科技等级:** ${techTier ?? "未知"}`,
      `**游戏阶段:** ${gamePhase || "无"}`,
      `**当前项目:** ${activeSchematic || "无"}`
    );
  }

  return lines.join("\n");
}

function buildServerCard(snapshot, footerText) {
  const status = getStatusMeta(snapshot.simplifiedStatus);
  const modules = [
    {
      type: "header",
      text: plainText(truncate(snapshot.name, MAX_HEADER_LENGTH))
    }
  ];
  const asciiBlock = formatAsciiBlock(snapshot);

  if (asciiBlock) {
    modules.push({
      type: "section",
      text: kmarkdown(asciiBlock)
    });
  }

  modules.push(
    {
      type: "section",
      text: kmarkdown([
        "**服务器地址**",
        formatAddress(snapshot),
        "**简介**",
        formatDescription(snapshot)
      ].join("\n"))
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "paragraph",
        cols: 2,
        fields: [
          kmarkdown([
            "**状态**",
            `${status.emoji} ${status.label}`,
            "",
            "**玩家数量**",
            formatPlayerCountLabel(snapshot),
            "",
            "**玩家名称**",
            truncate(formatOnlinePlayers(snapshot), PLAYER_NAMES_MAX_LENGTH)
          ].join("\n")),
          kmarkdown(buildServerInfoText(snapshot))
        ]
      }
    },
    {
      type: "context",
      elements: [plainText(footerText)]
    }
  );

  return {
    type: "card",
    theme: STATUS_THEMES[snapshot.simplifiedStatus] ?? "secondary",
    color: STATUS_COLORS[snapshot.simplifiedStatus] ?? "#64748b",
    size: "lg",
    modules
  };
}

export function buildKookStatusPanel(snapshots, { displayTimeZone = "UTC", now = new Date() } = {}) {
  const footerText = `服务器时间 (${displayTimeZone}): ${formatFixedTime(now, displayTimeZone)}`;
  const updateText = `最后更新: ${formatFixedTime(now, displayTimeZone)}`;
  const cards = [
    {
      type: "card",
      theme: "primary",
      color: "#5865f2",
      size: "lg",
      modules: [
        {
          type: "context",
          elements: [plainText(updateText)]
        }
      ]
    },
    ...snapshots.slice(0, MAX_CARD_COUNT - 1).map((snapshot) => buildServerCard(snapshot, footerText))
  ];

  return {
    type: 10,
    content: JSON.stringify(cards)
  };
}

function colorToHex(color) {
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }

  if (typeof color !== "number" || !Number.isFinite(color)) {
    return "#64748b";
  }

  return `#${Math.max(0, Math.min(0xffffff, color)).toString(16).padStart(6, "0")}`;
}

function themeFromColor(color) {
  switch (colorToHex(color).toLowerCase()) {
    case "#22c55e":
      return "success";
    case "#eab308":
    case "#f97316":
      return "warning";
    case "#ef4444":
      return "danger";
    default:
      return "secondary";
  }
}

function normalizeDiscordEmbed(embed) {
  if (!embed) {
    return null;
  }

  if (typeof embed.toJSON === "function") {
    return embed.toJSON();
  }

  if (embed.data && typeof embed.data === "object") {
    return embed.data;
  }

  return embed;
}

function extractPrimaryEmbed(payload) {
  return normalizeDiscordEmbed(payload?.embeds?.[0]);
}

function translateTitle(title) {
  if (!title) {
    return "服务器通知";
  }

  const mappings = [
    ["✅ Auto-stop cancelled:", "✅ 自动停止已取消："],
    ["⚠️ Auto-stop warning:", "⚠️ 自动停止警告："],
    ["🔴 Server auto-stopped:", "🔴 服务器已自动停止："],
    ["🔴 Server stopped externally:", "🔴 服务器已被外部停止："],
    ["🟡 Starting server:", "🟡 正在启动服务器："],
    ["🟡 Start requested:", "🟡 已请求启动："],
    ["🟢 Server online:", "🟢 服务器在线："],
    ["🟡 Server starting:", "🟡 服务器启动中："],
    ["🟠 Server stopping:", "🟠 服务器关闭中："],
    ["🔴 Server offline:", "🔴 服务器离线："]
  ];

  for (const [prefix, translatedPrefix] of mappings) {
    if (title.startsWith(prefix)) {
      return `${translatedPrefix}${title.slice(prefix.length).trim()}`;
    }
  }

  return title;
}

function translateRestartAccess(value) {
  return value
    .replace("a Discord administrator or a member with the", "Discord 管理员或拥有")
    .replace("role", "身份组的成员")
    .replace("a Discord administrator", "Discord 管理员");
}

function translateDescription(description) {
  if (!description) {
    return "";
  }

  if (description === "A player joined the server. The idle timer has been reset.") {
    return "有玩家加入服务器。空闲计时器已重置。";
  }

  if (description.startsWith("No players detected. The server will automatically stop ")) {
    return "当前没有玩家在线。服务器将按计划自动停止。\n\n可在 Discord 使用 🔴 反应取消自动停止。";
  }

  if (description === "Server was automatically stopped due to inactivity.\n\nReact 🟢 to restart the server.") {
    return "服务器因无人活动已自动停止。\n\n可在 Discord 使用 🟢 反应重启服务器。";
  }

  const manualStopMatch = /^This server was stopped outside of the bot\. Only (.+) can restart it\.\n\nReact 🟢 to restart the server\.$/.exec(description);
  if (manualStopMatch) {
    return `此服务器在机器人外被停止。只有 ${translateRestartAccess(manualStopMatch[1])} 可以重启。\n\n可在 Discord 使用 🟢 反应重启服务器。`;
  }

  const startingMatch = /^Server start requested by \*\*(.+)\*\*\. It should be online shortly\.$/.exec(description);
  if (startingMatch) {
    return `服务器启动请求来自 **${startingMatch[1]}**。应很快上线。`;
  }

  if (description === "The start request was accepted. The server action message has been updated.") {
    return "启动请求已接受。服务器操作消息已更新。";
  }

  if (description === "Server is back online.") {
    return "服务器已重新上线。";
  }

  const onlineAttributionMatch = /^Server is back online\.\n\nStarted by \*\*(.+)\*\*\.\nStart requested .+\.$/.exec(description);
  if (onlineAttributionMatch) {
    return `服务器已重新上线。\n\n启动请求来自 **${onlineAttributionMatch[1]}**。`;
  }

  if (description === "Server is starting. Restart is not available while startup is in progress.") {
    return "服务器正在启动。启动过程中暂不能重启。";
  }

  if (description === "Server is stopping. Restart will be available once it is offline.") {
    return "服务器正在关闭。离线后可在 Discord 重启。";
  }

  const offlineMatch = /^Server is offline(.*)\.\n\nReact 🟢 to restart the server\.$/.exec(description);
  if (offlineMatch) {
    return `服务器当前离线${offlineMatch[1] || ""}。\n\n可在 Discord 使用 🟢 反应重启服务器。`;
  }

  const cancelMatch = /^Auto-stop was cancelled by \*\*(.+)\*\*\. The idle timer has been reset\.$/.exec(description);
  if (cancelMatch) {
    return `自动停止已由 **${cancelMatch[1]}** 取消。空闲计时器已重置。`;
  }

  return description;
}

function formatActionControls(reactions) {
  if (!Array.isArray(reactions) || reactions.length === 0) {
    return null;
  }

  return `Discord 操作：${reactions.join(" ")}`;
}

function buildActionCard({ title, description, color = "#64748b", theme = "secondary", controls = null }) {
  const modules = [
    {
      type: "header",
      text: plainText(truncate(title, ACTION_TITLE_MAX_LENGTH))
    }
  ];

  if (description) {
    modules.push({
      type: "section",
      text: kmarkdown(truncate(description, ACTION_DESCRIPTION_MAX_LENGTH))
    });
  }

  if (controls) {
    modules.push({
      type: "context",
      elements: [plainText(controls)]
    });
  }

  return {
    type: 10,
    content: JSON.stringify([{
      type: "card",
      theme,
      color,
      size: "lg",
      modules
    }])
  };
}

export function buildKookActionMessage(payload, { reactions = [] } = {}) {
  const embed = extractPrimaryEmbed(payload);
  const content = typeof payload?.content === "string" ? payload.content.trim() : "";
  const title = translateTitle(embed?.title ?? (content ? "服务器通知" : null));
  const description = translateDescription(embed?.description ?? content);

  return buildActionCard({
    title,
    description,
    color: colorToHex(embed?.color),
    theme: themeFromColor(embed?.color),
    controls: formatActionControls(reactions)
  });
}

export function buildKookActionMessageForEvent(event) {
  switch (event.kind) {
    case "activity-cancelled":
      return buildActionCard({
        title: `✅ 自动停止已取消：${event.server.name}`,
        description: "有玩家加入服务器。空闲计时器已重置。",
        color: "#22c55e",
        theme: "success"
      });
    case "auto-stop-warning":
      return buildActionCard({
        title: `⚠️ 自动停止警告：${event.server.name}`,
        description: "当前没有玩家在线。服务器将按计划自动停止。",
        color: "#f97316",
        theme: "warning",
        controls: "Discord 操作：🔴"
      });
    case "auto-stopped":
      return buildActionCard({
        title: `🔴 服务器已自动停止：${event.server.name}`,
        description: "服务器因无人活动已自动停止。",
        color: "#ef4444",
        theme: "danger",
        controls: "Discord 操作：🟢"
      });
    case "manual-stopped":
      return buildActionCard({
        title: `🔴 服务器已被外部停止：${event.server.name}`,
        description: "此服务器在机器人外被停止。可在 Discord 重启。",
        color: "#ef4444",
        theme: "danger",
        controls: "Discord 操作：🟢"
      });
    case "server-online": {
      const requestedBy = event.startInfo?.startedBy
        ? `\n\n启动请求来自 **${event.startInfo.startedBy}**。`
        : "";
      return buildActionCard({
        title: `🟢 服务器在线：${event.server.name}`,
        description: `服务器已重新上线。${requestedBy}`,
        color: "#22c55e",
        theme: "success"
      });
    }
    case "server-starting-requested":
      return buildActionCard({
        title: `🟡 正在启动服务器：${event.server.name}`,
        description: `服务器启动请求来自 **${event.requestedBy}**。应很快上线。`,
        color: "#eab308",
        theme: "warning"
      });
    case "auto-stop-cancelled":
      return buildActionCard({
        title: `✅ 自动停止已取消：${event.server.name}`,
        description: `自动停止已由 **${event.cancelledBy}** 取消。空闲计时器已重置。`,
        color: "#22c55e",
        theme: "success"
      });
    case "server-starting-state":
      return buildActionCard({
        title: `🟡 服务器启动中：${event.server.name}`,
        description: "服务器正在启动。启动过程中暂不能重启。",
        color: "#eab308",
        theme: "warning"
      });
    case "server-stopping-state":
      return buildActionCard({
        title: `🟠 服务器关闭中：${event.server.name}`,
        description: "服务器正在关闭。离线后可在 Discord 重启。",
        color: "#f97316",
        theme: "warning"
      });
    case "server-offline":
      return buildActionCard({
        title: `🔴 服务器离线：${event.server.name}`,
        description: "服务器当前离线。",
        color: "#ef4444",
        theme: "danger",
        controls: "Discord 操作：🟢"
      });
    default:
      return null;
  }
}
