import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateConfig, mcp, tokenFile, fixtureFor, searchRows, quotaTarget } from '../collect.mjs';
import { redact } from '../judge.mjs';
import { missingTokenTask } from '../negative-task.mjs';
import { createTaskService } from '../../../bot/src/task.mjs';
import { createGitHubClient } from '../../../bot/src/github.mjs';

const root = resolve(import.meta.dirname, '../../..');
const config = { groupId: 'grp-test', runId: 'unit-test', deploymentCommit: 'a'.repeat(40), since: '2026-11-18T00:00:00Z', operator: '維護者', containers: {} };
test('deployed /task negative harness never consults credentials or calls network/writes', async () => {
  const actual = await missingTokenTask({ createTaskService, createGitHubClient });
  assert.deepEqual(actual, { error: 'E-GITHUB', networkCalls: 0, hubWrites: 0, createdAudit: 0, emptyTitle: true, cancel: true, stranger: true, doubleClick: true });
});
test('zero quota cannot be enabled without a restorable positive baseline', () => {
  assert.throws(() => quotaTarget('0', undefined), /BASELINE_REQUIRED/);
  assert.throws(() => quotaTarget('restore', { dailyLimit: 0 }), /BASELINE_REQUIRED/);
  assert.equal(quotaTarget('0', { dailyLimit: 123 }), 0);
  assert.equal(quotaTarget('restore', { dailyLimit: 123 }), 123);
});
test('unrecognised Mail search never silently means zero tasks; fixtures distinguish documents', () => {
  assert.deepEqual(searchRows({ messages: [] }), []);
  assert.deepEqual(searchRows({ messages: [{ id: 1 }] }), [{ id: 1 }]);
  assert.throws(() => searchRows({ unexpected: [] }), /INVALID_SEARCH_SCHEMA/);
  assert.throws(() => searchRows({ messages: [{ id: 'bad' }] }), /INVALID_SEARCH_SCHEMA/);
  assert.notEqual(fixtureFor('run', 'handoff', 'handoff'), fixtureFor('run', 'decision', 'decision'));
});
test('config rejects URL credentials, plaintext transport, SQL group and container injection', () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const patch of [{ groupId: "x';drop table devices;--" }, { containers: { bot: '-h' } }, { isolation: { foreignMarkerPath: '/data/../secret' } }, { mail: { url: 'https://token:maintainer [at] example.invalid/mcp/' } }, { mail: { url: 'http://example.com/mcp/' } }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});
test('MCP 401 plaintext is recorded as 401; successful SSE initializes and calls once', async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/denied') { res.writeHead(401); res.end('Unauthorized'); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const m = JSON.parse(text);
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-token');
    if (m.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = m.method === 'initialize' ? { serverInfo: { name: 'fake' } } : { content: [{ text: '{"original_text":"繁體"}' }] };
    if (m.method === 'tools/call') calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'synthetic-session' });
    res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await mcp(base + '/denied', 'synthetic-test-token')).status, 401);
  const s = await mcp(base, 'synthetic-test-token');
  assert.deepEqual(await s.call('get_document', { document_id: 'mail-1' }), { original_text: '繁體' });
  assert.equal(calls, 1);
});
test('MCP never follows redirects carrying bearer credentials', async (t) => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/leak') { leaked = true; res.end(); }
    else { res.writeHead(302, { location: '/leak' }); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  await assert.rejects(mcp(`http://127.0.0.1:${server.address().port}/redirect`, 'synthetic-test-token'));
  assert.equal(leaked, false);
});
test('private credentials require restricted mode and accept device/upstream file formats', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 's1-private-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fake.env');
  await writeFile(file, 'HUB_TOKEN=' + 'z'.repeat(40), { mode: 0o600 });
  assert.equal(await tokenFile(file), 'z'.repeat(40));
  const publicFile = join(dir, 'public.env');
  await writeFile(publicFile, 'HTTP_BEARER_TOKEN=' + 'z'.repeat(40), { mode: 0o644 });
  await assert.rejects(tokenFile(publicFile), /PRIVATE_FILE_PERMISSIONS/);
});
test('safe state roundtrip retains enum evidence while removing arbitrary DM and OAuth strings', () => {
  const state = { negative: { error: 'E-GITHUB' }, notifications: [{ state: 'held' }], state: 'oauth-state-secret', body_md: 'private raw text' };
  const round = JSON.parse(JSON.stringify(redact(state)));
  assert.equal(round.negative.error, 'E-GITHUB');
  assert.equal(round.notifications[0].state, 'held');
  assert.equal(round.body_md, '[REDACTED]');
  assert.equal(round.state, '[REDACTED]');
});
test('all entry points help offline; capture refuses without --live before reading config', () => {
  for (const tc of [14, 16, 17, 18, 19, 20, 21]) {
    const entry = join(root, `ops/acceptance/tc-${tc}.mjs`);
    const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    const denied = spawnSync(process.execPath, [entry, '--config', '/nonexistent/no-secrets-read', '--step', 'final'], { encoding: 'utf8' });
    assert.equal(denied.status, 1);
    assert.ok(!denied.stderr.includes('/nonexistent'));
  }
});
test('offline verify creates UTC receipt with commit, command, output, exit and pending', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 's1-runner-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json'); await writeFile(file, JSON.stringify(config));
  const run = spawnSync(process.execPath, [join(root, 'ops/acceptance/tc-19.mjs'), '--config', file, '--verify'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  const evidence = join(dir, 'docs/evidence/S1/TC-19');
  const reports = (await readdir(evidence)).filter((f) => f.startsWith('run-'));
  assert.equal(reports.length, 1);
  const report = await readFile(join(evidence, reports[0]), 'utf8');
  for (const text of ['UTC:', config.deploymentCommit, 'Command:', 'Exit: 2', '**pending**', 'real GitHub positive']) assert.ok(report.includes(text), text);
});
