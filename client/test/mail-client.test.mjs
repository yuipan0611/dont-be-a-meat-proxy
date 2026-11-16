import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailClient, createStaging, syncInbox } from '../mail-client.mjs';
import { FakeClock, fakeFetch, toolResult, handshake } from './helpers/fakes.mjs';

const PROJECT = '/data/projects/group-a';
const EVENT_ID = 'a6fac5ad-' + '984e-40cc-9cfb-716cd121b7f9';

function baseItem(over = {}) {
  return {
    to: ['RedStone'],
    subject: '交接登入頁',
    kind: 'handoff',
    intent: 'question',
    sourceSession: 'mac-session-01',
    summary: '登入頁完成',
    text: '測試已通過；下一步待確認',
    links: [],
    unfinished: [],
    clientEventId: EVENT_ID,
    ...over,
  };
}

function client(fetch, over = {}) {
  return createMailClient({
    url: 'http://hub.test/mcp/',
    token: '<HUB_TOKEN>',
    projectKey: PROJECT,
    agentName: 'BlueLake',
    senderToken: '<REGISTRATION_TOKEN>',
    clock: new FakeClock(),
    fetch,
    ...over,
  });
}

test('sendItem saves a handoff and returns the Hub message ID', async () => {
  const fetch = fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    return toolResult(rpc.id, {
      message_id: 42,
      thread_id: EVENT_ID,
      created_ts: '2026-11-17T01:00:00Z',
      verified_sender: true,
      target_outcomes: [{ recipient: 'RedStone', kind: 'to', outcome: 'delivered' }],
    });
  });
  const res = await client(fetch).sendItem(baseItem());
  assert.equal(res.status, 'saved');
  assert.equal(res.messageId, 42);
  assert.equal(res.createdTs, '2026-11-17T01:00:00Z');
});

// ---- transport failures (SDS API-02: 401 / 429 / 503 / timeout) ----
import { MailError } from '../mail-client.mjs';
import { hangingFetch } from './helpers/fakes.mjs';

function failingTool(status, extra = {}) {
  return fakeFetch((rpc) => handshake(rpc) ?? { status, body: { detail: 'x' }, ...extra });
}

async function rejectsWith(promise, expect) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof MailError, `expected MailError, got ${e}`);
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(e[k], v, `field ${k}`);
    return true;
  });
}

test('HTTP 401 is E-AUTH, not saved, not retryable', async () => {
  await rejectsWith(client(failingTool(401)).sendItem(baseItem()), {
    code: 'E-AUTH', delivery: 'not_saved', retryable: false, idempotencyKey: EVENT_ID,
  });
});

test('HTTP 429 is E-HUB rate_limited, not saved, retryable with the same key and Retry-After', async () => {
  const fetch = failingTool(429, { headers: { 'retry-after': '7' } });
  await rejectsWith(client(fetch).sendItem(baseItem()), {
    code: 'E-HUB', reason: 'rate_limited', delivery: 'not_saved', retryable: true, idempotencyKey: EVENT_ID,
  });
  await assert.rejects(client(fetch).sendItem(baseItem()), (e) => e.details.retryAfterMs === 7000);
});

test('HTTP 503 after the request was sent is 保存結果未確認 (unconfirmed), retryable', async () => {
  await rejectsWith(client(failingTool(503)).sendItem(baseItem()), {
    code: 'E-HUB', reason: 'unavailable', delivery: 'unconfirmed', retryable: true, message: '保存結果未確認',
  });
});

test('request timeout is unconfirmed, fires at the configured budget on the injected clock', async () => {
  const clock = new FakeClock();
  const fetch = hangingFetch();
  const p = client(fetch, { clock, timeoutMs: 10_000 }).sendItem(baseItem());
  let settled = false;
  p.catch(() => {}).finally(() => (settled = true));
  await clock.advance(9_999);
  assert.equal(settled, false);
  await clock.advance(1);
  await rejectsWith(p, { code: 'E-HUB', reason: 'timeout', delivery: 'unconfirmed', retryable: true });
});

test('connection refused before anything was sent is not saved', async () => {
  const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const fetch = fakeFetch((rpc) => handshake(rpc) ?? err);
  await rejectsWith(client(fetch).sendItem(baseItem()), { code: 'E-HUB', reason: 'network', delivery: 'not_saved', retryable: true });
});

test('connection dropped mid-request (reset) is unconfirmed', async () => {
  const err = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const fetch = fakeFetch((rpc) => handshake(rpc) ?? err);
  await rejectsWith(client(fetch).sendItem(baseItem()), { code: 'E-HUB', delivery: 'unconfirmed', retryable: true });
});

