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
import { createDecisionsManager } from '../../src/decisions.mjs';
import { createBridge, createMailReader } from '../../src/bridge.mjs';
import { createDelivery } from '../../src/deliver.mjs';
import { storeContract } from '../helpers/store-contract.mjs';
import { createFakeDiscord, OWNER_DISCORD, fakeButtonInteraction } from '../helpers/fakes.mjs';
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
  assert.equal(execFileSync('docker', ['exec', name, 'psql', '-X', '-Atq', '-U', 'postgres', '-d', db, '-c', `select has_table_privilege('anon','discord_notifications','SELECT'), has_table_privilege('authenticated','assistant_budget','SELECT'), count(*) filter (where relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relkind='r'`], { encoding: 'utf8' }).trim(), 'f|f|14');
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

test('L08: service_role store isolates foreign members, notifications, cursors and budget', {skip:skipPg}, async()=>{
 const {pool}=await freshStore();
 const a=createPgStore({pool,groupId:'group-a'}), b=createPgStore({pool,groupId:'group-b'});
 const member='00000000-0000-4000-8000-0000000000b1';
 await pool.query(`insert into groups (id,display_name,project_key,mail_hostname,bank_id) values ('group-b','B','/data/projects/group-b','b.local','group-b');
 insert into members (id,group_id,display_name,role) values ('${member}','group-b','B','owner');
 insert into discord_links(member_id,guild_id,discord_user_id,last_interaction_id) values ('${member}','10000000\x30000000002','20000000\x30000000002','b');
 insert into devices(member_id,group_id,label,platform,token_id,token_prefix,token_hash,allowed_agents) values ('${member}','group-b','B','linux','tok_groupb001','mph_test',repeat('b',64),'{RedStone}');`);
 assert.equal(await a.findMemberByDiscord('10000000\x30000000002','20000000\x30000000002'),null);
 await b.commitIngest({groupId:'group-b',agentName:'RedStone',cursor:99,rows:[{groupId:'group-b',memberId:member,mailId:9,recipientAgent:'RedStone',label:'x',sender:'x',subject:'private',summary:'private',mailCreatedAt:'2026-11-20T00:00:00Z',state:'pending'}]});
 assert.deepEqual(await a.listPending(member),[]);assert.deepEqual(await a.membersWithWork(),[]);
 assert.equal(await a.getCursor('RedStone'),null);
 await a.commitIngest({groupId:'group-a',agentName:'RedStone',cursor:1,rows:[]});
 assert.equal(await b.getCursor('RedStone'),99);
 const foreign=(await b.listPending(member))[0];
 await a.markNotification(foreign.id,'sent');assert.equal((await b.listPending(member)).length,1);
 assert.equal(await a.requestRevocation({tokenId:'tok_groupb001',memberId:member,actorId:'test',reason:'test',requestId:'deny'}),false);
 await assert.rejects(a.issueDevice({groupId:'group-b',memberId:member}),/group/i);
 await assert.rejects(a.reserveBudget({groupId:'group-b',day:'2026-11-20',estimateUsd:0.1,capUsd:0.5}),/group/i);
 assert.ok((await a.watchedAgents()).every(x=>x.groupId==='group-a'));
});

