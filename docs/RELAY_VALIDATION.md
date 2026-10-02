# Relay reliability changes — October 1, 2026

This change implements live text relay across Discord, KOOK, Factorio and Minecraft. Console-history recovery is deliberately deferred. The existing live bot has not been changed by these checks.

## Regression coverage

The Node 24 suite covers the following relay failure cases with isolated fixtures and real temporary state files:

- Enqueue during a network send and during an empty worker's completion; completion removes only the dispatched ID.
- Overflow and expiry during a blocked send; in-flight entries remain protected and expired work cannot be resurrected.
- Independent platform and game destinations, FIFO platform order, and slow or failed destinations.
- Duplicate gateway message IDs versus separate messages containing identical text.
- Repeated live game chat, server-origin echoes, player quotations of platform text, ANSI and supported egg wrappers.
- Initial connection, reconnect, and token renewal without relay history requests; live player events have no warmup suppression.
- Unsent, dispatched, rejected and uncertain outcomes; no automatic network retry after an uncertain Discord send.
- Running-state checks, runtime guards after command/SDK queue waits, shared command pacing, explicit Wings throttling and daemon rejection.
- Stable Discord nonce and mention suppression at the actual network boundary.
- Literal replacement characters, placeholder-like user text, author bounds, Unicode truncation, safe platform splitting and complete command/frame limits.
- Legacy pending-queue migration, persisted platform jobs/source receipts, unfinished dispatch checkpoints, malformed restored records and storage failure.
- Temporary access pauses, explicit disable, channel rebind cancellation, unsupported game transport and subscription cleanup across service restarts.
- Shared single-line/content-placeholder validation through configuration and administration controls.

The relay source files inspected before implementation matched the deployed image. Three defects were independently reproduced in memory: stale queue overwrite lost a second message, sequential fan-out skipped a second destination after failure, and string replacement corrupted literal dollar syntax.

## Operational behavior

Pending entries expire after 24 hours and each destination queue is capped at 100 entries. Runtime state now includes optional `relayOutbox` and `relayReceipts` maps in addition to the existing `relayQueue`. Older queue entries receive IDs during startup. Source receipts are retained for up to 24 hours, capped at 10,000.

Acceptance and dispatch checkpoints are saved before side effects. A process restart with an unfinished dispatch withholds that entry as uncertain. This prefers avoiding duplicates and may withhold a message whose dispatch had not actually reached the destination. The console protocol does not supply end-to-end message acknowledgements.

Operator notices use configured Discord/KOOK log channels. Queue ages, IDs, destinations, retries and transport outcomes appear in diagnostics without chat content or credentials. A storage-failure notice is emitted once per failure episode. Missing operator log channels leave diagnostics in process logs.

Temporary access uncertainty preserves already queued work but rejects new relay intake while actions are paused. Explicit relay disable, archive/delete, removal or route/template/game changes cancel affected pending jobs. Native console commands are paced at one per second; player queries retain their output-capture behavior.

## Recorded validation

- **396 tests passed, zero failures**, on Node 24.21.0, including a run against the review image's actual source and installed production dependencies.
- Review image built: `pterodactyl-platform-bridge:relay-review-20261001`.
- Nine relay source hashes matched the candidate image.
- Network-disabled image rehearsals passed: fresh setup, persistence/restart, interrupted-write recovery, reinstall, monitoring bootstrap, SIGINT/shutdown flush, healthcheck, and stopped disposable-volume backup/restore.
- `git diff --check` passed. The existing live container remains on its previous image and was not restarted. Dedicated live relay acceptance and deployment remain pending.

## Candidate and live acceptance

Run `npm test` on Node 24, build a separately tagged image, and run the repository's network-disabled image storage/runtime rehearsals. Use unique test volumes and mock credentials; never mount live data into a rehearsal.

Before deployment, retain the current image and make a consistent stopped-data backup of the existing private configuration/runtime volume. Validate the candidate on dedicated Discord/KOOK channels and disposable Factorio/Minecraft servers: all directions, repeated identical messages, a burst, offline queue/drain, reconnect, explicit disable/rebind and one actual token-renewal cycle. Check terminal notices and route isolation. Deployment and live acceptance are separate from fixture validation.

History recovery requires a later design with persisted event identity/cursors and bounded retention; this change does not create a rolling database or attempt console replay.


## Authorized one-time live relay deployment

On October 1, 2026 (America/Toronto), the maintainer explicitly authorized deployment of the tested relay candidate. The candidate is now running in the existing live Compose project and original private data volume. A consistent stopped-volume backup and matching deployment files were retained at `backups/relay-live-20261001-160638`; the previous image is retained as `pterodactyl-platform-bridge:rollback-relay-20261001-160638`. An initial backup ownership failure occurred before image replacement and automatically restarted the previous bot; the corrected stopped-data backup was verified before the successful deployment.

Post-deployment checks verified the exact candidate image, Docker healthy, zero restarts, a fresh successful monitoring pass for all 5 configured servers, reliable player snapshots after console startup, and empty relay queues. Read-only Discord checks verified the administration channel remains in its configured private category with exactly the expected administration-role/bot grants and @everyone denied. The three cold-start console-not-ready warnings resolved after authentication. No manual game commands, power actions, or test chat messages were sent. This verifies deployment and monitoring; manual end-to-end relay acceptance remains pending. Game chat remains live-only, with history recovery deferred.
