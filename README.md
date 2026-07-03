# Pterodactyl Platform Bridge

A multi-platform bot that monitors Pterodactyl game servers and posts live status panels and server events into chat platforms.

Supports **Factorio**, **Minecraft**, and **Satisfactory**.

## Features

- Live status panel per server, updated every minute (player list, CPU/memory, game duration)
- Discord/KOOK ↔ game chat relay for Factorio and Minecraft, plus Discord ↔ KOOK server-channel mirroring; optional game relay for Satisfactory
- Idle auto-stop with `/start-server` and `/cancel-stop` slash commands, plus reaction controls

Current Satisfactory limitations:

- No game → Discord chat relay
- The official API exposes connected player counts, but not player names
- Join/leave notifications are count-based and may group multiple changes between polls

## Setup

Clone the repository, then run the interactive setup wizard:

```bash
npm install
npm run setup
```

The wizard creates `.env` and `servers.json` and asks before overwriting either file. Start the bot with:

```bash
npm start
```

You can rerun `npm run setup` at any time to regenerate the config.

## Docker Compose

1. Copy the config templates and fill them in:

```bash
cp .env.example .env
cp servers.example.json servers.json
```

2. Build and start:

```bash
docker compose up --build -d
```

3. Follow logs:

```bash
docker compose logs -f
```

Runtime state (Discord message IDs, auto-stop state) is persisted in the `bot-data` Docker volume.

To stop without losing state:

```bash
docker compose down
```

To stop and wipe state:

```bash
docker compose down -v
```

## Deploying to Another Machine

Copy these files to the target host, then run `docker compose up -d --build`:

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- `package.json`, `package-lock.json`, `src/`
- `.env`, `servers.json`

## Hosting

The bot runs outside of Pterodactyl — on a separate VM or host — and talks to the panel through the client API and WebSocket. One bot process can manage several Pterodactyl servers.

## Runtime Architecture

The server polling, power-state tracking, and auto-stop decisions run in core services. Those services publish domain events such as status panel updates, action messages, game chat relays, and server notices. Discord and KOOK each have platform listeners that render those same events into platform-specific messages.

Discord still owns slash command and reaction inputs. KOOK mirrors core output events and can relay messages from configured KOOK server channels when `KOOK_ENABLED=true`.

## Config Reference

