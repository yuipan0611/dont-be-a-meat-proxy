// L-02b black-box: real Mail (pinned amd64 image) + L-01 Postgres + Hindsight 1.2.1 + bank-proxy/gateway
// + the bridge container from deploy/memory-bridge/compose.bridge.yaml. LLM = host Ollama (no paid key);
// the daily-cap refusal is produced by the real gateway with a 1 µUSD cap.
// Run: node --test ops/test/memory-bridge.integration.test.mjs     (L02B_KEEP=1 keeps the stacks)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { startStack, hindsightRest, root } from './memory-stack.mjs';
import { createMailClient } from '../../client/mail-client.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const FIXTURE = readFileSync(join(root, 'client/test/fixtures/handoff-1500.txt'), 'utf8');
const dockerOk = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
let ollamaOk = false;
try { ollamaOk = (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
const skip = !dockerOk ? 'Docker not running' : !ollamaOk ? 'Ollama (qwen2.5:7b) not running' : false;
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('L-02b bridge: Mail → Hindsight, Hindsight down, re-run, same document_id, budget refusal', { skip, timeout: 40 * 60_000 }, async (t) => {
  const s = await startStack({ keep: process.env.L02B_KEEP === '1' });
  const mailPriv = join(s.dir, 'mail-private');
  const bridgeState = join(s.dir, 'bridge-state');
  const clockState = join(s.dir, 'hubclock');
  for (const d of [bridgeState, clockState]) mkdirSync(d, { mode: 0o700 });
  const mailPort = await freePort();
  const mailProject = `l02bmail-${process.pid}`;
  Object.assign(s.env, {
    HUB_PRIVATE_DIR_MAIL: mailPriv, HUB_MAIL_PORT: String(mailPort), HUB_OPS_UID: String(process.getuid()), HUB_OPS_GID: String(process.getgid()),
    HUB_MEMORY_PROJECT: s.memProject, HUB_BRIDGE_STATE_DIR: bridgeState, HUBCLOCK_STATE_DIR: clockState,
  });
  const mailEnv = () => ({ ...s.env, HUB_PRIVATE_DIR: mailPriv });
  const mailc = (...a) => execFileSync('docker', ['compose', '-p', mailProject, '-f', join(root, 'deploy/compose.yaml'),
    '-f', join(root, 'deploy/hubclock/compose.hubclock.yaml'), '-f', join(root, 'deploy/memory-bridge/compose.bridge.yaml'), ...a],
  { cwd: root, env: mailEnv(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const ops = (name, ...a) => execFileSync('python3', [join(root, 'ops', name), '--state-dir', mailPriv, ...a], { cwd: root, encoding: 'utf8' });
  const bridge = (...a) => {
    const r = spawnSync('docker', ['compose', '-p', mailProject, '-f', join(root, 'deploy/compose.yaml'), '-f', join(root, 'deploy/hubclock/compose.hubclock.yaml'),
      '-f', join(root, 'deploy/memory-bridge/compose.bridge.yaml'), 'run', '--rm', '--no-deps', 'memory-bridge', 'node', '/app/ops/memory-bridge/main.mjs', ...a],
    { cwd: root, env: mailEnv(), encoding: 'utf8', timeout: 900_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const status = () => JSON.parse(bridge('status').out);
  t.after(() => {
    if (process.env.L02B_KEEP !== '1') { try { mailc('down', '-v', '--remove-orphans'); } catch {} }
    s.stop();
  });

  await t.test('stacks up: L-01 db, memory (Hindsight on Ollama), Mail with MemoryBridge registered', () => {
    s.pgc('up', '-d', '--wait', '--wait-timeout', '90', 'db');
    s.pg('migrate');
    s.pg('hindsight-init');
    s.memc('build', 'bank-proxy');
    s.memc('up', '-d', '--wait', '--wait-timeout', '600', 'hindsight', 'bank-proxy');
    assert.equal(hindsightRest(s, 'PUT', '/v1/default/banks/group-a', { name: 'group-a' }).status, 200);
    ops('init-secrets');
    mailc('up', '-d', '--wait', '--wait-timeout', '180', 'mail-a');
    const out = ops('bootstrap', '--url', `http://127.0.0.1:${mailPort}/mcp/`);
    assert.match(out, /MemoryBridge/);
    assert.match(ops('bootstrap', '--url', `http://127.0.0.1:${mailPort}/mcp/`), /RETAINED registration for role memorybridge/);
    writeFileSync(join(mailPriv, 'memorybridge.hindsight-api.key'), s.secrets.tenant + '\n', { mode: 0o600 });
    chmodSync(join(mailPriv, 'memorybridge.hindsight-api.key'), 0o600);
  });

  const reg = (role) => JSON.parse(readFileSync(join(mailPriv, `${role}.sender.json`), 'utf8'));
  const upstream = () => readFileSync(join(mailPriv, 'mail-a.env'), 'utf8').match(/HTTP_BEARER_TOKEN=(\S+)/)[1];
  let macClient;
  const sendHandoff = async (text, kind = 'handoff') => {
    macClient ??= createMailClient({ url: `http://127.0.0.1:${mailPort}/mcp/`, token: upstream(), projectKey: reg('mac').projectKey, agentName: 'BlueLake', senderToken: reg('mac').senderToken });
    return macClient.sendItem({ to: ['RedStone'], cc: [reg('memorybridge').agentName], subject: `${kind} test`, kind, intent: 'action', summary: '測試', text, links: [], unfinished: [], sourceSession: 'mac-it', clientEventId: crypto.randomUUID() });
  };
  const doc = (id) => hindsightRest(s, 'GET', `/v1/default/banks/group-a/documents/mail-${id}`);
  const recOf = (st, id) => st.notIndexed.find((r) => r.mailId === id);

  let first;
  await t.test('Hindsight stopped: the bridge queues the handoff and keeps it pending with error + last attempt', async () => {
    first = await sendHandoff(FIXTURE);
    s.memc('stop', 'hindsight');
    const r = bridge('once');
    assert.equal(r.code, 0, r.err);
    const st = status();
    const rec = recOf(st, first.messageId);
    assert.equal(rec.status, 'pending');
    assert.equal(rec.lastError.kind, 'unreachable');
    assert.ok(rec.lastAttemptAt);
    console.log(`DOWN: ${JSON.stringify(rec.lastError)}`);
  });

  await t.test('Hindsight back + re-run by Mail ID: indexed; the stored original is byte-for-byte the Mail text (TC-21 via the bridge)', () => {
    s.memc('start', 'hindsight');
    s.memc('up', '-d', '--wait', '--wait-timeout', '300', 'hindsight');
    assert.equal(bridge('reindex', String(first.messageId)).code, 0); // due now instead of waiting the backoff
    const t0 = Date.now();
    assert.equal(bridge('once').code, 0);
    console.log(`RETAIN via bridge: ${Date.now() - t0} ms`);
    const st = status();
    assert.equal(st.byStatus.indexed, 1, JSON.stringify(st));
    const d = doc(first.messageId);
    assert.equal(d.status, 200);
    assert.equal(sha(d.json.original_text), sha(FIXTURE));
    console.log(`DOC metadata: ${JSON.stringify(d.json.document_metadata ?? d.json.metadata ?? null).slice(0, 300)}`);
  });

  await t.test('black-box Hindsight 1.2.1: retaining the same document_id again (same text, then different text)', () => {
    const count = () => {
      const docs = hindsightRest(s, 'GET', '/v1/default/banks/group-a/documents').json;
      const mem = hindsightRest(s, 'GET', '/v1/default/banks/group-a/memories/list?limit=200').json;
      return { documents: (docs.items ?? docs.documents ?? docs).length, memories: (mem.items ?? mem.memories ?? mem.results ?? []).length };
    };
    const before = count();
    assert.equal(bridge('reindex', String(first.messageId)).code, 0);
    assert.equal(bridge('once').code, 0);
    const sameAgain = count();
    const r = hindsightRest(s, 'POST', '/v1/default/banks/group-a/memories', { items: [{ content: '替換測試：完全不同的內容。', document_id: `mail-${first.messageId}` }], async: false });
    assert.equal(r.status, 200, r.body);
    const different = count();
    const after = doc(first.messageId).json;
    const replaced = after.original_text === '替換測試：完全不同的內容。';
    const report = { before, sameAgain, different, original_text_replaced: replaced };
    console.log(`BLACKBOX_SAME_DOCUMENT_ID ${JSON.stringify(report)}`);
    if (process.env.L02B_EVIDENCE) writeFileSync(process.env.L02B_EVIDENCE, `${new Date().toISOString()} ${JSON.stringify(report)}\n`, { flag: 'a' });
    assert.equal(sameAgain.documents, before.documents, 'same document_id does not add a document');
    assert.equal(different.documents, before.documents);
    assert.equal(replaced, true, 'a later retain on the same document_id replaces original_text');
    // put the Mail text back (the bridge's job: Mail is the record)
    assert.equal(bridge('reindex', String(first.messageId)).code, 0);
    assert.equal(bridge('once').code, 0);
    assert.equal(sha(doc(first.messageId).json.original_text), sha(FIXTURE));
  });

  await t.test('daily request cap reached (F-11 gateway cap 0, no provider): pending, nothing lost, indexed after', async () => {
    Object.assign(s.env, { HUB_LLM_DAILY_REQUEST_LIMIT: '0', HINDSIGHT_LLM_PROVIDER: 'openai', HINDSIGHT_LLM_MODEL: 'hub-llm', HINDSIGHT_LLM_BASE_URL: 'http://llm-gateway:8790/v1' });
    s.memc('build', 'llm-gateway');
    s.memc('up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', 'llm-gateway', 'hindsight', 'bank-proxy');
    const m = await sendHandoff('決策：記憶索引超過每日額度時要留在 pending，不能丟。', 'decision');
    assert.equal(bridge('once').code, 0);
    const rec = recOf(status(), m.messageId);
    assert.ok(['pending', 'unknown'].includes(rec.status), JSON.stringify(rec));
    console.log(`OVER_CAP: status=${rec.status} error=${JSON.stringify(rec.lastError).slice(0, 300)}`);
    const d = doc(m.messageId);
    console.log(`OVER_CAP document stored by Hindsight anyway: ${d.status === 200} (${d.status})`);
    const budget = JSON.parse(s.memc('exec', '-T', 'llm-gateway', 'node', '--input-type=module', '-e',
      "import fs from 'node:fs'; const r=await fetch('http://127.0.0.1:8790/status',{headers:{'x-api-key':fs.readFileSync('/run/secrets/hindsight_key','utf8').trim()}}); console.log(JSON.stringify((await r.json()).budget));"));
    assert.equal(budget.usedRequests, 0, 'nothing was sent to a provider');
    const logs = s.memc('logs', 'llm-gateway');
    assert.match(logs, /DAILY_LIMIT/);
    // back under budget (local model again): the same record is indexed, text intact
    Object.assign(s.env, { HUB_LLM_DAILY_REQUEST_LIMIT: '500', HINDSIGHT_LLM_PROVIDER: 'ollama', HINDSIGHT_LLM_MODEL: 'qwen2.5:7b', HINDSIGHT_LLM_BASE_URL: 'http://host.docker.internal:11434/v1' });
    s.memc('up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', 'hindsight', 'bank-proxy');
    assert.equal(bridge('reindex', String(m.messageId)).code, 0);
    assert.equal(bridge('once').code, 0);
    const st = status();
    assert.equal(recOf(st, m.messageId), undefined, JSON.stringify(st));
    assert.equal(doc(m.messageId).json.original_text, '決策：記憶索引超過每日額度時要留在 pending，不能丟。');
  });

  await t.test('restart: state survives a new container; a second writer stands by (exit 3)', () => {
    const st = status();
    assert.equal(st.byStatus.indexed, 2);
    assert.ok(st.cursor !== null);
    mailc('up', '-d', 'memory-bridge'); // the long-running service holds the lock
    let r;
    for (let i = 0; i < 20; i++) {
      r = bridge('once');
      if (r.code === 3) break;
      execFileSync('sleep', ['1']);
    }
    assert.equal(r.code, 3, 'manual once stands by while the service runs');
    mailc('stop', 'memory-bridge');
  });
});
