// Integration: real Postgres (L-01 pgvector:pg18 digest, every supabase migration, hub_app →
// service_role) and the real local Agent Mail binary. Skips — never fakes a pass — when Docker
// or the Mail binary is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { createPgStore } from '../../src/store-pg.mjs';
import { createBridge, createMailReader } from '../../src/bridge.mjs';
import { createDelivery } from '../../src/deliver.mjs';
import { storeContract } from '../helpers/store-contract.mjs';
import { createFakeDiscord, OWNER_DISCORD } from '../helpers/fakes.mjs';
import { createMailClient } from '../../../client/mail-client.mjs';
import { startLocalMail, mailBinAvailable } from '../../../client/test/helpers/local-mail-server.mjs';

const root = resolve(import.meta.dirname, '../../..');
const IMAGE = 'pgvector/pgvector:pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782';
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const skipPg = !dockerOk && 'docker not available';
const name = `l03-pg-${process.pid}`;
const appPassword = randomBytes(32).toString('hex');
let port;
let admin;
let dbSeq = 0;

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const psql = (db, sqlText) => execFileSync('docker', ['exec', '-i', name, 'psql', '-X', '-q', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1'], { input: sqlText, encoding: 'utf8' });
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  if (skipPg) return;
  port = await freePort();
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  docker('run', '-d', '--rm', '--name', name, '--platform', platform, '-e', `POSTGRES_PASSWORD=${randomBytes(16).toString('hex')}`, '-p', `127.0.0.1:${port}:5432`, IMAGE);
  for (let i = 0; ; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) break;
    if (i > 120) throw new Error('postgres did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
  psql('postgres', 'create database hub_template;');
  for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) psql('hub_template', readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
  psql('hub_template', readFileSync(join(root, 'supabase/seed.sql'), 'utf8'));
  psql('postgres', `create role hub_app login noinherit password '${appPassword}'; grant service_role to hub_app; alter role hub_app set role = 'service_role';`);
});

after(() => {
  if (!skipPg) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
});

/** Fresh database per test, cloned from the migrated+seeded template, used as hub_app. */
async function freshStore() {
  const db = `hub_t${++dbSeq}`;
  psql('postgres', `create database ${db} template hub_template; revoke connect on database ${db} from public; grant connect on database ${db} to hub_app;`);
  // The seed's devices carry allowed_agents {BlueLake} / {RedStone} — exactly what the contract expects.
  const pool = new pg.Pool({ host: '127.0.0.1', port, database: db, user: 'hub_app', password: appPassword, max: 5 });
  after(() => pool.end());
  return { store: createPgStore({ pool }), pool, db };
}

storeContract((n, fn) => test(`pg: ${n}`, { skip: skipPg }, fn), async () => (await freshStore()).store);

test('pg: connects as hub_app with role service_role; anon cannot read the new tables', { skip: skipPg }, async () => {
  const { pool, db } = await freshStore();
  const r = await pool.query('select session_user, current_user');
  assert.deepEqual(r.rows[0], { session_user: 'hub_app', current_user: 'service_role' });
  assert.equal(execFileSync('docker', ['exec', name, 'psql', '-X', '-Atq', '-U', 'postgres', '-d', db, '-c', `select has_table_privilege('anon','discord_notifications','SELECT'), has_table_privilege('authenticated','assistant_budget','SELECT'), count(*) filter (where relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relkind='r'`], { encoding: 'utf8' }).trim(), 'f|f|13');
});

test('pg: 20 concurrent reservations never exceed the cap (atomic E-QUOTA check)', { skip: skipPg }, async () => {
  const { store } = await freshStore();
  const results = await Promise.all(Array.from({ length: 20 }, () => store.reserveBudget({ groupId: 'group-a', day: '2026-11-20', estimateUsd: 0.05, capUsd: 0.5 })));
  assert.equal(results.filter(Boolean).length, 10);
  const b = await store.budgetRow('group-a', '2026-11-20');
  assert.ok(b.reserved <= 0.5 + 1e-9);
  assert.equal(b.rejected, 10);
});

test('pg: DB enforces summary ≤200 and that a revoked token cannot come back', { skip: skipPg }, async () => {
  const { store, pool } = await freshStore();
  await assert.rejects(store.commitIngest({ agentName: 'RedStone', groupId: 'group-a', cursor: 1, rows: [{ groupId: 'group-a', memberId: '00000000-0000-4000-8000-0000000000a1', mailId: 1, recipientAgent: 'RedStone', label: 'x', sender: 'x', subject: '', summary: 'x'.repeat(201), mailCreatedAt: '2026-11-20T00:00:00Z', state: 'pending' }] }), /check/);
  assert.equal(await store.getCursor('RedStone'), null, 'failed ingest did not move the cursor');
  assert.equal(await store.requestRevocation({ tokenId: 'tok_fakewin01', memberId: '00000000-0000-4000-8000-0000000000a1', actorId: 'x', reason: 'r', requestId: '1' }), true);
  await store.completeRevocation({ tokenId: 'tok_fakewin01', actorId: 'bot', requestId: '2', configRevision: 1 });
  await assert.rejects(pool.query(`update devices set status = 'active', revoked_at = null where token_id = 'tok_fakewin01'`), /cannot be reactivated/);
  await assert.rejects(pool.query('update audit_log set action = $1', ['x']), /permission denied|append-only/);
});

const skipMail = (skipPg || !(await mailBinAvailable())) && 'docker or mcp-agent-mail binary not available';

test('TC-18 end-to-end: real Mail + real Postgres → one DM; unknown recipient → nothing', { skip: skipMail, timeout: 60_000 }, async () => {
  const { store } = await freshStore();
  const hub = await startLocalMail();
  after(() => hub.stop());
  const P = '/data/projects/group-a';
  async function boot(agent) {
    const op = createMailClient({ url: hub.url, token: hub.token, projectKey: P, agentName: agent });
    await op.callTool('ensure_project', { human_key: P });
    const reg = await op.callTool('register_agent', { project_key: P, name: agent, program: 'l03-it', model: 'none' });
    await op.callTool('set_contact_policy', { project_key: P, agent_name: agent, policy: 'open' });
    return createMailClient({ url: hub.url, token: hub.token, projectKey: P, agentName: agent, senderToken: reg.registration_token });
  }
  const mac = await boot('BlueLake');
  await boot('RedStone');
  // The bot reads with the backend credential only; its session name is not a registered agent.
  const reader = createMailReader({ client: createMailClient({ url: hub.url, token: hub.token, projectKey: P, agentName: 'HubBot' }), projectKey: P });
  const discord = createFakeDiscord();
  const clock = { nowMs: () => Date.now() };
  const bridge = createBridge({ mail: reader, store, clock });
  const delivery = createDelivery({ store, discord, clock });
  await bridge.tick(); // start at tail

  const sent = await mac.sendItem({ to: ['RedStone'], subject: 'TC-18 交接', kind: 'handoff', intent: 'question', sourceSession: 's', summary: 'TC18 Mac→Windows', text: '全文不應出現在通知', links: [], unfinished: [] });
  await assert.rejects(mac.sendItem({ to: ['NoSuchAgent'], subject: 'x', kind: 'handoff', intent: 'question', sourceSession: 's', summary: '不該通知', text: 't', links: [], unfinished: [] }));
  await bridge.tick();
  await delivery.tick();
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0].userId, OWNER_DISCORD);
  assert.match(discord.sent[0].content, new RegExp(`Mail #${sent.messageId}`));
  assert.match(discord.sent[0].content, /TC18 Mac→Windows/);
  assert.ok(!discord.sent[0].content.includes('全文不應出現在通知'));
  assert.ok(!discord.sent.some((d) => d.content.includes('不該通知')));
  // Peek only: the recipient still sees it as unread at its next session start.
  const inbox = await reader.fetchEvents({ agentName: 'RedStone', limit: 10 });
  assert.ok(inbox.events.some((e) => e.message_id === sent.messageId));
});
