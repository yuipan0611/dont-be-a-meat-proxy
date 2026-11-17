// L-02 LLM gateway: every paid call reserves from the global ledger before it is sent.
// Run: node --test ops/bank-proxy/test/llm-gateway.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../budget.mjs';
import { createLlmGateway } from '../llm-gateway.mjs';

const listen = (handler) => new Promise((res) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/** Fake Anthropic: records what it got, answers with the configured reply. */
async function fakeAnthropic() {
  const seen = [];
  let reply = (req, body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '好' }], usage: { input_tokens: 1000, output_tokens: 100 } }));
  };
  const up = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: b }); reply(req, b, res); });
  });
  return { ...up, seen, setReply: (f) => { reply = f; } };
}

async function setup({ capMicros = 500_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-'));
  const clock = { now: () => Date.parse('2026-11-20T03:00:00Z') };
  const ledger = createLedger({ file: join(dir, 'ledger.json'), capMicros, clock });
  const up = await fakeAnthropic();
  const gw = createLlmGateway({ ledger, upstreamUrl: up.url, upstreamKey: 'sk-re\x61l-upstream', clientKeys: { 'internal-hindsight-key': 'hindsight' } });
  const g = await listen(gw);
  const call = (body, { key = 'internal-hindsight-key', path = '/v1/messages', headers = {} } = {}) => fetch(`${g.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const cleanup = async () => { await close(g.server); await close(up.server); rmSync(dir, { recursive: true, force: true }); };
  return { ledger, up, call, cleanup };
}

const MSG = { model: 'claude-haiku-5-5', max_tokens: 1000, messages: [{ role: 'user', content: '萃取事實' }] };

test('forwards to Anthropic with the real key (never the internal one) and settles the actual cost', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const r = await s.call(MSG);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).content[0].text, '好');
  const [got] = s.up.seen;
  assert.equal(got.url, '/v1/messages');
  assert.equal(got.headers['x-api-key'], 'sk-re\x61l-upstream');
  assert.equal(got.headers['anthropic-version'], '2023-06-01');
  assert.equal(got.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(got.body), MSG);
  // 1000 in × 0.1 + 100 out × 0.5 = 150 µUSD
  assert.deepEqual(s.ledger.status(), { day: '2026-11-20', capMicros: 500_000, spentMicros: 150, reservedMicros: 0 });
});

test('unknown or missing client key → 401, nothing forwarded', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal((await s.call(MSG, { key: 'sk-re\x61l-upstream' })).status, 401);
  assert.equal((await s.call(MSG, { key: '' })).status, 401);
  assert.equal(s.up.seen.length, 0);
});

test('only POST /v1/messages; an unpriced model or missing max_tokens is refused before sending', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal((await s.call(MSG, { path: '/v1/models' })).status, 404);
  const bad = await s.call({ ...MSG, model: 'claude-opus-5-5' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error.message, /not priced/);
  assert.equal((await s.call({ ...MSG, max_tokens: undefined })).status, 400);
  assert.equal((await s.call('{not json')).status, 400);
  assert.equal(s.up.seen.length, 0);
});

test('over the daily cap → 429 rate_limit_error with x-should-retry: false, nothing forwarded (hard cap, not metrics)', async (t) => {
  const s = await setup({ capMicros: 300 });
  t.after(s.cleanup);
  // worst case for MSG ≈ body bytes × 0.1 + 1000 × 0.5 = ~510 µUSD > 300
  const r = await s.call(MSG);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('x-should-retry'), 'false');
  const body = await r.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /今日/);
  assert.equal(s.up.seen.length, 0);
});

test('concurrent calls share one cap: the second reservation is refused while the first is in flight', async (t) => {
  const s = await setup({ capMicros: 800 });
  t.after(s.cleanup);
  let release;
  s.up.setReply((req, b, res) => { release = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 10 } })); }; });
  const first = s.call(MSG);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const second = await s.call(MSG);
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(s.ledger.status().spentMicros, 6); // 10×0.1 + 10×0.5 = 6
});

test('streaming: SSE is passed through unchanged and settled from message_start / message_delta usage', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2000,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"繁體"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":300}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  s.up.setReply((req, b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const next = () => (i < sse.length ? res.write(sse[i++], () => setTimeout(next, 2)) : res.end());
    next();
  });
  const r = await s.call({ ...MSG, stream: true });
  assert.equal(await r.text(), sse.join(''));
  assert.equal(s.ledger.status().spentMicros, 2000 * 0.1 + 300 * 0.5);
  assert.equal(s.ledger.status().reservedMicros, 0);
});

test('upstream error status → reservation released (not billed); missing usage on 200 → charged in full', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.up.setReply((req, b, res) => { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"x"}}'); });
  assert.equal((await s.call(MSG)).status, 529);
  assert.deepEqual([s.ledger.status().spentMicros, s.ledger.status().reservedMicros], [0, 0]);
  s.up.setReply((req, b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"no":"usage"}'); });
  await (await s.call(MSG)).text();
  const st = s.ledger.status();
  assert.ok(st.spentMicros >= 500, `charged the full reservation, got ${st.spentMicros}`);
  assert.equal(st.reservedMicros, 0);
});
