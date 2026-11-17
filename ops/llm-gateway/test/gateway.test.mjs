import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequestBudget } from '../request-budget.mjs';
import { createGemini } from '../gemini.mjs';
import { createGateway } from '../gateway.mjs';
import { createQueue } from '../queue.mjs';
import { createGatewayClient } from '../client.mjs';
import { createAssistant, createReadOnlyTools, NO_INFO } from '../../../bot/src/assistant.mjs';
import { createGatewayBudget } from '../../../bot/src/budget.mjs';
import { createMemoryStore } from '../../../bot/test/helpers/store-memory.mjs';
import { createFakeMail, FakeClock, seed, itemBody } from '../../../bot/test/helpers/fakes.mjs';
import { createProvider, runEval } from '../../eval/eval-classify.mjs';

const model = 'gemini-2.5-flash';
const key = 'test-internal-key';
const msg = (fake = {}) => ({ model, max_tokens: 256, messages: [{ role: 'user', content: JSON.stringify({ fake }) }] });

async function rig(t, { cap = 500, timeoutMs = 10_000, queue, command } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'f11-test-'));
  const exe = join(dir, 'gemini');
  writeFileSync(exe, readFileSync(new URL('./fixtures/fake-gemini.mjs', import.meta.url), 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`)); chmodSync(exe, 0o700);
  const clock = { value: Date.parse('2026-11-17T15:59:59Z'), now() { return this.value; } };
  const file = join(dir, 'requests.json');
  const budget = createRequestBudget({ file, dailyLimit: cap, clock });
  const logs = [];
  const gemini = createGemini({ command: command ?? exe, profileDir: join(dir, 'profile'), timeoutMs });
  const gateway = createGateway({ budget, gemini, clientKeys: { [key]: 'bot', 'test-hindsight-key': 'hindsight', 'test-eval-key': 'eval' }, queue, log: (o) => logs.push(o) });
  const server = http.createServer(gateway.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const request = async (body, { path = '/v1/messages', auth = key, signal } = {}) => {
    const res = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-api-key': auth } : {}) }, body: JSON.stringify(body), signal });
    return { status: res.status, headers: res.headers, data: await res.json() };
  };
  return { dir, file, budget, clock, logs, gateway, baseUrl, request, client: createGatewayClient({ baseUrl, key }) };
}

test('official-CLI-shaped executable receives stdin, isolated profile/cwd, fixed safe argv and allowlisted environment', async (t) => {
  const r = await rig(t);
  const record = join(r.dir, 'record.jsonl');
  const result = await r.request(msg({ record, response: '繁體中文；$(touch BAD) `secret`' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.content[0].text, '繁體中文；$(touch BAD) `secret`');
  assert.deepEqual(result.data.usage, { input_tokens: 8, output_tokens: 9 });
  const child = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(child.env.NO_BROWSER, 'true');
  assert.equal(child.env.GEMINI_FORCE_FILE_STORAGE, 'true');
  assert.equal(child.env.GEMINI_CLI_HOME, join(r.dir, 'profile'));
  assert.equal(child.args.includes('--admin-policy'), true);
  assert.equal(child.args.includes('--yolo'), false);
  assert.equal(child.args.some((a) => a.includes('touch BAD')), false);
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'DISCORD_TOKEN']) assert.equal(child.env[name], undefined);
  assert.equal(existsSync(child.cwd), false, 'temporary request directory removed');
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(r.logs).includes('secret'), false);
});

test('unknown key/path/model, invalid JSON and bad stream flag refuse before CLI and consume no budget', async (t) => {
  const r = await rig(t);
  for (const [body, opts, status] of [[msg(), { auth: null }, 401], [msg(), { auth: 'wrong' }, 401], [msg(), { path: '/v1/responses' }, 404], [{ ...msg(), model: 'claude-anything' }, {}, 400], [{ ...msg(), stream: 'yes' }, {}, 400], [{ ...msg(), max_tokens: 0 }, {}, 400], [null, {}, 400]]) {
    assert.equal((await r.request(body, opts)).status, status);
  }
  assert.equal(r.budget.status().usedRequests, 0);
});

test('hard global request limit shared by bot, Hindsight and EVAL; rejects before launching after cap', async (t) => {
  const r = await rig(t, { cap: 2 });
  const results = await Promise.all([
    r.request(msg({ delay: 30 })),
    r.request(msg(), { auth: 'test-hindsight-key', path: '/v1/chat/completions' }),
    r.request(msg(), { auth: 'test-eval-key' }),
  ]);
  assert.deepEqual(results.map((x) => x.status), [200, 200, 429]);
  assert.equal(results[2].data.error.code, 'DAILY_LIMIT');
  assert.equal(results[2].headers.get('x-should-retry'), 'false');
  assert.equal(r.budget.status().usedRequests, 2);
  assert.equal(r.logs.filter((l) => l.ev === 'llm_call').length, 2);
  assert.equal(r.budget.status().reservedRequests, 0);
});

test('zero daily limit never invokes Gemini; Asia/Taipei rollover and crash reservations are conservative', async (t) => {
  const zero = await rig(t, { cap: 0 });
  assert.equal((await zero.request(msg())).status, 429);
  assert.equal(zero.logs.some((x) => x.ev === 'llm_call'), false);
  const r = await rig(t, { cap: 1 });
  assert.equal(r.budget.reserve('crashed', 'hindsight'), true);
  const recovered = createRequestBudget({ file: r.file, dailyLimit: 1, clock: r.clock });
  assert.equal(recovered.status().usedRequests, 1);
  assert.equal(recovered.reserve('over', 'bot'), false);
  r.clock.value += 1000;
  assert.equal(recovered.status().day, '2026-11-18');
  assert.equal(recovered.reserve('tomorrow', 'bot'), true);
  recovered.charge('tomorrow');
  assert.equal(recovered.status().usedRequests, 1);
});

test('bounded queue executes FIFO and serially, full/wait-timeout/cancelled entries do not consume requests', async (t) => {
  const r = await rig(t, { queue: createQueue({ maxQueued: 1, waitMs: 30 }) });
  const first = r.request(msg({ delay: 150 }));
  await delay(10);
  const second = r.request(msg());
  await delay(5);
  const third = await r.request(msg());
  assert.equal(third.data.error.code, 'QUEUE_FULL');
  assert.equal((await second).data.error.code, 'QUEUE_TIMEOUT');
  assert.equal((await first).status, 200);
  assert.equal(r.budget.status().usedRequests, 1);
  const q = createQueue();
  const order = [];
  await Promise.all([1, 2, 3].map((i) => q.run(async () => { order.push(i); await delay(5); order.push(-i); })));
  assert.deepEqual(order, [1, -1, 2, -2, 3, -3]);
  const hold = q.run(() => delay(30));
  const c = new AbortController();
  const cancelled = q.run(() => assert.fail('cancelled job ran'), c.signal);
  c.abort(); await assert.rejects(cancelled, { code: 'CANCELLED' }); await hold;
});

test('CLI timeout, quota, malformed/empty output and auth errors fail closed without leaking raw errors', async (t) => {
  const r = await rig(t, { timeoutMs: 1000 });
  for (const [fixture, code, status] of [
    [{ delay: 3000 }, 'CLI_TIMEOUT', 504],
    [{ mode: 'fail', stderr: 'invalid_grant https://auth.example/SECRET_TOKEN' }, 'AUTH_REQUIRED', 503],
    [{ mode: 'error', error: '429 RESOURCE_EXHAUSTED SECRET_TOKEN' }, 'UPSTREAM_QUOTA', 429],
    [{ mode: 'bad-json' }, 'INVALID_CLI_JSON', 502], [{ mode: 'empty' }, 'EMPTY_RESPONSE', 502],
  ]) {
    const result = await r.request(msg(fixture));
    assert.equal(result.status, status); assert.equal(result.data.error.code, code);
    assert.equal(JSON.stringify(result).includes('SECRET_TOKEN'), false);
  }
  assert.equal(r.budget.status().usedRequests, 5, 'uncertain failures stay charged');
  assert.equal(JSON.stringify(r.logs).includes('SECRET_TOKEN'), false);
});

test('missing executable releases reservation and readyz distinguishes liveness from successful auth', async (t) => {
  const r = await rig(t, { command: '/does-not-exist/gemini' });
  assert.equal((await fetch(r.baseUrl + '/healthz')).status, 200);
  assert.equal((await fetch(r.baseUrl + '/readyz')).status, 503);
  assert.equal((await r.request(msg())).data.error.code, 'CLI_UNAVAILABLE');
  assert.equal(r.budget.status().usedRequests, 0);
  const good = await rig(t);
  const success = await good.request(msg());
  assert.equal(success.status, 200, JSON.stringify(success.data));
  assert.equal((await fetch(good.baseUrl + '/readyz')).status, 200);
  await good.request(msg({ mode: 'error', error: 'authentication failed' }));
  assert.equal((await fetch(good.baseUrl + '/readyz')).status, 503);
  const status = await fetch(good.baseUrl + '/status', { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await status.json()).backend, 'auth_required');
  assert.equal((await good.client.status()).backend, 'auth_required');
});

test('OpenAI JSON-schema response shape usable by Hindsight client validation; model invalid JSON is an error', async (t) => {
  const r = await rig(t);
  const body = { ...msg({ response: '{"facts":[{"text":"登入由 維護者 執行。"}]}' }), response_format: { type: 'json_schema', json_schema: { name: 'Extraction', strict: false, schema: { type: 'object', properties: { facts: { type: 'array' } } } } } };
  const result = await r.request(body, { path: '/v1/chat/completions', auth: 'test-hindsight-key' });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.data.choices[0].message.content).facts[0].text, '登入由 維護者 執行。');
  assert.equal(result.data.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.data.usage, { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 });
  const bad = await r.request({ ...body, messages: msg({ response: 'invalid' }).messages }, { path: '/v1/chat/completions' });
  assert.equal(bad.data.error.code, 'INVALID_MODEL_JSON');
});

test('Anthropic and OpenAI tool emulation returns only declared calls and respects forced tool choice', async (t) => {
  const r = await rig(t);
  const body = { ...msg(), tools: [{ name: 'recent_items', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'recent_items' } };
  const a = await r.request(body);
  assert.equal(a.data.stop_reason, 'tool_use');
  assert.equal(a.data.content[0].name, 'recent_items');
  assert.deepEqual(a.data.content[0].input, { limit: 5 });
  const o = await r.request({ ...body, tools: [{ type: 'function', function: { name: 'recent_items', parameters: { type: 'object' } } }], tool_choice: 'required' }, { path: '/v1/chat/completions' });
  assert.equal(o.data.choices[0].message.tool_calls[0].function.name, 'recent_items');
  for (const response of ['{"text":"","tool_calls":[{"name":"run_shell_command","arguments":{}}]}', '{"text":"done","tool_calls":[]}']) {
    assert.equal((await r.request({ ...body, messages: msg({ response }).messages })).status, 502);
  }
});

test('real bot assistant loop uses shared gateway budget and keeps citation / read-only behavior', async (t) => {
  const r = await rig(t, { cap: 2 });
  const store = createMemoryStore(seed()), mail = createFakeMail(), clock = new FakeClock('2026-11-17T10:00:00Z');
  mail.deliver({ from: 'BlueLake', to: ['RedStone'], subject: '交接', body: itemBody({ summary: '完成' }), createdTs: clock.iso() });
  store.db.notifs.push({ id: 1, group_id: 'group-a', member_id: 1, mail_id: 1, recipient_agent: 'RedStone', label: '交接', sender: 'BlueLake', subject: '交接', summary: '完成', mail_created_at: clock.iso(), state: 'sent' });
  const notifications = [];
  const budget = createGatewayBudget({ store, clock, onCapReached: async (x) => notifications.push(x) });
  const assistant = createAssistant({ llm: r.client, budget, model, tools: createReadOnlyTools({ store, mail }) });
  const answer = await assistant.answer({ groupId: 'group-a', question: '現在進度？' });
  assert.equal(answer.kind, 'answer'); assert.match(answer.text, /#1/);
  assert.deepEqual(assistant.toolNames(), ['recent_items', 'get_item']);
  assert.equal((await assistant.answer({ groupId: 'group-a', question: '再查一次' })).kind, 'quota');
  assert.equal((await assistant.answer({ groupId: 'group-a', question: '再查一次' })).kind, 'quota');
  assert.equal(notifications.length, 1);
  assert.equal(r.budget.status().usedRequests, 2);
});

test('EVAL provider calls gateway only, rejects legacy provider names, and a provider outage cannot pass', async (t) => {
  const r = await rig(t);
  const record = join(r.dir, 'eval-record.jsonl');
  const provider = createProvider({ type: 'gemini-gateway', client: r.client, model });
  const result = await provider.classify({}, { prompt: JSON.stringify({ fake: { record, response: '{"classification":"question","reason":"繁體理由"}' } }) });
  assert.deepEqual(result, { classification: 'question', reason: '繁體理由' });
  assert.equal(r.budget.status().usedRequests, 1);
  assert.throws(() => createProvider({ type: 'anthropic-api' }), /unsupported/);
  assert.throws(() => createProvider({ type: 'claude-cli' }), /unsupported/);
  const { metrics } = await runEval({ provider: { name: 'offline', async classify() { throw new Error('offline'); } } });
  assert.equal(metrics.providerErrors, 30); assert.equal(metrics.passed, false);
});

test('bot notifies once on auth failure until recovery; provider 429 is not a daily-limit claim', async () => {
  const store = createMemoryStore(seed()), clock = new FakeClock('2026-11-17T10:00:00Z');
  let notices = 0;
  const guard = createGatewayBudget({ store, clock, onAuthRequired: async () => { notices++; } });
  const error = (code) => async () => { throw Object.assign(new Error(code), { code, status: code === 'UPSTREAM_QUOTA' ? 429 : 503 }); };
  for (let i = 0; i < 2; i++) await assert.rejects(guard.guarded('group-a', {}, error('AUTH_REQUIRED')));
  assert.equal(notices, 1);
  await guard.guarded('group-a', {}, async () => ({}));
  await assert.rejects(guard.guarded('group-a', {}, error('AUTH_REQUIRED')));
  assert.equal(notices, 2);
  await assert.rejects(guard.guarded('group-a', {}, error('UPSTREAM_QUOTA')), { code: 'UPSTREAM_QUOTA' });
  await guard.observeBackend({ groupId: 'group-a', backend: 'ready' });
  await guard.observeBackend({ groupId: 'group-a', backend: 'auth_required' });
  await guard.observeBackend({ groupId: 'group-a', backend: 'auth_required' });
  assert.equal(notices, 3, 'background Hindsight failure can be notified by status observation without a bot model call');
});

test('active HTTP cancellation kills the CLI, charges the possible request and frees the queue', async (t) => {
  const r = await rig(t);
  const record = join(r.dir, 'active.jsonl');
  const controller = new AbortController();
  const work = r.request(msg({ record, delay: 1500 }), { signal: controller.signal });
  const rejection = assert.rejects(work, { name: 'AbortError' });
  for (let i = 0; i < 100 && !existsSync(record); i++) await delay(10);
  assert.equal(existsSync(record), true, 'fake CLI started');
  controller.abort(); await rejection;
  for (let i = 0; i < 100 && r.gateway.status().queue.active; i++) await delay(10);
  assert.equal(r.gateway.status().queue.active, 0);
  assert.equal(r.budget.status().usedRequests, 1);
  assert.equal((await r.request(msg())).status, 200);
});

test('oversized stdout is rejected without preserving partial generated text', async (t) => {
  const dir = (await rig(t)).dir;
  const gemini = createGemini({ command: join(dir, 'gemini'), profileDir: dir, maxOutput: 1024 });
  const { prompt } = (await import('../protocol.mjs')).prepare(msg({ mode: 'overflow' }), 'anthropic', [model]);
  await assert.rejects(gemini.generate({ prompt, model }), { code: 'OUTPUT_TOO_LARGE' });
});

test('existing stream=true interface returns valid buffered Anthropic / OpenAI SSE and usage', async (t) => {
  const r = await rig(t);
  for (const path of ['/v1/messages', '/v1/chat/completions']) {
    const response = await fetch(r.baseUrl + path, { method: 'POST', headers: { 'x-api-key': key }, body: JSON.stringify({ ...msg(), stream: true, stream_options: { include_usage: true } }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    const data = text.split('\n').filter((line) => line.startsWith('data: ') && !line.endsWith('[DONE]')).map((line) => JSON.parse(line.slice(6)));
    if (path === '/v1/messages') {
      assert.equal(data[0].type, 'message_start');
      assert.equal(data.at(-1).type, 'message_stop');
      assert.equal(data.find((d) => d.type === 'message_delta').usage.output_tokens, 9);
      assert.match(data.find((d) => d.type === 'content_block_delta').delta.text, /繁體中文/);
    } else {
      assert.match(text, /data: \[DONE\]/);
      assert.equal(data[0].choices[0].delta.role, 'assistant');
      assert.equal(data.at(-1).usage.completion_tokens, 9);
    }
  }
  assert.equal(r.budget.status().usedRequests, 2);
});
