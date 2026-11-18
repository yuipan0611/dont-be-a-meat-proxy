// L-02b Mail → Hindsight index bridge (SDS API-04 / GAP-16). FakeClock + in-memory Mail + fake Hindsight.
// Run: node --test ops/memory-bridge/test/bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBridge, documentIdFor } from '../bridge.mjs';
import { createFileStore } from '../../lifecycle/store-file.mjs';
import { FakeWallClock, FakeHub, T0, MIN, tempDir } from '../../lifecycle/test/helpers.mjs';

const BRIDGE = 'bridge-agent'; // stands in for the Mail-generated name in memorybridge.sender.json
const MAC = 'BlueLake';
const WIN = 'RedStone';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Fake Hindsight REST: documents keyed by (bank, document_id). Failure modes are queued per call. */
class FakeHindsight {
  constructor() { this.docs = new Map(); this.calls = []; this.mode = []; }
  async retain(bank, item) {
    this.calls.push({ op: 'retain', bank, item });
    const m = this.mode.shift();
    if (m === 'down') throw Object.assign(new Error('ECONNREFUSED'), { kind: 'unreachable' });
    if (m === 'timeout') { this.docs.set(`${bank}/${item.document_id}`, { original_text: item.content }); throw Object.assign(new Error('timeout'), { kind: 'unknown' }); }
    if (m === 'timeout-lost') throw Object.assign(new Error('timeout'), { kind: 'unknown' });
    if (m === 'budget') throw Object.assign(new Error('500 rate_limit_error 今日 LLM 額度已用完'), { kind: 'failed', status: 500 });
    if (m === 'bad') throw Object.assign(new Error('422 invalid'), { kind: 'rejected', status: 422 });
    this.docs.set(`${bank}/${item.document_id}`, { original_text: item.content, metadata: item.metadata });
    return { ok: true };
  }
  async getDocument(bank, id) {
    this.calls.push({ op: 'get', bank, id });
    if (this.mode[0] === 'down-get') { this.mode.shift(); throw Object.assign(new Error('ECONNREFUSED'), { kind: 'unreachable' }); }
    return this.docs.get(`${bank}/${id}`) ?? null;
  }
}

async function setup({ owner = 'bridge-A' } = {}) {
  const clock = new FakeWallClock(T0);
  const hub = new FakeHub(clock);
  const tmp = await tempDir('bridge-test-');
  const store = createFileStore({ dir: tmp.dir, clock, owner });
  assert.equal((await store.acquireLock()).acquired, true);
  const hs = new FakeHindsight();
  const make = (st = store) => createBridge({ mail: hub.clientFor(BRIDGE), hindsight: hs, store: st, clock, bank: 'group-a', retryBaseMs: 30_000, retryMaxMs: 15 * MIN });
  return { clock, hub, tmp, store, hs, bridge: make(), make };
}

function send(hub, from, kind, text, { to = [WIN], cc = [BRIDGE], intent = 'action', threadId } = {}) {
  const body = { v: 1, client_event_id: `00000000-0000-4000-8000-${String(hub.messages.length + 1).padStart(12, '0')}`, kind, intent, source_session: 's', summary: `摘要 ${kind}`, text, links: [], unfinished: [] };
  return hub.post(from, { to, cc, topic: kind, body, threadId }).message;
}
const rec = async (store, id) => (await store.snapshot()).requests[documentIdFor(id)];

test('a handoff CC\'d to the bridge is retained verbatim with document_id mail-<id> and Mail metadata; then indexed', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const text = '交接：登入頁完成，下一步 /login。PR：https://github.com/o/r/pull/1 🚀';
  const m = send(s.hub, MAC, 'handoff', text);
  await s.bridge.tick();
  const [call] = s.hs.calls.filter((c) => c.op === 'retain');
  assert.equal(call.bank, 'group-a');
  assert.equal(call.item.document_id, `mail-${m.id}`);
  assert.equal(call.item.content, text);
  assert.equal(call.item.metadata.mail_id, String(m.id));
  assert.equal(call.item.metadata.from, MAC);
  assert.equal(call.item.metadata.kind, 'handoff');
  assert.equal(call.item.metadata.created_ts, m.created_ts);
  assert.equal(call.item.timestamp, m.created_ts);
  const r = await rec(s.store, m.id);
  assert.equal(r.status, 'indexed');
  assert.equal(r.textSha256, sha(text));
  assert.equal(r.attempts, 1);
  assert.ok(r.indexedAt);
});

