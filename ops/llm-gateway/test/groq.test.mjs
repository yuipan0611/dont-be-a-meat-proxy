import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../backends.mjs';
import { createGroqApi, GROQ_MODEL } from '../groq-api.mjs';
import { prepare } from '../protocol.mjs';
import { createGateway } from '../gateway.mjs';
import { createRequestBudget } from '../request-budget.mjs';
import { createGatewayClient } from '../client.mjs';
import { createAssistant, createReadOnlyTools } from '../../../bot/src/assistant.mjs';
import { createGatewayBudget } from '../../../bot/src/budget.mjs';
import { createMemoryStore } from '../../../bot/test/helpers/store-memory.mjs';
import { createFakeMail, FakeClock, seed } from '../../../bot/test/helpers/fakes.mjs';
import { createProvider } from '../../eval/eval-classify.mjs';

const tool = { name: 'read_status', description: 'Read only status', input_schema: { type: 'object', properties: {}, additionalProperties: false } };
const body = (extra = {}) => ({ model: 'hub-llm', max_tokens: 256, messages: [{ role: 'user', content: '請用繁體中文回答。' }], ...extra });
const req = (extra = {}, protocol = 'anthropic') => prepare(body(extra), protocol, ['hub-llm']);
const data = (content = '服務正常。', calls) => ({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
const call = (name = tool.name, args = '{}') => ({ id: 'provider-call', type: 'function', function: { name, arguments: args } });

test('Groq factory uses the official endpoint and both allowed native models, preserving the logical client model', async () => {
  for (const model of [GROQ_MODEL, 'openai/gpt-oss-20b']) {
    let sent;
    const backend = createBackend({ type: 'groq-api', model, apiKey: 'FAKE-secret', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer FAKE-secret'); assert.equal(options.redirect, 'error');
      sent = JSON.parse(options.body); return Response.json(data());
    } });
    const r = req({ system: '你是助理。' });
    const out = r.finish(await backend.generate(r));
    assert.equal(out.model, 'hub-llm'); assert.equal(out.content[0].text, '服務正常。');
    assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 8 });
    assert.equal(sent.model, model); assert.equal(sent.max_completion_tokens, 256);
    assert.equal(sent.include_reasoning, false); assert.equal(sent.reasoning_effort, 'low');
    assert.equal(sent.reasoning_format, undefined); assert.equal(sent.stream, false);
    assert.deepEqual(sent.messages.slice(1), [{ role: 'system', content: '你是助理。' }, { role: 'user', content: '請用繁體中文回答。' }]);
    assert.equal(sent.messages.some((m) => m.content?.includes('Return ONLY JSON')), false);
  }
  assert.throws(() => createGroqApi({}), /key required/);
  await assert.rejects(createGroqApi({ key: 'FAKE' }).generate({ ...req(), model: 'other' }), { code: 'INVALID_REQUEST' });
});

test('Anthropic native tool call and result IDs survive the second turn without executing tools in the gateway', async () => {
  const seen = [];
  const backend = createGroqApi({ key: 'FAKE', fetchImpl: async (url, options) => {
    seen.push(JSON.parse(options.body)); return Response.json(seen.length === 1 ? data(null, [call()]) : data('已讀取狀態。'));
  } });
  const r = req({ tools: [tool], tool_choice: { type: 'tool', name: tool.name } });
  const first = r.finish(await backend.generate({ ...r, model: GROQ_MODEL }));
  const use = first.content[0]; assert.equal(use.type, 'tool_use'); assert.deepEqual(use.input, {});
  assert.equal(seen[0].parallel_tool_calls, false);
  assert.deepEqual(seen[0].tool_choice, { type: 'function', function: { name: tool.name } });
  const next = req({ tools: [tool], messages: [...body().messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'ok' }] }] });
  assert.equal(next.finish(await backend.generate({ ...next, model: GROQ_MODEL })).content[0].text, '已讀取狀態。');
  assert.equal(seen[1].messages.at(-2).tool_calls[0].id, use.id);
  assert.deepEqual(seen[1].messages.at(-1), { role: 'tool', tool_call_id: use.id, content: 'ok' });
});

