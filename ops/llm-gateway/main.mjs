#!/usr/bin/env node
import http from 'node:http';
import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequestBudget } from './request-budget.mjs';
import { createQueue } from './queue.mjs';
import { createBackend } from './backends.mjs';
import { createGateway } from './gateway.mjs';

const env = process.env;
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const secret = (name) => {
  const value = readFileSync(join(env.SECRETS_DIR ?? '/run/secrets', name), 'utf8').trim();
  if (!value) throw new Error(`empty internal key: ${name}`);
  return value;
};
const keys = { [secret('hindsight_key')]: 'hindsight', [secret('bot_key')]: 'bot', [secret('eval_key')]: 'eval' };
if (Object.keys(keys).length !== 3) throw new Error('use distinct gateway client keys');
const file = env.LEDGER_FILE ?? '/state/gemini-requests.json';
mkdirSync(dirname(file), { recursive: true });
// No second writer and no unsafe stale-lock guessing. Operator removes stale lock ONLY after stop.
const lock = `${file}.lock`;
closeSync(openSync(lock, 'wx', 0o600));
let server;
try {
  const budget = createRequestBudget({ file, dailyLimit: Number(env.LLM_DAILY_REQUEST_LIMIT ?? 500) });
  const type = env.LLM_BACKEND ?? 'disabled';
  const gemini = createBackend({ type, command: type === 'antigravity-cli' ? env.AGY_BIN ?? '/opt/agy/agy' : env.GEMINI_BIN,
    profileDir: env.GEMINI_PROFILE_DIR ?? '/home/gemini', timeoutMs: Number(env.GEMINI_TIMEOUT_MS ?? 90_000),
    model: env.LLM_UPSTREAM_MODEL, apiKey: ['gemini-api-free', 'gemini-api-paid'].includes(type) ? secret('gemini_api_key') : undefined });
  const gateway = createGateway({ budget, gemini, clientKeys: keys, models: [env.LLM_MODEL ?? 'hub-llm'],
    queue: createQueue({ maxQueued: Number(env.LLM_MAX_QUEUED ?? 20), waitMs: Number(env.LLM_QUEUE_WAIT_MS ?? 30_000) }), log });
  server = http.createServer(gateway.handle);
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.listen(Number(env.LLM_GATEWAY_PORT ?? 8790), env.LLM_GATEWAY_HOST ?? '0.0.0.0', () => log({ ev: 'started', ...gateway.status() }));
  server.on('error', () => { log({ ev: 'listener_failed' }); process.exitCode = 1; });
} catch (e) { unlinkSync(lock); throw e; }
process.on('exit', () => { try { unlinkSync(lock); } catch {} });
const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 125_000).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
