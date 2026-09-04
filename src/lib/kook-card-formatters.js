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

/** One card is spent on the update header, leaving the rest for servers. */
export const MAX_STATUS_PANEL_SERVERS = MAX_CARD_COUNT - 1;
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
    ...snapshots.slice(0, MAX_STATUS_PANEL_SERVERS).map((snapshot) => buildServerCard(snapshot, footerText))
  ];

  return {
    type: 10,
    content: JSON.stringify(cards)
  };
}

export function buildKookArchivePanel(servers) {
  const archiveText = servers.length === 0
    ? "暂无已归档服务器。"
    : servers.map((server) => {
      const note = server.archiveNote ? ` — ${server.archiveNote}` : "";
      return `• **${server.name}**${note}`;
    }).join("\n");

  return {
    type: 10,
    content: JSON.stringify([{
      type: "card",
      theme: "secondary",
      color: "#64748b",
      size: "lg",
      modules: [
        { type: "header", text: plainText("已归档服务器") },
        { type: "section", text: kmarkdown(truncate(archiveText, MAX_KMARKDOWN_LENGTH)) }
      ]
    }])
  };
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
        description: "当前没有玩家在线；服务器将在预定时间自动关闭。",
        color: "#f97316",
        theme: "warning",
        controls: "请前往 Discord 使用 🔴 表情取消自动停止"
      });
    case "auto-stopped":
      return buildActionCard({
        title: `🔴 服务器已自动停止：${event.server.name}`,
        description: "服务器因长时间无人在线已自动停止。",
        color: "#ef4444",
        theme: "danger",
        controls: "请前往 Discord 使用 🟢 表情重启服务器"
      });
    case "manual-stopped":
      return buildActionCard({
        title: `🔴 服务器已被外部停止：${event.server.name}`,
        description: "服务器已在机器人外停止。具备权限的成员可前往 Discord 重启。",
        color: "#ef4444",
        theme: "danger",
        controls: "请前往 Discord 使用 🟢 表情重启服务器"
      });
    case "server-online": {
      const requestedBy = event.startInfo?.startedBy
        ? `\n\n启动请求来自 **${event.startInfo.startedBy}**。`
        : event.startInfo?.source === "pterodactyl-panel"
          ? "\n\n启动来自 Pterodactyl 面板。"
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
        description: `**${event.requestedBy}** 已提交启动请求；服务器即将上线。`,
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
        description: "服务器正在启动；启动完成前暂时无法再次重启。",
        color: "#eab308",
        theme: "warning"
      });
    case "server-stopping-state":
      return buildActionCard({
        title: `🟠 服务器关闭中：${event.server.name}`,
        description: "服务器正在关闭；完全离线后可前往 Discord 重启。",
        color: "#f97316",
        theme: "warning"
      });
    case "server-offline":
      return buildActionCard({
        title: `🔴 服务器离线：${event.server.name}`,
        description: "服务器当前离线。",
        color: "#ef4444",
        theme: "danger",
        controls: "请前往 Discord 使用 🟢 表情重启服务器"
      });
    default:
      return null;
  }
}
