// Unit tests for hub-hook.mjs (H-04). Seam: runHook(mode, { input, env, deps }) → { stdout, stderr, exitCode }.
// The Hub is an in-memory fake with the mail-client interface; time is a FakeClock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../hub-hook.mjs';
import { createFakeHub } from './helpers/fake-hub.mjs';
import { FakeClock } from './helpers/fakes.mjs';

const CONFIG = {
  v: 1, group_id: 'group-a', project_key: '/data/projects/group-a', hub_mail_url: 'https://hub.example/mcp/',
  agents: { darwin: 'BlueLake', win32: 'RedStone' }, peers: ['BlueLake', 'RedStone'], clock_agent: 'JadeBluff',
  recent_handoffs: 5, poll_seconds: 15,
};

/** One machine: its project dir (with hub-client.json), its local data dir, and deps wired to the fake hub. */
function machine(hub, { agent = 'RedStone', clock = new FakeClock(Date.parse('2026-11-18T01:00:00Z')), alive = () => true, revision = () => 'rev-0' } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'hubhook-proj-'));
  writeFileSync(join(projectDir, 'hub-client.json'), JSON.stringify(CONFIG));
  const dataDir = mkdtempSync(join(tmpdir(), 'hubhook-data-'));
  const env = { HUB_TOKEN: 'test-device-token', HUB_SENDER_TOKEN: 'test-sender', HUB_AGENT: agent, HUB_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: projectDir };
  const proc = { pid: 4242, ppid: 777 };
  const deps = {
    clock,
    createClient: (opts) => { assert.equal(opts.agentName, agent); return hub.client(agent); },
    ppid: () => proc.ppid,
    pid: proc.pid,
    isAlive: (pid) => alive(pid),
    workRevision: () => revision(),
  };
  const run = (mode, input = {}, extra = {}) => runHook(mode, { input: { session_id: 'sess-1', ...input }, env, deps: { ...deps, ...extra }, args: extra.args ?? [] });
  return { run, env, deps, dataDir, projectDir, clock, proc };
}

const handoff = (over = {}) => ({
  to: ['RedStone'], subject: 'TC02 交接', kind: 'handoff', intent: 'action', sourceSession: 'mac-1',
  summary: '登入頁 Figma 已完成，下一步 /login，截止 11/20',
  text: 'TC02 交接：登入頁 Figma 已完成，下一步實作 /login 路由，截止 11/20。PR：https://github.com/o/r/pull/1',
  links: ['https://github.com/o/r/pull/1'], unfinished: ['/login 路由'], ...over,
});

