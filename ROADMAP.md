# Product Roadmap

This roadmap is the repository source of truth for planned product, architecture, onboarding, release, and deployment work.

It intentionally does **not** cover donation strategy or maintainer funding decisions.

## Guiding principles

- **Deployment files bootstrap the bot; Discord administers the product.**
- Keep bootstrap secrets outside normal Discord message history and never echo credentials.
- Prefer the Pterodactyl Client API for normal onboarding; make broader Application API access optional and explicit.
- Treat server topology changes as runtime events instead of requiring process restarts.
- Build and publish one canonical versioned artifact, then reuse it across supported deployment platforms.
- Preserve a useful generic Pterodactyl experience for unsupported games rather than failing completely.
- Keep existing `servers.json` installs migratable while moving day-to-day administration away from hand-edited files.

## Phase 1 — Discord-native provisioning

**Goal:** a new operator can start with only the Discord bootstrap token and complete Pterodactyl setup from Discord.

Initial vertical slice:

1. Start the bot with the Discord token as the only required bootstrap secret.
2. Add `/bridge setup`, restricted to the guild owner or Discord administrators.
3. Create or claim a private bridge administration channel.
4. Collect the Pterodactyl panel URL and Client API key through a secure Discord interaction/modal.
5. Validate the connection without echoing the credential.
6. Discover servers accessible to the Client API account.
7. Let the administrator select one discovered server to import.
8. Persist the resulting configuration.
9. Instantiate the server runtime dynamically without restarting the bot.
10. Create/bind its Discord surface and publish its status.
11. Prove the configuration survives a process restart.

**Exit criteria:** a fresh install can go from bot invite to one managed Pterodactyl server without editing `servers.json`.

## Phase 2 — Authoritative configuration and runtime reconciliation

**Goal:** replace file-oriented topology management with an authoritative persistent control plane.

Planned work:

- Introduce a persistent configuration store for connections, guild settings, managed servers, Discord bindings, permissions, and non-secret operator settings.
- Introduce a server/runtime registry that owns the active runtime for each managed server.
- Introduce a reconciler that applies desired configuration changes to the live runtime.
- Support live server add/remove/disable operations without restarting the process.
- Support live Discord channel binding changes.
- Make Pterodactyl connection replacement a controlled lifecycle operation.
- Separate secrets from ordinary configuration and audit output.
- Keep legacy `servers.json` import/migration available during transition.
- Retire `ConfigReloadService` as the long-term configuration authority once equivalent behavior is covered by the control plane.

**Exit criteria:** topology and connection changes can be applied from the control plane safely and deterministically.

## Phase 3 — Full Discord administration

**Goal:** normal operation no longer requires editing deployment files.

Planned administration surfaces:

- Server discovery and bulk import.
- Automatic game detection where reliable.
- Generic monitoring/control mode for unsupported games.
- Per-server configuration for status, relay, automation, archive state, and display metadata.
- Automatic Discord category/channel provisioning with an option to bind existing channels.
- Role-based authorization, with at least:
  - Bridge Administrator
  - Server Operator
  - Normal Member
- Mutation audit trail that never records secret values.
- Connection health and diagnostics.
- Configuration backup/export and recovery.
- Re-discovery when Pterodactyl servers change.

**Exit criteria:** an administrator can perform the supported day-to-day configuration lifecycle from Discord.

## Phase 4 — Release and upgrade foundation

**Goal:** make releases reproducible and safe before broad distribution.

Planned work:

- Publish versioned GitHub Releases.
- Publish a canonical GHCR container image.
- Define configuration/schema migration behavior between releases.
- Define upgrade and rollback procedures.
- Keep public CI separate from maintainer-specific production deployment.
- Add release notes and compatibility information.
- Validate clean first-install and upgrade paths in CI where practical.

**Exit criteria:** each supported version has a reproducible artifact and documented upgrade path.

## Phase 5 — Deployment ecosystem

**Goal:** let users deploy the same product through the environments they already use.

Priority order:

1. **Pterodactyl Egg** — primary deployment path for existing Pterodactyl operators.
2. **Pelican-compatible Egg** — reuse the same application and configuration model.
3. **Railway template** — one-click hosted deployment where the Panel/Wings endpoints are reachable.
4. **Zeabur template** — hosted template using the canonical release artifact.
5. **Render blueprint/guide** — supported hosted deployment where persistence/networking requirements are satisfied.
6. **Square Cloud guide/config** — bot-focused hosting support.
7. Additional hosts only when they can reuse the same release artifact without creating a divergent product.

All supported installers should consume the same versioned application/container whenever the platform permits it.

### Network constraint

Hosted deployments cannot reach private-only Pterodactyl/Wings endpoints unless the operator provides suitable networking. The Pterodactyl/Pelican Egg path therefore remains important even when cloud templates exist.

**Exit criteria:** the project has at least one Pterodactyl-native install path and one public cloud one-click path backed by the canonical release artifact.

## Phase 6 — Adapter and ecosystem expansion

**Goal:** expand capabilities after onboarding, configuration, and releases are stable.

Candidates:

- More game-specific adapters.
- Better generic Pterodactyl monitoring for unknown games.
- Multiple Pterodactyl connections in one bridge instance.
- Optional Pterodactyl Application API support for node-aware or broader administrative discovery.
- Multi-panel operation.
- Additional chat/community platforms when there is demonstrated demand.
- More granular automation policies.

These features should build on the control-plane/reconciler architecture rather than adding new file-based configuration paths.

## Near-term implementation order

The next implementation work should remain deliberately narrow:

1. Persistent configuration model.
2. Secure Discord setup claim and administration channel.
3. Pterodactyl connection validation and server discovery.
4. Import one server.
5. Dynamic runtime creation for that server.
6. Restart persistence.
7. Regression coverage for authorization, secret handling, duplicate setup, failed validation, and recovery.

Do not start broad marketplace/deployment publication until this first Discord-native onboarding slice is reliable enough that hosted users are not forced back into manual `servers.json` maintenance.
