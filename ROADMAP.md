# Product roadmap

## Public beta target

Self-hosting Discord community administrators use Docker or a Pterodactyl Egg, one guild and one Pterodactyl panel per installation. Implemented adapters cover Factorio, Minecraft, Satisfactory and Source 1 console bridges (live Source acceptance pending); KOOK remains optional. MIT licensing and free features continue. Donations remain optional; a destination has not been supplied.

## Foundations implemented

- Private administration setup, Client API validation/discovery, persistent imports and live activation.
- Token-only bootstrap and guild claim; a persisted private category precedes every new channel, configurable existing private/public categories and a linked access role guide publication, and bound existing-channel parents/permissions are preserved. Administration-channel privacy denies @everyone, allows the configured administration role/bot explicitly, and grants no requester override; that role can use controls. Guided cards and persistent bindings replace the required command sequence while retaining shortcuts.
- Persistent control-plane configuration and separate credentials, explicit legacy migration, runtime reconciliation and retained lifecycle records.
- Direct per-server card updates independent of discovery and status polling; separated core administration policy and Discord interaction/rendering modules. Console-ready player refresh and recovery retries protect reliable idle automation.
- Diagnostics, redacted export, audit events and marked/hidden public archive/deleted presentation.
- Importable Pterodactyl Egg for the first beta using the canonical image and persistent server-directory storage; automated checks accompany it. Actual Panel/Wings testing is deferred to a separate test server; the live bot remains on Docker.
- Versioned release workflow and GHCR packaging, supported Node 24 runtime, image-based Compose, and preserved source-build legacy Compose.

These implementation foundations are **not evidence that the public release gate has passed**.

## Required before publication

Automated verification is recorded in [docs/VALIDATION.md](docs/VALIDATION.md). Complete the remaining live checks and record the [release checklist](docs/OPERATIONS.md#public-release-gate): fresh Docker onboarding/restart, migration and failure recovery, upgrade/rollback, unavailable/restored access, permissions and secret handling, and live game integrations. Configure GHCR public access. Replace labeled mockups with sanitized actual screenshots. Only then publish a tagged beta artifact and release notes with compatibility information.

## After beta feedback

Prioritize reliability and usability fixes from real administrator installs. Deferred work: granular delegated administration roles, bulk import, generic/automatic game detection, multiple panels, broader Application API support, Pelican Eggs and cloud templates. Future installers must consume the same canonical artifact and preserve private data; remote hosts need network access to Panel/Wings/game endpoints.
