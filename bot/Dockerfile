# L-03 Discord bot. Build context = repo root (needs client/mail-client.mjs):
#   docker compose -f deploy/compose.yaml -f deploy/bot/compose.bot.yaml build bot
# node:24-alpine multi-arch index digest — same pin as HubClock (deploy/hubclock), pulled 2026-11-17.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY bot/package.json bot/package-lock.json /app/bot/
RUN cd /app/bot && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY client/mail-client.mjs /app/client/mail-client.mjs
COPY bot/src /app/bot/src
USER node
ENV NODE_ENV=production TZ=UTC
ENTRYPOINT ["node", "/app/bot/src/main.mjs"]
CMD ["run"]