const ctx = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test('start: an unread handoff is shown verbatim with its ID before the first instruction', async () => {
  const hub = createFakeHub();
  const sent = await hub.send('BlueLake', handoff());
  const win = machine(hub);
  const r = await win.run('start', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  const c = ctx(r);
  assert.match(c, new RegExp(`#${sent.messageId}\\b`));
  assert.ok(c.includes(handoff().text), 'original text verbatim');
  assert.ok(c.includes('https://github.com/o/r/pull/1'));
});

/** Runs a long-lived mode (watch) on the FakeClock, advancing time until it settles. */
async function drive(promise, clock, { stepMs = 500, maxMs = 4 * 3600_000 } = {}) {
  let settled = false, value;
  promise.then((v) => { settled = true; value = v; });
  for (let t = 0; !settled && t <= maxMs; t += stepMs) await clock.advance(stepMs);
  assert.ok(settled, 'mode did not finish');
  return value;
}

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { MailError } from '../mail-client.mjs';
import { DEFAULTS } from '../hub-hook.mjs';
const outbox = (m) => (existsSync(join(m.dataDir, 'outbox')) ? readdirSync(join(m.dataDir, 'outbox')) : []);

// ---- start (FR-09, FR-10, AC-03.x, TC-02, TC-04) ----

test('start: with no unread it says so explicitly and still lists recent handoffs (AC-03.2)', async () => {
  const hub = createFakeHub();
  await hub.send('RedStone', handoff({ to: ['BlueLake'], subject: '別人的交接' }));
  const c = ctx(await machine(hub).run('start'));
  assert.match(c, /沒有給你的新項目/);
  assert.match(c, /最近 5 則交接/);
  assert.match(c, /別人的交接/);
});

test('start: Hub unreachable says it cannot fetch, never "no new items" (AC-03.4, TC-04)', async () => {
  const hub = createFakeHub();
  hub.down();
  const c = ctx(await machine(hub).run('start'));
  assert.match(c, /無法取得交接與專案現況/);
  assert.doesNotMatch(c, /沒有給你的新項目/);
});

test('start: missing HUB_TOKEN is reported as "cannot fetch", not as an empty inbox', async () => {
  const hub = createFakeHub();
  const m = machine(hub);
  delete m.env.HUB_TOKEN;
  const c = ctx(await m.run('start'));
  assert.match(c, /HUB_TOKEN/);
  assert.match(c, /無法取得交接與專案現況/);
  assert.doesNotMatch(c, /沒有給你的新項目/);
});

test('start: unread items are listed oldest first', async () => {
  const hub = createFakeHub();
  const a = await hub.send('BlueLake', handoff({ subject: '第一則' }));
  const b = await hub.send('BlueLake', handoff({ subject: '第二則', kind: 'help' }));
  const c = ctx(await machine(hub).run('start'));
  assert.ok(c.indexOf(`#${a.messageId}｜`) < c.indexOf(`#${b.messageId}｜`));
});

test('start: an item shown in full is read afterwards — not new in the next session, and marked read on the Hub (AC-03.3)', async () => {
  const hub = createFakeHub();
  const sent = await hub.send('BlueLake', handoff());
  const win = machine(hub);
  await win.run('start', { session_id: 's-a' });
  assert.deepEqual(hub.readsOf('RedStone'), [sent.messageId]);
  const again = ctx(await win.run('start', { session_id: 's-b' }));
  assert.match(again, /沒有給你的新項目/);
  assert.match(again, new RegExp(`#${sent.messageId}｜`), 'still visible in recent handoffs');
});

test('start: recent handoffs are the newest N=5, newest first', async () => {
  const hub = createFakeHub();
  for (let i = 1; i <= 7; i++) await hub.send('BlueLake', handoff({ to: ['RedStone'], subject: `交接${i}` }));
  const c = ctx(await machine(hub).run('start'));
  const section = c.slice(c.indexOf('專案現況'));
  const order = [...section.matchAll(/交接(\d)/g)].map((x) => Number(x[1]));
  assert.deepEqual(order, [7, 6, 5, 4, 3]);
});

test('start: an over-long original is clipped, stays unread, and points to `read`', async () => {
  const hub = createFakeHub();
  const sent = await hub.send('BlueLake', handoff({ text: '長'.repeat(DEFAULTS.fullTextLimit + 10) }));
  const win = machine(hub);
  const c = ctx(await win.run('start'));
  assert.match(c, new RegExp(`hub-hook.mjs read ${sent.messageId}`));
  assert.deepEqual(hub.readsOf('RedStone'), []);
  assert.match((await win.run('inbox')).stdout, new RegExp(`#${sent.messageId}｜`));
});

test('start: after a kill -9 session it says so, names the last saved checkpoint, and reports session.closed (CLI-03)', async () => {
  const hub = createFakeHub();
  const dead = new Set([999]);
  const mac = machine(hub, { agent: 'BlueLake', alive: (pid) => !dead.has(pid), revision: () => 'rev-1' });
  mac.proc.ppid = 999; // the Claude process of the first session
  await mac.run('start', { session_id: 's-old' });
  const cp = await mac.run('checkpoint', { summary: '做了登入頁', text: '登入頁完成，/login 未做', unfinished: ['/login'] });
  const id = Number(cp.stdout.match(/#(\d+)/)[1]);
  // Claude is SIGKILLed: no `end`. A new session starts under a new Claude process.
  mac.proc.ppid = 1001;
  const c = ctx(await mac.run('start', { session_id: 's-new' }));
  assert.match(c, /上次 session 未正常交接（s-old/);
  assert.match(c, new RegExp(`上次已保存交接 #${id}`));
  const closed = hub.inboxOf('JadeBluff');
  assert.equal(closed.length, 1);
  assert.deepEqual(
    (({ event_type, recipient_session, agent, reason }) => ({ event_type, recipient_session, agent, reason }))(JSON.parse(closed[0].body_md)),
    { event_type: 'session.closed', recipient_session: 's-old', agent: 'BlueLake', reason: 'crashed' });
});

test('start: a crashed session with no checkpoint is reported without inventing a summary', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake', alive: () => false });
  await mac.run('start', { session_id: 's-old' });
  const c = ctx(await mac.run('start', { session_id: 's-new' }));
  assert.match(c, /上次沒有已保存的交接；不補寫/);
  assert.equal(hub.inboxOf('RedStone').length, 0);
});

test('start: another session of this agent that is still running is not called crashed', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake', alive: () => true });
  await mac.run('start', { session_id: 's-1' });
  const c = ctx(await mac.run('start', { session_id: 's-2' }));
  assert.doesNotMatch(c, /未正常交接/);
});

// ---- watch (CLI-02, F-09) ----

test('watch: a new message wakes Claude with a short notice (ID + summary + how to read), not the full text', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  const p = win.run('watch');
  await win.clock.advance(1000);
  const sent = await hub.send('BlueLake', handoff({ intent: 'question', kind: 'help' }));
  const r = await drive(p, win.clock);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, new RegExp(`Hub 新訊息 #${sent.messageId}（不是錯誤）`));
  assert.match(r.stderr, /help\/question/);
  assert.match(r.stderr, new RegExp(`hub-hook.mjs read ${sent.messageId}`));
  assert.ok(!r.stderr.includes('PR：https://github.com/o/r/pull/1'), 'full text stays in staging');
  assert.ok(r.stderr.split('\n').length === 1);
});

