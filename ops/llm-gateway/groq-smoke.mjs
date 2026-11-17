#!/usr/bin/env node
// PM-only live smoke. Both chat requests and Hindsight extraction use the deployed gateway.
// The Groq provider key is read by main.mjs from its private mount, never by a consumer.
import { readFileSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function privateKey(file) {
  const s = lstatSync(file);
  if (!s.isFile() || (s.mode & 0o777) & 0o077 || !(s.mode & 0o400)) throw new Error('key file must be private and owner-readable (0400/0600)');
  const key = readFileSync(file, 'utf8').trim();
  if (!key || /\s/.test(key)) throw new Error('invalid key file');
  return key;
}

function base(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('URL must be an origin without credentials');
  return u.origin;
}

export async function runSmoke({ gatewayUrl, gatewayKey, hindsightUrl, hindsightKey, fetchImpl = fetch, log = console.log }) {
  const gw = base(gatewayUrl), hs = base(hindsightUrl);
  const bank = `f11b-smoke-${randomUUID()}`, path = `/v1/default/banks/${bank}`;
  const content = '測試使用者小明住在臺南，最喜歡無糖綠茶。這是 F-11b 合成測試資料。';
  async function api(origin, key, method, route, body, stage, timeoutMs = 90_000) {
    try {
      const response = await fetchImpl(origin + route, { method, redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (method === 'DELETE') return;
      return await response.json();
    } catch (e) { throw new Error(`${stage}: ${/^HTTP \d+$/.test(e.message) ? e.message : 'request failed or timed out; not retried'}`); }
  }
  const chat = (body) => api(gw, gatewayKey, 'POST', '/v1/chat/completions', { model: 'hub-llm', max_tokens: 256, ...body }, 'gateway');
  let started = Date.now();
  const answer = await chat({ messages: [{ role: 'user', content: '請用一句繁體中文說明測試成功，不要呼叫工具。' }] });
  const text = answer.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !/[\u3400-\u9fff]/u.test(text)) throw new Error('zh-TW smoke: missing Chinese answer');
  log(`PASS Chinese response (${Date.now() - started} ms); PM must assess Traditional Chinese quality`);
  started = Date.now();
  const tool = await chat({ messages: [{ role: 'user', content: '請呼叫 read_status 一次。' }],
    tools: [{ type: 'function', function: { name: 'read_status', description: 'Return read-only test status', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    tool_choice: { type: 'function', function: { name: 'read_status' } }, parallel_tool_calls: false });
  const calls = tool.choices?.[0]?.message?.tool_calls;
  if (calls?.length !== 1 || calls[0].function?.name !== 'read_status' || JSON.stringify(JSON.parse(calls[0].function.arguments)) !== '{}') throw new Error('tool smoke: incorrect function call');
  log(`PASS native function call (${Date.now() - started} ms); no tool executed`);
  started = Date.now();
  let cleanupNeeded = false;
  try {
    cleanupNeeded = true; // creation may succeed even when its HTTP response is lost
    await api(hs, hindsightKey, 'PUT', path, { name: 'F-11b temporary smoke bank' }, 'create bank');
    const retained = await api(hs, hindsightKey, 'POST', `${path}/memories`, { items: [{ content, document_id: 'synthetic', context: 'F-11b smoke' }], async: false }, 'sync retain', 300_000);
    if (retained?.success === false) throw new Error('sync retain returned success:false');
    const doc = await api(hs, hindsightKey, 'GET', `${path}/documents/synthetic`, undefined, 'document');
    if (doc.original_text !== content) throw new Error('Hindsight document does not match');
    const recalled = await api(hs, hindsightKey, 'POST', `${path}/memories/recall`, { query: '小明住在哪裡？喜歡喝什麼？', budget: 'low', max_tokens: 512 }, 'recall', 300_000);
    if (!Array.isArray(recalled.results) || !recalled.results.some((r) => typeof r.text === 'string' && r.text.trim())) throw new Error('no extracted facts recalled');
    log(`PASS Hindsight sync retain + document + nonempty recalled facts (${Date.now() - started} ms)`);
  } finally {
    if (cleanupNeeded) {
      try { await api(hs, hindsightKey, 'DELETE', path, undefined, 'delete scratch bank'); log('PASS scratch bank removed'); }
      catch { throw new Error(`cleanup failed: operator must remove scratch bank ${bank}; no retry attempted`); }
    }
  }
  log('All smoke checks passed; assess fact accuracy and production gateway logs separately.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { 'gateway-url': { type: 'string' }, 'gateway-key-file': { type: 'string' }, 'hindsight-url': { type: 'string' }, 'hindsight-key-file': { type: 'string' } } });
    for (const name of ['gateway-url', 'gateway-key-file', 'hindsight-url', 'hindsight-key-file']) if (!values[name]) throw new Error(`--${name} required`);
    // Validate URLs and both file permissions before any live request.
    await runSmoke({ gatewayUrl: base(values['gateway-url']), hindsightUrl: base(values['hindsight-url']), gatewayKey: privateKey(values['gateway-key-file']), hindsightKey: privateKey(values['hindsight-key-file']) });
  } catch (e) { console.error(`FAIL ${e.code ? 'configuration or private file unavailable' : e.message}`); process.exitCode = 1; }
}
