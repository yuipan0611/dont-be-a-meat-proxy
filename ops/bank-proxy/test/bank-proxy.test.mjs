// L-02 bank-proxy: per-device token → exactly one Hindsight bank, read-only tools (SDS API-04).
// Run: node --test ops/bank-proxy/test/bank-proxy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createBankProxy, READ_TOOLS } from '../bank-proxy.mjs';

const listen = (handler) => new Promise((res) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const sha = (t) => createHash('sha256').update(t).digest('hex');

const ALICE = 'alice-device-token-0123456789abcdef0123456789abcdef'; // group-a
const BOB = 'bob-device-token-0123456789abcdef0123456789abcdef012'; // group-b
const MASTER = 'hindsight-tenant-master-key';

const TOOLS = ['retain', 'sync_retain', 'recall', 'reflect', 'list_memories', 'get_memory', 'get_document', 'delete_bank', 'clear_memories', 'update_bank']
  .map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

/** Fake Hindsight MCP: records requests; tools/list returns every tool; GET opens an SSE stream. */
async function fakeHindsight({ sseList = false } = {}) {
  const seen = [];
  const up = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': req.headers['mcp-session-id'] ?? '' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n');
        setTimeout(() => res.end('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/bye"}\n\n'), 20);
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      const msg = JSON.parse(b);
      const result = msg.method === 'tools/list' ? { tools: TOOLS } : { content: [{ type: 'text', text: `ok ${msg.params?.name ?? msg.method}` }] };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sseList) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        res.end(payload);
      }
    });
  });
  return { ...up, seen };
}

function memRegistry() {
  const rows = new Map([
    [sha(ALICE), { tokenId: 'tok_alice0001', groupId: 'group-a', bankId: 'group-a', principal: '維護者 / Mac' }],
    [sha(BOB), { tokenId: 'tok_bob00001', groupId: 'group-b', bankId: 'group-b', principal: 'Bob / Win' }],
  ]);
  let down = false;
  return {
    async lookup(hash) { if (down) throw new Error('db down'); return rows.get(hash) ?? null; },
    revoke(token) { rows.delete(sha(token)); },
    setDown(v) { down = v; },
  };
}

