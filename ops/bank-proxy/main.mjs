#!/usr/bin/env node
// L-02 service entry: two listeners in one process (one ledger writer).
//   :8780  bank-proxy   — published only on host loopback for Caddy (/memory/* → here)
//   :8790  LLM gateway  — memory-net only (Hindsight's HINDSIGHT_API_LLM_BASE_URL); never published
// Modes: `serve` (default) | `budget-status` (prints today's ledger totals, no secrets).
//
// Secrets are files (Compose secrets), never env values or argv:
//   $SECRETS_DIR/hub_app_password        hub DB login for the token registry
//   $SECRETS_DIR/hindsight_api_key       Hindsight tenant master key (upstream of bank-proxy)
//   $SECRETS_DIR/anthropic_api_key       real Anthropic key (upstream of the gateway)
//   $SECRETS_DIR/llm_gateway_key         internal key Hindsight presents to the gateway

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBankProxy } from './bank-proxy.mjs';
import { createLlmGateway } from './llm-gateway.mjs';
import { createLedger, DEFAULT_CAP_MICROS } from './budget.mjs';
import { createPgRegistry } from './registry-pg.mjs';

const env = process.env;
const SECRETS = env.SECRETS_DIR ?? '/run/secrets';
const secret = (name) => {
  const v = readFileSync(join(SECRETS, name), 'utf8').trim();
  if (!v) throw new Error(`secret ${name} is empty`);
  return v;
};
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const clock = { now: () => Date.now() };
const ledgerFile = env.LEDGER_FILE ?? '/state/llm-ledger.json';
const capMicros = Number(env.LLM_DAILY_CAP_MICROS ?? DEFAULT_CAP_MICROS);

const mode = process.argv[2] ?? 'serve';
if (mode === 'budget-status') {
  console.log(JSON.stringify(createLedger({ file: ledgerFile, capMicros, clock }).status()));
  process.exit(0);
}
if (mode !== 'serve') {
  console.error('usage: main.mjs serve | budget-status');
  process.exit(2);
}

const groupId = env.HUB_GROUP_ID;
if (!/^[a-z][a-z0-9-]{1,62}$/.test(groupId ?? '')) throw new Error('HUB_GROUP_ID required');
const ledger = createLedger({ file: ledgerFile, capMicros, clock });
const registry = createPgRegistry({ groupId, host: env.HUB_DB_HOST ?? 'db', password: secret('hub_app_password') });
const proxy = createBankProxy({
  groupId, registry, upstreamUrl: env.HINDSIGHT_URL ?? 'http://hindsight:8888', upstreamKey: secret('hindsight_api_key'), log,
});
const gateway = createLlmGateway({
  ledger, upstreamUrl: env.ANTHROPIC_URL ?? 'https://api.anthropic.com', upstreamKey: secret('anthropic_api_key'),
  clientKeys: { [secret('llm_gateway_key')]: 'hindsight' }, log,
});

const health = (handler) => (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  return handler(req, res);
};
const servers = [
  http.createServer(health(proxy)).listen(Number(env.BANK_PROXY_PORT ?? 8780), '0.0.0.0'),
  http.createServer(health(gateway)).listen(Number(env.LLM_GATEWAY_PORT ?? 8790), '0.0.0.0'),
];
for (const s of servers) { s.requestTimeout = 0; s.headersTimeout = 30_000; } // MCP GET streams are long-lived
log({ ev: 'started', budget: ledger.status() });

const stop = () => {
  log({ ev: 'stopping' });
  for (const s of servers) s.close();
  registry.end().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
