# L-02 member bank-proxy. F-11 LLM gateway has its own image. Build context: ops/bank-proxy.
FROM node:22.21.1-alpine3.22@sha256:b2358485e3e33bc3a33114d2b1bdb18cdbe4df01bd2b257198eb51beb1f026c5
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bank-proxy.mjs registry-pg.mjs main.mjs ./
USER node
EXPOSE 8780
CMD ["node", "/app/main.mjs", "serve"]