async function setup(opts) {
  const up = await fakeHindsight(opts);
  const registry = memRegistry();
  const logs = [];
  const proxy = await listen(createBankProxy({ registry, upstreamUrl: up.url, upstreamKey: MASTER, log: (e) => logs.push(e) }));
  const call = (path, { token = ALICE, method = 'POST', body, headers = {} } = {}) => fetch(`${proxy.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const cleanup = async () => { await close(proxy.server); await close(up.server); };
  return { up, registry, logs, call, rpc, cleanup };
}

test('no token, a wrong token, or the upstream master key → 401 on every path; nothing forwarded', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  for (const path of ['/mcp/group-a/', '/mcp/', '/v1/default/banks', '/metrics', '/']) {
    assert.equal((await s.call(path, { token: null, body: s.rpc('tools/list') })).status, 401, path);
    assert.equal((await s.call(path, { token: 'wrong', body: s.rpc('tools/list') })).status, 401, path);
    assert.equal((await s.call(path, { token: MASTER, body: s.rpc('tools/list') })).status, 401, path);
  }
  assert.equal(s.up.seen.length, 0);
});

test('own bank: forwarded to /mcp/<bank>/ with the master key; bank/identity headers stripped; session id kept', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const body = s.rpc('tools/call', { name: 'recall', arguments: { query: '交接', bank_id: 'group-a', include_chunks: true } });
  const r = await s.call('/mcp/group-a', { body, headers: { 'x-bank-id': 'group-b', 'mcp-session-id': 'sess-1', 'x-tenant-id': 'evil', 'mcp-protocol-version': '2025-06-18' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 'sess-1');
  assert.match((await r.json()).result.content[0].text, /ok recall/);
  const [got] = s.up.seen;
  assert.equal(got.url, '/mcp/group-a/');
  assert.equal(got.headers.authorization, `Bearer ${MASTER}`);
  assert.equal(got.headers['x-bank-id'], undefined);
  assert.equal(got.headers['x-tenant-id'], undefined);
  assert.equal(got.headers['mcp-session-id'], 'sess-1');
  assert.equal(got.headers['mcp-protocol-version'], '2025-06-18');
  assert.deepEqual(JSON.parse(got.body), body); // Own-bank arguments are preserved
});

test('another bank, the multi-bank /mcp/, REST, metrics and admin paths → 403 for a valid token', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  for (const path of ['/mcp/group-b/', '/mcp/', '/mcp', '/v1/default/banks', '/v1/default/banks/group-a/memories', '/metrics', '/docs', '/mcp/group-a/../group-b/', '/mcp/group-a%2F..%2Fgroup-b/']) {
    assert.equal((await s.call(path, { body: s.rpc('tools/list') })).status, 403, path);
  }
  assert.equal(s.up.seen.length, 0);
});

test('refusal logs contain a route class and query fingerprint, never raw query text', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const query = 'note=private-fixture';
  assert.equal((await s.call('/mcp/group-b/?' + query)).status, 403);
  assert.deepEqual(s.logs[0], {
    ev: 'path_refused', token_id: 'tok_alice0001', method: 'POST', route: 'bank',
    query: { length: Buffer.byteLength(query), sha256: sha(query) },
  });
});

test('write / destructive / LLM tools are refused with TOOL_NOT_ALLOWED and never forwarded', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  for (const name of ['retain', 'sync_retain', 'reflect', 'delete_bank', 'clear_memories', 'update_bank', 'no_such_tool']) {
    const r = await s.call('/mcp/group-a/', { body: s.rpc('tools/call', { name, arguments: {} }, 7) });
    assert.equal(r.status, 200, name);
    const j = await r.json();
    assert.equal(j.id, 7);
    assert.equal(j.error.data.reason, 'TOOL_NOT_ALLOWED', name);
  }
  // a batch with one bad call is refused as a whole
  const batch = [s.rpc('tools/call', { name: 'recall', arguments: {} }, 1), s.rpc('tools/call', { name: 'delete_bank', arguments: {} }, 2)];
  const rb = await s.call('/mcp/group-a/', { body: batch });
  const jb = await rb.json();
  assert.ok(Array.isArray(jb));
  assert.ok(jb.every((x) => x.error?.data?.reason === 'TOOL_NOT_ALLOWED'));
  assert.equal(s.up.seen.length, 0);
  assert.ok(s.logs.some((l) => l.ev === 'tool_refused' && l.tool === 'delete_bank' && l.token_id === 'tok_alice0001'));
  assert.ok(!JSON.stringify(s.logs).includes(ALICE), 'logs never contain the token');
});

test('read tools pass: recall, list_memories, get_memory, get_document', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.deepEqual([...READ_TOOLS].sort(), ['get_document', 'get_memory', 'list_memories', 'recall']);
  for (const name of READ_TOOLS) assert.equal((await s.call('/mcp/group-a/', { body: s.rpc('tools/call', { name, arguments: {} }) })).status, 200);
  assert.equal(s.up.seen.length, 4);
});

for (const sseList of [false, true]) {
  test(`tools/list is filtered to the allowed tools (${sseList ? 'SSE' : 'JSON'} response)`, async (t) => {
    const s = await setup({ sseList });
    t.after(s.cleanup);
    const r = await s.call('/mcp/group-a/', { body: s.rpc('tools/list', {}) });
    const text = await r.text();
    const payload = sseList ? JSON.parse(/data: (.*)/.exec(text)[1]) : JSON.parse(text);
    assert.deepEqual(payload.result.tools.map((x) => x.name).sort(), ['get_document', 'get_memory', 'list_memories', 'recall']);
  });
}

test('GET SSE stream and DELETE session pass through with the session id (Streamable HTTP)', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const g = await s.call('/mcp/group-a/', { method: 'GET', headers: { 'mcp-session-id': 'sess-1', accept: 'text/event-stream' } });
  assert.equal(g.status, 200);
  assert.match(g.headers.get('content-type'), /event-stream/);
  const text = await g.text();
  assert.match(text, /notifications\/ping[\s\S]*notifications\/bye/);
  const d = await s.call('/mcp/group-a/', { method: 'DELETE', headers: { 'mcp-session-id': 'sess-1' } });
  assert.equal(d.status, 204);
  assert.deepEqual(s.up.seen.map((x) => [x.method, x.headers['mcp-session-id']]), [['GET', 'sess-1'], ['DELETE', 'sess-1']]);
});

test('revocation is immediate: the next request on the same MCP session is 401', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const hdr = { 'mcp-session-id': 'sess-1' };
  assert.equal((await s.call('/mcp/group-a/', { body: s.rpc('tools/call', { name: 'recall', arguments: {} }), headers: hdr })).status, 200);
  s.registry.revoke(ALICE);
  assert.equal((await s.call('/mcp/group-a/', { body: s.rpc('tools/call', { name: 'recall', arguments: {} }), headers: hdr })).status, 401);
});

test('registry unavailable → 503, fail-closed (never forwarded)', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  s.registry.setDown(true);
  assert.equal((await s.call('/mcp/group-a/', { body: s.rpc('tools/list') })).status, 503);
  assert.equal(s.up.seen.length, 0);
});

test('oversized or non-JSON POST bodies are refused before forwarding', async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal((await s.call('/mcp/group-a/', { body: '{not json' })).status, 400);
  assert.equal((await s.call('/mcp/group-a/', { body: JSON.stringify({ x: 'a'.repeat(3 * 1024 * 1024) }) })).status, 413);
  assert.equal(s.up.seen.length, 0);
});

test('group-bound proxy rejects a valid foreign token on every path and foreign bank_id arguments', async (t) => {
 const up=await fakeHindsight(); const registry=memRegistry();
 const proxy=await listen(createBankProxy({groupId:'group-a',registry,upstreamUrl:up.url,upstreamKey:MASTER}));
 t.after(async()=>{await close(proxy.server);await close(up.server);});
 for(const path of ['/mcp/group-a/','/mcp/group-b/','/mcp/','/healthz','/','/v1/default/banks']) {
  const r=await fetch(proxy.url+path,{headers:{authorization:`Bearer ${BOB}`}});
  assert.equal(r.status,401,path);
 }
 const r=await fetch(proxy.url+'/mcp/group-a/',{method:'POST',headers:{authorization:`Bearer ${ALICE}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{bank_id:'group-b',query:'private'}}})});
 assert.equal(r.status,403);assert.equal(up.seen.length,0);
});
