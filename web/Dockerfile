FROM node:22-alpine
ENV NODE_ENV=production
RUN apk add --no-cache python3
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY web/ ./
COPY client/ /app/client/
COPY ops/ /app/ops/
COPY bot/ /app/bot/
COPY server/ /app/server/
COPY deploy/ /app/deploy/
COPY supabase/ /app/supabase/
ARG SOURCE_REVISION=unavailable
ENV SOURCE_REVISION=$SOURCE_REVISION
RUN npm run build
EXPOSE 8080
CMD ["node","src/main.mjs"]
