// HubClock unit tests (FakeClock + in-memory Mail). Run: node --test ops/lifecycle/test/lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createLifecycle } from '../lifecycle.mjs';
import { createFileStore, LockLostError } from '../store-file.mjs';
import { loadIdentity } from '../main.mjs';
import { tsToMicros, stableUuid, resultKey } from '../protocol.mjs';
import { MailError } from '../../../client/mail-client.mjs';
import { FakeWallClock, FakeHub, T0, MIN, HOUR, tempDir, unconfirmed } from './helpers.mjs';

const CLOCK = 'clock-agent'; // stands in for the Mail-generated name from hubclock.sender.json
const MAC = 'BlueLake';
const WIN = 'RedStone';
const US = 1000; // µs per ms

async function setup({ settleMs = 5_000, leaseMs = 60_000 } = {}) {
  const clock = new FakeWallClock(T0);
  const hub = new FakeHub(clock);
  const tmp = await tempDir();
  const store = createFileStore({ dir: tmp.dir, clock, leaseMs, owner: 'writer-A' });
  assert.equal((await store.acquireLock()).acquired, true);
  const client = hub.clientFor(CLOCK);
  const lc = createLifecycle({ client, store, clock, groupId: 'group-a', settleMs });
  return { clock, hub, tmp, store, client, lc };
}

const statusOf = async (store, key) => (await store.snapshot()).requests[key]?.status;

// ------------------------------------------------------------------ question 24 h
test('question: answered 1 µs before 24 h stays answered and sends no notice', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'question');
  await lc.tick();
  const start = tsToMicros(root.created_ts);
  hub.control(WIN, CLOCK, 'answer', root, 'win-s1', { micros: start + 24 * HOUR * US - 1 });
  clock.set(T0 + 25 * HOUR);
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'answered');
  assert.equal(hub.results().length, 0);
});

test('question: 24 h boundary — not before deadline+settle, unanswered exactly at it, notice to asker only', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup({ settleMs: 5_000 });
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'question');
  await lc.tick();
  clock.set(T0 + 24 * HOUR + 5_000 - 1);
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'pending');
  clock.set(T0 + 24 * HOUR + 5_000);
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'unanswered');
  const [r] = hub.results();
  assert.deepEqual(r.to, [MAC]);
  assert.equal(r.body.status, 'unanswered');
  assert.equal(r.thread_id, root.thread_id);
  assert.equal(r.body.deadline_at, '2026-12-02T00:00:00.000000Z');
});

test('question: answer saved exactly at 24 h is late — unanswered is kept and the late answer recorded', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'question');
  await lc.tick();
  hub.control(WIN, CLOCK, 'answer', root, 'win-s1', { micros: tsToMicros(root.created_ts) + 24 * HOUR * US });
  clock.set(T0 + 25 * HOUR);
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'unanswered');
  assert.equal(req.late.length, 1);
});

test('question: a threaded reply item from the recipient counts as the answer', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'question');
  clock.advance(10 * MIN);
  hub.post(WIN, { to: [MAC], cc: [CLOCK], topic: 'help', threadId: root.thread_id,
    body: { v: 1, client_event_id: '00000000-0000-4000-8000-0000000000ff', kind: 'help', intent: 'question', source_session: 'w', summary: 'a', text: 'a', links: [], unfinished: [] } });
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'answered');
});

// ------------------------------------------------------------------ action 30 min
test('action: approve 1 µs before 30:00 wins even if HubClock only ingests it after the deadline', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  clock.advance(2 * HOUR); // offline: no timer yet
  const p = hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  await lc.tick();
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve', micros: tsToMicros(p.created_ts) + 30 * MIN * US - 1 });
  clock.advance(31 * MIN); // first tick after the deadline
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'approved');
  const [r] = hub.results();
  assert.deepEqual(r.to.sort(), [MAC, WIN].sort()); // recipient needs the published approval before acting
  assert.equal(r.body.status, 'approved');
});

test('action: choice saved exactly at 30:00 is late → expired, notice to sender and recipient', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  const p = hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve', micros: tsToMicros(p.created_ts) + 30 * MIN * US });
  clock.advance(30 * MIN + 5_000);
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'expired');
  assert.match(req.late[0].why, /at\/after deadline/);
  const [r] = hub.results();
  assert.equal(r.body.status, 'expired');
  assert.match(r.body.text, /逾時/);
});

test('action: 30 min boundary — still presented at deadline+settle-1 ms, expired at deadline+settle', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup({ settleMs: 5_000 });
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  await lc.tick();
  clock.set(T0 + 30 * MIN + 5_000 - 1);
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'presented');
  clock.set(T0 + 30 * MIN + 5_000);
  await lc.tick();
  assert.equal(await statusOf(store, `${root.id}:${WIN}`), 'expired');
});

