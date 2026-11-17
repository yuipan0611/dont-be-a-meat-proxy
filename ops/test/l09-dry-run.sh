#!/usr/bin/env bash
# Disposable nested Docker daemon; no VPS login, real secrets, host socket, ports or volumes shared.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
VPS="l09-dry-$(date +%s)-$$"
case "$(uname -m)" in arm64|aarch64) PLATFORM=linux/arm64;; *) PLATFORM=linux/amd64;; esac
cleanup() {
  result=$?
  if [[ "$result" != 0 && "${L09_KEEP_FAILED:-0}" == 1 ]]; then
    echo "Retained disposable fixture for diagnosis: $VPS"
  else
    docker rm -f -v "$VPS" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
# Privileged applies only to this isolated local DinD daemon, never any production service.
# Build the unchanged real validator from this checkout on the outer Docker builder. Nested Go
# dependency downloads failed in the initial DinD rehearsal; importing this artifact is not a validator fixture.
docker build -q --platform "$PLATFORM" -t neighbor-l09-validator:dry-built server/validator >/dev/null
docker build -q --platform "$PLATFORM" -t neighbor-l09-bank-proxy:dry-built ops/bank-proxy >/dev/null
docker build -q --platform "$PLATFORM" -t neighbor-l09-web:dry-built -f web/Dockerfile . >/dev/null
docker build -q -t neighbor-l09-vps:test ops/test/l09 >/dev/null
docker run -d --privileged --name "$VPS" -e DOCKER_TLS_CERTDIR= -e TEST_PLATFORM="$PLATFORM" neighbor-l09-vps:test >/dev/null
for _ in $(seq 1 40); do
  if docker exec "$VPS" docker info >/dev/null 2>&1 2>&1; then break; fi
  sleep 1
done
docker exec "$VPS" docker info >/dev/null 2>&1
# Archive excludes all working secrets, generated caches and Git history.
tar --exclude=.git --exclude=.hub-local --exclude=spikes --exclude=node_modules --exclude=__pycache__ --exclude=.generated -czf - . |
  docker exec -i "$VPS" sh -c 'mkdir -p /opt/neighbor-hub; tar -xzf - -C /opt/neighbor-hub'
# Preseed cached pinned layers without granting the nested daemon the host socket.
for image in \
  ghcr.io/dicklesworthstone/mcp_agent_mail_rust@sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1 \
  pgvector/pgvector@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782 \
  node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 \
  golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image save "$image" | docker exec -i "$VPS" docker load >/dev/null
  fi
done
# docker save/load preserves the image index content but not its registry alias. The fixture tags
# the exact cached Mail index; this is the same binary/layers, not a Mail provider substitute.
docker exec "$VPS" docker tag sha256:49a3c779f509bdacbc4edd21db193c3105438f627e8b00ed5590766a32ede0e1 l09-mail-cached 2>/dev/null || true
docker exec "$VPS" docker tag sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782 l09-pg-cached 2>/dev/null || true
docker exec "$VPS" docker tag sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 node:24-alpine 2>/dev/null || true
docker image save neighbor-l09-validator:dry-built neighbor-l09-bank-proxy:dry-built neighbor-l09-web:dry-built | docker exec -i "$VPS" docker load >/dev/null
# Reuse the fixture VPS's installed Python/Bash for the explicit Hindsight fixture; no nested apk/DNS.
docker image save neighbor-l09-vps:test | docker exec -i "$VPS" docker load >/dev/null
echo 'source_build=validator+bank-proxy+web real source, outer Docker builder; same artifacts loaded into fake VPS'
echo 'L09 Docker fake VPS dry-run; systemd/Discord/Hindsight are explicit fixtures; not production acceptance'
docker exec "$VPS" python3 /opt/neighbor-hub/ops/test/l09/setup.py
STARTED="$(docker exec "$VPS" python3 -c 'import time; print(time.time_ns()/1e9)')"
run_step() {
  local code=0
  docker exec "$VPS" /opt/neighbor-hub/ops/deploy-l09.sh --step "$1" || code=$?
  echo "step_${1}_exit=$code"
  return "$code"
}
for step in 1 2 3 4; do run_step "$step"; done
# Negative gate: actual Caddy parse failure must restore old site and never call reload.
docker exec "$VPS" sh -c 'cp /etc/caddy/Caddyfile /tmp/caddy-good; printf "\ninvalid_l09_directive {\n" >> /etc/caddy/Caddyfile'
if run_step 5; then echo 'FAIL invalid Caddy unexpectedly passed'; exit 1; fi
docker exec "$VPS" sh -c 'test ! -e /run/l09-reloads; mv /tmp/caddy-good /etc/caddy/Caddyfile'
echo 'PASS negative Caddy validate: zero reload; original hub site restored'
for step in 5 6 7; do run_step "$step"; done
if run_step 5; then echo 'FAIL replay unexpectedly passed'; exit 1; fi
docker exec "$VPS" sh -c 'test "$(cat /run/l09-reloads)" = 1'
docker exec "$VPS" python3 /opt/neighbor-hub/ops/test/l09/verify.py "$STARTED"
echo 'PASS one real Caddy reload across launch; replay refused; container preservation checked each step'
echo 'NOT TESTED: real systemd sandbox/timer wake, Discord/OAuth/Groq API, full Hindsight model/RAM, TLS, TC14 VPS, physical devices'