test('watch: polls every 15 s, so a message is seen within one poll interval', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  const t0 = win.clock.now();
  const p = win.run('watch');
  await win.clock.advance(20_000);
  await hub.send('BlueLake', handoff());
  const sentAt = win.clock.now();
  const r = await drive(p, win.clock, { stepMs: 250 });
  assert.equal(r.exitCode, 2);
  const lag = win.clock.now() - sentAt;
  assert.ok(lag <= 15_000, `detected ${lag} ms after send`);
  assert.ok(win.clock.now() - t0 >= 30_000 - 1);
});

test('watch: a message already announced in this session does not wake it again', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  await hub.send('BlueLake', handoff());
  const first = await drive(win.run('watch'), win.clock);
  assert.equal(first.exitCode, 2);
  const second = await drive(win.run('watch', {}, { watchMaxMs: 60_000 }), win.clock);
  assert.match(second.stderr, /例行重新掛載/);
  assert.doesNotMatch(second.stderr, /Hub 新訊息/);
});

test('watch: only one watcher per session — a second one exits 0 at once while the first is alive', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  const first = win.run('watch');
  await win.clock.advance(1000);
  const second = await win.run('watch', {}, { pid: 5555 });
  assert.equal(second.exitCode, 0);
  assert.equal(second.stderr, '');
  await hub.send('BlueLake', handoff());
  assert.equal((await drive(first, win.clock)).exitCode, 2);
});

test('watch: when its Claude process is gone it exits 0 without reading the Hub (F-09 orphan fix)', async () => {
  const hub = createFakeHub();
  let claudeAlive = true;
  const win = machine(hub, { alive: (pid) => (pid === 777 ? claudeAlive : true) });
  await win.run('start');
  const p = win.run('watch');
  await win.clock.advance(1000);
  claudeAlive = false; // kill -9 of Claude; on POSIX the watcher would also be re-parented
  await hub.send('BlueLake', handoff());
  const callsBefore = hub.calls.length;
  const r = await drive(p, win.clock);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '');
  assert.equal(hub.calls.filter((c) => c.agent === 'RedStone').length, hub.calls.slice(0, callsBefore).filter((c) => c.agent === 'RedStone').length, 'no Hub calls after orphaning');
  assert.match((await win.run('inbox')).stdout, /#1｜/, 'message is left for the next session');
});

test('watch: re-parenting alone (ppid changed) also counts as orphaned', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  const p = win.run('watch');
  await win.clock.advance(1000);
  win.proc.ppid = 1;
  assert.equal((await drive(p, win.clock)).exitCode, 0);
});