test('TC-12 (unit): action for an offline recipient never times out before it is presented', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  await lc.tick();
  clock.advance(48 * HOUR);
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'pending');
  assert.equal(req.deadlineAt, null);
  assert.equal(hub.results().length, 0);
});

test('reject carries the reason; a second choice is ignored (once only)', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  clock.advance(MIN);
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'reject', reason: '測試拒絕' });
  clock.advance(MIN);
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve' });
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'rejected');
  assert.equal(req.reason, '測試拒絕');
  assert.equal(hub.results().length, 1);
  assert.match(hub.results()[0].body.text, /理由：測試拒絕/);
});

test('fail-closed: choice before presented, or from another session, never approves', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve' });
  hub.control(WIN, CLOCK, 'presented', root, 'win-s2');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve' });
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'presented');
  assert.equal(req.late.length, 2);
  assert.equal(hub.results().length, 0);
});

test('question reclassified as action by the recipient (TC-08 step 2) follows the 30-minute rule', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'question');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  clock.advance(30 * MIN + 5_000);
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.kind, 'action');
  assert.equal(req.reclassified, true);
  assert.equal(req.status, 'expired');
});

test('presented for a root HubClock was not CC\'d on is built from the root message', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.post(MAC, { to: [WIN], topic: 'task', body: { v: 1, client_event_id: '00000000-0000-4000-8000-0000000000aa', kind: 'task', intent: 'action' } }).message;
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'presented');
  assert.equal(req.requester, MAC);
});

// ------------------------------------------------------------------ session.closed
test('session.closed invalidates only that session\'s presented requests; no later revival', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const a = hub.root(MAC, [WIN], 'action');
  const b = hub.root(MAC, [WIN], 'action');
  const q = hub.root(MAC, [WIN], 'question');
  hub.control(WIN, CLOCK, 'presented', a, 'win-s1');
  await lc.tick();
  hub.control(WIN, CLOCK, 'session.closed', null, 'win-s1');
  await lc.tick();
  const s = (await store.snapshot()).requests;
  assert.equal(s[`${a.id}:${WIN}`].status, 'invalidated');
  assert.equal(s[`${b.id}:${WIN}`].status, 'pending'); // never shown → waits for the next session (TC-12)
  assert.equal(s[`${q.id}:${WIN}`].status, 'pending'); // questions keep their 24 h
  // A new session presenting / approving the invalidated request cannot revive it.
  hub.control(WIN, CLOCK, 'presented', a, 'win-s2');
  hub.control(WIN, CLOCK, 'choice', a, 'win-s2', { choice: 'approve' });
  clock.advance(MIN);
  await lc.tick();
  assert.equal((await store.snapshot()).requests[`${a.id}:${WIN}`].status, 'invalidated');
  const res = hub.results();
  assert.equal(res.length, 1);
  assert.equal(res[0].body.status, 'invalidated');
});

// ------------------------------------------------------------------ restart / duplicates / outbox
test('restart: a new process recomputes missed deadlines from persisted state and sends once', async (t) => {
  const { clock, hub, tmp, store, client } = await setup();
  t.after(tmp.cleanup);
  const lc1 = createLifecycle({ client, store, clock, groupId: 'group-a' });
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  await lc1.tick();
  // Process dies without releasing the lock; it is down for 3 hours.
  clock.advance(3 * HOUR);
  const store2 = createFileStore({ dir: tmp.dir, clock, owner: 'writer-B' });
  assert.equal((await store2.acquireLock()).acquired, true); // stale lease taken over
  const lc2 = createLifecycle({ client: hub.clientFor(CLOCK), store: store2, clock, groupId: 'group-a' });
  await lc2.tick();
  const req = (await store2.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'expired');
  assert.equal(req.resolvedAt, req.deadlineAt); // original deadline kept, not reset by the restart
  await lc2.tick();
  assert.equal(hub.results().length, 1);
});

test('duplicate inbox events and a re-read page are applied once', async (t) => {
  const { clock, hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  const p = hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  await lc.tick();
  hub.redeliver(CLOCK, p.id);
  hub.redeliver(CLOCK, root.id);
  const c = hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve' });
  hub.redeliver(CLOCK, c.id);
  // Simulate a crash before the cursor was committed: rewind the cursor and re-run.
  await store.transact((tx) => tx.setCursor(null));
  clock.advance(MIN);
  await lc.tick();
  const req = (await store.snapshot()).requests[`${root.id}:${WIN}`];
  assert.equal(req.status, 'approved');
  assert.equal(req.presentedMailId, p.id);
  assert.equal(hub.results().length, 1);
});

test('outbox: unconfirmed send keeps the same key; the retry is a Hub replay, not a second message', async (t) => {
  const { clock, hub, tmp, store, client, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'reject' });
  hub.sendFailures.push({ error: unconfirmed(), storeAnyway: true }); // stored, but we never saw the receipt
  await lc.tick();
  const key = resultKey({ groupId: 'group-a', rootMailId: root.id, recipientAgent: WIN, status: 'rejected' });
  let e = (await store.snapshot()).outbox[key];
  assert.equal(e.state, 'pending');
  assert.equal(e.lastError.delivery, 'unconfirmed');
  await lc.tick(); // backoff not elapsed → no resend
  assert.equal(client.calls.send, 1);
  clock.advance(15_000);
  await lc.tick();
  e = (await store.snapshot()).outbox[key];
  assert.equal(e.state, 'sent');
  assert.equal(client.calls.send, 2);
  assert.equal(hub.results().length, 1); // same idempotency key → replay
  assert.equal(e.resultMailId, hub.results()[0].id);
});

