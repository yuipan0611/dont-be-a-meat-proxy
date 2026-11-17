# Build context is repository root. Version is checked again at deployment; no npx auto-updates.
FROM node:22.21.1-alpine3.22@sha256:b2358485e3e33bc3a33114d2b1bdb18cdbe4df01bd2b257198eb51beb1f026c5
RUN npm install --global @google/gemini-cli@0.68.0 --no-audit --no-fund && npm cache clean --force
RUN addgroup -g 10004 gemini && adduser -D -u 10004 -G gemini gemini
WORKDIR /app
COPY ops/llm-gateway /app/ops/llm-gateway
COPY ops/bank-proxy/budget.mjs /app/ops/bank-proxy/budget.mjs
USER 10004:10004
ENV HOME=/home/gemini
EXPOSE 8790
CMD ["node", "/app/ops/llm-gateway/main.mjs"]
