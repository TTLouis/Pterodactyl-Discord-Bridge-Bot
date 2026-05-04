# Discord + Pterodactyl Bridge

This project supports Factorio and Satisfactory servers managed by Pterodactyl.

It does two things:

- keeps a single Discord status panel updated every minute
- relays Discord and game-server events where the selected adapter supports them

## Current Capabilities

- Factorio: status, player list, Discord -> game relay, and game -> Discord chat relay
- Satisfactory: status through the HTTPS API and optional Discord -> server relay through `RunCommand`

Current Satisfactory limitations in this bot:

- no game -> Discord chat relay yet
- no online player name list yet, only player count

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

Factorio player names are bootstrapped from `/players o` and then refreshed when live `[JOIN]` or `[LEAVE]` console events are seen over the Pterodactyl WebSocket.

Satisfactory player counts come from the Dedicated Server HTTPS API `QueryServerState` response.

## Setup

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
- your Pterodactyl panel URL and client API key in `servers.json`
- one entry in `servers[]` for each server
- `description`, `publicAddress`, `publicPort`, and `maxPlayers` for each server if you want them shown in the panel
- optionally `asciiTitleLines` for a larger manual ASCII-art server title above the embed
- optionally `asciiTitle` if you prefer a single string with embedded `\n` line breaks
- optionally override `CONFIG_PATH` and `STATE_PATH` if you want the config or runtime state somewhere else

4. For each Satisfactory server, also fill in:

- `game.apiToken`
- optionally `game.apiUrl` if the HTTPS API should not be derived from `https://<publicAddress>:<publicPort>/api/v1`
- optionally `game.allowInsecureTls` if you want to override the default `true`
- optionally `game.chatCommandTemplate` if you want Discord messages relayed through `RunCommand`

Satisfactory API tokens are application tokens. Per the current official wiki/doc mirror, third-party tools should use Bearer application tokens, and they are generated from the dedicated server console with `server.GenerateAPIToken`.

5. Start the bot:

```bash
npm start
```

## Docker

1. Prepare the local files:

```bash
copy .env.example .env
copy servers.example.json servers.json
copy NUL runtime-state.json
```

If `runtime-state.json` already exists, keep it. The bot stores the Discord status panel message IDs there.

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
- `./servers.json` to `/data/servers.json` read-only
- `./runtime-state.json` to `/data/runtime-state.json` read-write

The container then runs with:

- `CONFIG_PATH=/data/servers.json`
- `STATE_PATH=/data/runtime-state.json`

To stop it:

```bash
docker compose down
```

## Deploy Elsewhere

After you change application code, rebuild the image locally:

```bash
docker compose build
```

You can then deploy it on another machine in either of these ways.

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
- `runtime-state.json` if you want to preserve the existing Discord panel message IDs

If you are not copying an existing `runtime-state.json`, create an empty one on the target host before starting the container.

Then run:

```bash
docker compose up --build -d
```

### Option 2: Build once, ship the image, and run it on the target host

Save the image to a tarball:

```bash
docker image save discord-pterodactyl-bridge:latest -o discord-pterodactyl-bridge.tar
```

Copy these files to the target host:

- `discord-pterodactyl-bridge.tar`
- `.env`
- `servers.json`
- `runtime-state.json` if you want to preserve the existing Discord panel message IDs

If you are not copying an existing `runtime-state.json`, create it as an empty file on the target host first.

Load and run the image on the target host:

```bash
docker load -i discord-pterodactyl-bridge.tar
docker run -d --name discord-bot --restart unless-stopped --init --env-file .env -e CONFIG_PATH=/data/servers.json -e STATE_PATH=/data/runtime-state.json -v /opt/discord-bot/servers.json:/data/servers.json:ro -v /opt/discord-bot/runtime-state.json:/data/runtime-state.json discord-pterodactyl-bridge:latest
```

On Linux, make sure the mounted `runtime-state.json` is writable by container user `1000:1000`, because the image runs as the non-root `node` user.

## Config Shape

```json
{
  "discord": {
    "guildId": "YOUR_GUILD_ID",
    "statusChannelId": "GLOBAL_STATUS_CHANNEL_ID",
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
        "chatCommandTemplate": "/shout DISCORD<{author}>: {content}"
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
- Factorio chat is relayed into the game through the Pterodactyl WebSocket.
- Satisfactory status is queried from the HTTPS API endpoint at `/api/v1` with Bearer auth.
- If `game.apiUrl` is omitted for Satisfactory, the bot derives it from `publicAddress` and `publicPort`.
- Satisfactory often uses self-signed TLS certificates; `game.allowInsecureTls` defaults to `true` in this runtime.
- The bot stores the Discord status panel message IDs in `runtime-state.json` so it can edit the same server panels on the next refresh.
- `asciiTitleLines` is easier to maintain in JSON because each array entry becomes one line in the Discord code block.
- `asciiTitle` also works if you prefer a single string with embedded `\n` line breaks.




