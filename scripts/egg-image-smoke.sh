#!/bin/bash
# No network, real credentials, Panel, or Discord changes. Only uniquely named test volumes.
set -euo pipefail
image=${1:-bridge:ci}
root=$(cd "$(dirname "$0")/.." && pwd)
name="bridge-egg-smoke-$$"
volume="${name}-data"
restore="${name}-restore"
cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" "$restore" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker volume create "$restore" >/dev/null
# Wings owns its server mount; the image must work without its own UID or a writable root.
for target in "$volume" "$restore"; do
    docker run --rm --network none --user 0 --entrypoint /bin/sh \
        --mount "type=volume,source=$target,target=/home/container,volume-nocopy" "$image" -c 'chown 12345:12345 /home/container'
done
common=(--network none --read-only --user 12345:12345 -e BRIDGE_DEPLOYMENT=pterodactyl
    -e 'STARTUP=node /app/src/index.js' -e DISCORD_TOKEN=smoke-token -e KOOK_ENABLED=false)
run_runtime() {
    local mode=$1
    docker run -d --name "$name" "${common[@]}" -e "SMOKE_MODE=$mode" \
        --mount "type=volume,source=$volume,target=/home/container,volume-nocopy" -v "$root/scripts/egg-runtime-smoke.js:/tmp/egg-runtime-smoke.mjs:ro" \
        "$image" node /tmp/egg-runtime-smoke.mjs >/dev/null
    local ready=false
    for attempt in {1..30}; do
        if docker logs "$name" 2>&1 | grep -Eq 'Runtime smoke waiting for SIGINT'; then ready=true; break; fi
        sleep 1
    done
    if [ "$ready" != true ]; then docker logs "$name"; exit 1; fi
    docker exec "$name" /bin/bash /entrypoint.sh node /app/src/healthcheck.js
    docker kill --signal SIGINT "$name" >/dev/null
    [ "$(docker wait "$name")" = 0 ]
    docker logs "$name" 2>&1 | grep -Eq 'Received SIGINT. Shutting down.'
    docker logs "$name" 2>&1 | grep -Eq 'Bridge ready'
    if docker logs "$name" 2>&1 | grep -Eq 'smoke-token|smoke-private-key'; then exit 1; fi
    docker rm "$name" >/dev/null
    docker run --rm "${common[@]}" -e "SMOKE_MODE=$mode" \
        --mount "type=volume,source=$volume,target=/home/container,volume-nocopy" "$image" \
        node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; const state=JSON.parse(fs.readFileSync(process.env.STATE_PATH)); assert.equal(state.serverRuntime["signal-smoke"].mode, process.env.SMOKE_MODE);'
}
run_runtime setup
for phase in fresh restart recovery; do
    docker run --rm -i "${common[@]}" -e "SMOKE_PHASE=$phase" \
        --mount "type=volume,source=$volume,target=/home/container,volume-nocopy" "$image" node --input-type=module < "$root/scripts/beta-image-smoke.js"
done
# Reinstallation is the Egg's non-destructive no-op; run it against existing private data.
docker run --rm "${common[@]}" --mount "type=volume,source=$volume,target=/home/container,volume-nocopy" "$image" \
    node --input-type=module -e 'import fs from "node:fs"; import {execFileSync} from "node:child_process"; const egg=JSON.parse(fs.readFileSync("/app/deployment/egg-pterodactyl-platform-bridge.json")); execFileSync("sh", ["-c", egg.scripts.installation.script], {stdio:"inherit"});'
run_runtime monitoring
# Complete stopped-data backup/restore into a distinct mount, preserving permissions.
docker run --rm --network none --user 0 --entrypoint /bin/sh \
    -v "$volume:/source:ro" -v "$restore:/restore" "$image" \
    -c 'tar -C /source -cf - . | tar -C /restore -xf -'
docker run --rm -i "${common[@]}" -e SMOKE_PHASE=recovery \
    --mount "type=volume,source=$restore,target=/home/container,volume-nocopy" "$image" node --input-type=module < "$root/scripts/beta-image-smoke.js"
echo 'Egg image smoke passed: setup, persistence, recovery, reinstall, monitoring, SIGINT, healthcheck and restore.'