test('L08 + L05: decision queries and mutations stay in their bound group', {skip:skipPg}, async()=>{
 const {pool}=await freshStore();
 await pool.query(`insert into groups(id,display_name,project_key,mail_hostname) values ('grp-test2','B','/data/projects/grp-test2','b.local');
 insert into members(id,group_id,display_name,role) values ('00000000-0000-4000-8000-0000000000b1','grp-test2','B','owner');`);
 const a=createPgStore({pool,groupId:'group-a'}),b=createPgStore({pool,groupId:'grp-test2'});
 await b.recordDecisionDraft({groupId:'grp-test2',draftMailId:201,draftId:'dec_private',authorAgent:'B',text:'private',createdAt:'2026-01-01T00:00:00Z'});
 assert.equal(await a.getDecisionByMailId(201),null);
 assert.equal(await a.getDecisionByDraftId('dec_private'),null);assert.equal(await a.getDecisionByDraftId('201'),null);
 assert.deepEqual(await a.listDecisions('grp-test2'),[]);assert.deepEqual(await a.listDecisions('grp-test2',{status:'draft'}),[]);
 assert.deepEqual(await a.listDueDraftReminders(Date.parse('2026-11-20T00:00:00Z')),[]);
 assert.equal(await a.markDraftReminderSent(201),null);
 const update={draftMailId:201,status:'confirmed',memberId:'00000000-0000-4000-8000-0000000000a1',discordUserId:'test',memberName:'A'};
 assert.equal(await a.updateDecisionStatus(update),null);
 assert.equal(await b.updateDecisionStatus(update),null,'foreign confirmer cannot change own draft');
 assert.equal((await b.getDecisionByMailId(201)).status,'draft');assert.equal((await b.getDecisionByMailId(201)).reminder_sent,false);
 await assert.rejects(a.recordDecisionDraft({groupId:'grp-test2',draftMailId:202,authorAgent:'A'}),/Group boundary/);
 await b.recordDecisionDraft({groupId:'grp-test2',draftMailId:1,authorAgent:'B'});
 await a.recordDecisionDraft({groupId:'group-a',draftMailId:1,authorAgent:'A',createdAt:'2026-01-01T00:00:00Z'});
 assert.equal((await a.getDecisionByMailId(1)).author_agent,'A');assert.equal((await b.getDecisionByMailId(1)).author_agent,'B');
 await a.commitIngest({groupId:'group-a',agentName:'RedStone',cursor:1,rows:[{groupId:'group-a',memberId:'00000000-0000-4000-8000-0000000000a1',mailId:1,recipientAgent:'RedStone',label:'決策',sender:'A',subject:'A',summary:'A',mailCreatedAt:'2026-11-20T00:00:00Z',state:'pending'}]});
 await b.updateDecisionStatus({...update,draftMailId:1,memberId:'00000000-0000-4000-8000-0000000000b1'});
 assert.equal((await a.recentItems('group-a',10))[0].decision_status,'草稿','foreign status must not join onto own mail ID');
 const decisions=createDecisionsManager({store:a,discord:createFakeDiscord(),clock:{nowMs:()=>Date.now()},defaultGuildId:'10000000\x30000000001'});
 const foreignButton=fakeButtonInteraction('decision:confirm:201');await decisions.handleButton(foreignButton);
 assert.ok(foreignButton.log.some(x=>/找不到/.test(x.content)));assert.equal((await b.getDecisionByMailId(201)).status,'draft');
 const strangerButton=fakeButtonInteraction('decision:confirm:1',{userId:'20000000\x30000000099'});await decisions.handleButton(strangerButton);
 assert.ok(strangerButton.log.some(x=>/沒有.*權限/.test(x.content)));
 const confirmButton=fakeButtonInteraction('decision:confirm:1');await decisions.handleButton(confirmButton);
 assert.equal((await a.getDecisionByMailId(1)).status,'confirmed');
 assert.ok(confirmButton.log.some(x=>/已確認決策草稿/.test(x.content)));
 const duplicateButton=fakeButtonInteraction('decision:confirm:1');await decisions.handleButton(duplicateButton);
 assert.ok(duplicateButton.log.some(x=>/只能使用一次/.test(x.content)));
 await a.recordDecisionDraft({groupId:'group-a',draftMailId:202,authorAgent:'A'});
 const rejectButton=fakeButtonInteraction('decision:reject:202');await decisions.handleButton(rejectButton);
 assert.equal((await a.getDecisionByMailId(202)).status,'rejected');
 assert.equal(await a.updateDecisionStatus({...update,draftMailId:1}),null,'buttons remain single use');
 await a.audit({groupId:null,actorType:'member',actorId:'stranger',action:'discord.decision.denied'});
 assert.equal((await pool.query("select group_id from audit_log where actor_id='stranger'")).rows[0].group_id,'group-a');
});
