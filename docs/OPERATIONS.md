# Operations and recovery

## Private channel provisioning

Setup persists a private category before creating any administration, server or status channel. A fresh bootstrap may create a private **Pterodactyl Bridge** category. Use `/bridge categories private:<category> public:<category> linked-role:<role>` or the guided menus to select pre-existing operations/community categories and a server-access role. Selected categories keep their names and permissions. New bot-created channels start under the private category.

Explicit publication moves every selected linked server channel, including migrated and manually bound channels, under the selected public or semi-public category. It grants the linked role access and denies `@everyone`, replacing other channel-specific grants as described in the confirmation. Already-published servers can repair their linked channel through the same confirmation. The bot-created status channel moves under the destination category and copies its permissions with explicit bot access. The administration channel and other unpublished server channels remain private. Publication checks the bot's access and reads back each moved channel's parent and permission overwrites before saving publication; failures restore the previous channel settings. The bot needs both **Manage Channels** and **Manage Roles**; [Discord requires Manage Roles for channel permission overwrites](https://docs.discord.com/developers/resources/channel#edit-channel-permissions). Verify these boundaries on a separately authorized test environment before public release.

The administration channel denies `@everyone`, explicitly allows only the configured bridge administration role and the bot, and relies on Discord’s implicit Administrator access for administrators. It must not include an individual requester grant. Members of that configured role are authorized to use bridge administration controls. This role is separate from the linked server-access role used for published server channels.

Before resuming any authorized live testing, verify the strict administration-channel privacy policy. The present record does not claim that this live verification has passed.

## Pterodactyl deployment

The first-beta candidate includes a version-matched Egg release attachment. [Pterodactyl installation and recovery](PTERODACTYL.md) covers its persistent server directory, token settings and explicit image selection. Actual Panel/Wings acceptance is pending for a later separate test server. The existing live bot stays on Docker Compose.

## Monitoring, publication and archive controls

**Start monitoring** enables status polling, configured relay and idle automation, and creates or reuses a linked channel. It does not list the server on the main status page or start the game server. **Link existing channel** selects the channel used by this server; its access is reviewed before confirmation. **Publish status & channel** lists the server on the main status page and publishes its private linked channel using the selected destination/access role. Its confirmation names both destinations. **Pause monitoring** retains settings and channels.

**Archive server** presents two choices: **Archive — do not stop** (the primary/default choice) and **Archive & stop server** (an explicit power request). Opening the review changes nothing. Confirmation is restricted to the requesting administrator, expires after five minutes, and is invalidated by changes to the server's lifecycle or linked channel. The optional stop is sent only after archive settings are saved and monitoring is paused. An accepted request means shutdown was requested, not that shutdown has already completed; an unconfirmed stop leaves the record archived and directs the administrator to check Pterodactyl.

Archive and unarchive post lifecycle announcements to linked Discord/KOOK channels. Channels and message history are retained. Unarchive restores the monitoring and publication state captured at archive time, including across bot restarts, while keeping configured relay/autostop settings. It sends no game-server start command. Restoring monitoring requires panel access and does not bypass unavailable/deleted records. Archives created by older versions have no captured monitoring state: unarchive resumes monitoring by default and keeps their publication setting. Archive listing visibility still follows the configured marked/hidden display setting.

## Status and category ordering

Select **Arrange status & channels** to enable category layout. The main status channel moves into the selected public/semi-public category while retaining its permissions. Published monitored game channels follow the status-message order. The read-only text divider `====archieve====` comes next, followed by archived/deleted linked channels already in that category, then remaining channels in their previous relative order. The linked role may view/read the divider; posting, reactions, threads, app commands and other interactions are denied. Discord administrators retain their inherent access.

Use **Move up in status & channels** and **Move down in status & channels** on server cards to save a shared order. New servers append to unspecified records. The order survives restart and also applies to unavailable status entries. Private/unpublished game channels are not pulled into the public category by ordering. The layout is checked after administration changes and discovery refresh, and only changed positions/permissions are written. Divider bindings persist and deleted dividers are recreated without deleting channel history.

## Storage and migration

The Docker volume contains configuration, separate credentials, runtime state, health files, administration-message bindings and audit data. Persistent configuration is schema-versioned. Treat the entire volume as private: a redacted `/bridge export` is useful for troubleshooting but **cannot restore credentials**.

Legacy installations remain supported through `docker-compose.legacy.yml`. Before changing deployment files, stop the bridge and back up `.env`, `servers.json`, any local Compose override, and the entire named data volume. Preserve the same Compose project name (`-p`) so the volume does not change. Supply overrides explicitly, for example `docker compose -f docker-compose.legacy.yml -f docker-compose.override.yml ...` when that file exists.

Run `/bridge migrate confirm:true` from the private administration channel. Resolve any reported conflicts rather than overwriting definitions by hand. The migration retains a legacy backup and changes persistent configuration authority. Verify server identifiers, game settings, channel bindings and credentials, then restart and confirm the same records load. Keep the original private files and pre-migration volume backup for rollback.

Migration preserves saved Discord administration choices, including private/public category routing, linked access role, administration role and status-channel binding. If an earlier migration lost those selections, use **Categories / access role** to select them again before publishing; updating the bot does not reconstruct missing choices. A public destination may be a category restricted to selected roles. Publication never changes the selected category's own permissions.

Never repair credentials by posting them in channel history. Use the private connection/token modal. On a schema error, damaged storage or interrupted transaction, preserve the volume, inspect diagnostics/logs, and restore a known-good **complete** backup if automatic recovery cannot complete. Do not independently mix configuration and credential files from different backup times.

## Private full-volume backup

These commands use the public Compose file. For legacy deployments substitute the correct Compose files and project name. Identify the actual volume rather than assuming a name:

```bash
docker compose -f docker-compose.yml ps -q discord-bot
docker inspect YOUR_CONTAINER_ID --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}'
```

Use the volume mounted at `/data` in the commands below. Stop writes before archiving. The backup contains API keys and must remain private.

```bash
umask 077
mkdir -p backups
docker compose -f docker-compose.yml stop discord-bot
docker run --rm --user 0 -v YOUR_DATA_VOLUME:/data:ro \
  -v "$PWD/backups:/backup" node:24-bookworm-slim \
  tar -czf /backup/bridge-data.tar.gz -C /data .
cp .env backups/bootstrap.env
docker compose -f docker-compose.yml start discord-bot
```

Store a dated copy outside the host with access restricted to trusted administrators. Record the bridge image tag/digest with each backup. Do not use `docker compose down -v`: that destroys the volume.

## Restore and compatible rollback

Stop the bridge and retain the failed volume as evidence. Restore into a **new empty volume**, retaining the archive's file permissions and ownership:

```bash
docker volume create bridge_restore
docker run --rm --user 0 -v bridge_restore:/data \
  -v "$PWD/backups:/backup:ro" node:24-bookworm-slim \
  tar -xzf /backup/bridge-data.tar.gz -C /data
```

Point the deployment's `bot_data` volume at `bridge_restore` using a private Compose override with `external: true` and `name: bridge_restore`. Restore the matching `.env` privately, select the image version that produced the backup, start, and verify administration controls, server identifiers, status, relay and idle automation. Preserve the failed volume until recovery is confirmed.

Rollback requires the previous image **and its matching pre-upgrade backup** when schemas changed. A previous image must not read an unsupported newer schema. Consult release notes before attempting in-place downgrade. Keep server channels and records intact during recovery; channel deletion is not a restoration step.

## Updating

1. Read release notes and compatibility instructions. Record the old image tag/digest; take a stopped full-volume backup and save `.env`.
2. Set `BRIDGE_VERSION` to the chosen published version. Run `docker compose -f docker-compose.yml pull`, then `docker compose -f docker-compose.yml up -d`.
3. Check container health, `/bridge diagnostics`, card controls and server status. Verify a restart preserves configuration.
4. If verification fails, stop the new bridge and restore the previous image and matching backup as above. Keep the failed volume/logs for diagnosis.

## Diagnostics

| Symptom | Check and recovery |
| --- | --- |
| Healthy setup mode, no monitoring | Complete guild claim, connection and status-channel setup; activate a server. |
| Unavailable server or stale data | Check panel connectivity, key permissions and server existence in the panel. Refresh discovery; explicitly reactivate once access returns. |
| No channel/card update | Check bot guild membership, channel/category overrides, Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links and history permissions. |
| Relay missing | Enable Message Content Intent; check game console/API access and relay setting. |
| Persistence error | Check volume mount, free space and bot-user ownership; preserve and restore the complete private backup. |
| Auto-stop paused | Resolve uncertain access and validate player detection before re-enabling automation. |

Configuration and power-action audit events omit secret values. Logs and redacted exports still need review before public sharing. Console diagnostics can be enabled temporarily with `PTERODACTYL_CONSOLE_DIAGNOSTICS=true`.

## Public release gate

`Public CI` runs tests and builds the Docker image on hosted runners. `Maintainer Deployment` remains a separate testing-branch workflow for the maintainer's host. `Release` accepts `v<package version>` tags, reruns tests, builds AMD64/ARM64 GHCR images and creates a GitHub Release. Prerelease versions are marked prerelease; no floating latest tag is published.

Before pushing a public tag, make the GHCR package publicly readable and ensure the supported Node 24 suite passes and complete this checklist:

- Fresh token-only Docker install through guild claim, category-first private administration/status/server channels, panel connection, import/activation/publication. Verify administration-channel @everyone denial, only configured-role/bot explicit access, administrator implicit access and no requester grant; verify the role can use controls. Verify repeat setup reuses categories, selected category names/permissions are preserved, published server access is role-gated, status inherits the public category, and administration/other servers remain private; existing bound channels retain parents and permissions.
- Unauthorized setup/actions and repeated setup; restart restores card controls without duplicates.
- Legacy migration conflicts, interrupted storage writes, damaged storage, full-volume restore, failed upgrade and rollback rehearsal.
- Panel outage/lost access/missing server/restored access, archive/deleted display and runtime cleanup.
- Live Factorio, Minecraft and Satisfactory status, supported relays and idle auto-stop. Use test servers for power actions.
- Record actual Pterodactyl Egg import/start/stop/restart/reinstall, onboarding, networking, private storage and two-version upgrade/rollback acceptance on the later separate test server. Until then, label Egg live validation pending in release notes.
- Capture actual setup/status screenshots with secrets and private identifiers removed; replace clearly labeled documentation mockups.

Do not claim this gate passed without recorded evidence. No public tag, image or release is published by preparing these files.

### Deleted Discord channel recovery

Run `/bridge setup` to repair a deleted administration channel, use Create status channel (or `/bridge status-channel` without a channel) for a deleted status channel, and Activate / repair channel (or `/bridge activate`) for a deleted server channel. Creation actions force-check the saved binding with Discord, reuse existing channels, and persist replacements only after successful creation. Null results or Discord Unknown Channel permit recreation; access and network failures retain the binding and require fixing permissions or connectivity. Replacements are created in the configured private category. Server replacements require confirmed publication again. A missing private category must be restored or explicitly selected before creation; channels are never created at the guild root.

If a game is Online but players are Unknown, resource access succeeded while a game query was not authoritative. Idle auto-stop stays paused. Check console authentication/renewal logs and the game adapter; do not interpret Unknown as zero. Wings console credentials expire and are renewed automatically by reconnecting with a fresh panel token. Verification should span a renewal cycle, not only startup.
