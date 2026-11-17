FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY web/ ./
COPY client/ /app/client/
COPY ops/lifecycle/ /app/ops/lifecycle/
ARG SOURCE_REVISION=unavailable
ENV SOURCE_REVISION=$SOURCE_REVISION
RUN npm run build
EXPOSE 8080
CMD ["node","src/main.mjs"]
