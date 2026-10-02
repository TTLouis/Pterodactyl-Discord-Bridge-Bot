# Administration usability review — October 1, 2026

Validation uses controller-driven simulated Discord interactions and delayed API responses, plus a read-only live Factorio-K2SE console query. This is not a completed manual first-time onboarding exercise in Discord.

| Scenario | Finding and correction |
| --- | --- |
| Import → bind → activate → publish | Tested the complete sequence with confirmations. Cards show the next action and publication prerequisites. Activation remains private until publication is confirmed. |
| Save settings while discovery is slow | Discovery previously occupied administration work. It now runs independently; saved changes refresh the affected card without waiting for the discovery batch. |
| Delayed panel/status query | Runtime reconciliation schedules polling without holding the interaction open. A regression test keeps resources pending and verifies reconciliation still completes. |
| Slow Discord channel/category lookup | Interactions acknowledge before those requests. Modal-opening interactions preserve Discord's response rules. |
| Chat relay setup | Factorio and Minecraft use game defaults. Administrators use on/off controls; custom templates are optional advanced settings. Satisfactory standard relay is unavailable. Existing overrides survive edits. |
| Unauthorized interaction | Ordinary members are rejected; owner/administrator/configured administration role checks remain covered. |
| Factorio-K2SE unknown player count | Live TLS/WebSocket authentication and `/players o` succeeded, returning one player. Startup queried before backlog readiness. Refresh now runs at console readiness and repaints status; unreliable Factorio/Minecraft queries retry on ordinary polls. Unknown counts continue to pause idle automation. |

All 355 automated tests pass on Node 24. The image smoke exercises empty storage, persisted restart, and interrupted-write recovery without a Discord login or game commands.

Remaining live acceptance: visually walk through administration cards after deployment; test supported relay and idle auto-stop on approved disposable targets for each game; complete fresh-install/upgrade/rollback release rehearsals. The live console diagnostic sent only `/players o`; it did not invoke power actions or change game settings.

Post-deployment Discord read-back confirms Factorio-K2SE shows 1/20 players and its online player name. Jev-torio is Monitoring/Private with Publish enabled. Monitoring health reports 5/5 successful servers, and the private administration category/overwrites are preserved.

## Recurring console failure follow-up

The administrator subsequently reported unknown player counts again. Startup-only validation was insufficient. [Wings emits token-expiring/expired events](https://github.com/pterodactyl/wings/blob/develop/router/websocket/listeners.go), and token rejection can produce JWT-error events; these were ignored, allowing a long-lived socket to appear ready after its credentials ceased working. The client now reconnects with freshly fetched credentials and discards retired-socket events. New regression tests exercise pending-command rejection, cache invalidation, fresh authentication, and successful subsequent queries. 358 tests pass. Live renewal-cycle validation passed: all three Factorio sockets received token-expiring at 17:20:46 UTC, fetched new credentials, and became ready again at 17:20:51–52. Successful subsequent queries repainted Discord: Factorio and Factorio-K2SE both showed 1/20 players and current names; Jev-torio had a reliable zero-player count. Monitoring reported 5/5 successful servers. This establishes one actual renewal cycle, not indefinite reliability.
