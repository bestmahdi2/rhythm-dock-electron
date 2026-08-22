# Rhythm Dock room server.
FROM node:20-alpine

# Run as a non-root user. The container needs no privileges: it touches no host files
# and binds an unprivileged port.
RUN addgroup -S rhythm && adduser -S rhythm -G rhythm

WORKDIR /app

# Copy manifests first so a code change does not invalidate the dependency layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

USER rhythm

ENV NODE_ENV=production
ENV PORT=8420
EXPOSE 8420

# The server holds no state, so an unhealthy container can simply be replaced.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8420/healthz || exit 1

CMD ["node", "src/index.js"]