test('watch: expires itself after 55 min with a re-arm notice — before the 3600 s hook timeout in the template', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  const t0 = win.clock.now();
  const r = await drive(win.run('watch'), win.clock, { stepMs: 5_000 });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /例行重新掛載/);
  const elapsed = win.clock.now() - t0;
  assert.ok(elapsed >= 55 * 60_000 && elapsed < 56 * 60_000, `expired after ${elapsed} ms`);
  const tpl = JSON.parse(readFileSync(new URL('../templates/claude-settings.json', import.meta.url), 'utf8'));
  const watchTimeouts = Object.values(tpl.hooks).flatMap((g) => g.flatMap((x) => x.hooks)).filter((h) => h.args?.includes('watch'));
  assert.equal(watchTimeouts.length, 2);
  for (const h of watchTimeouts) {
    assert.equal(h.asyncRewake, true);
    assert.ok(DEFAULTS.watchMaxMs + DEFAULTS.pollMs + 10_000 < h.timeout * 1000, 'self-expiry (+ one poll) must beat the hook timeout');
  }
});

test('watch: a revoked token wakes Claude once, then later watchers stay quiet instead of looping', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  hub.down(new MailError('E-AUTH', '連線未授權或已撤銷', { reason: 'unauthorized' }));
  const r = await drive(win.run('watch'), win.clock);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /授權失敗/);
  const again = await drive(win.run('watch'), win.clock);
  assert.equal(again.exitCode, 0);
});

test('watch: an unreachable Hub wakes Claude once after ~1 min and keeps retrying, then delivers when it is back', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  hub.down();
  const r = await drive(win.run('watch'), win.clock);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /暫時連不上/);
  const p = win.run('watch');
  await win.clock.advance(5 * 60_000);
  hub.up();
  await hub.send('BlueLake', handoff());
  const back = await drive(p, win.clock);
  assert.match(back.stderr, /Hub 新訊息 #1/);
});

// ---- checkpoint / send / stop (CLI-03, FR-08, AC-02.4, AC-04.x) ----

test('checkpoint: saves a handoff to the peer agent, marked as written by the agent, and says "已保存 #ID"', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake' });
  await mac.run('start');
  const r = await mac.run('checkpoint', { summary: '登入頁完成', text: '細節……', links: ['https://github.com/o/r/pull/2'], unfinished: ['/login'] });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /^已保存 #1（交接給 RedStone）/);
  const [m] = hub.inboxOf('RedStone');
  assert.match(m.subject, /^agent 自動交接：/);
  const env = JSON.parse(m.body_md);
  assert.equal(env.source_session, 'sess-1');
  assert.equal(env.kind, 'handoff');
});

test('checkpoint while the Hub is down says "未送達", keeps it, and a later stop resends it exactly once (AC-02.4, AC-04.2)', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake' });
  await mac.run('start');
  hub.down();
  const r = await mac.run('checkpoint', { summary: 's', text: 't' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /未送達/);
  assert.equal(outbox(mac).length, 1);
  hub.up();
  const stop = await mac.run('stop', { stop_hook_active: false });
  assert.match(JSON.parse(stop.stdout).systemMessage, /已補送.*已保存 #1/);
  await mac.run('stop', {});
  assert.equal(hub.inboxOf('RedStone').length, 1);
  assert.equal(outbox(mac).length, 0);
});

test('a timed-out send stays "保存結果未確認" and the resend reuses the same key, so the Hub keeps one message', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake' });
  await mac.run('start');
  const first = hub.client('BlueLake');
  // The Hub stores it but the reply is lost.
  hub.failNext(new MailError('E-HUB', 'timeout', { reason: 'timeout', delivery: 'unconfirmed', retryable: true }));
  const r = await mac.run('send', { to: ['RedStone'], subject: 'q', kind: 'help', intent: 'question', summary: 's', text: 't' });
  assert.match(r.stderr, /保存結果未確認/);
  const key = JSON.parse(readFileSync(join(mac.dataDir, 'outbox', outbox(mac)[0]), 'utf8')).key;
  await first.sendItem({ ...JSON.parse(readFileSync(join(mac.dataDir, 'outbox', outbox(mac)[0]), 'utf8')).item }); // what the Hub had actually stored
  await mac.run('stop', {});
  assert.equal(hub.inboxOf('RedStone').length, 1);
  assert.equal(JSON.parse(hub.messages[0].body_md).client_event_id, key);
});

test('send: an unknown recipient or a secret is rejected locally and nothing is queued', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake' });
  await mac.run('start');
  const r1 = await mac.run('send', { to: ['win-claud'], subject: 'x', summary: 's', text: 't' });
  assert.match(r1.stderr, /^未寫入/);
  const r2 = await mac.run('send', { to: ['RedStone'], subject: 'x', summary: 's', text: 'key sk-ab\x63defghijklmnopqrstuvwxyz123456' });
  assert.match(r2.stderr, /^未寫入/);
  assert.equal(outbox(mac).length, 0);
  assert.equal(hub.messages.length, 0);
});

