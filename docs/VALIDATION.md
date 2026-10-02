# Beta candidate verification

Recorded September 30, 2026 on the `testing` checkout. No public release has been published. The passing checks below use fixtures and isolated containers, plus the explicitly scoped Discord permission check.

## Passing checks

- Full supported Node 24 suite: **343 tests passed**, zero failures. Includes confirmed missing admin/status/server channel recreation, forced existence checks, lookup failure preservation, repeated-action duplicate prevention, and integrated entrypoint bootstrap, monitoring transition, restart, unavailable persistence, guild authorization, persistent cards, expiring power confirmations, private credential replacement, migration conflicts, transaction recovery, stale status, adapter cleanup, existing integrations and KOOK regressions.
- Production dependency audit: zero vulnerabilities after updating the compatible Undici override to 6.28.1.
- Local Docker image build: nonroot Node 24 candidate `pterodactyl-platform-bridge:beta-review`; private files and development dependencies excluded, persistence defaults and healthcheck supplied.
- Isolated Docker-volume rehearsals: token-only initialization, persisted guild/card/credential restart, schema v1 upgrade, interrupted journal recovery, and stopped full-volume backup/restore into a new volume. Test credentials only; network disabled.
- Public/legacy Compose validation, workflow YAML parsing and `git diff --check` passed.

Public CI runs the regression suite, builds the release image, and repeats isolated image initialization, restart and transaction recovery using `scripts/beta-image-smoke.js`.

## Incomplete live attempt

A limited Factorio live harness was attempted, but its process ended before the outcome could be retrieved. Its effects are unknown and the attempt is **not accepted validation**. The maintainer stopped further live testing and will supply a dedicated testing server separately. The subsequently authorized read-only Discord category/role identifier check does not validate game behavior or authorize Discord mutations. The latest authorization makes any live resumption conditional on strict administration-channel privacy verification: `@everyone` denied, only configured administration-role/bot explicit grants, administrators implicit access, and no requester grant. That strict privacy condition was subsequently applied and verified on saved administration channel `1554287862114164862` in private category `1351826213546754098`: exactly three overwrites, with only administration role `1515105756075003974` and the bot allowed; `@everyone` denied. No game or publication actions were performed during this permission check. Prior harness effects remain unconfirmed.

## Pending release gates

A dedicated Discord guild and disposable Factorio, Minecraft and Satisfactory servers are required for actual onboarding, channel publication, live status, supported relay and idle auto-stop checks. Real sanitized screenshots must replace the clearly labeled documentation mockups. GHCR public-package access and tag publication also remain pending.

