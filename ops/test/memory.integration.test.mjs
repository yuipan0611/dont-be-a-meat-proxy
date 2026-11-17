// L-02 end-to-end on Docker: L-01 Postgres + hindsight database/login + Hindsight 1.2.1 + bank-proxy.
// LLM = host Ollama qwen2.5:7b (no paid key). Skips (not passes) when Docker or Ollama is missing.
// Run: node --test ops/test/memory.integration.test.mjs        (first run downloads ~400 MB of models)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startStack, hindsightRest, root, TOKENS } from './memory-stack.mjs';
import { mcpSession, resultText } from './mcp-http.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const FIXTURE = readFileSync(join(root, 'client/test/fixtures/handoff-1500.txt'), 'utf8');
const FIXTURE_SHA = readFileSync(join(root, 'client/test/fixtures/handoff-1500.sha256'), 'utf8').trim().split(/\s+/)[0];
// Characters that only exist in Simplified Chinese (their Traditional forms differ). Informational for facts.
const SIMPLIFIED_ONLY = /[们这说为发后会对时来么组决选择应该边过还没让请开关网页设计记录数据实现确认]/;

const dockerOk = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
let ollamaOk = false;
try { ollamaOk = (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
const skip = !dockerOk ? 'Docker not running' : !ollamaOk ? 'Ollama (qwen2.5:7b) not running on 127.0.0.1:11434' : false;

test('L-02 Hindsight + bank-proxy on the L-01 cluster', { skip, timeout: 20 * 60_000 }, async (t) => {
  const s = await startStack({ keep: process.env.L02_KEEP === '1' });
  t.after(s.stop);
  const peaks = {};
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const ids = [...s.memc('ps', '-q').split('\n'), ...s.pgc('ps', '-q').split('\n')].filter(Boolean);
      const out = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...ids], { encoding: 'utf8' }).stdout ?? '';
      for (const line of out.trim().split('\n')) {
        const [name, usage] = line.split('\t');
        const m = /([\d.]+)(KiB|MiB|GiB)/.exec(usage ?? '');
        if (!m) continue;
        const mib = Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]];
        const key = name.replace(/^l02(db|mem)-[\d-]+-/, '');
        peaks[key] = Math.max(peaks[key] ?? 0, mib);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  await t.test('provision: hub migrations + seed, then database hindsight / login hindsight_app (idempotent)', () => {
    s.pgc('up', '-d', '--wait', '--wait-timeout', '90', 'db');
    s.pg('migrate');
    s.pg('psql', ['-f', '/supabase/seed.sql']); // test-only fake devices (group-a: mac, win)
    s.sql(`insert into public.groups (id, display_name, project_key, mail_hostname, bank_id) values ('group-b','B 組','/data/projects/group-b','hub.example.invalid','group-b');
      insert into public.members (id, group_id, display_name) values ('00000000-0000-4000-8000-0000000000b1','group-b','Bob');
      insert into public.devices (member_id, group_id, label, platform, token_id, token_prefix, token_hash, allowed_agents)
        values ('00000000-0000-4000-8000-0000000000b1','group-b','Bob / Win','windows','tok_fakegrpb01','mph_fgrb',
                encode(sha256(convert_to('${TOKENS.other}','UTF8')),'hex'),'{GreenHill}');`);
    const first = s.pg('hindsight-init');
    assert.ok(!first.includes(s.secrets.hsDb), 'password never printed');
    s.pg('hindsight-init'); // rerun keeps the role and its password
    assert.equal(s.sql("select rolsuper::text || rolcreatedb::text || rolcreaterole::text from pg_roles where rolname='hindsight_app'"), 'falsefalsefalse');
    assert.equal(s.sql("select has_database_privilege('public','hindsight','CONNECT')"), 'f');
    assert.equal(s.sql("select pg_get_userbyid(datdba) from pg_database where datname='hindsight'"), 'hindsight_app');
    assert.equal(s.sql("select extname from pg_extension where extname='vector'", 'hindsight'), 'vector');
  });

  await t.test('reverse isolation: hindsight_app cannot reach hub; hub_app cannot reach hindsight (real TCP logins)', () => {
    const login = (user, file, db) => spawnSync('docker', ['compose', '-p', s.dbProject, '-f', join(root, 'deploy/postgres/compose.yaml'),
      'exec', '-T', '-e', 'PGPASSWORD', 'db', 'psql', '-X', '-h', '127.0.0.1', '-U', user, '-d', db, '-Atqc', 'select current_user'],
      { env: { ...s.env, PGPASSWORD: readFileSync(join(s.env.HUB_PRIVATE_DIR, file), 'utf8').trim() }, encoding: 'utf8' });
    const ok = login('hindsight_app', 'hindsight-db.password', 'hindsight');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'hindsight_app');
    const toHub = login('hindsight_app', 'hindsight-db.password', 'hub');
    assert.notEqual(toHub.status, 0);
    assert.match(toHub.stderr, /permission denied for database "hub"/);
    const toHs = login('hub_app', 'hub-app.password', 'hindsight');
    assert.notEqual(toHs.status, 0);
    assert.match(toHs.stderr, /permission denied for database "hindsight"/);
  });

  await t.test('memory stack: networks and ports as designed; Hindsight and bank-proxy healthy', () => {
    const cfg = JSON.parse(s.memc('config', '--format', 'json'));
    assert.deepEqual(Object.keys(cfg.services.hindsight.networks).sort(), ['hindsight-db-net', 'memory-net']);
    assert.deepEqual(Object.keys(cfg.services['bank-proxy'].networks).sort(), ['hub-db-net', 'memory-net']);
    assert.equal(cfg.services.hindsight.ports, undefined);
    assert.deepEqual(cfg.services['bank-proxy'].ports.map((p) => [p.host_ip, Number(p.target)]), [['127.0.0.1', 8780]]);
    assert.match(cfg.services.hindsight.image, /@sha256:[0-9a-f]{64}$/);
    s.memc('build', 'bank-proxy');
    s.memc('up', '-d', '--wait', '--wait-timeout', '600', 'hindsight', 'bank-proxy');
  });

  await t.test('operator (internal only): banks + TC-03 fixture retained into group-a, a B-only marker into group-b', () => {
    for (const b of ['group-a', 'group-b']) assert.equal(hindsightRest(s, 'PUT', `/v1/default/banks/${b}`, { name: b }).status, 200);
    const t0 = Date.now();
    const r = hindsightRest(s, 'POST', '/v1/default/banks/group-a/memories', {
      items: [{ content: FIXTURE, document_id: 'mail-tc21-1500', context: 'handoff', metadata: { mail_id: 'tc21' } }], async: false,
    });
    assert.equal(r.status, 200, r.body);
    console.log(`RETAIN group-a: ${Date.now() - t0} ms, usage=${JSON.stringify(r.json.usage)}`);
    const b = hindsightRest(s, 'POST', '/v1/default/banks/group-b/memories', {
      items: [{ content: 'B 組私有：GROUP-B-PRIVATE-MARKER，資料庫決定用 MongoDB。', document_id: 'mail-b-1' }], async: false,
    });
    assert.equal(b.status, 200, b.body);
  });

  const url = (bank) => `${s.base}/mcp/${bank}/`;

  await t.test('TC-21: original text comes back byte-for-byte (sha256) through bank-proxy, still Traditional Chinese', async () => {
    assert.equal(sha(FIXTURE), FIXTURE_SHA);
    const mac = await mcpSession(url('group-a'), TOKENS.mac);
    assert.equal(mac.init.status, 200);
    const doc = JSON.parse(resultText(await mac.call('get_document', { document_id: 'mail-tc21-1500' })));
    assert.equal(sha(doc.original_text), FIXTURE_SHA, 'get_document original_text sha256');
    const win = await mcpSession(url('group-a'), TOKENS.win); // another agent of the same group reads it too
    const rec = JSON.parse(resultText(await win.call('recall', { query: '登入頁 權杖撤銷 交接', include_chunks: true })));
    const chunks = Object.values(rec.chunks ?? {});
    assert.ok(chunks.length >= 1, 'recall returned chunks');
    const chunkText = chunks.filter((c) => (c.document_id ?? 'mail-tc21-1500') === 'mail-tc21-1500').map((c) => c.text ?? c.chunk_text).join('');
    assert.equal(sha(chunkText), FIXTURE_SHA, 'include_chunks text sha256');
    const facts = rec.results.map((x) => x.text);
    const simplified = facts.filter((f) => SIMPLIFIED_ONLY.test(f));
    console.log(`FACTS=${facts.length} simplified_like=${simplified.length} (informational, not a pass condition)`);
  });

  await t.test('isolation: other bank 403, multi-bank / REST 403, bank_id argument refused, write tools refused', async () => {
    const hdr = { authorization: `Bearer ${TOKENS.mac}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const path of ['/mcp/group-b/', '/mcp/', '/v1/default/banks', '/metrics']) {
      assert.equal((await fetch(`${s.base}${path}`, { method: 'POST', headers: hdr, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status, 403, path);
    }
    const bob = await mcpSession(url('group-a'), TOKENS.other);
    assert.equal(bob.init.status, 401);
    const mac = await mcpSession(url('group-a'), TOKENS.mac);
    const cross = await mac.call('get_document', { document_id: 'mail-b-1', bank_id: 'group-b' });
    assert.equal(cross.status, 403);
    const rec = await mac.call('recall', { query: 'MongoDB GROUP-B-PRIVATE-MARKER', bank_id: 'group-b' });
    assert.equal(rec.status, 403);
    for (const name of ['retain', 'sync_retain', 'reflect', 'delete_bank', 'clear_memories', 'update_bank', 'delete_document']) {
      assert.equal((await mac.call(name, {})).body.error.data.reason, 'TOOL_NOT_ALLOWED', name);
    }
    assert.ok(hindsightRest(s, 'GET', '/v1/default/banks/group-a/documents/mail-tc21-1500').json.original_text, 'document still there');
  });

  await t.test('revocation in the DB cuts an open MCP session on the next request; no token / master key → 401', async () => {
    const win = await mcpSession(url('group-a'), TOKENS.win);
    assert.equal((await win.call('list_memories', {})).status, 200);
    s.sql("update public.devices set status='revocation_pending', revocation_requested_at=now() where token_id='tok_fakewin01'");
    assert.equal((await win.call('list_memories', {})).status, 401);
    assert.equal((await mcpSession(url('group-a'), null)).init.status, 401);
    assert.equal((await mcpSession(url('group-a'), s.secrets.tenant)).init.status, 401);
  });

  await t.test('backup: ops/postgres dump hindsight produces a restorable archive (ops/backup HUB_HINDSIGHT_BACKUP)', () => {
    const dump = s.run('bash', [join(root, 'ops/postgres'), 'dump', 'hindsight'], { encoding: 'buffer' });
    assert.ok(dump.length > 10_000, `dump size ${dump.length}`);
    const list = s.run('bash', [join(root, 'ops/postgres'), 'verify-dump'], { input: dump });
    assert.match(list, /TABLE DATA public documents/);
  });

  await t.test('resources: no OOM; Postgres stays inside 512 MiB; connections within budget', () => {
    const conns = s.sql("select usename || '=' || count(*) from pg_stat_activity where usename is not null group by usename order by 1");
    console.log(`PG_CONNECTIONS ${conns.replace(/\n/g, ' ')}`);
    const hs = Number(s.sql("select count(*) from pg_stat_activity where usename='hindsight_app'"));
    assert.ok(hs <= 12, `hindsight_app connections ${hs} ≤ role limit 12`);
    for (const [proj, file, svc] of [[s.dbProject, 'deploy/postgres/compose.yaml', 'db'], [s.memProject, 'deploy/memory/compose.yaml', 'hindsight'], [s.memProject, 'deploy/memory/compose.yaml', 'bank-proxy']]) {
      const cid = spawnSync('docker', ['compose', '-p', proj, '-f', join(root, file), 'ps', '-q', svc], { env: s.env, encoding: 'utf8' }).stdout.trim();
      const st = JSON.parse(spawnSync('docker', ['inspect', cid], { encoding: 'utf8' }).stdout)[0].State;
      assert.equal(st.OOMKilled, false, `${svc} OOMKilled`);
      assert.equal(st.Status, 'running', svc);
    }
    sampling = false;
  });

  await sampler;
  const summary = Object.entries(peaks).map(([k, v]) => `${k}=${v.toFixed(0)}MiB`).join(' ');
  console.log(`PEAK_MEMORY ${summary}`);
  if (process.env.L02_EVIDENCE) writeFileSync(process.env.L02_EVIDENCE, `${new Date().toISOString()} PEAK_MEMORY ${summary}\n`, { flag: 'a' });
  assert.ok((peaks['db-1'] ?? 0) < 512, 'Postgres peak below its 512 MiB limit');
});