test('stop: work changed without a checkpoint → asks once; not again for the same state or when stop_hook_active', async () => {
  const hub = createFakeHub();
  let rev = 'rev-0';
  const mac = machine(hub, { agent: 'BlueLake', revision: () => rev });
  await mac.run('start');
  assert.equal((await mac.run('stop', {})).stdout, '', 'no change yet');
  rev = 'rev-1';
  assert.equal(JSON.parse((await mac.run('stop', { stop_hook_active: true })).stdout || '{}').decision, undefined);
  const r = await mac.run('stop', {});
  assert.equal(JSON.parse(r.stdout).decision, 'block');
  assert.match(JSON.parse(r.stdout).reason, /checkpoint/);
  assert.equal((await mac.run('stop', {})).stdout, '', 'same state: no second block');
});

test('stop: no block after a checkpoint covers the current work, and none for a mail-only wake turn', async () => {
  const hub = createFakeHub();
  let rev = 'rev-0';
  const mac = machine(hub, { agent: 'BlueLake', revision: () => rev });
  await mac.run('start');
  rev = 'rev-2';
  await mac.run('checkpoint', { summary: 's', text: 't' });
  assert.equal((await mac.run('stop', {})).stdout, '');
});

// ---- end (CLI-02 end, API-06 session.closed) ----

test('end: reports session.closed to the clock agent, closes the session, and the next start sees a clean exit', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake', alive: () => false });
  await mac.run('start', { session_id: 's-1' });
  const r = await mac.run('end', { session_id: 's-1', reason: 'prompt_input_exit' });
  assert.equal(r.exitCode, 0);
  const [closed] = hub.inboxOf('JadeBluff');
  assert.equal(JSON.parse(closed.body_md).reason, 'prompt_input_exit');
  const c = ctx(await mac.run('start', { session_id: 's-2' }));
  assert.doesNotMatch(c, /未正常交接/);
});

test('end: with the Hub down, session.closed waits in the journal and the next start resends and reports it', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake', alive: () => false });
  await mac.run('start', { session_id: 's-1' });
  hub.down();
  const r = await mac.run('end', { session_id: 's-1', reason: 'other' });
  assert.match(r.stderr, /未送出/);
  hub.up();
  const c = ctx(await mac.run('start', { session_id: 's-2' }));
  assert.match(c, /上次有 1 則未送出/);
  assert.match(c, /已補送：session.closed（s-1）/);
  assert.equal(hub.inboxOf('JadeBluff').length, 1);
});

test('end: stops this session\'s watcher', async () => {
  const hub = createFakeHub();
  const killed = [];
  const win = machine(hub);
  await win.run('start');
  const p = win.run('watch');
  await win.clock.advance(1000);
  await win.run('end', { reason: 'other' }, { pid: 9999, kill: (pid) => killed.push(pid) });
  assert.deepEqual(killed, [4242]);
  win.proc.ppid = 1;
  await drive(p, win.clock);
});

// ---- read / inbox (FR-10, FR-13) ----

test('read: prints the original verbatim, marks it read on the Hub, and it leaves the inbox', async () => {
  const hub = createFakeHub();
  const text = '逐字 😀\r\n```js\nx()\n```';
  const sent = await hub.send('BlueLake', handoff({ text }));
  const win = machine(hub);
  await win.run('inbox');
  const r = await win.run('read', {}, { args: [String(sent.messageId)] });
  assert.ok(r.stdout.includes(text.split('\n').join('\n    ')));
  assert.deepEqual(hub.readsOf('RedStone'), [sent.messageId]);
  assert.match((await win.run('inbox')).stdout, /沒有給你的新項目/);
});

// ---- HubClock alignment (H-05: ops/lifecycle/protocol.mjs) ----
import { buildClientControl, clientControlKey } from '../../ops/lifecycle/protocol.mjs';

