# Pterodactyl Platform Bridge

Monitor Pterodactyl game servers from Discord, with optional KOOK mirroring. The bot keeps status panels current, relays chat where supported, and can stop idle servers automatically.

Supports **Factorio**, **Minecraft**, and **Satisfactory**.

## What it does

- Publishes live server status: power state, players, CPU, memory, game duration, and connection details.
- Relays Discord and KOOK channel messages to Factorio and Minecraft game chat; mirrors server-channel chat between Discord and KOOK.
- Provides idle auto-stop, restart, and cancellation controls through Discord slash commands and reactions.
- Persists panel IDs, action state, and queued relays across restarts.

## Quick start

### Requirements

- Node.js 20+ **or** Docker Compose
- A Discord application invited with the `bot` and `applications.commands` scopes
- Discord Gateway intents enabled for **Guilds**, **Guild Messages**, **Guild Message Reactions**, and **Message Content**
- A Pterodactyl Client API key; it also needs allocation-read access when the bot should discover public ports automatically

### Run with Node.js

```bash
npm install
cp .env.example .env
cp servers.example.json servers.json
```

Add the Discord token to `.env`, then edit `servers.json` with your guild, channel, and Pterodactyl details.

```bash
npm run validate-config
npm start
```

On first run, confirm the bot is online, a panel appears in the configured status channel, and the startup log has no Pterodactyl connection errors.

### Run with Docker Compose

```bash
cp .env.example .env
cp servers.example.json servers.json
docker compose run --rm discord-bot npm run validate-config
docker compose up --build -d
docker compose logs -f
```

Runtime state is stored in the `bot-data` volume. Use `docker compose down` to stop without losing it, or `docker compose down -v` to reset all persisted bot state.

## Supported games

| Game | Status and player data | Chat relay | Notes |
| --- | --- | --- | --- |
| Factorio | Console player list | Discord/KOOK ↔ game | Configure a `/shout`-style `chatCommandTemplate`. |
| Minecraft | Console player list | Discord/KOOK ↔ game | Configure a `/say`-style `chatCommandTemplate`. |
| Satisfactory | Official API player count | Optional Discord/KOOK → game | The API does not provide player names; join/leave notices are count-based. |

## Configuration

Start with [servers.example.json](servers.example.json). It is the canonical complete example and is validated by the test suite.

| Area | Required settings | Useful optional settings |
| --- | --- | --- |
| `discord` | `guildId`, `statusChannelId` | `logChannelId`, admin role, `displayTimeZone` |
| `pterodactyl` | `baseUrl`, `apiKey` | poll intervals, API request timeout |
| each `servers[]` item | `name`, `pterodactylServerId`, `discordChannelId`, `game.type` | address/port, description, KOOK channel, auto-stop, archive metadata |
| `kook` | `guildId`, `statusChannelId` when `KOOK_ENABLED=true` | log channel, admin role, timezone |

Important rules:

- Pterodactyl server IDs must be unique. Active servers must also use unique Discord and KOOK server channels.
- Set `archived: true` to retain a server in the archive panel without polling it or accepting relays/actions.
- Omit `publicPort` to discover the default allocation from Pterodactyl; set `publicAddress` to show a friendly host name.
- `description` and `asciiTitle` are arrays of lines, preserving blank lines and Discord Markdown.
- `game.chatCommandTemplate` supports `{author}`, `{content}`, and `{platform}`. Satisfactory needs `game.apiToken`; its `allowInsecureTls` option supports self-signed server certificates.
- `autoStop.warningMinutesBefore` must be positive and shorter than `autoStop.emptyTimeoutHours`.

Valid edits to display settings, archive state, poll intervals, and Satisfactory API settings reload automatically. Server topology, game type, channel mappings, and Pterodactyl connection settings require a bot restart.

## Operations

| Command | Purpose |
| --- | --- |
| `npm run validate-config` | Validate `CONFIG_PATH`/`servers.json` without Discord or KOOK tokens. |
| `npm test` | Run the automated test suite. |
| `npm run health-status` | Print the latest poll summary, including failed servers. |
| `docker compose exec discord-bot node src/health-status.js` | Read that summary in a running container. |
| `/refresh-status` | Force a Discord status refresh from the configured log channel. |
| `/restart-bot` | Gracefully exit so Docker or systemd can restart the bot. |

The Docker healthcheck verifies that the poll loop is alive. `SYNC_HEALTH_PATH` stores the latest poll summary so operators can distinguish a running bot from one that cannot reach every server. Set `PTERODACTYL_CONSOLE_DIAGNOSTICS=true` temporarily for safe console WebSocket diagnostics; tokens and query parameters are excluded from those logs.

## Architecture

Core services poll Pterodactyl, track power state and auto-stop decisions, and publish domain events. Discord and KOOK listeners render those events for each platform. Discord command and reaction handling is isolated from the polling/relay coordinator, so platform input can evolve independently.

## Deployment

Deploy from a clean clone plus your private `.env` and `servers.json`. The GitHub Actions workflow runs tests for pull requests and `main` pushes; a `main` deployment waits for a healthy container and restores the previous checkout if verification fails.

## License

This project is licensed under the [MIT License](LICENSE).
