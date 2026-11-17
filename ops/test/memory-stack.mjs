// L-02 local stack helper: L-01 Postgres + hindsight-init + memory project (Hindsight + bank-proxy).
// Used by memory.integration.test.mjs. Local LLM = host Ollama (no paid key); the gateway itself is
// covered by ops/bank-proxy/test/llm-gateway.test.mjs and, with a real key, by runbook-L02 §5.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

export const root = resolve(import.meta.dirname, '../..');
const pgCompose = join(root, 'deploy/postgres/compose.yaml');
const memCompose = join(root, 'deploy/memory/compose.yaml');
const op = join(root, 'ops/postgres');

export const TOKENS = {
  mac: 'FAKE-mac-token-do-not-use', // supabase/seed.sql, group-a
  win: 'FAKE-windows-token-do-not-use', // group-a
  other: 'FAKE-groupb-token-do-not-use', // added below, group-b
};

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

export async function startStack({ keep = false, llm = 'ollama', groupId = 'group-a' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'l02-'));
  const id = `${process.pid}-${Date.now() % 100000}`;
  const dbProject = `l02db-${id}`;
  const memProject = `l02mem-${id}`;
  const priv = join(dir, 'private');
  const mem = join(dir, 'memory');
  mkdirSync(priv, { mode: 0o700 });
  for (const d of ['hindsight', 'bank-proxy']) mkdirSync(join(mem, d), { recursive: true, mode: 0o700 });
  const hex = () => randomBytes(32).toString('hex');
  const s = { pg: hex(), hubApp: hex(), hsDb: hex(), tenant: hex(), gateway: hex() };
  writeFileSync(join(priv, 'postgres.password'), s.pg, { mode: 0o600 });
  writeFileSync(join(priv, 'hub-app.password'), s.hubApp, { mode: 0o600 });
  writeFileSync(join(priv, 'hindsight-db.password'), s.hsDb, { mode: 0o600 });
  writeFileSync(join(mem, 'hindsight/hindsight-db.password'), s.hsDb, { mode: 0o644 }); // Docker Desktop: bind perms are not mapped
  writeFileSync(join(mem, 'hindsight/hindsight-api.key'), s.tenant, { mode: 0o644 });
  writeFileSync(join(mem, 'hindsight/llm-gateway.key'), s.gateway, { mode: 0o644 });
  writeFileSync(join(mem, 'bank-proxy/hub-app.password'), s.hubApp, { mode: 0o644 });
  writeFileSync(join(mem, 'bank-proxy/anthropic.key'), 'sk-lo\x63al-test-not-a-real-key', { mode: 0o644 });
  writeFileSync(join(mem, 'bank-proxy/hindsight-api.key'), s.tenant, { mode: 0o644 });
  writeFileSync(join(mem, 'bank-proxy/llm-gateway.key'), s.gateway, { mode: 0o644 });
  const gatewayPrivate = join(dir, 'gateway-private');
  mkdirSync(gatewayPrivate, { mode: 0o700 });
  for (const [name, value] of [['hindsight', s.gateway], ['bot', hex()], ['eval', hex()]]) writeFileSync(join(gatewayPrivate, `${name}.key`), value, { mode: 0o644 });
  const profile = join(dir, 'gemini-profile'), agyBin = join(dir, 'agy-bin');
  mkdirSync(profile); mkdirSync(agyBin);
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o777 });
  cpSync(join(root, 'supabase'), join(dir, 'supabase'), { recursive: true });
  const arch = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const port = await freePort();
  const env = {
    ...process.env, HUB_GROUP_ID: groupId, HUB_PG_PROJECT: dbProject, HUB_PRIVATE_DIR: priv, HUB_PG_SQL_DIR: join(dir, 'supabase'), HUB_PG_PLATFORM: arch,
    HUB_HS_PLATFORM: arch, HUB_MEMORY_PRIVATE_DIR: mem, HUB_BANKPROXY_STATE_DIR: state, HUB_BANKPROXY_PORT: String(port),
    HUB_BANKPROXY_UID: String(process.getuid()), HUB_BANKPROXY_GID: String(process.getgid()), HUB_BANKPROXY_TAG: 'l02-test',
    HUB_LLM_PRIVATE_DIR: gatewayPrivate, HUB_GEMINI_PROFILE_DIR: profile, HUB_LLM_STATE_DIR: state, HUB_AGY_BIN_DIR: agyBin,
    HUB_LLM_NETWORK: `${memProject}_llm-net`, HUB_LLM_DAILY_REQUEST_LIMIT: '500',
  };
  if (llm === 'ollama') {
    Object.assign(env, { HINDSIGHT_LLM_PROVIDER: 'ollama', HINDSIGHT_LLM_MODEL: 'qwen2.5:7b', HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:11434/v1' });
  }
  // The Ollama bypass exists only in this local test overlay. Production is fixed to the gateway.
  const overlay = join(dir, 'memory-test.yaml');
  writeFileSync(overlay, `services:
  hindsight:
    environment:
      HINDSIGHT_API_LLM_PROVIDER: \${HINDSIGHT_LLM_PROVIDER:-openai}
      HINDSIGHT_API_LLM_MODEL: \${HINDSIGHT_LLM_MODEL:-hub-llm}
      HINDSIGHT_API_LLM_BASE_URL: \${HINDSIGHT_LLM_BASE_URL:-http://llm-gateway:8790/v1}
  llm-gateway:
    image: neighbor-llm-gateway:f11-test
    build:
      context: ${root}
      dockerfile: ops/llm-gateway/Dockerfile.test
    user: "${process.getuid()}:${process.getgid()}"
    environment:
      LLM_BACKEND: gemini-cli
      LLM_UPSTREAM_MODEL: gemini-3.5-flash
      GEMINI_BIN: /no-real-provider-installed
`);
  const run = (file, args, o = {}) => execFileSync(file, args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...o });
  const pgc = (...a) => run('docker', ['compose', '-p', dbProject, '-f', pgCompose, ...a]);
  const memc = (...a) => run('docker', ['compose', '-p', memProject, '-f', memCompose, '-f', overlay, ...a]);
  const pg = (cmd, args = []) => run('bash', [op, cmd, ...args]);
  const sql = (q, db = 'hub') => pg('psql', ['-d', db, '-Atqc', q]).trim();
  const stop = () => {
    if (keep) return;
    try { memc('down', '-v', '--remove-orphans'); } catch {}
    try { pgc('down', '-v', '--remove-orphans'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, env, secrets: s, port, base: `http://127.0.0.1:${port}`, run, pgc, memc, pg, sql, stop, dbProject, memProject };
}

/** Operator call to Hindsight's REST API from inside its container (it is never published). */
export function hindsightRest(stack, method, path, body) {
  const py = `
import json, sys, urllib.request
key = open('/run/secrets/hindsight_api_key').read().strip()
data = sys.stdin.read().encode() or None
req = urllib.request.Request('http://127.0.0.1:8888' + sys.argv[2], data=data, method=sys.argv[1],
                             headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        print(json.dumps({'status': r.status, 'body': r.read().decode('utf-8')}, ensure_ascii=False))
except urllib.error.HTTPError as e:
    print(json.dumps({'status': e.code, 'body': e.read().decode('utf-8')}, ensure_ascii=False))
`;
  const out = stack.run('docker', ['compose', '-p', stack.memProject, '-f', memCompose, 'exec', '-T', 'hindsight', 'python', '-c', py, method, path],
    { input: body === undefined ? '' : JSON.stringify(body) });
  const r = JSON.parse(out.trim().split('\n').at(-1));
  try { r.json = JSON.parse(r.body); } catch {}
  return r;
}