// ---- client-side validation (SDS API-02 send adapter; MVP checks only in client) ----

function recordingHub() {
  return fakeFetch((rpc) => handshake(rpc) ?? toolResult(rpc.id, { message_id: 1, created_ts: 't', thread_id: EVENT_ID }));
}
const toolCalls = (fetch) => fetch.calls.filter((c) => c.rpc.method === 'tools/call');

test('text of exactly 20,000 code points (all emoji, 40,000 UTF-16 units) is accepted', async () => {
  const fetch = recordingHub();
  const text = '😀'.repeat(20_000);
  assert.equal(text.length, 40_000);
  const res = await client(fetch).sendItem(baseItem({ text }));
  assert.equal(res.status, 'saved');
  assert.equal(JSON.parse(toolCalls(fetch)[0].rpc.params.arguments.body_md).text, text);
});

test('text of 20,001 code points is E-FIELD and never reaches the Hub', async () => {
  const fetch = recordingHub();
  await rejectsWith(client(fetch).sendItem(baseItem({ text: '字'.repeat(20_001) })), {
    code: 'E-FIELD', delivery: 'not_saved', details: { field: 'text', limit: 20_000, actual: 20_001 },
  });
  assert.equal(fetch.calls.length, 0);
});

test('text is sent unnormalized (NFD stays NFD)', async () => {
  const fetch = recordingHub();
  const nfd = 'é café'.normalize('NFD');
  await client(fetch).sendItem(baseItem({ text: nfd }));
  assert.equal(JSON.parse(toolCalls(fetch)[0].rpc.params.arguments.body_md).text, nfd);
});

for (const [name, over, field] of [
  ['unknown kind', { kind: 'chat' }, 'kind'],
  ['unknown intent', { intent: 'maybe' }, 'intent'],
  ['empty text', { text: '   ' }, 'text'],
  ['missing summary', { summary: undefined }, 'summary'],
  ['missing source session', { sourceSession: '' }, 'sourceSession'],
  ['no recipient', { to: [] }, 'to'],
  ['non-URL link', { links: ['not a url'] }, 'links'],
  ['non-string unfinished', { unfinished: [3] }, 'unfinished'],
  ['bad client event id', { clientEventId: 'abc' }, 'clientEventId'],
]) {
  test(`E-FIELD for ${name}, nothing sent`, async () => {
    const fetch = recordingHub();
    await rejectsWith(client(fetch).sendItem(baseItem(over)), { code: 'E-FIELD', delivery: 'not_saved' });
    await assert.rejects(client(fetch).sendItem(baseItem(over)), (e) => e.details.field === field);
    assert.equal(fetch.calls.length, 0);
  });
}

test('missing intent is sent as action (SRS: unlabeled → action)', async () => {
  const fetch = recordingHub();
  await client(fetch).sendItem(baseItem({ intent: undefined }));
  assert.equal(JSON.parse(toolCalls(fetch)[0].rpc.params.arguments.body_md).intent, 'action');
});

test('attachments are refused with E-ATTACH; attachment_paths is never sent', async () => {
  const fetch = recordingHub();
  await rejectsWith(client(fetch).sendItem(baseItem({ attachments: ['/etc/passwd'] })), { code: 'E-ATTACH', delivery: 'not_saved' });
  assert.equal(fetch.calls.length, 0);
  await client(fetch).sendItem(baseItem());
  const args = toolCalls(fetch)[0].rpc.params.arguments;
  assert.equal('attachment_paths' in args, false);
  assert.equal(args.convert_images, false);
});

test('envelope v1 wire format: topic = kind, thread and idempotency key = client_event_id', async () => {
  const fetch = recordingHub();
  await client(fetch).sendItem(baseItem({ links: ['https://github.com/o/r/pull/1'], unfinished: ['UI 文案'] }));
  const args = toolCalls(fetch)[0].rpc.params.arguments;
  assert.equal(args.topic, 'handoff');
  assert.equal(args.thread_id, EVENT_ID);
  assert.equal(args.idempotency_key, EVENT_ID);
  assert.equal(args.project_key, PROJECT);
  assert.equal(args.sender_name, 'BlueLake');
  assert.deepEqual(JSON.parse(args.body_md), {
    v: 1,
    client_event_id: EVENT_ID,
    kind: 'handoff',
    intent: 'question',
    source_session: 'mac-session-01',
    summary: '登入頁完成',
    text: '測試已通過；下一步待確認',
    links: ['https://github.com/o/r/pull/1'],
    unfinished: ['UI 文案'],
  });
});