test('only handoff and decision are indexed; help/task, replies to others, controls and own messages are not', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const d = send(s.hub, MAC, 'decision', '決策：資料庫用 PostgreSQL。');
  send(s.hub, MAC, 'help', '幫我看一下');
  send(s.hub, MAC, 'task', '請做 X');
  s.hub.post(MAC, { to: [BRIDGE], topic: 'control', body: { v: 1, event_type: 'presented' } });
  await s.bridge.tick();
  const recs = Object.values((await s.store.snapshot()).requests);
  assert.deepEqual(recs.map((r) => r.mailId), [d.id]);
  assert.equal(recs[0].status, 'indexed');
});

test('Hindsight down: stays pending with error + last attempt time, backs off, and indexes once it is back', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 A');
  s.hs.mode.push('down');
  await s.bridge.tick();
  let r = await rec(s.store, m.id);
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.lastError, {
    stage: 'retain', kind: 'unreachable', code: 'RETAIN_FAILED',
    length: Buffer.byteLength('ECONNREFUSED'), sha256: sha('ECONNREFUSED'),
  });
  assert.equal(r.lastAttemptAt, T0);
  assert.equal(r.nextTryAt, T0 + 30_000);
  await s.bridge.tick(); // before nextTryAt: no new attempt
  assert.equal(s.hs.calls.filter((c) => c.op === 'retain').length, 1);
  s.clock.advance(30_000);
  await s.bridge.tick();
  r = await rec(s.store, m.id);
  assert.equal(r.status, 'indexed');
  assert.equal(r.attempts, 2);
  assert.equal(r.lastError, null);
});

test('daily budget exhausted (gateway 429 surfaces as a Hindsight failure): pending, nothing lost, retried later', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 B');
  s.hs.mode.push('budget', 'budget');
  await s.bridge.tick();
  s.clock.advance(30_000);
  await s.bridge.tick();
  let r = await rec(s.store, m.id);
  assert.equal(r.status, 'pending');
  assert.equal(r.attempts, 2);
  assert.equal(r.nextTryAt, s.clock.nowMs() + 60_000); // exponential
  assert.equal(r.lastError.status, 500);
  assert.equal(r.lastError.sha256, sha('500 rate_limit_error 今日 LLM 額度已用完'));
  assert.equal(r.lastError.message, undefined);
  s.clock.advance(60_000);
  await s.bridge.tick();
  r = await rec(s.store, m.id);
  assert.equal(r.status, 'indexed');
});

test('backoff is capped at retryMaxMs', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文');
  for (let i = 0; i < 8; i++) {
    s.hs.mode.push('down');
    await s.bridge.tick();
    s.clock.set((await rec(s.store, m.id)).nextTryAt);
  }
  const r = await rec(s.store, m.id);
  assert.equal(r.nextTryAt - r.lastAttemptAt, 15 * MIN);
});

test('unknown result (timeout) that DID store: next tick finds the same document_id with the same text → indexed, no second retain', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 C');
  s.hs.mode.push('timeout');
  await s.bridge.tick();
  assert.equal((await rec(s.store, m.id)).status, 'unknown');
  s.clock.advance(30_000);
  await s.bridge.tick();
  assert.equal((await rec(s.store, m.id)).status, 'indexed');
  assert.equal(s.hs.calls.filter((c) => c.op === 'retain').length, 1);
});

test('unknown result that did NOT store: checked first, then retained again with the same document_id', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 D');
  s.hs.mode.push('timeout-lost');
  await s.bridge.tick();
  s.clock.advance(30_000);
  await s.bridge.tick();
  const ops = s.hs.calls.map((c) => c.op);
  assert.deepEqual(ops, ['retain', 'get', 'retain']);
  assert.equal(s.hs.calls[2].item.document_id, `mail-${m.id}`);
  assert.equal((await rec(s.store, m.id)).status, 'indexed');
});