test('a question or action request CCs the configured HubClock; handoffs and checkpoints do not', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake' });
  await mac.run('start');
  await mac.run('send', { to: ['RedStone'], subject: 'q', kind: 'help', intent: 'question', summary: 's', text: 't' });
  await mac.run('send', { to: ['RedStone'], subject: 'a', kind: 'task', intent: 'action', summary: 's', text: 't' });
  await mac.run('send', { to: ['RedStone'], subject: 'h', kind: 'handoff', summary: 's', text: 't' });
  await mac.run('checkpoint', { summary: 's', text: 't' });
  assert.deepEqual(hub.messages.map((m) => [m.subject, m.cc]), [['q', ['JadeBluff']], ['a', ['JadeBluff']], ['h', []], ['agent 自動交接：s', []]]);
});

test('replyTo answers in the root thread to the asker, and records the answer with an `answer` control (not a CC)', async () => {
  const hub = createFakeHub();
  const q = await hub.send('BlueLake', handoff({ kind: 'help', intent: 'question', subject: 'README 第一行？' }));
  const win = machine(hub);
  await win.run('start');
  const r = await win.run('send', { replyTo: q.messageId, summary: '第一行是標題', text: '# 燈塔專案' });
  assert.equal(r.exitCode, 0, r.stderr);
  const reply = hub.messages.at(-1);
  const replyMsg = hub.messages.find((m) => m.subject === 'Re: README 第一行？');
  assert.deepEqual([replyMsg.to, replyMsg.cc, replyMsg.thread_id], [['BlueLake'], [], q.threadId]);
  assert.deepEqual(JSON.parse(reply.body_md), buildClientControl({ eventType: 'answer', rootMailId: q.messageId, recipientSession: 'sess-1', agent: 'RedStone' }));
  assert.deepEqual(reply.to, ['JadeBluff']);
  // The asker sees it as a reply, not as a new action request.
  const mac = machine(hub, { agent: 'BlueLake' });
  const c = ctx(await mac.run('start'));
  assert.match(c, /這是同一串裡的回覆/);
  assert.doesNotMatch(c, /這是動作請求/);
});

