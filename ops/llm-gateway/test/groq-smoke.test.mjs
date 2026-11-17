import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSmoke, privateKey } from '../groq-smoke.mjs';

test('live-smoke private file reader rejects public modes and symlinks without printing keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'groq-smoke-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'key'); writeFileSync(file, 'FAKE-KEY\n', { mode: 0o600 });
  assert.equal(privateKey(file), 'FAKE-KEY'); chmodSync(file, 0o644); assert.throws(() => privateKey(file), /private/);
  chmodSync(file, 0o400); assert.equal(privateKey(file), 'FAKE-KEY'); symlinkSync(file, join(dir, 'link')); assert.throws(() => privateKey(join(dir, 'link')), /private/);
});

test('live smoke uses gateway for chat and Hindsight for real extraction, then deletes only its scratch bank', async () => {
  const calls = [], output = []; let original;
  await runSmoke({ gatewayUrl: 'http://gateway', gatewayKey: 'FAKE-GW', hindsightUrl: 'http://hindsight', hindsightKey: 'FAKE-HS', log: (m) => output.push(m), fetchImpl: async (url, options) => {
    const b = options.body && JSON.parse(options.body); calls.push({ url, ...options, body: b });
    if (url.includes('chat/completions')) return Response.json({ choices: [{ message: b.tools ? { tool_calls: [{ function: { name: 'read_status', arguments: '{}' } }] } : { content: '測試成功。' } }] });
    if (url.endsWith('/memories')) { assert.equal(b.async, false); original = b.items[0].content; return Response.json({ success: true }); }
    if (url.endsWith('/documents/synthetic')) return Response.json({ original_text: original });
    if (url.endsWith('/memories/recall')) return Response.json({ results: [{ text: '小明住在臺南。' }] });
    return Response.json({});
  } });
  assert.equal(calls.length, 7); assert.equal(calls.filter((c) => c.url.includes('gateway')).length, 2);
  assert.equal(calls.at(-1).method, 'DELETE'); assert.match(calls.at(-1).url, /\/banks\/f11b-smoke-[a-f0-9-]+$/);
  assert.ok(calls.every((c) => !c.url.includes('api.groq.com'))); assert.equal(output.join().includes('FAKE'), false);
});

test('Hindsight failure still cleans up; HTTP errors do not disclose bodies or retry', async () => {
  const calls = [];
  await assert.rejects(runSmoke({ gatewayUrl: 'http://gateway', gatewayKey: 'FAKE', hindsightUrl: 'http://hindsight', hindsightKey: 'FAKE', log: () => {}, fetchImpl: async (url, options) => {
    calls.push(options.method);
    if (url.includes('chat/completions')) return Response.json({ choices: [{ message: JSON.parse(options.body).tools ? { tool_calls: [{ function: { name: 'read_status', arguments: '{}' } }] } : { content: '成功。' } }] });
    if (url.endsWith('/memories')) return new Response('PRIVATE provider detail', { status: 500 });
    return Response.json({});
  } }), (e) => e.message === 'sync retain: HTTP 500');
  assert.deepEqual(calls, ['POST', 'POST', 'PUT', 'POST', 'DELETE']);
});

test('malformed smoke tool arguments are reported without echoing model content', async () => {
  let calls = 0;
  await assert.rejects(runSmoke({ gatewayUrl: 'http://gateway', gatewayKey: 'FAKE', hindsightUrl: 'http://hindsight', hindsightKey: 'FAKE', log: () => {}, fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ message: calls === 1 ? { content: '測試成功。' } : { tool_calls: [{ function: { name: 'read_status', arguments: 'PRIVATE invalid JSON' } }] } }] });
  } }), (e) => e.message === 'tool smoke: invalid function arguments');
  assert.equal(calls, 2, 'failed tool stage does not write a Hindsight bank or retry');
});