Use the complete [operations release checklist](OPERATIONS.md#public-release-gate). Fixture and container checks establish implementation behavior; they do not establish live game compatibility or a published usable artifact.

## Authorized maintainer deployment

On September 30, 2026 (America/Toronto), the candidate was deployed to the maintainer’s existing live bot after a stopped-volume/configuration backup and retention of the previous image for rollback. Version `0.3.0-beta.1` on Node `v24.21.0` reached Docker healthy with zero restarts. A fresh monitoring pass succeeded for all 5 configured servers with no unavailable servers. Read-back checks verified strict administration-channel access, the configured private parent, role-accessible guild commands, and the persistent overview controls. Existing legacy server configuration and volume were retained; schema v2 and user-selected routing were persisted. This is deployment verification, not manual game power/relay/auto-stop validation or a public release.

## October 1 corrective deployment

Compact boxed administration embeds were verified through live message read-back. Regression tests cover URL normalization after reconciliation and transient panel failure retry with paused actions and automatic status repaint on recovery. The trailing-slash defect caused double-slash requests and 404s after administration changes. The corrective image is deployed. Live resource checks subsequently returned HTTP 504, so fresh successful monitoring remains unverified; no game actions were run. Discovery-only reactivation was rejected by automatic approval review, and the safer deployment retained paused managed records.

The remaining resource 504 was traced to an expired TLS certificate served by the Wings host, with the panel reporting `DaemonConnectionException` and cURL certificate-expiry verification errors. The certificate manager already has a renewed certificate; remote daemon certificate installation requires access to that host. TLS validation remains enabled and managed records are not resumed on failed resource checks.

## Action-review deployment

The explicitly approved prompt update is live. Activation reviews show before/after configuration, named busy operations, and no refresh lock on audit-only prompts. All 336 tests pass. Deployed controller hashes match the tested source. Fresh live monitoring succeeded for all 4 currently configured monitored servers, with one retained unavailable record preserved. Admin privacy and persistent controls passed read-back; container healthy with zero restarts. No game power actions or paused-record reactivation were performed.

Automatic game relay defaults, separate on/off controls, preservation of custom commands, unsupported standard relay handling, and immediate affected-card publication readiness have regression coverage. These follow-up UI changes await deployment. Live read-back after administrator activation confirmed Jev-torio monitoring and Publish enabled; all 5 servers monitored successfully.

## October 1 usability and console recovery

355 tests pass on Node 24 with installed dependencies. Controller-driven interaction tests cover import/bind/activation/publication/relay/archive, unauthorized controls, early acknowledgements, card updates during blocked discovery, and nonblocking runtime reconciliation. Console tests cover refresh at readiness, immediate status repaint, and unreliable-query retry. The rebuilt production image passes isolated fresh/restart/interrupted-write recovery smoke. A read-only live Factorio-K2SE `/players o` query succeeded over verified TLS and returned one player. See [the usability review](USABILITY_REVIEW.md) for limits; the manual game acceptance release gates remain pending.

The corrective image was deployed with a stopped private-volume/configuration backup and rollback image. Live read-back confirms 5/5 monitored servers successful, zero unavailable servers, a healthy container with no restarts, Factorio-K2SE showing 1/20 players, and Jev-torio’s Publish button enabled. The administration channel remains in the configured private category with only the required role/bot allow overwrites and @everyone denied. These checks do not replace fresh-install/manual-game release acceptance.

## Console token lifetime regression

The later recurring Unknown report exposed unhandled Wings token-expiry/JWT-error events. 358 Node 24 tests pass with credential invalidation/reconnect and retired-socket regressions. After corrective deployment, the live bot was observed through its actual ten-minute credential lifetime: all three Factorio sockets renewed at 17:20:46–52 UTC, and subsequent player queries/status repaint succeeded. Factorio and Factorio-K2SE showed 1/20 players; monitoring remained 5/5 successful. This is evidence for one real renewal cycle and supersedes startup-only console validation.

## Pterodactyl Egg candidate

The first-beta candidate now includes an importable Pterodactyl Egg and shared version-pinned image. Actual Panel/Wings import and live acceptance are pending for a later separate test server; the existing live Docker deployment is retained. Isolated automated image rehearsals use mocked external services and no network. They cannot replace Panel/Wings or two-release upgrade/rollback acceptance.

On October 1, 2026, all **360 tests passed** under Node `v24.21.0`. The separate `pterodactyl-platform-bridge:egg-review` image built successfully. Network-disabled rehearsals passed setup and monitoring bootstrap with mocked Discord, numeric UID/GID 12345 on a read-only root filesystem, private configuration restart/journal recovery, preserved data after no-op reinstall, entrypoint-aware heartbeat checking, graceful SIGINT with a queued state write flushed to disk, and stopped-data backup/restore into a distinct volume. Compose fresh/restart/recovery checks passed, public Compose configuration validated, and both CI/release workflow YAML files parsed successfully. No live deployment or public publication was performed. Older-release/schema rollback and actual Panel/Wings acceptance remain pending.


## October 1 relay reliability candidate

The separately tagged `pterodactyl-platform-bridge:relay-review-20261001` candidate implements independent persistent relay workers, stable source IDs, protected in-flight queue updates, typed dispatch outcomes, safe template rendering, shared console pacing, and live-only game chat. Reconnect history recovery is deferred by maintainer choice. All 396 Node 24.21.0 tests pass, including the candidate's installed dependencies. Network-disabled image startup/restart/storage-recovery/shutdown/healthcheck/restore rehearsals pass, and nine relay source hashes match the candidate image. `git diff --check` passes. The current live bot was not restarted or replaced; dedicated live relay acceptance and deployment remain pending. See [relay validation](RELAY_VALIDATION.md) for cases, behavior, and acceptance gates.


## Authorized one-time live relay deployment

On October 1, 2026 (America/Toronto), the maintainer explicitly authorized deployment of the tested relay candidate. The candidate is now running in the existing live Compose project and original private data volume. A consistent stopped-volume backup and matching deployment files were retained at `backups/relay-live-20261001-160638`; the previous image is retained as `pterodactyl-platform-bridge:rollback-relay-20261001-160638`. An initial backup ownership failure occurred before image replacement and automatically restarted the previous bot; the corrected stopped-data backup was verified before the successful deployment.

Post-deployment checks verified the exact candidate image, Docker healthy, zero restarts, a fresh successful monitoring pass for all 5 configured servers, reliable player snapshots after console startup, and empty relay queues. Read-only Discord checks verified the administration channel remains in its configured private category with exactly the expected administration-role/bot grants and @everyone denied. The three cold-start console-not-ready warnings resolved after authentication. No manual game commands, power actions, or test chat messages were sent. This verifies deployment and monitoring; manual end-to-end relay acceptance remains pending. Game chat remains live-only, with history recovery deferred.

## Publication and migration routing fix — October 1, 2026

The Node 24 suite passed **402 tests**, zero failures. Regression coverage verifies saved Discord routing/status/admin choices survive legacy migration, a bound linked channel in the selected private category moves on confirmed publication, missing selections produce an actionable response, destination bot permissions are checked, and a mismatched parent or overwrite read-back prevents publication and restores prior channel settings. Existing channels outside the selected private category retain their permissions.

Read-only live inspection found missing routing selections after migration. The earlier private backup identifies private category `维护`, destination category `服务器`, linked role `服务器情报`, and administration role `游戏服管理`; all still exist. The private category explicitly denies everyone View Channel. Live inspection made no channel or configuration changes. These fixes have not been deployed and actual publication verification remains pending.

## Administration workflow and archive lifecycle — October 1, 2026

The full current Node 24 suite passed **428 tests**, zero failures; focused administration/platform tests passed **97 tests**. Controls and review text distinguish monitoring, linked channels and the main status page. Archive requires an expiring administrator-specific confirmation with **Archive — do not stop** as its primary/default choice and a separate **Archive & stop server** option. Regressions cover no power request on the default path, exactly one optional stop after monitoring reconciliation, stale/expired/wrong-administrator/access-lost confirmations, unconfirmed stop reporting, persisted pre-archive state restoration across restart, and Discord/KOOK announcements without mentions. Unarchive restores previous monitoring/publication settings and never sends a game-server start command. Whitespace checks passed. These workflow changes remain local; no live messages or game power commands were sent during validation.

## Publication repairs and semi-public role verification — October 1, 2026

All **431 Node 24 tests** passed. Publication now applies the selected category and role policy to every linked channel, including migrated and manually bound channels. Already-published monitored servers expose Repair published channel. Read-back verifies both the exact category/overwrites and the linked role’s effective View Channel, Send Messages and Read Message History access. Already-correct channels are verified without rewriting their settings and reported as already configured correctly.

The first correction was deployed, and Factorio-AI’s linked channel was repaired in the selected semi-public category with its original overwrites retained in a private backup. Read-back confirmed role `1372558467927248896` could view/send/read history, everyone was denied View Channel, and the exact three-overwrite policy was applied. No game power commands or test chat messages were sent.