test('recipient not in the configured roster is E-RCPT with the roster, nothing sent', async () => {
  const fetch = recordingHub();
  const c = client(fetch, { roster: ['RedStone', 'HubClock'] });
  await rejectsWith(c.sendItem(baseItem({ to: ['win-claud'] })), {
    code: 'E-RCPT', delivery: 'not_saved', details: { unknown: ['win-claud'], roster: ['RedStone', 'HubClock'] },
  });
  assert.equal(fetch.calls.length, 0);
});

// ---- minimal secret pre-check (SR-MSG-04 minimum categories) ----
const FAKE_SECRETS = {
  'openai-sk': 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  'github-ghp': 'ghp_' + 'a'.repeat(36),
  'github-pat': 'github_pat_' + '11ABCDEFG0' + 'x'.repeat(40),
  'private-key-pem': '-----\x42EGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----',
};
for (const [rule, secret] of Object.entries(FAKE_SECRETS)) {
  test(`E-SECRET (${rule}) blocks the send and the error never echoes the secret`, async () => {
    const fetch = recordingHub();
    let err;
    try {
      await client(fetch).sendItem(baseItem({ text: `請用這個：${secret} 謝謝` }));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof MailError);
    assert.equal(err.code, 'E-SECRET');
    assert.deepEqual(err.details.rules, [rule]);
    assert.equal(fetch.calls.length, 0);
    assert.equal(JSON.stringify({ m: err.message, d: err.details }).includes(secret.slice(0, 12)), false);
  });
}

test('secrets in summary / unfinished / links / subject are caught too', async () => {
  for (const over of [
    { summary: FAKE_SECRETS['github-ghp'] },
    { unfinished: [FAKE_SECRETS['openai-sk']] },
    { links: [`https://x.test/?t=${FAKE_SECRETS['github-ghp']}`] },
    { subject: FAKE_SECRETS['openai-sk'] },
  ]) {
    const fetch = recordingHub();
    await rejectsWith(client(fetch).sendItem(baseItem(over)), { code: 'E-SECRET' });
  }
});

test('ordinary text mentioning sk- or ghp_ briefly is not flagged', async () => {
  const fetch = recordingHub();
  const res = await client(fetch).sendItem(baseItem({ text: 'task-list 與 ghp_ 前綴說明；PRIVATE KEY 這個詞本身不算' }));
  assert.equal(res.status, 'saved');
});

// ---- retry with the same idempotency key (SDS: 429/503/timeout keep key, back off) ----

function scriptedHub(statuses) {
  // statuses: per tools/call attempt, a number (HTTP status) or 'ok'
  let i = 0;
  return fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s === 'ok') return toolResult(rpc.id, { message_id: 9, created_ts: 't', thread_id: EVENT_ID });
    return { status: s, body: { detail: 'x' }, headers: s === 429 ? { 'retry-after': '3' } : {} };
  });
}

test('sendWithRetry retries 503 with backoff on the injected clock and keeps the same key', async () => {
  const clock = new FakeClock();
  const fetch = scriptedHub([503, 503, 'ok']);
  const p = client(fetch, { clock }).sendWithRetry(baseItem(), { maxAttempts: 3, baseDelayMs: 1000 });
  await clock.advance(999);
  assert.equal(toolCalls(fetch).length, 1);
  await clock.advance(1); // 1st backoff 1s
  assert.equal(toolCalls(fetch).length, 2);
  await clock.advance(2000); // 2nd backoff 2s
  const res = await p;
  assert.equal(res.messageId, 9);
  assert.equal(res.attempts, 3);
  const keys = toolCalls(fetch).map((c) => c.rpc.params.arguments.idempotency_key);
  assert.deepEqual(keys, [EVENT_ID, EVENT_ID, EVENT_ID]);
});

test('sendWithRetry honours Retry-After on 429', async () => {
  const clock = new FakeClock();
  const fetch = scriptedHub([429, 'ok']);
  const p = client(fetch, { clock }).sendWithRetry(baseItem(), { maxAttempts: 2, baseDelayMs: 100 });
  await clock.advance(2999);
  assert.equal(toolCalls(fetch).length, 1);
  await clock.advance(1);
  assert.equal((await p).messageId, 9);
});

test('sendWithRetry stops immediately on 401', async () => {
  const fetch = scriptedHub([401, 'ok']);
  await rejectsWith(client(fetch).sendWithRetry(baseItem(), { maxAttempts: 5 }), { code: 'E-AUTH' });
  assert.equal(toolCalls(fetch).length, 1);
});

