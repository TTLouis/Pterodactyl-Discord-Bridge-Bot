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

## Current preview boundary

The Egg bootstraps the process and `/bridge setup` creates or claims the administration/status channels, validates the Client API connection, discovers accessible servers, and can import Factorio or Minecraft servers without hand-editing `servers.json`. Satisfactory onboarding is still pending because it also requires a game API token.

## API key expectation

Use a Pterodactyl **Client API** key for the normal bridge path. The account/key needs access to the servers the bridge will manage, including the endpoints used for resource/status reads, allocations when automatic address discovery is used, power actions, and console websocket credentials. Application API access is intentionally not required for this preview.
