# LiveShare Relay — minimal DeepSeek Harness LiveShare relay
FROM node:22-alpine

WORKDIR /app

# Only the manifests first so dependency layers cache independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs ./
COPY src ./src

ENV NODE_ENV=production \
    LIVESHARE_RELAY_HOST=0.0.0.0 \
    LIVESHARE_RELAY_PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${LIVESHARE_RELAY_PORT}/__liveshare/health" || exit 1

CMD ["node", "server.mjs"]
