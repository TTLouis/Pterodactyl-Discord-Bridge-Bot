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
  Online: { emoji: "🟢", label: "Online" },
  Starting: { emoji: "🟡", label: "Starting" },
  Stopping: { emoji: "🟠", label: "Stopping" },
  Offline: { emoji: "🔴", label: "Offline" }
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
    return "Not configured";
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
    return "Unavailable from API";
  }

  if (!Array.isArray(snapshot.onlinePlayers)) {
    return "Not applicable";
  }

  if (snapshot.onlinePlayers.length === 0) {
    return "None";
  }

  return snapshot.onlinePlayers.join(", ");
}

function formatMemory(bytes) {
  if (typeof bytes !== "number") {
    return "Unknown";
  }

  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function formatCpu(percent) {
  if (typeof percent !== "number") {
    return "Unknown";
  }

  return `${percent}%`;
}

function formatDuration(uptimeMs) {
  if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return "Unknown";
  }

  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatDescription(snapshot) {
  if (!snapshot.description) {
    return "No description";
  }

  return truncate(snapshot.description, DESCRIPTION_MAX_LENGTH);
}

function formatTimestamp(value, options) {
  return new Intl.DateTimeFormat(undefined, options).format(value);
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
  const durationLabel = snapshot.gameDurationCached ? "Last Known Time" : "Time";
  const lines = [
    "**Server Infos**",
    `**RAM:** ${formatMemory(snapshot.memoryBytes)}`,
    `**CPU:** ${formatCpu(snapshot.cpuPercent)}`,
    "",
    "**Total Game Duration**",
    `**${durationLabel}:** ${formatDuration(snapshot.gameDurationMs)}`
  ];

  if (snapshot.satisfactoryState) {
    const { techTier, activeSchematic, gamePhase } = snapshot.satisfactoryState;
    lines.push(
      `**Tier:** ${techTier ?? "Unknown"}`,
      `**Game Phase:** ${gamePhase || "None"}`,
      `**Active Schematic:** ${activeSchematic || "None"}`
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
        "**Server Address**",
        formatAddress(snapshot),
        "**Description**",
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
            "**Status**",
            `${status.emoji} ${status.label}`,
            "",
            "**Player Number**",
            formatPlayerCountLabel(snapshot),
            "",
            "**Player Names**",
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
  const footerText = `Server Time (${displayTimeZone}): ${formatFixedTime(now, displayTimeZone)}`;
  const updateText = `Last update: ${formatFixedTime(now, displayTimeZone)}`;
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
