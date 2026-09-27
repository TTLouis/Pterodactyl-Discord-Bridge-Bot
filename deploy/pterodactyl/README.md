# Pterodactyl Egg (preview)

This directory contains the first native Pterodactyl installation path for Pterodactyl Platform Bridge.

## Import

1. In the Pterodactyl admin panel, import `egg-pterodactyl-platform-bridge.json` into a Nest.
2. Create a server from the imported Egg.
3. Supply the Discord bot token, guild/admin/status channel IDs, Panel URL, and a Pterodactyl Client API key.
4. Leave **Game Chat Relay** set to `false`.
5. Start the server.

The Egg writes persistent state under `/home/container/data`. The initial configuration is generated automatically when it does not exist.

## Current preview boundary

The Egg bootstraps the process and separates Discord administration from logging, but the full `/bridge setup` onboarding flow is not implemented yet. The next control-plane milestone will use the admin channel to discover/import Pterodactyl servers and persist them without hand-editing `servers.json`.

## API key expectation

Use a Pterodactyl **Client API** key for the normal bridge path. The account/key needs access to the servers the bridge will manage, including the endpoints used for resource/status reads, allocations when automatic address discovery is used, power actions, and console websocket credentials. Application API access is intentionally not required for this preview.
