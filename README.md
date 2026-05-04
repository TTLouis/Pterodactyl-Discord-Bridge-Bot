# Discord + Pterodactyl Bridge

This project supports Factorio, Minecraft, and Satisfactory servers managed by Pterodactyl.

It does the following things:

- keeps a single Discord status panel updated every minute
- relays Discord and game-server events where the selected adapter supports them
- can optionally auto-stop idle servers and let users restart them from Discord

## Current Capabilities

- Factorio: status, player list, game duration, Discord -> game relay, and game -> Discord chat relay
- Minecraft: status, player list, game duration, Discord -> game relay, and game -> Discord chat relay
- Satisfactory: status through the HTTPS API, player count, game duration, best-effort player names through `ListPlayers`, and optional Discord -> server relay through `RunCommand`
- Optional idle auto-stop with `/start-server` and `/cancel-stop` slash commands

Current Satisfactory limitations in this bot:

- no game -> Discord chat relay yet
- player names depend on the server accepting a `ListPlayers` command through the HTTPS API

## Status Panel

The main panel is updated in place in your configured Discord status channel. Each server is rendered as its own message with:

- a Discord-rendered "Last update" timestamp in each viewer's local timezone
- a fixed server-time footer using `discord.displayTimeZone`
- optional ASCII-art title block in a Discord code block
- fallback markdown heading when no ASCII title is configured
- description
- public address and port
- player count
- max player count
- online player names when the adapter can provide them
- simplified status
- CPU and memory
- game duration when the adapter can provide it

Factorio player names are bootstrapped from `/players o` and then refreshed when live `[JOIN]` or `[LEAVE]` console events are seen over the Pterodactyl WebSocket.

Minecraft player names are bootstrapped from `/list` and then refreshed when live join or leave console events are seen over the Pterodactyl WebSocket.

Satisfactory player counts come from the Dedicated Server HTTPS API `QueryServerState` response.

## Discord Commands

The bot registers these guild slash commands on startup:

- `/start-server` starts the server associated with the current Discord channel.
- `/cancel-stop` cancels a pending auto-stop warning for the server associated with the current Discord channel.

If a server was stopped outside of the bot, `/start-server` requires the user to have Discord Administrator permission. Bot-initiated auto-stops can be restarted by users in the configured server channel.

## Setup

There are two supported setup paths:

- use the bootstrap script when installing the bot on a new machine
- use `npm run setup` when you already have the repository checked out

The setup wizard creates `.env` and `servers.json` interactively. It will ask before overwriting either file.

### Fresh Install

On Linux or macOS:

```bash
curl -fsSL https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.sh -o bootstrap.sh || wget -O bootstrap.sh https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.sh && bash bootstrap.sh || echo "Bootstrap failed. Install Node.js 20+, npm, and unzip, then try again."
```

Do not prefix the whole command with `sudo`. Run it as your normal user so the downloaded files and generated config files are owned by your account.

On Windows PowerShell:

```powershell
Invoke-WebRequest -Uri https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases/latest/download/bootstrap.ps1 -OutFile bootstrap.ps1; if ($?) { powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 } else { Write-Host "Bootstrap download failed. Install Node.js 20+ and npm, then try again." -ForegroundColor Red }
```

The bootstrap scripts:

- check for Node.js 20 or newer, npm, and archive extraction support
- offer to install Node.js 20+, npm, and any required archive tool if a required tool is missing
- warn if Docker or Docker Compose is missing, then let you continue with npm-based setup
- download and extract the latest release package
- install dependencies
- run the interactive setup wizard

They do not install Docker or Docker Compose for you.

### Existing Checkout

If you already cloned the repository, run:

```bash
npm install
npm run setup
```

Then start the bot:

```bash
npm start
```

You can rerun `npm run setup` later to regenerate `.env` or `servers.json`. The wizard asks before replacing existing files.

### Manual Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the environment and config templates:

```bash
copy .env.example .env
copy servers.example.json servers.json
```

3. Fill in:

- `DISCORD_TOKEN` in `.env`
- your Discord guild ID, status channel ID, and optional `discord.displayTimeZone` in `servers.json`
- optionally `discord.logChannelId` if you want bot logs mirrored into Discord
- your Pterodactyl panel URL and client API key in `servers.json`
- one entry in `servers[]` for each server
- `description`, `publicAddress`, `publicPort`, and `maxPlayers` for each server if you want them shown in the panel
- optionally `asciiTitleLines` for a larger manual ASCII-art server title above the embed
- optionally `asciiTitle` if you prefer a single string with embedded `\n` line breaks
- optionally `autoStop` for idle server shutdown behavior
- optionally override `CONFIG_PATH` and `STATE_PATH` if you want the config or runtime state somewhere else