test('once any attempt was unconfirmed, exhausting retries still reports 保存結果未確認', async () => {
  const clock = new FakeClock();
  const fetch = scriptedHub([503, 429]);
  const p = client(fetch, { clock }).sendWithRetry(baseItem(), { maxAttempts: 2, baseDelayMs: 10 });
  p.catch(() => {});
  await clock.advance(60_000);
  await rejectsWith(p, { code: 'E-HUB', delivery: 'unconfirmed', idempotencyKey: EVENT_ID });
});

// ---- durable receive (SDS API-03) ----

function inboxHub({ pages, messages, failRead = new Set(), cursorError }) {
  return fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    if (rpc.method === 'resources/read') {
      const id = Number(rpc.params.uri.match(/message\/(\d+)/)[1]);
      if (failRead.has(id)) return { status: 503, body: 'down' };
      return { jsonrpc: '2.0', id: rpc.id, result: { contents: [{ uri: rpc.params.uri, text: messages[id] }] } };
    }
    const a = rpc.params.arguments;
    if (rpc.params.name === 'fetch_inbox_events') {
      if (cursorError) return toolResult(rpc.id, { error: { type: cursorError, message: cursorError } }, true);
      return toolResult(rpc.id, pages[a.after ?? 0]);
    }
    if (rpc.params.name === 'mark_message_read') return toolResult(rpc.id, { message_id: a.message_id, read: true });
    throw new Error('unexpected ' + JSON.stringify(rpc));
  });
}

const ev = (cursor, id) => ({ cursor, message_id: id, kind: 'to', delivered_ts: 't', subject: 's', from: 'BlueLake' });
const rawMsg = (id) => `{"id":${id},"body_md":"原文 ${id} 😀","from":"BlueLake"}`;

async function tmpStaging() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return createStaging({ dir: await mkdtemp(join(tmpdir(), 'hub-staging-unit-')) });
}

test('syncInbox pages oldest-first until has_more is false and commits the last cursor', async () => {
  const fetch = inboxHub({
    pages: {
      0: { events: [ev(1, 10), ev(2, 11)], next_cursor: 2, has_more: true, tail_cursor: 3 },
      2: { events: [ev(3, 12)], next_cursor: 3, has_more: false, tail_cursor: 3 },
    },
    messages: { 10: rawMsg(10), 11: rawMsg(11), 12: rawMsg(12) },
  });
  const staging = await tmpStaging();
  const r = await syncInbox({ client: client(fetch, { agentName: 'RedStone' }), staging });
  assert.deepEqual(r.staged, [10, 11, 12]);
  assert.equal(await staging.getCursor(), 3);
  assert.equal((await staging.get(11)).raw, rawMsg(11));
  const evArgs = toolCalls(fetch).filter((c) => c.rpc.params.name === 'fetch_inbox_events').map((c) => c.rpc.params.arguments);
  assert.ok(evArgs.every((a) => a.position_now === undefined && a.agent_name === 'RedStone'));
  assert.equal(toolCalls(fetch).some((c) => c.rpc.params.name === 'mark_message_read'), false);
});

test('a read failure mid-page does not commit the cursor; the next sync stages the rest', async () => {
  const pages = { 0: { events: [ev(1, 10), ev(2, 11)], next_cursor: 2, has_more: false, tail_cursor: 2 } };
  const messages = { 10: rawMsg(10), 11: rawMsg(11) };
  const staging = await tmpStaging();
  await assert.rejects(
    syncInbox({ client: client(inboxHub({ pages, messages, failRead: new Set([11]) })), staging }),
    (e) => e.code === 'E-HUB',
  );
  assert.equal(await staging.getCursor(), null);
  assert.deepEqual(await staging.list(), [10]);
  const r = await syncInbox({ client: client(inboxHub({ pages, messages })), staging });
  assert.deepEqual(r.staged, [11]);
  assert.equal(await staging.getCursor(), 2);
});

for (const type of ['CURSOR_EXPIRED', 'CURSOR_AHEAD']) {
  test(`${type} surfaces as E-CURSOR (收件游標需恢復) and leaves the cursor alone`, async () => {
    const staging = await tmpStaging();
    await staging.setCursor(5);
    await assert.rejects(syncInbox({ client: client(inboxHub({ cursorError: type })), staging }), (e) => {
      assert.equal(e.code, 'E-CURSOR');
      assert.equal(e.message, '收件游標需恢復');
      return true;
    });
    assert.equal(await staging.getCursor(), 5);
  });
}

