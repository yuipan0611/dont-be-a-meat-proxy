// TC-18 (AC-09.1～09.4) + SRS §4.5 #3／#9 with Discord and Mail doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, renderNotification, escapeDiscord, SUMMARY_MAX } from '../src/notify-format.mjs';
import { createBridge } from '../src/bridge.mjs';
import { createDelivery } from '../src/deliver.mjs';
import { createMemoryStore } from './helpers/store-memory.mjs';
import { createFakeMail, createFakeDiscord, FakeClock, seed, itemBody, OWNER_DISCORD, 維護者 } from './helpers/fakes.mjs';

function rig({ presenceEnabled = false } = {}) {
  const clock = new FakeClock();
  const mail = createFakeMail();
  const store = createMemoryStore(seed());
  const discord = createFakeDiscord();
  const bridge = createBridge({ mail, store, clock });
  const delivery = createDelivery({ store, discord, clock, presenceEnabled, digestRetryMs: 0 });
  return { clock, mail, store, discord, bridge, delivery, async cycle() { await bridge.tick(); return delivery.tick(); } };
}

test('classify: handoff label, summary ≤200 code points, emoji intact', () => {
  const long = '進度😀'.repeat(150);
  const n = classifyMessage({ id: 5, from: 'BlueLake', subject: 's', topic: 'handoff', body_md: itemBody({ summary: long }), created_ts: '2026-11-20T02:00:00.000000Z', thread_id: 'e1' });
  assert.equal(n.label, '交接');
  assert.equal([...n.summary].length, SUMMARY_MAX);
  assert.ok(n.summary.endsWith('…'));
  assert.ok(!n.summary.includes('�'));
});

test('classify: HubClock result → 「HubClock 通知：<狀態>」; other control records are not notified', () => {
  const result = classifyMessage({ id: 9, from: 'JadeBluff', subject: 'r', topic: 'control', created_ts: '2026-11-20T02:00:00Z',
    body_md: JSON.stringify({ v: 1, event_type: 'result', status: 'expired', text: '確認提示顯示後 30 分鐘未回應，已逾時' }) });
  assert.equal(result.label, 'HubClock 通知：已逾時');
  assert.equal(classifyMessage({ id: 10, topic: 'control', body_md: JSON.stringify({ v: 1, event_type: 'presented' }), created_ts: '2026-11-20T02:00:00Z' }), null);
});

test('classify: replies, help/action labels; a summary that looks like a secret is hidden', () => {
  const reply = classifyMessage({ id: 3, topic: 'handoff', thread_id: 'root', body_md: itemBody({ clientEventId: 'other' }), created_ts: '2026-11-20T02:00:00Z' });
  assert.equal(reply.label, '回覆');
  const help = classifyMessage({ id: 4, topic: 'help', thread_id: 'e1', body_md: itemBody({ kind: 'help', intent: 'action' }), created_ts: '2026-11-20T02:00:00Z' });
  assert.equal(help.label, '求助／動手請求');
  const secret = classifyMessage({ id: 6, topic: 'handoff', thread_id: 'e1', body_md: itemBody({ summary: 'key sk-ab\x63defghijklmnopqrstuvwxyz123' }), created_ts: '2026-11-20T02:00:00Z' });
  assert.ok(!secret.summary.includes('sk-'));
});