4. For each Satisfactory server, also fill in:

- `game.apiToken`
- optionally `game.apiUrl` if the HTTPS API should not be derived from `https://<publicAddress>:<publicPort>/api/v1`
- optionally `game.allowInsecureTls` if you want to override the default `true`
- optionally `game.chatCommandTemplate` if you want Discord messages relayed through `RunCommand`

Satisfactory API tokens are application tokens. Per the current official wiki/doc mirror, third-party tools should use Bearer application tokens, and they are generated from the dedicated server console with `server.GenerateAPIToken`.

5. For each Minecraft server, set `game.type` to `minecraft`. The default relay command is:

```text
/say [Discord] {author}: {content}
```

6. Start the bot:

```bash
npm start
```

## Releasing Setup Scripts

The recommended release model is to publish these GitHub Release assets:

- `bootstrap.sh`
- `bootstrap.ps1`
- `discord-pterodactyl-bridge.zip`

The bootstrap scripts download `discord-pterodactyl-bridge.zip` from `releases/latest/download/...`, extract it, install npm dependencies, and run the setup wizard. Users do not need Git.

Create the package asset with:

```bash
npm run package:release
```

## Hosting Model

This bot is intended to run outside of Pterodactyl, usually on a small separate VM or host.
It talks to Pterodactyl through the client API and WebSocket, then posts status and relay messages into Discord.

Keeping the bot separate from the game panel has a few practical advantages:

- the bot has its own logs and console, independent of any single game server
- one bot process can manage several Pterodactyl servers
- updates and restarts do not depend on a Pterodactyl egg or game-server allocation
- Docker Compose can persist runtime state without mixing it into a game server container

A Pterodactyl egg may be possible later, but the recommended deployment path is currently Docker Compose on a separate host.

## Docker Compose

1. Prepare the local files:

```bash
copy .env.example .env
copy servers.example.json servers.json
```

The bot stores Discord status panel message IDs and auto-stop state in `/data/runtime-state.json`.
With the provided compose file, that file lives in the named Docker volume `bot-data`, so you do not need to create it manually.

2. Build and start the container:

```bash
docker compose up --build -d
```

The compose service tags the built image as `discord-pterodactyl-bridge:latest`.

3. Follow logs:

```bash
docker compose logs -f
```

The compose file mounts:

- `.env` as container environment variables
- `./servers.json` to `/config/servers.json` read-only
- the `bot-data` Docker volume to `/data`

The container then runs with:

- `CONFIG_PATH=/config/servers.json`
- `STATE_PATH=/data/runtime-state.json`

To stop it:

```bash
docker compose down
```

Use this command only if you want to remove the persisted status-message and auto-stop state too:

```bash
docker compose down -v
```

## Deploy on a Separate VM

The simplest production setup is:

- a small VM or host with Docker and Docker Compose installed
- a checkout of this repository
- local `.env` and `servers.json` files on that host
- a persistent Docker volume for runtime state

After you change application code, rebuild and restart the container:

```bash
docker compose up -d --build
```

You can deploy the project on another machine in either of these ways.

### Option 1: Copy the project and rebuild on the target host

