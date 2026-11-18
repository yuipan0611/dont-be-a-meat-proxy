// L-02b Hindsight REST client: request shape and error classification (drives pending/unknown/error).
// Run: node --test ops/memory-bridge/test/hindsight-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHindsightClient } from '../hindsight-client.mjs';

const listen = (handler) => new Promise((res) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

async function fake(reply) {
  const seen = [];
  const up = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: b }); reply(req, res, b); });
  });
  return { ...up, seen };
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const ITEM = { content: '原文', document_id: 'mail-7', context: 'handoff', timestamp: '2026-11-17T00:00:00Z', metadata: { mail_id: '7' } };

test('retain: synchronous POST to the bank with the tenant key; 200 → ok', async (t) => {
  const f = await fake((req, res) => json(res, 200, { success: true, items_count: 1 }));
  t.after(() => close(f.server));
  const c = createHindsightClient({ url: f.url, apiKey: 'tenant-key' });
  assert.deepEqual(await c.retain('group-a', ITEM), { ok: true });
  const [r] = f.seen;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/default/banks/group-a/memories');
  assert.equal(r.headers.authorization, 'Bearer tenant-key');
  assert.deepEqual(JSON.parse(r.body), { items: [ITEM], async: false });
});

test('errors are classified: refused → unreachable, 5xx → failed, 4xx → rejected(+status), timeout → unknown, success:false → failed', async (t) => {
  const dead = await listen(() => {});
  await close(dead.server); // a port that was just freed: connection refused
  const c0 = createHindsightClient({ url: dead.url, apiKey: 'k' });
  await assert.rejects(c0.retain('group-a', ITEM), (e) => e.kind === 'unreachable');

  let mode = 500;
  const f = await fake((req, res, b) => {
    if (mode === 'hang') return; // never answers
    if (mode === 'false') return json(res, 200, { success: false, error: 'x' });
    json(res, mode, { detail: 'rate_limit_error 今日 LLM 額度已用完' });
  });
  t.after(() => close(f.server));
  const c = createHindsightClient({ url: f.url, apiKey: 'k', timeoutMs: 200 });
  await assert.rejects(c.retain('group-a', ITEM), { kind: 'failed', status: 500, code: 'HINDSIGHT_HTTP', message: 'HINDSIGHT_HTTP' });
  mode = 422;
  await assert.rejects(c.retain('group-a', ITEM), (e) => e.kind === 'rejected' && e.status === 422);
  mode = 'false';
  await assert.rejects(c.retain('group-a', ITEM), (e) => e.kind === 'failed');
  mode = 'hang';
  await assert.rejects(c.retain('group-a', ITEM), (e) => e.kind === 'unknown');
});

test('HTTP, success:false and malformed JSON errors carry only safe diagnostics', async (t) => {
  let status = 500;
  let body = JSON.stringify({ success: false, detail: '私密 fixture' });
  const f = await fake((req, res) => { res.writeHead(status); res.end(body); });
  t.after(() => close(f.server));
  const c = createHindsightClient({ url: f.url, apiKey: 'k' });
  for (const [httpStatus, code, response] of [
    [500, 'HINDSIGHT_HTTP', body],
    [200, 'HINDSIGHT_RETAIN_FAILED', body],
    [200, 'HINDSIGHT_INVALID_JSON', 'private fixture'],
  ]) {
    status = httpStatus;
    body = response;
    await assert.rejects(c.retain('group-a', ITEM), {
      code, message: code, status,
      length: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }
});

test('getDocument: 200 → document, 404 → null, other → classified error; IDs are path-encoded', async (t) => {
  let status = 200;
  const f = await fake((req, res) => (status === 200 ? json(res, 200, { id: 'mail-7', original_text: '原文' }) : json(res, status, {})));
  t.after(() => close(f.server));
  const c = createHindsightClient({ url: f.url, apiKey: 'k' });
  assert.equal((await c.getDocument('group-a', 'mail-7')).original_text, '原文');
  assert.equal(f.seen[0].url, '/v1/default/banks/group-a/documents/mail-7');
  status = 404;
  assert.equal(await c.getDocument('group-a', 'mail-7'), null);
  status = 503;
  await assert.rejects(c.getDocument('group-a', 'mail-7'), (e) => e.kind === 'failed');
});
