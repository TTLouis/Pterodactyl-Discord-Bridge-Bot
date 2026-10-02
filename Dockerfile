FROM node:24-bookworm-slim


# Retain UID/GID 1000 for existing Compose volumes while supplying Wings' user/home.
RUN usermod -l container -d /home/container node && groupmod -n container node

WORKDIR /app

ENV NODE_ENV=production \
    STATE_PATH=/data/runtime-state.json \
    PERSISTENT_CONFIG_PATH=/data/persistent-config.json \
    PERSISTENT_SECRETS_PATH=/data/persistent-secrets.json \
    HEARTBEAT_PATH=/data/heartbeat \
    SYNC_HEALTH_PATH=/data/sync-health.json

COPY --chown=container:container package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=container:container . .
RUN mkdir -p /data /config /home/container && chown container:container /data /config /home/container
COPY deployment/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ARG BRIDGE_REVISION=unknown
LABEL org.opencontainers.image.revision=$BRIDGE_REVISION

USER container

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["/bin/bash", "/entrypoint.sh", "node", "/app/src/healthcheck.js"]

ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
CMD ["node", "/app/src/index.js"]