test('render: no full text, has type/sender/summary/how to view, Discord-only-notifies, mentions neutralised', () => {
  const text = renderNotification({ label: '交接', sender: 'BlueLake', recipient_agent: 'RedStone', subject: '@everyone 看這裡', summary: '<@123> 完成', mail_id: 12, mail_created_at: '2026-11-20T02:00:00.000Z' });
  assert.match(text, /交接/);
  assert.match(text, /BlueLake/);
  assert.match(text, /Mail #12/);
  assert.match(text, /不能在這裡同意/); // §4.5 #3
  assert.ok(!/@everyone/.test(text.replace('@​everyone', '')));
  assert.ok(!text.includes('<@123>'));
  assert.equal(escapeDiscord('a*b'), 'a\\*b');
});

test('TC-18: Mac→Windows handoff produces one DM to the owner with type, sender, summary', async () => {
  const r = rig();
  await r.bridge.tick(); // first tick: start at tail, history is not notified
  r.mail.deliver({ from: 'BlueLake', to: ['RedStone'], body: itemBody({ summary: 'TC18 交接摘要' }), createdTs: r.clock.iso() });
  const stats = await r.cycle();
  assert.equal(stats.sent, 1);
  assert.equal(r.discord.sent.length, 1);
  assert.equal(r.discord.sent[0].userId, OWNER_DISCORD);
  assert.match(r.discord.sent[0].content, /交接/);
  assert.match(r.discord.sent[0].content, /TC18 交接摘要/);
  assert.ok(!r.discord.sent[0].content.includes('全文'));
  // Bridge peeks only: running again does not resend.
  await r.cycle();
  assert.equal(r.discord.sent.length, 1);
});

test('TC-18 negative (AC-09.4): a send the Hub never saved creates no notification', async () => {
  const r = rig();
  await r.bridge.tick();
  // E-RCPT / E-HUB: nothing is stored, so nothing appears in any inbox.
  await r.cycle();
  assert.equal(r.discord.sent.length, 0);
  assert.equal(r.store.db.notifs.length, 0);
});

test('history before the bot starts watching is not notified; same mail to two of my agents → one DM', async () => {
  const r = rig();
  r.mail.deliver({ to: ['RedStone'], createdTs: r.clock.iso() });
  await r.bridge.tick();
  assert.equal(r.store.db.notifs.length, 0);
  r.mail.deliver({ from: 'GreenCastle', to: ['RedStone'], cc: ['BlueLake'], createdTs: r.clock.iso() });
  await r.cycle();
  assert.equal(r.discord.sent.length, 1);
});

test('HubClock result reaching my agent is pushed with the HubClock label', async () => {
  const r = rig();
  await r.bridge.tick();
  r.mail.deliver({ from: 'JadeBluff', to: ['BlueLake'], topic: 'control', subject: 'result #3', createdTs: r.clock.iso(),
    body: JSON.stringify({ v: 1, client_event_id: 'x', event_type: 'result', status: 'unanswered', text: '24 小時內沒有回答' }) });
  await r.cycle();
  assert.match(r.discord.sent[0].content, /HubClock 通知：未回答/);
});

test('§4.5 #9: offline member gets no per-item DMs, then ONE digest when back', async () => {
  const r = rig({ presenceEnabled: true });
  await r.bridge.tick();
  await r.store.setPresenceByDiscord('10000000\x30000000001', OWNER_DISCORD, 'offline');
  for (let i = 0; i < 4; i++) r.mail.deliver({ subject: `s${i}`, createdTs: r.clock.iso() });
  const s1 = await r.cycle();
  assert.equal(s1.held, 4);
  assert.equal(r.discord.sent.length, 0);
  await r.store.setPresenceByDiscord('10000000\x30000000001', OWNER_DISCORD, 'online');
  const s2 = await r.delivery.tick();
  assert.equal(s2.digested, 4);
  assert.equal(r.discord.sent.length, 1);
  assert.match(r.discord.sent[0].content, /你不在時有 4 則/);
  await r.delivery.tick();
  assert.equal(r.discord.sent.length, 1, 'digest is sent once');
});

test('§4.5 #9 + SR-NTF-04: a failed DM is not resent by itself; it joins one digest later', async () => {
  const r = rig();
  await r.bridge.tick();
  r.mail.deliver({ subject: 'a', createdTs: r.clock.iso() });
  r.mail.deliver({ subject: 'b', createdTs: r.clock.iso() });
  r.discord.failNextSends(2);
  const s1 = await r.cycle();
  assert.equal(s1.failed, 2);
  r.mail.deliver({ subject: 'c', createdTs: r.clock.iso() });
  await r.cycle();
  const contents = r.discord.sent.map((x) => x.content);
  assert.equal(contents.length, 2, 'one digest for a+b, one DM for c');
  assert.match(contents[0], /你不在時有 2 則/);
  assert.match(contents[1], /主旨：c/);
});

test('unknown send outcome is recorded unknown and never resent', async () => {
  const r = rig();
  await r.bridge.tick();
  r.mail.deliver({ createdTs: r.clock.iso() });
  r.discord.failNextSends(1, 'unknown');
  await r.cycle();
  await r.cycle();
  assert.equal(r.discord.sent.length, 0);
  assert.equal(r.store.db.notifs[0].state, 'unknown');
});

test('bot was down: a backlog older than 10 min becomes one digest, not a replay', async () => {
  const r = rig();
  await r.bridge.tick();
  for (let i = 0; i < 3; i++) r.mail.deliver({ subject: `old${i}`, createdTs: r.clock.iso() });
  r.clock.advance(60 * 60_000);
  await r.cycle();
  assert.equal(r.discord.sent.length, 1);
  assert.match(r.discord.sent[0].content, /你不在時有 3 則/);
});

test('Hub down: cursor stays, nothing lost; next tick picks the item up', async () => {
  const r = rig();
  await r.bridge.tick();
  r.mail.deliver({ createdTs: r.clock.iso() });
  r.mail.setDown(true);
  await r.cycle();
  assert.equal(r.discord.sent.length, 0);
  r.mail.setDown(false);
  await r.cycle();
  assert.equal(r.discord.sent.length, 1);
});

test('revoked device / unlinked member: its agent is no longer watched', async () => {
  const r = rig();
  r.store.db.devices.find((d) => d.token_id === 'tok_fakewin01').status = 'revoked';
  const watched = await r.store.watchedAgents();
  assert.deepEqual(watched.map((w) => w.agentName), ['BlueLake']);
  r.store.db.links[0].status = 'unlinked';
  assert.deepEqual(await r.store.watchedAgents(), []);
  assert.ok(維護者);
});
