// Operator acceptance checks. Credentials come from files; never CLI arguments or output.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { createMailClient } from '../client/mail-client.mjs';

const PROJECT = '/data/projects/group-a';
const DEFAULT_URL = 'https://hub.example.invalid/mcp/';
const sha = (text) => createHash('sha256').update(text).digest('hex');

export async function privateText(path) {
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'Credential files must have mode 600');
  return readFile(path, 'utf8');
}

async function privateJson(path, data) {
  const temporary = path + '.tmp-' + randomUUID();
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function deviceCredentials(dir) {
  const result = {};
  for (const device of ['mac', 'windows']) {
    const env = await privateText(join(dir, device + '.env'));
    const token = env.match(/^HUB_TOKEN=([A-Za-z0-9_-]{32,128})$/m)?.[1];
    assert.ok(token, 'Device credential file is invalid');
    result[device] = { token, ...JSON.parse(await privateText(join(dir, device + '.sender.json'))) };
  }
  return result;
}

export async function unauthorized(url) {
  const origin = new URL(url).origin;
  const paths = ['/mcp/', '/api/', '/mail/', '/mail/api/unified-inbox', '/mail/ws-state',
    '/health/liveness', '/openapi.json', '/unknown-h02', '/memory/mcp/group-a/'];
  for (const path of paths) {
    for (const token of [null, 'deliberately-wrong-h02']) {
      const res = await fetch(origin + path, {
        headers: token ? { authorization: 'Bearer ' + token } : {}, redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      await res.text();
      assert.equal(res.status, 401, 'TC-01: all HTTPS paths must reject unauthorized GET');
    }
  }
  for (const token of [null, 'deliberately-wrong-h02']) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    await res.text();
    assert.equal(res.status, 401, 'TC-01: unauthorized MCP POST must be rejected');
  }
  console.log('PASS TC-01: 20 unauthorized requests returned 401 (9 paths GET, MCP POST)');
}

function clientFor(url, credentials, device) {
  const { token, agentName, senderToken } = credentials[device];
  return createMailClient({ url, token, agentName, senderToken, projectKey: PROJECT });
}

export async function mcpChecks(url, dir) {
  const credentials = await deviceCredentials(dir);
  const mac = clientFor(url, credentials, 'mac');
  const win = clientFor(url, credentials, 'windows');
  const before = await win.fetchEvents({ after: 0 });
  const text = 'H02 原文驗證：繁體中文，換行與 emoji 😀\n' + randomUUID();
  const sent = await mac.sendItem({
    to: ['RedStone'], subject: 'H-02 acceptance', kind: 'handoff', intent: 'question',
    sourceSession: 'h02-acceptance', summary: 'H-02 原文測試', text, links: [], unfinished: [],
  });
  assert.equal(sent.status, 'saved');
  const read = await win.readMessage(sent.messageId);
  assert.equal(JSON.parse(read.message.body_md).text, text, 'Original text must be identical');
  const events = await win.fetchEvents({ after: before.tailCursor });
  assert.ok(events.events.some((event) => event.message_id === sent.messageId), 'Durable cursor must contain the delivery');
  const after = events.tailCursor;
  await assert.rejects(mac.sendItem({
    to: ['win-claud'], subject: 'H-02 unknown recipient', kind: 'handoff', intent: 'question',
    sourceSession: 'h02-acceptance', summary: 'Unknown recipient', text: 'Synthetic acceptance check',
  }), (error) => error.code === 'E-RCPT' && error.delivery === 'not_saved');
  const unchanged = await win.fetchEvents({ after });
  assert.equal(unchanged.tailCursor, after, 'Unknown recipient must not create a delivery');
  assert.equal(unchanged.events.length, 0);
  await privateJson(join(dir, 'persistence.json'), { messageId: sent.messageId, text, sha256: sha(text) });
  console.log('PASS MCP initialize + send/read + durable cursor; TC-11 E-RCPT and unchanged delivery tail');
  console.log('TC-05 checkpoint saved: message ID ' + sent.messageId + ', sha256 ' + sha(text));
}

export async function persistence(url, dir) {
  const credentials = await deviceCredentials(dir);
  const saved = JSON.parse(await privateText(join(dir, 'persistence.json')));
  const read = await clientFor(url, credentials, 'windows').readMessage(saved.messageId);
  const text = JSON.parse(read.message.body_md).text;
  assert.equal(text, saved.text, 'Restart must preserve original content');
  assert.equal(sha(text), saved.sha256);
  console.log('PASS TC-05: original message ID and sha256 unchanged after operator restart');
}

export async function openSession(url, token) {
  let id = 0;
  let session = null;
  async function request(method, params, notify = false) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(!notify ? { id: ++id } : {}) }),
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    session = res.headers.get('mcp-session-id') || session;
    const text = await res.text();
    return { status: res.status, text };
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'h02-acceptance', version: '1' },
  });
  assert.equal(initialized.status, 200);
  assert.ok(session, 'Session identity must return MCP session ID');
  const body = JSON.parse(initialized.text);
  assert.ok(body.result?.serverInfo, 'initialize must return serverInfo');
  const ready = await request('notifications/initialized', {}, true);
  assert.ok(ready.status >= 200 && ready.status < 300);
  assert.equal((await request('tools/list', {})).status, 200);
  return { request };
}

async function cli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { url: { type: 'string', default: DEFAULT_URL },
      'credentials-dir': { type: 'string', default: '.hub-local/h02-client' } },
  });
  const [command] = positionals;
  const url = new URL(values.url);
  assert.ok((url.protocol === 'https:' && url.hostname === 'hub.example.invalid') ||
    (url.protocol === 'http:' && url.hostname === '127.0.0.1'), 'Only the Hub or loopback test URL is allowed');
  const dir = resolve(values['credentials-dir']);
  if (command === 'unauthorized') return unauthorized(url.href);
  if (command === 'mcp') return mcpChecks(url.href, dir);
  if (command === 'persistence') return persistence(url.href, dir);
  if (command === 'revoke-session') {
    const credentials = await deviceCredentials(dir);
    const session = await openSession(url.href, credentials.windows.token);
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await reader.question('READY: Windows MCP session retained; run ops/revoke on VPS, then press Enter here: ');
    } finally { reader.close(); }
    assert.equal((await session.request('tools/list', {})).status, 401, 'Existing Windows session must be rejected');
    await openSession(url.href, credentials.mac.token);
    console.log('PASS TC-10: next request in SAME Windows MCP session is 401; Mac remains usable');
    return;
  }
  throw new Error('Use unauthorized, mcp, persistence or revoke-session');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error('FAIL H-02 verification: ' + (error.code || error.name || 'unknown') + '; no credentials printed');
    process.exitCode = 1;
  });
}