test('Hindsight OpenAI non-strict extraction JSON and OpenAI function history stay native', async () => {
  let sent;
  const backend = createGroqApi({ key: 'FAKE', fetchImpl: async (url, options) => { sent = JSON.parse(options.body); return Response.json(data('{"facts":["小明喜歡綠茶"]}')); } });
  const r = req({ response_format: { type: 'json_schema', json_schema: { name: 'facts', strict: false, schema: { type: 'object' } } }, messages: [{ role: 'system', content: 'Extract facts.' }, { role: 'user', content: '小明喜歡綠茶。' }] }, 'openai');
  const out = r.finish(await backend.generate({ ...r, model: GROQ_MODEL }));
  assert.deepEqual(JSON.parse(out.choices[0].message.content), { facts: ['小明喜歡綠茶'] });
  assert.equal(sent.response_format.json_schema.name, 'facts'); assert.equal(sent.response_format.json_schema.strict, false);
  const history = req({ messages: [{ role: 'assistant', tool_calls: [call()] }, { role: 'tool', tool_call_id: 'provider-call', content: 'ok' }] }, 'openai');
  assert.equal(history.chat.messages[1].tool_calls[0].id, 'provider-call');
  assert.equal(history.chat.messages[2].tool_call_id, 'provider-call');
});

test('Groq rejects invalid tool output, truncation and missing answers with shared validation', async () => {
  const cases = [
    [data(null, [call('unknown')]), 'INVALID_TOOL_RESPONSE'], [data(null, [call(tool.name, '[]')]), 'INVALID_TOOL_RESPONSE'],
    [data(null, [call(tool.name, '{')]), 'INVALID_TOOL_RESPONSE'], [data(null, [call(), call()]), 'INVALID_TOOL_RESPONSE'],
    [data('no call'), 'TOOL_CHOICE_VIOLATION'], [{ choices: [{ finish_reason: 'length' }] }, 'OUTPUT_TRUNCATED'],
    [{ choices: [] }, 'API_NO_ANSWER'],
  ];
  for (const [reply, code] of cases) {
    const r = req({ tools: [tool], tool_choice: 'any' });
    const backend = createGroqApi({ key: 'FAKE', fetchImpl: async () => Response.json(reply) });
    await assert.rejects(async () => r.finish(await backend.generate({ ...r, model: GROQ_MODEL })), { code });
  }
  const backend = createGroqApi({ key: 'FAKE', fetchImpl: async () => Response.json(data(null, [call()])) });
  await assert.rejects(backend.generate({ ...req(), model: GROQ_MODEL }), { code: 'INVALID_TOOL_RESPONSE' });
});

