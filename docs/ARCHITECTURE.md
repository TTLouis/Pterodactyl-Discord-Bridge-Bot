# Project responsibilities

Keep platform presentation, shared decisions, storage, and runtime work distinct.

| Section | Responsibility | Main files |
| --- | --- | --- |
| Core administration | Server state/publication policy, selected-server access checks, relay configuration, saved-change notifications | `src/core/administration/` |
| Discord administration | Interaction acknowledgements, confirmations, embeds/buttons/modals, authorization and channel/category permissions | `src/platforms/discord/` |
| Runtime services | Monitoring, reconciliation, console subscriptions, relay delivery and idle automation | `src/services/status-sync-service.js`, `src/services/auto-stop-service.js` |
| Game adapters | Game-specific console parsing and player queries | `src/adapters/` |
| Storage/configuration | Durable configuration/secrets, migrations, normalization and runtime state | `src/lib/persistent-config-store.js`, `src/lib/config.js` |
| Startup | Compose these components and wire runtime configuration changes | `src/index.js` |

A Discord action saves configuration, asks the core configuration coordinator to apply runtime wiring, and emits a configuration-changed event. The Discord controller refreshes the affected persistent card immediately. Panel polling is scheduled separately; the interaction does not wait for discovery or a full status poll. Discovery has its own coalesced background refresh.

Discord rendering lives in `administration-cards.js`; relay controls live in `relay-settings-controller.js`; setup, category permissions, and other administration interactions have separate controllers. Core administration has no Discord SDK dependency. Existing setup/binding workflows still coordinate storage and Discord API calls in the Discord controllers; this is an incremental separation, not a claim that every historical workflow is a pure domain service.

The old administration controller paths in `src/services/` are compatibility re-exports. New integrations should import the canonical Discord modules. KOOK and other platforms can consume core events without importing Discord cards or interaction objects.
