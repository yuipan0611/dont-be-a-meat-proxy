#!/usr/bin/env node
// L-02 member proxy. F-11 moves all LLM calls to ops/llm-gateway (separate single writer).
//   :8780  bank-proxy   — published only on host loopback for Caddy (/memory/* → here)
// Modes: `serve` (default). Shared budget status is now GET llm-gateway:8790/status.
//
// Secrets are files (Compose secrets), never env values or argv:
//   $SECRETS_DIR/hub_app_password        hub DB login for the token registry
//   $SECRETS_DIR/hindsight_api_key       Hindsight tenant master key (upstream of bank-proxy)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBankProxy } from './bank-proxy.mjs';
import { createPgRegistry } from './registry-pg.mjs';

const env = process.env;
const SECRETS = env.SECRETS_DIR ?? '/run/secrets';
const secret = (name) => {
  const v = readFileSync(join(SECRETS, name), 'utf8').trim();
  if (!v) throw new Error(`secret ${name} is empty`);
  return v;
};
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

const mode = process.argv[2] ?? 'serve';
if (mode === 'budget-status') {
  throw new Error('F-11: read authenticated GET llm-gateway:8790/status for the shared request budget');
}
if (mode !== 'serve') {
  console.error('usage: main.mjs serve');
  process.exit(2);
}

const groupId = env.HUB_GROUP_ID;
if (!/^[a-z][a-z0-9-]{1,62}$/.test(groupId ?? '')) throw new Error('HUB_GROUP_ID required');
const registry = createPgRegistry({ groupId, host: env.HUB_DB_HOST ?? 'db', password: secret('hub_app_password') });
const proxy = createBankProxy({
  groupId, registry, upstreamUrl: env.HINDSIGHT_URL ?? 'http://hindsight:8888', upstreamKey: secret('hindsight_api_key'), log,
});

const health = (handler) => (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  return handler(req, res);
};
const servers = [
  http.createServer(health(proxy)).listen(Number(env.BANK_PROXY_PORT ?? 8780), '0.0.0.0'),
];
for (const s of servers) { s.requestTimeout = 0; s.headersTimeout = 30_000; } // MCP GET streams are long-lived
log({ ev: 'started', llm: 'external-gateway' });

const stop = () => {
  log({ ev: 'stopping' });
  for (const s of servers) s.close();
  registry.end().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
