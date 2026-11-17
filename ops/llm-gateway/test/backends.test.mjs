import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../backends.mjs';
import { createGeminiApi } from '../gemini-api.mjs';
import { prepare } from '../protocol.mjs';

const request = (fake = {}) => prepare({ model: 'hub-llm', max_tokens: 512, messages: [{ role: 'user', content: JSON.stringify({ fake }) }] }, 'anthropic', ['hub-llm']);
const apiData = (text = '繁體中文測試。') => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });

test('configuration selects free / paid Gemini API without fallback and keeps the logical client model separate', async () => {
  for (const type of ['gemini-api-free', 'gemini-api-paid']) {
    const calls = [];
    const backend = createBackend({ type, model: 'gemini-3.1-flash-lite', apiKey: 'FAKE-provider-key', fetchImpl: async (url, options) => {
      calls.push({ url, options }); return Response.json(apiData());
    } });
    const req = request();
    const answer = req.finish(await backend.generate(req));
    assert.equal(answer.model, 'hub-llm'); assert.equal(answer.content[0].text, '繁體中文測試。');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(calls[0].options.headers['x-goog-api-key'], 'FAKE-provider-key');
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.generationConfig.maxOutputTokens, 512);
    assert.equal(sent.tools, undefined, 'no remote built-in tool execution');
    assert.deepEqual(answer.usage, { input_tokens: 10, output_tokens: 20 });
  }
  await assert.rejects(createBackend({ type: 'disabled' }).generate(request()), { code: 'BACKEND_UNCONFIGURED' });
  assert.throws(() => createBackend({ type: 'unknown', model: 'x' }), /unsupported/);
  assert.throws(() => createBackend({ type: 'gemini-api-free', model: 'x' }), /key required/);
});

test('Gemini API quota/auth/5xx/truncation failures never retry or expose upstream bodies', async () => {
  for (const [status, code] of [[429, 'UPSTREAM_QUOTA'], [403, 'AUTH_REQUIRED'], [401, 'AUTH_REQUIRED'], [500, 'API_FAILED']]) {
    let count = 0;
    const backend = createGeminiApi({ key: 'SECRET', fetchImpl: async () => { count++; return new Response('SECRET raw upstream body', { status }); } });
    await assert.rejects(backend.generate(request()), (e) => e.code === code && !e.message.includes('SECRET'));
    assert.equal(count, 1);
  }
  for (const [data, code] of [[{ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'OUTPUT_TRUNCATED'], [{ candidates: [] }, 'API_NO_ANSWER'], [apiData(''), 'EMPTY_RESPONSE']]) {
    const backend = createGeminiApi({ key: 'FAKE', fetchImpl: async () => Response.json(data) });
    await assert.rejects(backend.generate(request()), { code });
  }
  const invalidKey = createGeminiApi({ key: 'FAKE', fetchImpl: async () => Response.json({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 }) });
  await assert.rejects(invalidKey.generate(request()), { code: 'AUTH_REQUIRED' });
});

test('Gemini API enforces a deadline and caller cancellation without a provider fallback', async () => {
  const never = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const hold = setTimeout(() => {}, 1000); // AbortSignal timers are unrefed
  try {
    await assert.rejects(createGeminiApi({ key: 'FAKE', timeoutMs: 10, fetchImpl: never }).generate(request()), { code: 'API_TIMEOUT' });
    const c = new AbortController();
    const work = createGeminiApi({ key: 'FAKE', fetchImpl: never }).generate({ ...request(), signal: c.signal });
    c.abort(); await assert.rejects(work, { code: 'CANCELLED' });
  } finally { clearTimeout(hold); }
});

test('Antigravity fixture uses documented stream-json stdin and refuses tool activity / unsafe dedicated profiles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11-agy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exe = join(dir, 'agy');
  writeFileSync(exe, readFileSync(new URL('./fixtures/fake-gemini.mjs', import.meta.url), 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`)); chmodSync(exe, 0o700);
  const profile = join(dir, 'profile'), settingsDir = join(profile, '.gemini/antigravity-cli');
  mkdirSync(settingsDir, { recursive: true });
  copyFileSync(new URL('../antigravity-settings.json', import.meta.url), join(settingsDir, 'settings.json'));
  const record = join(dir, 'args.jsonl');
  const backend = createBackend({ type: 'antigravity-cli', model: 'Gemini 3.8 Flash', command: exe, profileDir: profile, inheritedHome: profile });
  const result = await backend.generate(request({ record }));
  assert.equal(result.text, '已確認：繁體中文測試。');
  const invocation = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(invocation.args.includes('--disable-slash-commands'), true);
  assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'Gemini 3.8 Flash');
  assert.equal(invocation.env.GEMINI_API_KEY, undefined);
  await assert.rejects(backend.generate(request({ mode: 'tool-run' })), { code: 'INVALID_CLI_JSON' });
  const unsafe = createBackend({ type: 'antigravity-cli', model: 'Gemini 3.8 Flash', command: exe, profileDir: profile, inheritedHome: '/unrelated-user' });
  await assert.rejects(unsafe.generate(request()), { code: 'UNSAFE_CLI_PROFILE' });
  mkdirSync(join(profile, '.gemini/config'), { recursive: true });
  writeFileSync(join(profile, '.gemini/config/hooks.json'), '{}');
  await assert.rejects(backend.generate(request()), { code: 'UNSAFE_CLI_PROFILE' });
});

test('Gemini CLI can also be selected explicitly using the fake executable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exe = join(dir, 'gemini');
  writeFileSync(exe, readFileSync(new URL('./fixtures/fake-gemini.mjs', import.meta.url), 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`)); chmodSync(exe, 0o700);
  const backend = createBackend({ type: 'gemini-cli', model: 'gemini-3.5-flash', command: exe, profileDir: dir });
  assert.equal((await backend.generate(request())).text, '已確認：繁體中文測試。');
});