test('outbox: E-AUTH stops the tick and leaves the result pending', async (t) => {
  const { hub, tmp, store, lc } = await setup();
  t.after(tmp.cleanup);
  const root = hub.root(MAC, [WIN], 'action');
  hub.control(WIN, CLOCK, 'presented', root, 'win-s1');
  hub.control(WIN, CLOCK, 'choice', root, 'win-s1', { choice: 'approve' });
  hub.sendFailures.push({ error: new MailError('E-AUTH', '連線未授權或已撤銷', { reason: 'unauthorized' }) });
  await assert.rejects(lc.tick(), (e) => e.code === 'E-AUTH');
  const [e] = Object.values((await store.snapshot()).outbox);
  assert.equal(e.state, 'pending');
});

test('result idempotency key is fixed per (group, root, recipient, status)', () => {
  const a = resultKey({ groupId: 'group-a', rootMailId: 7, recipientAgent: WIN, status: 'expired' });
  assert.equal(a, resultKey({ groupId: 'group-a', rootMailId: 7, recipientAgent: WIN, status: 'expired' }));
  assert.notEqual(a, resultKey({ groupId: 'group-a', rootMailId: 7, recipientAgent: WIN, status: 'approved' }));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stableUuid('x'), stableUuid('x'));
});

// ------------------------------------------------------------------ single-writer lock
test('lock: second writer stands by while the lease is fresh, takes over when stale; the old writer is fenced', async (t) => {
  const clock = new FakeWallClock(T0);
  const hub = new FakeHub(clock);
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const A = createFileStore({ dir: tmp.dir, clock, leaseMs: 60_000, owner: 'writer-A' });
  const B = createFileStore({ dir: tmp.dir, clock, leaseMs: 60_000, owner: 'writer-B' });
  assert.deepEqual(await A.acquireLock(), { acquired: true, holder: 'writer-A' });
  assert.deepEqual(await B.acquireLock(), { acquired: false, holder: 'writer-A' });
  clock.advance(60_000);
  assert.equal((await B.acquireLock()).acquired, false); // exactly at lease: still A's
  clock.advance(1);
  assert.equal((await B.acquireLock()).acquired, true);
  // A wakes up from a stall: it must not write.
  const lcA = createLifecycle({ client: hub.clientFor(CLOCK), store: A, clock, groupId: 'group-a' });
  hub.root(MAC, [WIN], 'question');
  await assert.rejects(lcA.tick(), LockLostError);
  await assert.rejects(A.transact((tx) => tx.setCursor(99)), LockLostError);
  assert.equal((await B.snapshot()).cursor, null);
  // A's release must not delete B's lock.
  await A.releaseLock();
  assert.equal((await B.acquireLock()).holder, 'writer-B');
});

test('lock: a live writer renewing its heartbeat is never pre-empted', async (t) => {
  const clock = new FakeWallClock(T0);
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const A = createFileStore({ dir: tmp.dir, clock, leaseMs: 60_000, owner: 'writer-A' });
  const B = createFileStore({ dir: tmp.dir, clock, leaseMs: 60_000, owner: 'writer-B' });
  await A.acquireLock();
  for (let i = 0; i < 10; i++) {
    clock.advance(15_000);
    await A.renewLock();
    assert.equal((await B.acquireLock()).acquired, false);
  }
});

// ------------------------------------------------------------------ identity
test('identity comes from hubclock.sender.json (generated name), and loose permissions are refused', async (t) => {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  await writeFile(join(tmp.dir, 'mail-a.env'), `HTTP_BEARER_TOKEN=${'x'.repeat(40)}\n`, { mode: 0o600 });
  await writeFile(join(tmp.dir, 'hubclock.sender.json'), JSON.stringify({ agentName: 'QuietHarbor', senderToken: 'reg-fixture', projectKey: '/data/projects/group-a' }), { mode: 0o600 });
  const id = await loadIdentity(tmp.dir);
  assert.equal(id.agentName, 'QuietHarbor');
  assert.equal(id.projectKey, '/data/projects/group-a');
  await chmod(join(tmp.dir, 'hubclock.sender.json'), 0o644);
  await assert.rejects(loadIdentity(tmp.dir), /chmod 600/);
});
