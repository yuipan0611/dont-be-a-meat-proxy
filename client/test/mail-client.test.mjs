import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailClient } from '../mail-client.mjs';
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
