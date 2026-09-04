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

### Prerequisites

- Node.js 20 or later, or Docker Compose
- A Discord application invited with the `bot` and `applications.commands` scopes
- Discord Gateway intents enabled for **Guilds**, **Guild Messages**, **Guild Message Reactions**, and **Message Content**
- A Pterodactyl Client API key. It also needs allocation-read access when the bot should discover a server's public port automatically.

Clone the repository, then copy the config templates and fill them in:

```bash
npm install
cp .env.example .env
cp servers.example.json servers.json
```

Put your Discord bot token in `.env`, then edit `servers.json` with your guild, channel, and Pterodactyl details. Every option is described under [Config Reference](#config-reference). Validate the configuration before starting:

```bash
npm run validate-config
```

```bash
npm start
```

On first run, confirm the bot is online in Discord, the status panel appears in the configured status channel, and the startup log has no Pterodactyl connection errors. The bot validates `servers.json` at startup and names the offending field if anything is missing or out of range, so a bad edit fails immediately rather than misbehaving later.

## Docker Compose

1. Copy and fill in the config templates as described under [Setup](#setup):

```bash
cp .env.example .env
cp servers.example.json servers.json
```

2. Build and start:

```bash
docker compose run --rm discord-bot npm run validate-config
docker compose up --build -d
```

3. Follow logs:

```bash
docker compose logs -f
```

Inspect the latest poll outcome (including failed servers) without exposing credentials:

```bash
docker compose exec discord-bot node src/health-status.js
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

The template-based setup above is the supported onboarding path. Run `npm run validate-config` on the target host before starting the bot.

## Hosting

The bot runs outside of Pterodactyl — on a separate VM or host — and talks to the panel through the client API and WebSocket. One bot process can manage several Pterodactyl servers.

## License

This project is licensed under the [MIT License](LICENSE).

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
      "asciiTitle": [
        "______         _             _         ",
        "|  ___|_ _  ___| |_ ___  _ __(_) ___    ",
        "| |_ / _` |/ __| __/ _ \\| '__| |/ _ \\ ",
        "|  _| (_| | (__| || (_) | |  | | (_) |",
        "|_|  \\__,_|\\___|\\__\\___/|_|  |_|\\___/ "
      ],
      "description": [
        "**Main public factory server**",
        "Vanilla settings with no required mods.",
        "",
        "New players are welcome."
      ],
      "pterodactylServerId": "a1b2c3d4",
      "archived": false,
      "archiveNote": null,
      "discordChannelId": "FACTORIO_DISCORD_CHANNEL_ID",
      "kookChannelId": "FACTORIO_KOOK_CHANNEL_ID",
      "publicAddress": "play.example.com",
      "publicPort": 34197,
      "maxPlayers": 32,
      "game": {
        "type": "factorio",
        "chatCommandTemplate": "/shout {platform}<{author}>: {content}",
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
      "description": [
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
        "chatCommandTemplate": "/say [{platform}] {author}: {content}"
      }
    },
    {
      "name": "Satisfactory Main",
      "asciiTitle": ["Satisfactory", "Main"],
      "description": [
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
- Set `archived: true` to keep a complete retired-server record in the compact archive panel. Archived servers are not polled and cannot receive relays or bot actions; `archiveNote` is optional and shown beside the server name. Both settings reload without a bot restart.
- `publicPort` is optional. When omitted, the bot reads the server's default Pterodactyl allocation from `/api/client/servers/{id}/network/allocations`
- The Pterodactyl Client API key must be allowed to read allocations when `publicPort` is omitted
- `publicAddress` is optional if your Pterodactyl allocation has a useful alias/IP, but setting it is recommended when you want Discord/KOOK to show a friendly DNS name
- `discord.displayTimeZone` accepts any IANA timezone (e.g. `America/Toronto`); also overridable via `DISCORD_DISPLAY_TIMEZONE`
- `discord.logChannelId` is optional — mirrors logger output into a Discord channel, including startup configuration, server snapshots, status refreshes, console bridge subscriptions, and power-state transitions
- Set `KOOK_ENABLED=true` with `KOOK_TOKEN` to mirror status panels, server-channel action messages, and chat relay to KOOK; `kook.displayTimeZone` defaults to `Asia/Shanghai`
- `kookChannelId` is optional per server. Servers without it remain Discord-only on KOOK mirrors and inbound KOOK chat relay
- `game.chatCommandTemplate` supports `{author}`, `{content}`, and `{platform}`. The core resolves `{platform}` to `Discord` or `KOOK` before relaying into the game
- Satisfactory API tokens are application tokens generated from the server console with `server.GenerateAPIToken`
- Satisfactory often uses self-signed TLS; `game.allowInsecureTls` defaults to `true`
- `game.apiRequestTimeoutSeconds` defaults to `10` so an unavailable Satisfactory API cannot stall all status updates
- `asciiTitle` is an array of lines for the ASCII title block
- `description` is an array of lines. It preserves manual line breaks, blank lines, Unicode, and Discord Markdown
- `pterodactyl.pollIntervalSeconds` controls empty-server refreshes; `activePlayerPollIntervalSeconds` defaults to `15` seconds while any server has players. Both live only in `servers.json` and reload without a restart
- Saving a valid `servers.json` automatically refreshes display settings such as descriptions, names, addresses, ports, player limits, timezone, and auto-stop values
- Saving Satisfactory API settings such as `game.apiToken`, `game.apiUrl`, `game.allowInsecureTls`, or `game.apiRequestTimeoutSeconds` reloads that server's Satisfactory API state without a bot restart
- Use `/restart-bot` in the configured Discord log channel to gracefully exit the bot so Docker/systemd can restart it
- Server additions/removals, IDs, channel mappings, non-Satisfactory game settings, Discord/KOOK channel IDs, and Pterodactyl connection changes require a bot restart
- Invalid JSON or an invalid live change is logged and the bot continues using the previous configuration
- Discord and KOOK each maintain an archive panel above the live status panel. The archive panel remains as a small placeholder when empty; both messages are edited in place. The Discord live panel shows at most 10 active servers and the KOOK live panel at most 4, both limited by the platforms. Servers beyond the limit are omitted and reported once in the log
- Console and gateway reconnects back off exponentially with jitter, capped at 60 seconds, and reset once a connection authenticates
- Set `PTERODACTYL_CONSOLE_DIAGNOSTICS=true` temporarily to log Pterodactyl console connection timing, safe endpoint details, credential-cache age, heartbeats, and WebSocket close codes/reasons. It never logs API keys, console tokens, or URL query parameters.
- `pterodactyl.apiRequestTimeoutSeconds` defaults to `10` and bounds every panel REST call, so an unresponsive panel cannot stall status updates for every server. Changing it requires a bot restart
- `game.playerListRefreshIntervalSeconds` sets the backup player-list refresh for Factorio and Minecraft and defaults to `900`. It is a safety net behind the live join/leave console events, so long intervals are fine
- Chat relayed to a stopped server is queued and delivered when its console is ready. The queue holds at most 100 messages per server and each message is capped at 500 characters; older messages are dropped first and expire after 24 hours. Both events are reported in the configured log channel
- A failed auto-stop is reported in the log channel and retried after five minutes; the bot never announces a stop it could not perform
- `autoStop.emptyTimeoutHours` defaults to `24`; `warningMinutesBefore` defaults to `60`. Both must be positive, and `warningMinutesBefore` must be smaller than the idle window in minutes; an invalid value is reported and the previous configuration is kept
- Server action messages use 🔴 to cancel a pending auto-stop and 🟢 to restart a stopped server
- Override `HEARTBEAT_PATH` to move the liveness file that `src/healthcheck.js` reads. The Compose healthcheck reports whether the poll loop is still completing passes; Docker does not restart unhealthy containers on its own, so pair it with an external watchdog if you want automatic recovery. `SYNC_HEALTH_PATH` stores the most recent poll summary, including whether every configured server failed.
- Override `CONFIG_PATH` and `STATE_PATH` env vars if you want config or Discord runtime state at custom paths
- Override `KOOK_STATE_PATH` if you want KOOK runtime state at a custom path; KOOK message IDs are kept separate from Discord message IDs
