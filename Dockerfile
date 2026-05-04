FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /data /config && chown node:node /data /config

USER node

CMD ["node", "src/index.js"]
