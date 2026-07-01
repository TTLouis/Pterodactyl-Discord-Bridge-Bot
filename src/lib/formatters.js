import { EmbedBuilder } from "discord.js";

const STATUS_COLORS = {
  Online: 0x22c55e,
  Starting: 0xeab308,
  Stopping: 0xf97316,
  Offline: 0xef4444
};
const MAX_FIELD_VALUE_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 4096;
const PLAYER_NAMES_MAX_LENGTH = 700;
const DESCRIPTION_MAX_LENGTH = 850;
const STATUS_META = {
  Online: { emoji: "🟢", label: "Online" },
  Starting: { emoji: "🟡", label: "Starting" },
  Stopping: { emoji: "🟠", label: "Stopping" },
  Offline: { emoji: "🔴", label: "Offline" }
};

function formatAddress(snapshot) {
  if (!snapshot.publicAddress || !snapshot.publicPort) {
    return "Not configured";
  }

  return `${snapshot.publicAddress}:${snapshot.publicPort}`;
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

function buildServerInfoField(snapshot) {
  const durationLines = [`**Time:** ${formatDuration(snapshot.gameDurationMs)}`];

  if (snapshot.satisfactoryState) {
    const { techTier, activeSchematic, gamePhase } = snapshot.satisfactoryState;
    durationLines.push(
      `**Tier:** ${techTier ?? "Unknown"}`,
      `**Game Phase:** ${gamePhase || "None"}`,
      `**Active Schematic:** ${activeSchematic || "None"}`
    );
  }

  return {
    name: "Server Infos",
    value: [
      `**RAM:** ${formatMemory(snapshot.memoryBytes)}`,
      `**CPU:** ${formatCpu(snapshot.cpuPercent)}`,
      "",
      "**Total Game Duration**",
      ...durationLines
    ].join("\n")
  };
}

function getStatusMeta(status) {
  return STATUS_META[status] ?? { emoji: "⚪", label: status };
}

function getStatusColor(status) {
  return STATUS_COLORS[status] ?? 0x64748b;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatDescription(snapshot) {
  if (!snapshot.description) {
    return "No description";
  }

  return truncate(String(snapshot.description), DESCRIPTION_MAX_LENGTH);
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

function formatDiscordTimestamp(value, style) {
  return `<t:${Math.floor(value.getTime() / 1000)}:${style}>`;
}

function formatAsciiBlock(snapshot) {
  if (!snapshot.asciiTitle) {
    return null;
  }

  const safeAsciiTitle = String(snapshot.asciiTitle).replace(/```/g, "'''");
  return truncate(["```text", safeAsciiTitle, "```"].join("\n"), MAX_DESCRIPTION_LENGTH);
}

function buildServerEmbed(snapshot, footerText) {
  const status = getStatusMeta(snapshot.simplifiedStatus);
  const address = formatAddress(snapshot);
  const onlinePlayers = truncate(formatOnlinePlayers(snapshot), PLAYER_NAMES_MAX_LENGTH);
  const asciiBlock = formatAsciiBlock(snapshot);
  const serverInfo = buildServerInfoField(snapshot);

  const embed = new EmbedBuilder()
    .setColor(getStatusColor(snapshot.simplifiedStatus))
    .addFields([
      {
        name: snapshot.name,
        value: truncate(["**Server Address**", address, "", "**Description**", formatDescription(snapshot)].join("\n"), MAX_FIELD_VALUE_LENGTH),
        inline: true
      },
      {
        name: "Status",
        value: truncate(
          [
            `${status.emoji} ${status.label}`,
            "",
            "**Player Number**",
            formatPlayerCountLabel(snapshot),
            "",
            "**Player Names**",
            onlinePlayers
          ].join("\n"),
          MAX_FIELD_VALUE_LENGTH
        ),
        inline: true
      },
      {
        name: serverInfo.name,
        value: truncate(serverInfo.value, MAX_FIELD_VALUE_LENGTH),
        inline: true
      }
    ])
    .setFooter({ text: footerText });

  if (asciiBlock) {
    embed.setDescription(asciiBlock);
  }

  return embed;
}

export function buildStatusPanel(snapshots, { displayTimeZone } = {}) {
  const now = new Date();
  const footerText = `Server Time (${displayTimeZone}): ${formatFixedTime(now, displayTimeZone)}`;
  const localTimestamp = formatDiscordTimestamp(now, "F");
  const relativeTimestamp = formatDiscordTimestamp(now, "R");

  return {
    content: `Last update: ${localTimestamp} (${relativeTimestamp})`,
    embeds: snapshots.slice(0, 10).map((snapshot) => buildServerEmbed(snapshot, footerText))
  };
}

export function buildActivityCancelledEmbed(serverName) {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`✅ Auto-stop cancelled: ${serverName}`)
    .setDescription("A player joined the server. The idle timer has been reset.");
}

export function buildAutoStopWarningEmbed(serverName, stopAt) {
  return new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle(`⚠️ Auto-stop warning: ${serverName}`)
    .setDescription(
      `No players detected. The server will automatically stop ${formatDiscordTimestamp(stopAt, "R")} (${formatDiscordTimestamp(stopAt, "f")}).\n\nReact 🔴 to cancel auto-stop.`
    );
}

export function buildAutoStoppedEmbed(serverName) {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(`🔴 Server auto-stopped: ${serverName}`)
    .setDescription("Server was automatically stopped due to inactivity.\n\nReact 🟢 to restart the server.");
}

export function buildManuallyStoppedEmbed(serverName, restartAccess = "a Discord administrator") {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(`🔴 Server stopped externally: ${serverName}`)
    .setDescription(`This server was stopped outside of the bot. Only ${restartAccess} can restart it.\n\nReact 🟢 to restart the server.`);
}

export function buildServerStartingEmbed(serverName, requestedBy) {
  return new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle(`🟡 Starting server: ${serverName}`)
    .setDescription(`Server start requested by **${requestedBy}**. It should be online shortly.`);
}

export function buildCancelStopEmbed(serverName, cancelledBy) {
  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`✅ Auto-stop cancelled: ${serverName}`)
    .setDescription(`Auto-stop was cancelled by **${cancelledBy}**. The idle timer has been reset.`);
}

export function buildCommandReply(serverName, result) {
  const output = result.outputLines.length > 0 ? result.outputLines.join("\n") : "(no output)";
  return [
    `**${serverName}**`,
    `Command: \`${result.command}\``,
    "```text",
    output,
    "```"
  ].join("\n");
}
