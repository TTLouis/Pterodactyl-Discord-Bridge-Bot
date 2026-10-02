# Pterodactyl Egg deployment

The first-beta package includes an importable Egg using the same pinned Node 24 GHCR image as Docker Compose. **Actual Panel/Wings import and live acceptance are pending** and will be tested later on a separate server. The maintainer’s live bot stays on its existing Docker deployment. Pelican compatibility is deferred.

## Install

1. Obtain `egg-pterodactyl-platform-bridge.json` from the chosen GitHub Release. Before publication, the repository copy is a candidate; its image tag may not yet exist publicly.
2. As a Panel administrator, import it into a nest and create a dedicated bridge server using its pinned image. Start with 256 MiB memory, 50% CPU and sufficient disk for private state/backups. These limits match the Compose defaults; adjust from observed usage.
3. Assign an allocation if required by the Panel. The bridge listens on no public port; it needs outbound DNS/HTTPS to Discord and the Panel, websocket access to Wings, and applicable game API endpoints. `localhost` inside this container is the bridge itself. Check routing, certificates and firewalls for endpoints on the same host.
4. Supply `DISCORD_TOKEN`; leave KOOK disabled unless needed. These startup variables are private credentials but Panel startup fields are not a secret vault. Restrict access to trusted users and administrators, and avoid screenshots containing tokens. Panel administrators must retain deployment mode `pterodactyl` and startup command `node /app/src/index.js`. Wings overrides are optional.
5. Start the server. `Bridge ready` indicates completed Discord bootstrap in setup or monitoring mode; it does not certify game integrations or Panel availability. Follow the README’s Discord application intents, invitation permissions and `/bridge setup` instructions. Panel URL and Client API key are entered through the existing private Discord modal.

Application code and dependencies stay packaged in `/app`. All mutable state, health files, credentials, audit data and message bindings live in `/home/container/data`, inside the persistent Panel server directory. An optional legacy `servers.json` belongs in `/home/container`. Egg installation/reinstallation is a no-op and preserves existing files; it does not fetch source, run npm, or update the image automatically. The image works with Wings’ numeric user and read-only root filesystem when the server directory is writable by that user.

The Egg denies ordinary file-manager access to `data/*` to discourage accidental edits. This is not a security boundary: authorized Panel operators, backups and privileged filesystem access can expose credentials. Treat the entire server directory as private.

## Stop, health and recovery

The Panel Stop action uses `^C`/SIGINT; Node flushes state during shutdown. Give it up to 30 seconds before forcing termination. Wings crash detection and restart policies are controlled by your Panel/node configuration, rather than Compose’s restart policy. Docker health does not automatically restart a stalled application.

A privileged operator can run `/bin/bash /entrypoint.sh node /app/src/healthcheck.js` inside the container to inspect heartbeat freshness, or `node /app/src/health-status.js` with `SYNC_HEALTH_PATH=/home/container/data/sync-health.json` for monitoring detail. Healthy setup mode waits for configuration.

Before upgrading, stop the server and take a complete private backup of the server directory. Record the image tag/digest and securely retain startup token settings separately; filesystem backups do not necessarily include Panel startup variables. Keep original ownership and file modes, including credential files’ mode 0600.

Import the chosen release’s Egg and explicitly select its matching pinned image for the existing server; do not assume editing a nest Egg updates existing servers. Preserve the same server directory. Start, verify `/bridge diagnostics`, controls and status, and restart once to check persisted bindings. Reinstall is not required for an image upgrade.

For rollback, stop the bridge and preserve the failed directory. Select the previous image and restore its matching complete pre-upgrade backup, along with matching private startup settings. Restore ownership to the Wings server user. Do not mix credentials/configuration from different backups or run an older image against an unsupported newer schema. Never run two bridge instances using the same bot identity concurrently.

## Validation status

Automated checks cover Egg image-version consistency and mock-service bootstrap, nonroot/read-only execution, storage restart and journal recovery, no-op reinstall, readiness, SIGINT shutdown, heartbeat health and complete stopped-directory restoration. External services are mocked and containers have no network access. These checks do not establish compatibility with an actual Panel/Wings installation or an older release/schema.

Later acceptance must record actual Panel/Wings versions and verify Egg import, startup detection, stop/restart/reinstall, networking, Discord onboarding, private permissions, persistent bindings, and upgrade/rollback across two release images. Use a separate bot identity, guild and disposable game targets. Record results in `docs/VALIDATION.md` before describing Egg deployment as live-validated.
