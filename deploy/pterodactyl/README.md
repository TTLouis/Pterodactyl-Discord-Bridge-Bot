# Pterodactyl Egg (preview)

This directory contains the first native Pterodactyl installation path for Pterodactyl Platform Bridge.

## Import

1. In the Pterodactyl admin panel, import `egg-pterodactyl-platform-bridge.json` into a Nest.
2. Create a server from the imported Egg.
3. Supply the Discord bot token, Discord guild ID, Panel URL, and a Pterodactyl Client API key.
4. Leave the admin/status channel IDs blank unless you want to bind existing channels.
5. Leave **Game Chat Relay** set to `false`.
6. Start the server and run **/bridge setup** as the guild owner or a Discord administrator.

The Egg writes persistent state under `/home/container/data`. The initial configuration is generated automatically when it does not exist.

## Discord channel layout

During onboarding, the bridge manages two server categories:

- **Game Servers** — visible active category containing the live `bridge-status` refresh channel and all active managed-server channels.
- **Archived Game Servers** — hidden from normal members. Archiving a server moves its existing channel here and stops active polling; restoring it moves the same channel back to **Game Servers**.

The bridge persists the category IDs, so future imports and archive/restore operations reuse the same categories instead of creating replacements.

## Discord application permissions

Invite the Discord application with the `bot` and `applications.commands` scopes. For the current onboarding flow, the bot needs:

- View Channels
- Send Messages
- Read Message History
- Manage Channels
- Add Reactions
- Manage Messages

`Manage Channels` is required because `/bridge setup` and `/bridge add` can create the private administration channel, global status channel, and per-server channels. Bridge administration commands are restricted to the guild owner or Discord administrators and, after setup, to the configured private admin channel.

## Current preview boundary

The Egg bootstraps the process and `/bridge setup` creates the administration/status channels, validates the Client API connection, discovers accessible servers, and imports Factorio, Minecraft, or Satisfactory servers without hand-editing `servers.json`. Satisfactory uses a private Discord modal for its game API token; the token is persisted but is not echoed into Discord or logs.

After initial setup, use:

- `/bridge servers` — list managed servers and Pterodactyl servers still available to import.
- `/bridge add` — discover and import another server.
- `/bridge connection` — verify Client API connectivity without displaying credentials.
- `/bridge configure` — change safe live settings such as display name, archive state, and inactivity auto-stop.
- `/bridge backup` — create a restricted backup under the bridge data directory; backups may contain credentials and should not be shared publicly.

Game ↔ Discord/KOOK chat relay remains experimental and disabled by default while message-loss reliability work is shelved.

## API key expectation

Use a Pterodactyl **Client API** key for the normal bridge path. The account/key needs access to the servers the bridge will manage, including the endpoints used for resource/status reads, allocations when automatic address discovery is used, power actions, and console websocket credentials. Application API access is intentionally not required for this preview.