```json
{
  "discord": {
    "guildId": "YOUR_GUILD_ID",
    "statusChannelId": "GLOBAL_STATUS_CHANNEL_ID",
    "logChannelId": "OPTIONAL_LOG_CHANNEL_ID",
    "displayTimeZone": "America/Toronto"
  },
  "kook": {
    "guildId": "YOUR_KOOK_GUILD_ID",
    "statusChannelId": "KOOK_GLOBAL_STATUS_CHANNEL_ID",
    "logChannelId": "OPTIONAL_KOOK_LOG_CHANNEL_ID",
    "displayTimeZone": "Asia/Shanghai"
  },
  "pterodactyl": {
    "baseUrl": "https://panel.example.com",
    "apiKey": "ptlc_your_client_api_key",
    "pollIntervalSeconds": 60,
    "activePlayerPollIntervalSeconds": 15
  },
  "servers": [
    {
      "name": "Factorio Main",
      "asciiTitleLines": [
        "______         _             _         ",
        "|  ___|_ _  ___| |_ ___  _ __(_) ___    ",
        "| |_ / _` |/ __| __/ _ \\| '__| |/ _ \\ ",
        "|  _| (_| | (__| || (_) | |  | | (_) |",
        "|_|  \\__,_|\\___|\\__\\___/|_|  |_|\\___/ "
      ],
      "descriptionLines": [
        "**Main public factory server**",
        "Vanilla settings with no required mods.",
        "",
        "New players are welcome."
      ],
      "pterodactylServerId": "a1b2c3d4",
      "discordChannelId": "FACTORIO_DISCORD_CHANNEL_ID",
      "kookChannelId": "FACTORIO_KOOK_CHANNEL_ID",
      "publicAddress": "play.example.com",
      "publicPort": 34197,
      "maxPlayers": 32,
      "game": {
        "type": "factorio",
        "chatCommandTemplate": "/shout {platform}<{author}>: {content}",
        "kookChatCommandTemplate": "/shout KOOK<{author}>: {content}",
        "playerListRefreshIntervalSeconds": 900
      },
      "autoStop": {
        "enabled": true,
        "emptyTimeoutHours": 24,
        "warningMinutesBefore": 60
      }
    },
    {
      "name": "Minecraft Main",
      "descriptionLines": [
        "**Main survival world**",
        "Join from Java Edition using the address above."
      ],
      "pterodactylServerId": "m1n2o3p4",
      "discordChannelId": "MINECRAFT_DISCORD_CHANNEL_ID",
      "kookChannelId": "MINECRAFT_KOOK_CHANNEL_ID",
      "publicAddress": "minecraft.example.com",
      "publicPort": 25565,
      "maxPlayers": 20,
      "game": {
        "type": "minecraft",
        "chatCommandTemplate": "/say [{platform}] {author}: {content}",
        "kookChatCommandTemplate": "/say [KOOK] {author}: {content}"
      }
    },
    {
      "name": "Satisfactory Main",
      "asciiTitle": "Satisfactory\\nMain",
      "descriptionLines": [
        "**Main factory world**",
        "Use the current experimental game version."
      ],
      "pterodactylServerId": "e5f6g7h8",
      "discordChannelId": "SATISFACTORY_DISCORD_CHANNEL_ID",
      "kookChannelId": "SATISFACTORY_KOOK_CHANNEL_ID",
      "publicAddress": "satisfactory.example.com",
      "publicPort": 7777,
      "maxPlayers": 16,
      "game": {
        "type": "satisfactory",
        "apiToken": "YOUR_SATISFACTORY_API_TOKEN",
        "allowInsecureTls": true,
        "apiRequestTimeoutSeconds": 10,
        "chatCommandTemplate": null
      }
    }
  ]
}
```

Key notes:

- `pterodactylServerId` is the client server identifier used by `/api/client/servers/{id}`
- `publicPort` is optional. When omitted, the bot reads the server's default Pterodactyl allocation from `/api/client/servers/{id}/network/allocations`
- The Pterodactyl Client API key must be allowed to read allocations when `publicPort` is omitted
- `publicAddress` is optional if your Pterodactyl allocation has a useful alias/IP, but setting it is recommended when you want Discord/KOOK to show a friendly DNS name
- `discord.displayTimeZone` accepts any IANA timezone (e.g. `America/Toronto`); also overridable via `DISCORD_DISPLAY_TIMEZONE`
- `discord.logChannelId` is optional — mirrors logger output into a Discord channel, including startup configuration, server snapshots, status refreshes, console bridge subscriptions, and power-state transitions
- Set `KOOK_ENABLED=true` with `KOOK_TOKEN` to mirror status panels, server-channel action messages, and chat relay to KOOK; `kook.displayTimeZone` defaults to `Asia/Shanghai`
- `kookChannelId` is optional per server. Servers without it remain Discord-only on KOOK mirrors and inbound KOOK chat relay
- `game.chatCommandTemplate` supports `{author}`, `{content}`, and `{platform}`. Use `discordChatCommandTemplate` or `kookChatCommandTemplate` when a platform needs a different in-game label
- Satisfactory API tokens are application tokens generated from the server console with `server.GenerateAPIToken`
- Satisfactory often uses self-signed TLS; `game.allowInsecureTls` defaults to `true`
- `game.apiRequestTimeoutSeconds` defaults to `10` so an unavailable Satisfactory API cannot stall all status updates
- `asciiTitleLines` (array) or `asciiTitle` (single string with `\n`) both work for the ASCII title block
- `descriptionLines` preserves manual line breaks, blank lines, Unicode, and Discord Markdown; the older `description` string remains supported
- `pterodactyl.pollIntervalSeconds` controls empty-server refreshes; `activePlayerPollIntervalSeconds` defaults to `15` seconds while any server has players. Values in `servers.json` take precedence over legacy interval environment variables and reload without a restart
- Saving a valid `servers.json` automatically refreshes display settings such as descriptions, names, addresses, ports, player limits, timezone, and auto-stop values
- Server additions/removals, IDs, channel mappings, game settings, Discord/KOOK channel IDs, and Pterodactyl connection changes require a bot restart
- Invalid JSON or an invalid live change is logged and the bot continues using the previous configuration
- `autoStop.emptyTimeoutHours` defaults to `24`; `warningMinutesBefore` defaults to `60`
- Server action messages use 🔴 to cancel a pending auto-stop and 🟢 to restart a stopped server
- Override `CONFIG_PATH` and `STATE_PATH` env vars if you want config or Discord runtime state at custom paths
- Override `KOOK_STATE_PATH` if you want KOOK runtime state at a custom path; KOOK message IDs are kept separate from Discord message IDs
