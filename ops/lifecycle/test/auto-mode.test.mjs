// L-06 auto mode — HubClock unit tests (FakeClock + in-memory Mail). TC-15 steps 1-6.
// Run: node --test ops/lifecycle/test/auto-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../lifecycle.mjs';
import { createFileStore } from '../store-file.mjs';
import { buildClientControl, tsToMicros } from '../protocol.mjs';
import { FakeWallClock, FakeHub, T0, MIN, HOUR, tempDir } from './helpers.mjs';

const CLOCK = 'clock-agent';
const MAC = 'BlueLake';
const WIN = 'RedStone';
const ANN = 'GreenHill'; // a third agent
const US = 1000;

async function setup({ settleMs = 5_000 } = {}) {
  const clock = new FakeWallClock(T0);
  const hub = new FakeHub(clock);
  const tmp = await tempDir();
  const store = createFileStore({ dir: tmp.dir, clock, owner: 'writer-A' });
  assert.equal((await store.acquireLock()).acquired, true);
  const lc = createLifecycle({ client: hub.clientFor(CLOCK), store, clock, groupId: 'group-a', settleMs });
  return { clock, hub, tmp, store, lc };
}

/** What `hub-hook auto on|off|done` sends. */
function autoControl(hub, from, eventType, fields = {}, { micros, rootMailId = null, threadId } = {}) {
  const body = buildClientControl({ eventType, rootMailId, recipientSession: `${from}-s1`, agent: from, ...fields });
  return hub.post(from, { to: [CLOCK], topic: 'control', body, threadId, micros }).message;
}
const autoOn = (hub, from, fields, o) => autoControl(hub, from, 'auto.on', { recipientAgent: from, ...fields }, o);

const grants = async (store) => Object.values((await store.snapshot()).grants ?? {});
const statusOf = async (store, key) => (await store.snapshot()).requests[key]?.status;
const autoResults = (hub) => hub.results().filter((r) => r.body.kind === 'auto');

// ---------------------------------------------------------------- step 1: open
test('auto.on: default 60 min, records opener/target/start/end from Mail time, notifies recipient and target', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const on = autoOn(hub, WIN, { target: MAC });
  await lc.tick();
  const [g] = await grants(store);
  assert.equal(g.status, 'active');
  assert.equal(g.recipientAgent, WIN);
  assert.equal(g.openedBy, WIN);
  assert.equal(g.target, MAC);
  assert.equal(g.minutes, 60);
  assert.equal(g.startAt, tsToMicros(on.created_ts));
  assert.equal(g.endAt, g.startAt + HOUR * US);
  const [r] = autoResults(hub);
  assert.equal(r.body.status, 'auto_on');
  assert.deepEqual([...r.to].sort(), [MAC, WIN].sort());
  assert.equal(r.thread_id, on.thread_id);
  assert.equal(r.body.target, MAC);
  assert.equal(r.body.start_at, '2026-12-01T00:00:00.000000Z');
  assert.equal(r.body.end_at, '2026-12-01T01:00:00.000000Z');
});

test('auto.on: 240 minutes is accepted', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC, minutes: 240 });
  await lc.tick();
  const [g] = await grants(store);
  assert.equal(g.endAt - g.startAt, 4 * HOUR * US);
});

// ---------------------------------------------------------------- step 5: rejections
test('rejections leave no grant: no target, 0 / 241 / 300 / 1.5 min, "all", list, self, opening for someone else', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const cases = [
    [WIN, {}, 'E-AUTO'],
    [WIN, { target: MAC, minutes: 0 }, 'E-AUTO'],
    [WIN, { target: MAC, minutes: 241 }, 'E-AUTO'],
    [WIN, { target: MAC, minutes: 300 }, 'E-AUTO'], // 5 hours (TC-15 step 5)
    [WIN, { target: MAC, minutes: 1.5 }, 'E-AUTO'],
    [WIN, { target: MAC, minutes: '60' }, 'E-AUTO'],
    [WIN, { target: '*' }, 'E-AUTO'],
    [WIN, { target: 'all' }, 'E-AUTO'],
    [WIN, { target: [MAC, ANN] }, 'E-AUTO'],
    [WIN, { target: WIN }, 'E-AUTO'],
    [MAC, { recipientAgent: WIN, target: MAC }, 'E-NOT-OWNER'], // Mac opens for Windows (TC-15 step 5)
  ];
  for (const [from, fields] of cases) autoOn(hub, from, fields);
  await lc.tick();
  assert.deepEqual(await grants(store), []);
  const rs = autoResults(hub);
  assert.equal(rs.length, cases.length);
  cases.forEach(([from, , code], i) => {
    assert.equal(rs[i].body.status, 'auto_rejected');
    assert.equal(rs[i].body.error_code, code, `case ${i}`);
    assert.deepEqual(rs[i].to, [from]);
  });
  assert.match(rs[0].body.text, /必須指定對象/);
  assert.match(rs[3].body.text, /最長 4 小時/);
  assert.match(rs[10].body.text, /只有收件人能開啟/);
  // and nothing is auto-approved afterwards
  const root = hub.root(MAC, [WIN], 'action');
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'pending');
});