Copy these files to the target machine:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`
- `package.json`
- `package-lock.json`
- `src/`
- `.env`
- `servers.json`

Then run:

```bash
docker compose up -d --build
```

If you need to preserve existing Discord status panel message IDs from another Docker Compose install, migrate the `bot-data` volume or copy `/data/runtime-state.json` out of the old container before replacing it.

### Option 2: Use a private self-hosted GitHub Actions runner

The `testing` branch includes a private deployment workflow at `.github/workflows/deploy.yml`.
It assumes a self-hosted Linux runner with the `DiscordBot` label and a checkout at `/opt/DiscordBot`.

On each push to `testing`, it runs:

```bash
cd /opt/DiscordBot
git fetch --prune origin testing
git switch -C testing origin/testing
docker compose up -d --build
docker image prune -f
```

That is useful for your own VM, but it is intentionally host-specific. Other users should treat it as an example, not a portable deployment workflow. The stable `main` branch intentionally does not auto-deploy.

### Option 3: Build once, ship the image, and run it on the target host

Save the image to a tarball:

```bash
docker image save discord-pterodactyl-bridge:latest -o discord-pterodactyl-bridge.tar
```

Copy these files to the target host:

- `discord-pterodactyl-bridge.tar`
- `.env`
- `servers.json`

Load and run the image on the target host:

```bash
docker load -i discord-pterodactyl-bridge.tar
docker volume create discord-bot-data
docker run -d --name discord-bot --restart unless-stopped --init --env-file .env -e CONFIG_PATH=/config/servers.json -e STATE_PATH=/data/runtime-state.json -v /opt/discord-bot/servers.json:/config/servers.json:ro -v discord-bot-data:/data discord-pterodactyl-bridge:latest
```

The image runs as the non-root `node` user. A Docker-managed named volume avoids most host file permission issues for runtime state.

## Pterodactyl Egg Status

This bot is not currently packaged as a Pterodactyl egg.
That may be worth investigating later for users who want to run the bot inside a panel-managed container, but it is not the main deployment target today.

If an egg is added later, it should still preserve the same basic contract:

- `DISCORD_TOKEN` is provided as a secret environment variable
- `servers.json` is supplied as user configuration
- runtime state is persisted across restarts
- the bot remains independent from any single game server

## Config Shape

```json
{
  "discord": {
    "guildId": "YOUR_GUILD_ID",
    "statusChannelId": "GLOBAL_STATUS_CHANNEL_ID",
    "logChannelId": "OPTIONAL_LOG_CHANNEL_ID",
    "displayTimeZone": "America/Toronto"
  },
  "pterodactyl": {
    "baseUrl": "https://panel.example.com",
    "apiKey": "ptlc_your_client_api_key",
    "pollIntervalSeconds": 60
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
      "description": "Main public factory server",
      "pterodactylServerId": "a1b2c3d4",
      "discordChannelId": "FACTORIO_DISCORD_CHANNEL_ID",
      "publicAddress": "play.example.com",
      "publicPort": 34197,
      "maxPlayers": 32,
      "game": {
        "type": "factorio",
        "chatCommandTemplate": "/shout DISCORD<{author}>: {content}",
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
      "description": "Main survival world",
      "pterodactylServerId": "m1n2o3p4",
      "discordChannelId": "MINECRAFT_DISCORD_CHANNEL_ID",
      "publicAddress": "minecraft.example.com",
      "publicPort": 25565,
      "maxPlayers": 20,
      "game": {
        "type": "minecraft",
        "chatCommandTemplate": "/say [Discord] {author}: {content}"
      }
    },
    {
      "name": "Satisfactory Main",
      "asciiTitle": "Satisfactory\\nMain",
      "description": "Main factory world",
      "pterodactylServerId": "e5f6g7h8",
      "discordChannelId": "SATISFACTORY_DISCORD_CHANNEL_ID",
      "publicAddress": "satisfactory.example.com",
      "publicPort": 7777,
      "maxPlayers": 16,
      "game": {
        "type": "satisfactory",
        "apiToken": "YOUR_SATISFACTORY_API_TOKEN",
        "allowInsecureTls": true,
        "chatCommandTemplate": null
      }
    }
  ]
}
```

Notes:

- `pterodactylServerId` must be the client server identifier used by `/api/client/servers/{id}`.
- `discord.displayTimeZone` should be an IANA timezone such as `America/Toronto`. You can also override it with the `DISCORD_DISPLAY_TIMEZONE` environment variable.
- `discord.logChannelId` is optional. When configured, logger output is also sent to that Discord channel.
- Factorio chat is relayed into the game through the Pterodactyl WebSocket.
- Minecraft chat is relayed into the game through the Pterodactyl WebSocket.
- Satisfactory status is queried from the HTTPS API endpoint at `/api/v1` with Bearer auth.
- If `game.apiUrl` is omitted for Satisfactory, the bot derives it from `publicAddress` and `publicPort`.
- Satisfactory often uses self-signed TLS certificates; `game.allowInsecureTls` defaults to `true` in this runtime.
- `autoStop.enabled` turns on idle shutdown for that server. `emptyTimeoutHours` defaults to `24`, and `warningMinutesBefore` defaults to `60`.
- The bot stores Discord status panel message IDs and auto-stop state in `runtime-state.json`.
- `asciiTitleLines` is easier to maintain in JSON because each array entry becomes one line in the Discord code block.
- `asciiTitle` also works if you prefer a single string with embedded `\n` line breaks.