test('markRead calls mark_message_read for this agent only when asked', async () => {
  const fetch = inboxHub({ pages: {}, messages: {} });
  await client(fetch, { agentName: 'RedStone' }).markRead(12);
  const [call] = toolCalls(fetch);
  assert.equal(call.rpc.params.name, 'mark_message_read');
  assert.deepEqual(call.rpc.params.arguments, { project_key: PROJECT, agent_name: 'RedStone', message_id: 12 });
});

test('staging.put never overwrites an already staged original', async () => {
  const staging = await tmpStaging();
  assert.equal(await staging.put(1, 'first'), true);
  assert.equal(await staging.put(1, 'second'), false);
  assert.equal((await staging.get(1)).raw, 'first');
});

test('HTTP 200 with an unparseable body after send is unconfirmed, not a crash', async () => {
  const fetch = fakeFetch((rpc) => handshake(rpc) ?? { status: 200, body: '<html>proxy page</html>' });
  await rejectsWith(client(fetch).sendItem(baseItem()), { code: 'E-HUB', reason: 'protocol', delivery: 'unconfirmed' });
});

// ---- H-05 additions: cc on items, typed control records ----
const CTL_KEY = '3b0c6f1e-' + '2d4a-5b7c-a1d2-0123456789ab';

function captureSend() {
  return fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    return toolResult(rpc.id, { message_id: 7, thread_id: rpc.params.arguments.thread_id, created_ts: '2026-11-17T01:00:00Z' });
  });
}
const sentArgs = (fetch) => fetch.calls.find((c) => c.rpc.method === 'tools/call').rpc.params.arguments;

test('sendItem forwards cc (e.g. the HubClock agent) to send_message', async () => {
  const fetch = captureSend();
  await client(fetch).sendItem(baseItem({ cc: ['QuietHarbor'] }));
  assert.deepEqual(sentArgs(fetch).cc, ['QuietHarbor']);
});

test('sendItem without cc sends no cc field', async () => {
  const fetch = captureSend();
  await client(fetch).sendItem(baseItem());
  assert.equal('cc' in sentArgs(fetch), false);
});

test('sendControl sends topic=control, the JSON record verbatim and the given fixed key', async () => {
  const fetch = captureSend();
  const control = { v: 1, event_type: 'presented', root_mail_id: 12, recipient_session: 'win-s1', agent: 'RedStone' };
  const r = await client(fetch).sendControl({ to: ['QuietHarbor'], subject: 'presented #12', threadId: EVENT_ID, control, idempotencyKey: CTL_KEY });
  const a = sentArgs(fetch);
  assert.equal(a.topic, 'control');
  assert.equal(a.idempotency_key, CTL_KEY);
  assert.equal(a.thread_id, EVENT_ID);
  assert.deepEqual(JSON.parse(a.body_md), control);
  assert.equal(a.attachment_paths, undefined);
  assert.equal(r.status, 'saved');
  assert.equal(r.idempotencyKey, CTL_KEY);
});

test('sendControl rejects a missing/invalid key or non-v1 record before any network call', async () => {
  const fetch = captureSend();
  const c = client(fetch);
  const control = { v: 1, event_type: 'choice' };
  await assert.rejects(c.sendControl({ to: ['X'], subject: 's', control }), (e) => e.code === 'E-FIELD' && e.details.field === 'idempotencyKey');
  await assert.rejects(c.sendControl({ to: ['X'], subject: 's', control: { v: 2, event_type: 'x' }, idempotencyKey: CTL_KEY }), (e) => e.details.field === 'control');
  await assert.rejects(c.sendControl({ to: [], subject: 's', control, idempotencyKey: CTL_KEY }), (e) => e.details.field === 'to');
  assert.equal(fetch.calls.length, 0);
});

test('sendControlWithRetry reuses the same key across a 503 and succeeds', async () => {
  let n = 0;
  const fetch = fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    if (++n === 1) return { status: 503, body: '' };
    return toolResult(rpc.id, { message_id: 8, thread_id: CTL_KEY, created_ts: '2026-11-17T01:00:00Z' });
  });
  const clock = new FakeClock();
  const p = client(fetch, { clock }).sendControlWithRetry(
    { to: ['QuietHarbor'], subject: 's', control: { v: 1, event_type: 'session.closed' }, idempotencyKey: CTL_KEY },
    { baseDelayMs: 1000 });
  await clock.advance(1000);
  const r = await p;
  assert.equal(r.attempts, 2);
  const keys = fetch.calls.filter((c) => c.rpc.method === 'tools/call').map((c) => c.rpc.params.arguments.idempotency_key);
  assert.deepEqual(keys, [CTL_KEY, CTL_KEY]);
});
