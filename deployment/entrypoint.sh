#!/bin/bash
set -euo pipefail

if [ "${BRIDGE_DEPLOYMENT:-docker}" = "pterodactyl" ]; then
    # Wings supplies STARTUP as metadata. This Egg uses the packaged command;
    # never expand or evaluate tokens or arbitrary startup shell text.
    if [ -n "${STARTUP:-}" ] && [ "$STARTUP" != "node /app/src/index.js" ]; then
        echo "Unsupported Egg startup command; use node /app/src/index.js." >&2
        exit 1
    fi
    cd /home/container
    umask 077
    mkdir -p data
    export CONFIG_PATH=/home/container/servers.json
    export PERSISTENT_CONFIG_PATH=/home/container/data/persistent-config.json
    export PERSISTENT_SECRETS_PATH=/home/container/data/persistent-secrets.json
    export STATE_PATH=/home/container/data/runtime-state.json
    export KOOK_STATE_PATH=/home/container/data/kook-runtime-state.json
    export HEARTBEAT_PATH=/home/container/data/heartbeat
    export SYNC_HEALTH_PATH=/home/container/data/sync-health.json
fi

exec "$@"
