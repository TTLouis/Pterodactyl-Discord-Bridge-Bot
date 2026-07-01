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
    return "未知";
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

export function buildKookActionMessage() {
  throw new Error("buildKookActionMessage is a placeholder and is not implemented yet.");
}