test('crash mid-retain (in_flight on disk) is treated as unknown by the next process: check before retain', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 E');
  s.hs.retain = async () => { throw new Error('process killed'); }; // simulate dying after in_flight was written
  await assert.rejects(s.bridge.tick(), /process killed/);
  assert.equal((await rec(s.store, m.id)).status, 'in_flight');
  await s.store.releaseLock();
  const hs2 = new FakeHindsight();
  hs2.docs.set(`group-a/mail-${m.id}`, { original_text: '原文 E' });
  const store2 = createFileStore({ dir: s.tmp.dir, clock: s.clock, owner: 'bridge-B' });
  assert.equal((await store2.acquireLock()).acquired, true);
  const b2 = createBridge({ mail: s.hub.clientFor(BRIDGE), hindsight: hs2, store: store2, clock: s.clock, bank: 'group-a' });
  await b2.tick();
  assert.deepEqual(hs2.calls.map((c) => c.op), ['get']);
  assert.equal((await rec(store2, m.id)).status, 'indexed');
});

test('an unexpected error inside a running process does not strand the record: the next pass looks it up first', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 J');
  const real = s.hs.retain.bind(s.hs);
  s.hs.retain = async () => { throw new Error('bug'); };
  await assert.rejects(s.bridge.tick(), /bug/);
  s.hs.retain = real;
  await s.bridge.tick();
  assert.deepEqual(s.hs.calls.map((c) => c.op), ['get', 'retain']);
  assert.equal((await rec(s.store, m.id)).status, 'indexed');
});

test('a 4xx rejection is an error (not retried automatically) and keeps the text hash; reindex retries it', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 F');
  s.hs.mode.push('bad');
  await s.bridge.tick();
  let r = await rec(s.store, m.id);
  assert.equal(r.status, 'error');
  s.clock.advance(60 * MIN);
  await s.bridge.tick();
  assert.equal(s.hs.calls.filter((c) => c.op === 'retain').length, 1);
  await s.bridge.reindex(m.id);
  await s.bridge.tick();
  r = await rec(s.store, m.id);
  assert.equal(r.status, 'indexed');
  assert.equal(r.attempts, 2);
});

test('reindex by Mail ID: an indexed message is re-retained on the same document_id; an unseen message is read from Mail', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 G');
  await s.bridge.tick();
  await s.bridge.reindex(m.id);
  await s.bridge.tick();
  assert.equal(s.hs.calls.filter((c) => c.op === 'retain').length, 2);
  // a handoff the bridge was never CC'd on (older client): backfilled by ID
  const old = send(s.hub, MAC, 'handoff', '舊交接，沒有 CC bridge', { cc: [] });
  await s.bridge.reindex(old.id);
  await s.bridge.tick();
  assert.equal((await rec(s.store, old.id)).status, 'indexed');
  // a help item is refused unless forced
  const h = send(s.hub, MAC, 'help', 'x', { cc: [] });
  await assert.rejects(s.bridge.reindex(h.id), /not a handoff or decision/);
});

test('restart: cursor and pending survive; the inbox is not re-ingested and nothing is lost', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const a = send(s.hub, MAC, 'handoff', '原文 H1');
  const b = send(s.hub, WIN, 'decision', '原文 H2', { to: [MAC] });
  s.hs.mode.push('down', 'down');
  await s.bridge.tick();
  await s.store.releaseLock();
  const store2 = createFileStore({ dir: s.tmp.dir, clock: s.clock, owner: 'bridge-B' });
  await store2.acquireLock();
  s.clock.advance(30_000);
  await s.make(store2).tick();
  const snap = await store2.snapshot();
  assert.deepEqual(Object.values(snap.requests).map((r) => [r.mailId, r.status]).sort(), [[a.id, 'indexed'], [b.id, 'indexed']]);
  s.hub.redeliver(BRIDGE, a.id); // duplicate inbox event
  await s.make(store2).tick();
  assert.equal(s.hs.calls.filter((c) => c.op === 'retain').length, 4); // 2 failed + 2 ok, no duplicate
});

test('Mail text that no longer matches the recorded hash is never indexed (error, not silently replaced)', async (t) => {
  const s = await setup();
  t.after(s.tmp.cleanup);
  const m = send(s.hub, MAC, 'handoff', '原文 I');
  s.hs.mode.push('down');
  await s.bridge.tick();
  s.hub.messages[m.id - 1].body_md = JSON.stringify({ ...JSON.parse(s.hub.messages[m.id - 1].body_md), text: '被改過' });
  s.clock.advance(30_000);
  await s.bridge.tick();
  const r = await rec(s.store, m.id);
  assert.equal(r.status, 'error');
  assert.equal(r.lastError.code, 'MAIL_TEXT_MISMATCH');
});