// ---------------------------------------------------------------- step 2 / 3: execute
test('target\'s action inside the window is auto_approved without presented, notice to both in the action thread', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  await lc.tick();
  clock.advance(10 * MIN);
  const root = hub.root(MAC, [WIN], 'action');
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'auto_approved');
  assert.ok(req.grantKey);
  const r = hub.results().find((x) => x.body.status === 'auto_approved');
  assert.equal(r.thread_id, root.thread_id);
  assert.deepEqual([...r.to].sort(), [MAC, WIN].sort());
  assert.equal(r.body.root_mail_id, root.id);
  // a late card / choice cannot change the outcome (one result per request)
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'reject' });
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'auto_approved');
});

test('another sender still needs confirmation; a question from the target is not auto-approved', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  clock.advance(30 * MIN);
  const ann = hub.root(ANN, [WIN], 'action');
  const q = hub.root(MAC, [WIN], 'question');
  await lc.tick();
  assert.equal(await statusOf(store, `${ann.id}:${WIN}`), 'pending');
  assert.equal(await statusOf(store, `${q.id}:${WIN}`), 'pending');
});

test('the grant only covers its recipient: Mac→Ann action is not approved by Windows\' grant', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  const root = hub.root(MAC, [WIN, ANN], 'action');
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'auto_approved');
  assert.equal(await statusOf(store, `${root.id}:${ANN}`), 'pending');
});

// ---------------------------------------------------------------- step 4: expiry / early off
test('SR-AUTO-03 boundary: arrived 1 µs before end → auto; arrived exactly at end → confirmation', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const on = autoOn(hub, WIN, { target: MAC });
  const end = tsToMicros(on.created_ts) + HOUR * US;
  const before = hub.root(MAC, [WIN], 'action', { micros: end - 1 });
  const at = hub.root(MAC, [WIN], 'action', { micros: end });
  clock.set(T0 + 2 * HOUR); // HubClock reads both late: arrival time decides, not ingest time
  await lc.tick();
  assert.equal(await statusOf(store, `${before.id}:${WIN}`), 'auto_approved');
  assert.equal(await statusOf(store, `${at.id}:${WIN}`), 'pending');
});

test('expiry: not ended at end+settle-1 ms; ended at end+settle with one "已結束" notice dated at the end time', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup({ settleMs: 5_000 });
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  await lc.tick();
  clock.set(T0 + HOUR + 5_000 - 1);
  await lc.tick();
  assert.equal((await grants(store))[0].status, 'active');
  clock.set(T0 + HOUR + 5_000);
  await lc.tick();
  await lc.tick();
  const [g] = await grants(store);
  assert.equal(g.status, 'expired');
  const ended = autoResults(hub).filter((r) => r.body.status === 'auto_ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].body.ended_by, 'expired');
  assert.equal(ended[0].body.ended_at, '2026-12-01T01:00:00.000000Z');
  assert.deepEqual([...ended[0].to].sort(), [MAC, WIN].sort());
  assert.match(ended[0].body.text, /已結束/);
});

