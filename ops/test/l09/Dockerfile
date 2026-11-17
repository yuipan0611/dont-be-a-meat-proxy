# Isolated local fake VPS. Never mount a host Docker socket into this container.
FROM docker:29-dind@sha256:4bbc7223f81db790097c6dea42fb93e05b8fead4f0431fbe6ccaba6e8473201c
RUN apk add --no-cache python3 bash sqlite coreutils util-linux curl git shadow caddy
RUN id caddy >/dev/null 2>&1 || adduser -S -D -H -G caddy caddy
