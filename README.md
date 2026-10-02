# Pterodactyl Platform Bridge

> **AI assistance:** I use OpenAI Codex to help develop and document this project. I maintain the project and make the release decisions.

Manage your Pterodactyl game servers from Discord, with optional KOOK mirroring. See server status and players, relay game chat, control server power, and stop empty servers automatically.

One installation connects **one Discord guild to one Pterodactyl panel**. All features are free under the [MIT License](LICENSE).

## What you can do

- Show server status, player information, connection addresses, and descriptions in Discord.
- Discover servers from your panel and manage them through private administration cards.
- Start, stop, and restart servers with confirmation.
- Relay chat between Discord, optional KOOK channels, and supported games.
- Enable idle auto-stop for servers with reliable player detection.
- Keep new server channels private until you choose to publish them to a selected access role.
- Archive servers while retaining their channels and history, and arrange status panels and channels in your preferred order.

| Game | Player information | Game chat relay | Extra setup |
| --- | --- | --- | --- |
| Factorio | Player list | Supported | Pterodactyl console access |
| Minecraft | Player list | Supported | Pterodactyl console access |
| Satisfactory | Player count | No standard chat relay | Game API token and reachable API endpoint |
| Source 1 | Human player list | Supported | Pterodactyl console access; enable `log on` and `sv_logecho 1` in `server.cfg` |

Compatibility depends on your game's console output or API. Source 2 and game-specific plugins may need additional compatibility work. Chat relay forwards new text messages; attachments, edits, deletions, and game chat sent while the bridge is disconnected are not recovered.

## Before you install

You need:

- A Discord guild where you are the owner or an administrator.
- A Discord bot token.
- Your Pterodactyl **Panel URL** and a **Client API key** that can access the servers you want to manage. Allocation-read access is needed to discover public ports.
- A host that can reach Discord, your Panel, Wings, and any required game API endpoints.
- Persistent storage for the bridge's settings and credentials.

### Prepare your Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot.
2. Enable **Message Content Intent** in the bot settings, even if you plan to leave chat relay disabled.
3. Copy the bot token. You will enter it in your deployment settings below.
4. Invite the application to your guild using the `bot` and `applications.commands` scopes. Grant **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Add Reactions**, **Manage Channels**, and **Manage Roles**. Manage Roles is needed to set channel access permissions.

Keep the bot token and API keys private. Enter the Panel URL and Client API key through the bridge's Discord setup modal after launch.

## Choose how to install