test('presented / choice / session.closed use the exact H-05 control shape and fixed keys', async () => {
  const hub = createFakeHub();
  const req = await hub.send('BlueLake', handoff({ kind: 'task', intent: 'action', subject: '刪除舊分支' }));
  const win = machine(hub, { alive: () => false });
  await win.run('start', { session_id: 's-9' });
  assert.match((await win.run('presented', {}, { args: [String(req.messageId)] })).stdout, /^已保存 #\d+（presented，請求 #1）/);
  assert.match((await win.run('choice', {}, { args: [String(req.messageId), 'approve', '可以'] })).stdout, /choice approve/);
  await win.run('end', { session_id: 's-9', reason: 'prompt_input_exit' });
  const controls = hub.messages.filter((m) => m.topic === 'control');
  const expect = [
    buildClientControl({ eventType: 'presented', rootMailId: 1, recipientSession: 's-9', agent: 'RedStone' }),
    buildClientControl({ eventType: 'choice', rootMailId: 1, recipientSession: 's-9', agent: 'RedStone', choice: 'approve', reason: '可以' }),
    buildClientControl({ eventType: 'session.closed', rootMailId: null, recipientSession: 's-9', agent: 'RedStone', reason: 'prompt_input_exit' }),
  ];
  assert.deepEqual(controls.map((m) => JSON.parse(m.body_md)), expect);
  assert.deepEqual(controls.map((m) => m.to), [['JadeBluff'], ['JadeBluff'], ['JadeBluff']]);
  assert.equal(controls[0].thread_id, req.threadId);
  const keys = controls.map((m) => JSON.parse(m.body_md)).map((c) => clientControlKey({ groupId: 'group-a', eventType: c.event_type, rootMailId: c.root_mail_id, agent: 'RedStone', recipientSession: 's-9' }));
  // Re-sending the same choice replays on the same key (no second record).
  await win.run('choice', {}, { args: [String(req.messageId), 'approve', '可以'] });
  assert.equal(hub.messages.filter((m) => m.topic === 'control').length, 3);
  assert.equal(new Set(keys).size, 3);
});

test('choice is refused before the request is staged locally, and with anything but approve|reject', async () => {
  const hub = createFakeHub();
  const win = machine(hub);
  await win.run('start');
  assert.match((await win.run('choice', {}, { args: ['42', 'approve'] })).stderr, /本機找不到 #42/);
  assert.match((await win.run('choice', {}, { args: ['42', 'yes'] })).stderr, /用法/);
});

test('with clock_agent unset (template placeholder) nothing is sent to a guessed name, and start warns', async () => {
  const hub = createFakeHub();
  const mac = machine(hub, { agent: 'BlueLake', alive: () => false });
  writeFileSync(join(mac.projectDir, 'hub-client.json'), JSON.stringify({ ...CONFIG, clock_agent: '<H-02 bootstrap 產生的 HubClock 名稱>' }));
  const c = ctx(await mac.run('start', { session_id: 's-1' }));
  assert.match(c, /HubClock 名稱未設定/);
  const r = await mac.run('send', { to: ['RedStone'], subject: 'q', kind: 'help', intent: 'question', summary: 's', text: 't' });
  assert.match(r.stdout, /已保存 #1.*HubClock 名稱未設定/);
  await mac.run('end', { session_id: 's-1' });
  assert.deepEqual(hub.messages.map((m) => m.cc), [[]]);
  assert.equal(hub.messages.length, 1);
});

test('the shipped hub-client.json template loads: per-OS agents, N = 5, 15 s polling, clock name left for H-02', async () => {
  const hub = createFakeHub();
  const m = machine(hub);
  writeFileSync(join(m.projectDir, 'hub-client.json'), readFileSync(new URL('../templates/hub-client.json', import.meta.url)));
  const { loadConfig } = await import('../hub-hook.mjs');
  const env = { ...m.env }; delete env.HUB_AGENT;
  const mac = loadConfig({ env, platform: 'darwin' });
  const win = loadConfig({ env, platform: 'win32' });
  assert.deepEqual([mac.agent, win.agent, mac.recentN, mac.pollMs, mac.clockAgent, mac.handoffTo], ['BlueLake', 'RedStone', 5, 15_000, null, ['RedStone']]);
  assert.equal(loadConfig({ env: { ...env, HUB_CLOCK_AGENT: 'JadeBluff' }, platform: 'darwin' }).clockAgent, 'JadeBluff');
});

test('the CLI still runs when hub-hook.mjs is reached through a symlinked client/ folder', async () => {
  const { spawnSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const m = machine(createFakeHub());
  symlinkSync(join(fileURLToPath(new URL('..', import.meta.url))), join(m.projectDir, 'client'));
  const env = { ...process.env, ...m.env, HUB_TOKEN: '' }; // config error path: prints a context without touching the network
  const r = spawnSync(process.execPath, [join(m.projectDir, 'client', 'hub-hook.mjs'), 'start'], { input: '{}', env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /HUB_TOKEN/);
});

test('a handoff is presented as a handoff (information), never as an action request needing presented/choice', async () => {
  const hub = createFakeHub();
  await hub.send('BlueLake', handoff({ intent: 'action' }));
  const c = ctx(await machine(hub).run('start'));
  assert.match(c, /｜交接｜/);
  assert.doesNotMatch(c, /handoff\/action/);
  assert.match(c, /不是動作請求/);
  assert.doesNotMatch(c, /presented 1/);
});

test('send/checkpoint accept the JSON as `--json <json>`, so the command starts with node client/hub-hook.mjs (matches the allow rule; no pipe)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const m = machine(createFakeHub(), { agent: 'BlueLake' });
  const env = { ...process.env, ...m.env, HUB_TOKEN: '' }; // config error stops before any network; we only check parsing
  const hook = fileURLToPath(new URL('../hub-hook.mjs', import.meta.url));
  const ok = spawnSync(process.execPath, [hook, 'send', '--json', '{"to":["RedStone"],"summary":"s","text":"t"}'], { env, encoding: 'utf8', input: '' });
  assert.match(ok.stderr, /HUB_TOKEN/, 'parsed --json and reached config');
  const bad = spawnSync(process.execPath, [hook, 'send', '--json', '{not json'], { env, encoding: 'utf8', input: '' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--json 不是 JSON/);
});

test('a reply to a question is sent before its `answer` control, even when both are queued in the same millisecond', async () => {
  for (let i = 0; i < 20; i++) {
    const hub = createFakeHub();
    const q = await hub.send('BlueLake', handoff({ kind: 'help', intent: 'question' }));
    const win = machine(hub);
    await win.run('start');
    await win.run('send', { replyTo: q.messageId, summary: 'a', text: 'a' });
    assert.deepEqual(hub.messages.slice(1).map((m) => m.topic), ['help', 'control']);
  }
});