test('Groq errors never retry or disclose provider bodies, including invalid JSON', async () => {
  for (const [status, code] of [[429, 'UPSTREAM_QUOTA'], [401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [500, 'API_FAILED'], [200, 'INVALID_API_JSON']]) {
    let calls = 0;
    const backend = createGroqApi({ key: 'SECRET', fetchImpl: async () => { calls++; return new Response('SECRET provider body', { status }); } });
    await assert.rejects(backend.generate({ ...req(), model: GROQ_MODEL }), (e) => e.code === code && !e.message.includes('SECRET'));
    assert.equal(calls, 1);
  }
});

test('Groq deadline covers headers and body; caller cancellation stops the request', async () => {
  const hang = (signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private detail')), { once: true }));
  const hold = setTimeout(() => {}, 1000);
  try {
    for (const bodyTimeout of [false, true]) {
      const backend = createGroqApi({ key: 'FAKE', timeoutMs: 10, fetchImpl: async (url, { signal }) => bodyTimeout ? { ok: true, json: () => hang(signal) } : hang(signal) });
      await assert.rejects(backend.generate({ ...req(), model: GROQ_MODEL }), { code: 'API_TIMEOUT' });
    }
    const c = new AbortController();
    const backend = createGroqApi({ key: 'FAKE', fetchImpl: (url, { signal }) => hang(signal) });
    const work = backend.generate({ ...req(), model: GROQ_MODEL, signal: c.signal }); c.abort();
    await assert.rejects(work, { code: 'CANCELLED' });
  } finally { clearTimeout(hold); }
});

test('fake Groq HTTP crosses both gateway shims with FIFO and one shared request cap for bot/Hindsight/EVAL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11b-'));
  const budget = createRequestBudget({ file: join(dir, 'requests.json'), dailyLimit: 2 });
  const roles = [], logs = []; let active = 0, maxActive = 0;
  const backend = createBackend({ type: 'groq-api', model: GROQ_MODEL, apiKey: 'FAKE', fetchImpl: async (url, options) => {
    active++; maxActive = Math.max(maxActive, active); roles.push(JSON.parse(options.body).messages.at(-1).content);
    await new Promise((r) => setTimeout(r, 20)); active--; return Response.json(data());
  } });
  const gateway = createGateway({ budget, gemini: backend, models: ['hub-llm'], clientKeys: { bot: 'bot', hindsight: 'hindsight', eval: 'eval' }, log: (e) => logs.push(e) });
  const server = http.createServer(gateway.handle); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const results = await Promise.all(['bot', 'hindsight', 'eval'].map(async (role) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${role === 'hindsight' ? 'chat/completions' : 'messages'}`, { method: 'POST', headers: { 'x-api-key': role, 'content-type': 'application/json' }, body: JSON.stringify(body({ messages: [{ role: 'user', content: role }] })) });
    return { status: response.status, data: await response.json() };
  }));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 429]); assert.deepEqual(roles, ['bot', 'hindsight']);
  assert.equal(results[0].data.content[0].text, '服務正常。'); assert.equal(results[1].data.choices[0].message.content, '服務正常。');
  assert.equal(results[2].data.error.code, 'DAILY_LIMIT'); assert.equal(maxActive, 1); assert.equal(budget.status().usedRequests, 2);
  assert.equal(JSON.stringify(logs).includes('FAKE'), false);
});

test('bot read-only citation loop and EVAL classification use native Groq through the shared gateway', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11b-bot-'));
  const budget = createRequestBudget({ file: join(dir, 'requests.json'), dailyLimit: 3 });
  let count = 0;
  const backend = createBackend({ type: 'groq-api', model: GROQ_MODEL, apiKey: 'FAKE', fetchImpl: async (url, options) => {
    const native = JSON.parse(options.body); count++;
    if (count === 1) {
      assert.deepEqual(native.tools.map((t) => t.function.name), ['recent_items', 'get_item']);
      return Response.json(data(null, [call('recent_items')]));
    }
    if (count === 2) {
      assert.equal(native.messages.at(-1).role, 'tool'); assert.match(native.messages.at(-1).content, /mail_id/);
      return Response.json(data('交接已完成 #1。'));
    }
    return Response.json(data('{"classification":"question","reason":"這是提問。"}'));
  } });
  const gateway = createGateway({ budget, gemini: backend, models: ['hub-llm'], clientKeys: { internal: 'bot' } });
  const server = http.createServer(gateway.handle); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const client = createGatewayClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: 'internal' });
  const store = createMemoryStore(seed()), clock = new FakeClock('2026-11-18T01:00:00Z');
  store.db.notifs.push({ id: 1, group_id: 'group-a', member_id: 1, mail_id: 1, recipient_agent: 'RedStone', label: '交接', sender: 'BlueLake', subject: '交接', summary: '完成', mail_created_at: clock.iso(), state: 'sent' });
  const assistant = createAssistant({ llm: client, budget: createGatewayBudget({ store, clock }), tools: createReadOnlyTools({ store, mail: createFakeMail() }) });
  const answer = await assistant.answer({ groupId: 'group-a', question: '目前進度？' });
  assert.equal(answer.kind, 'answer'); assert.deepEqual(answer.citations, [1]);
  const provider = createProvider({ type: 'gemini-gateway', client, model: 'hub-llm' });
  assert.deepEqual(await provider.classify({}, { prompt: '這是問題嗎？' }), { classification: 'question', reason: '這是提問。' });
  assert.equal(budget.status().usedRequests, 3);
});