| Method | You need | Where settings are saved |
| --- | --- | --- |
| [Pterodactyl Egg](#1-pterodactyl-egg) | Panel administrator access and a Wings node | The bridge server's persistent directory |
| [Docker Compose](#2-docker-compose) | Docker Engine and Compose | A persistent Docker volume |
| [Standalone / Node.js](#3-standalone--nodejs) | Node.js 24 and npm | Files in the extracted application folder |

For a fresh installation, **no `servers.json` is required**. Start with your Discord token and complete configuration in Discord. Keep KOOK disabled for your initial setup.

### 1. Pterodactyl Egg

The Egg is experimental; actual Panel/Wings compatibility testing is still pending.

1. Open [Releases](https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases) and choose a release with a published container image. Download its attached `egg-pterodactyl-platform-bridge.json`.
2. Import the Egg into a nest, then create a dedicated server using the image specified by that Egg. Start with **256 MiB memory** and **50% CPU**, adjusting as needed.
3. Set the startup variable `DISCORD_TOKEN` to your bot token. Leave `KOOK_ENABLED=false` and keep the supplied startup command and deployment mode.
4. Assign an allocation if your Panel requires one. The bridge does not listen on a public port, but it needs outbound connectivity to Discord, the Panel, Wings, and game APIs.
5. Start the server. When the console shows `Bridge ready`, continue with [Set up in Discord](#set-up-in-discord).

Use a release whose image is already available; a repository Egg may reference an unpublished image. See the [Pterodactyl guide](docs/PTERODACTYL.md) for storage, networking, updates, and recovery.

### 2. Docker Compose

1. From the chosen [release](https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases), download and extract **Source code (zip)** or **Source code (tar.gz)**. Open a terminal in the extracted folder containing `docker-compose.yml`.
2. Copy `.env.example` to `.env`. Set these values, replacing the placeholders:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
BRIDGE_VERSION=published_release_version
KOOK_ENABLED=false
```

`BRIDGE_VERSION` is the container image version, for example `0.3.0-beta.1`, without the Git tag's leading `v`. Choose a release whose image has been published.

3. Start the bridge:

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml logs -f --tail=100
```

When the logs show `Bridge ready`, continue with [Set up in Discord](#set-up-in-discord). Compose keeps your settings and credentials in the `bot_data` volume. Use the explicit `-f docker-compose.yml` shown above, and retain that volume when updating or recreating the container.

### 3. Standalone / Node.js

1. Install **Node.js 24** with npm on the host that will run the bridge.
2. Download and extract **Source code (zip)** or **Source code (tar.gz)** from your chosen [release](https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/releases). Open a terminal in the folder containing `package.json`.
3. Copy `.env.example` to `.env`. Set `DISCORD_TOKEN` to your bot token and leave `KOOK_ENABLED=false`. `BRIDGE_VERSION` is only used by Docker Compose.
4. Install dependencies and start the bridge:

```bash
npm ci --omit=dev
npm start
```

When the terminal shows `Bridge ready`, continue with [Set up in Discord](#set-up-in-discord). Keep the process running; use your host's service manager if you want it to start automatically after a reboot.

The example settings save configuration, credentials, and runtime files in this application folder. Keep it private and preserve `.env` and the saved data when updating. You can change the storage paths in `.env` if you prefer a separate persistent directory.

## Set up in Discord

These steps are the same for all three installation methods.

1. **Create your administration area.** Run `/bridge setup` as the guild owner or an administrator. The bridge creates a private **Pterodactyl Bridge** category and `#bridge-admin`, or reuses its saved setup. Administration is restricted to Discord administrators, the bot, and any configured bridge administration role.
2. **Choose categories and access.** In the private administration channel, use **Categories / access role** or `/bridge categories` to select your private operations category, the destination category for published channels, and the role allowed to access those server channels. The private category must deny **View Channel** to `@everyone`. Selected categories keep their names and permissions; the server-access role is separate from the bridge administration role.
3. **Connect your panel.** Run `/bridge connect` and enter your Panel URL and Client API key in the private modal. Use the Panel URL, rather than the Wings URL.
4. **Choose a status channel.** Use the setup controls or `/bridge status-channel` to create a private status channel or select an existing one.
5. **Add your servers.** Refresh discovery, choose each server's game, and import it. For Satisfactory, supply the game API token and check its endpoint/TLS settings through **Game API credentials**.
6. **Start monitoring.** On each server card, select **Start monitoring** to create or reuse a private linked channel, or link an existing channel. Monitoring does not start the game server or publish it on the main status page.
7. **Publish when ready.** Select **Publish status & channel** and review the confirmation. Publication lists the server on the status page and moves its linked channel to your selected destination, granting the selected server-access role and denying `@everyone`. It replaces other channel-specific access grants. A status channel created by the bridge also moves to the destination and uses that category's permissions. The administration channel and unpublished server channels stay private.
8. **Enable optional features.** Use **Chat relay** and idle auto-stop settings on each server card. Standard relay commands are supplied automatically. Check player detection before enabling idle auto-stop.

Your setup and channel bindings are saved across restarts. Use **Repair published channel** to check or restore an already-published server's channel access. Archive retains channels and history; its default choice does not stop the game server. Unarchive does not start it.

## Help with setup

| Problem | What to check |
| --- | --- |
| Bot cannot connect to Discord | Check the token and enable Message Content Intent. |
| `/bridge setup` is unavailable | Check the bot invitation scopes and run it as the guild owner or an administrator. |
| Channels cannot be created or published | Check the bot's permissions, especially Manage Channels and Manage Roles, and category overrides. |
| No servers appear | Check the Panel URL and Client API key's server access. |
| Server is Unavailable or player information is Unknown | Check Panel/Wings connectivity and game console/API access. Unknown players are not treated as an empty server for idle auto-stop. |
| Container image cannot be pulled | Check that the selected release image exists and is publicly accessible. |

Run `/bridge diagnostics` in the private administration channel for more detail. For existing installations, backups, updates, or restoration, see [Operations and recovery](docs/OPERATIONS.md).

Report reproducible problems through [GitHub Issues](https://github.com/TTLouis/Pterodactyl-Discord-Bridge-Bot/issues) with your release version, game/panel versions, and steps to reproduce. Remove credentials, private addresses, and player chat from diagnostics or screenshots; never attach `.env` or a private data backup.