test('auto.off: takes effect at its Mail time; later actions need confirmation; one "已結束" notice', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  clock.advance(10 * MIN);
  const before = hub.root(MAC, [WIN], 'action');
  clock.advance(1);
  autoControl(hub, WIN, 'auto.off', { target: MAC });
  clock.advance(1);
  const after = hub.root(MAC, [WIN], 'action');
  await lc.tick();
  assert.equal(await statusOf(store, `${before.id}:${WIN}`), 'auto_approved');
  assert.equal(await statusOf(store, `${after.id}:${WIN}`), 'pending');
  const [g] = await grants(store);
  assert.equal(g.status, 'closed');
  clock.set(T0 + 2 * HOUR); // the old end time passing must not send a second notice
  await lc.tick();
  const ended = autoResults(hub).filter((r) => r.body.status === 'auto_ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].body.ended_by, 'closed');
});

test('auto.off from another agent does not close the recipient\'s grant', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  autoControl(hub, MAC, 'auto.off', { target: MAC });
  await lc.tick();
  assert.equal((await grants(store))[0].status, 'active');
});

test('SR-AUTO-05: re-opening for the same target replaces the old grant; time restarts, no stacking', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC, minutes: 240 });
  clock.advance(30 * MIN);
  const second = autoOn(hub, WIN, { target: MAC, minutes: 60 });
  await lc.tick();
  const gs = await grants(store);
  assert.deepEqual(gs.map((g) => g.status).sort(), ['active', 'replaced']);
  const active = gs.find((g) => g.status === 'active');
  assert.equal(active.endAt, tsToMicros(second.created_ts) + HOUR * US);
  const late = hub.root(MAC, [WIN], 'action', { micros: tsToMicros(second.created_ts) + 2 * HOUR * US });
  clock.set(T0 + 3 * HOUR);
  await lc.tick();
  assert.equal(await statusOf(store, `${late.id}:${WIN}`), 'pending');
});

// ---------------------------------------------------------------- step 6: execution record
test('auto.executed: failure is recorded and notified as failure with its reason (AC-07.8); success too; once only', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  const bad = hub.root(MAC, [WIN], 'action');
  const ok = hub.root(MAC, [WIN], 'action');
  await lc.tick();
  clock.advance(MIN);
  autoControl(hub, WIN, 'auto.executed', { outcome: 'failed', reason: 'ENOENT: no-such-file.txt' }, { rootMailId: bad.id, threadId: bad.thread_id });
  autoControl(hub, WIN, 'auto.executed', { outcome: 'succeeded' }, { rootMailId: ok.id, threadId: ok.thread_id });
  autoControl(hub, WIN, 'auto.executed', { outcome: 'succeeded' }, { rootMailId: bad.id, threadId: bad.thread_id }); // second report ignored
  await lc.tick();
  const s = await store.snapshot();
  assert.equal(s.requests[`${bad.id}:${WIN}`].execution.outcome, 'failed');
  assert.equal(s.requests[`${bad.id}:${WIN}`].execution.reason, 'ENOENT: no-such-file.txt');
  assert.equal(s.requests[`${ok.id}:${WIN}`].execution.outcome, 'succeeded');
  const ex = hub.results().filter((r) => r.body.status === 'auto_executed');
  assert.equal(ex.length, 2);
  const fail = ex.find((r) => r.body.root_mail_id === bad.id);
  assert.equal(fail.body.outcome, 'failed');
  assert.match(fail.body.text, /失敗/);
  assert.match(fail.body.text, /ENOENT/);
  assert.equal(fail.thread_id, bad.thread_id);
  assert.deepEqual([...fail.to].sort(), [MAC, WIN].sort());
});

test('auto.executed for a request that was not auto-approved is ignored (no false execution record)', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  autoControl(hub, WIN, 'auto.executed', { outcome: 'succeeded' }, { rootMailId: root.id, threadId: root.thread_id });
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'pending');
  assert.equal(req.execution, undefined);
  assert.equal(hub.results().length, 0);
});

test('restart: grant and expiry survive a new process; the missed "已結束" notice is sent once', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  autoOn(hub, WIN, { target: MAC });
  await lc.tick();
  await store.releaseLock();
  clock.set(T0 + 5 * HOUR);
  const store2 = createFileStore({ dir: tmp.dir, clock, owner: 'writer-B' });
  assert.equal((await store2.acquireLock()).acquired, true);
  const lc2 = createLifecycle({ client: hub.clientFor(CLOCK), store: store2, clock, groupId: 'group-a' });
  await lc2.tick();
  await lc2.tick();
  assert.equal((await grants(store2))[0].status, 'expired');
  assert.equal(autoResults(hub).filter((r) => r.body.status === 'auto_ended').length, 1);
});
