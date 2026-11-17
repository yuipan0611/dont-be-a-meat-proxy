import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('explicit disabled service needs no provider credentials, protects its writer and cleans lock on shutdown', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11-service-')), secrets = join(dir, 'keys');
  mkdirSync(secrets);
  for (const name of ['bot', 'hindsight', 'eval']) writeFileSync(join(secrets, `${name}_key`), `FAKE-${name}`, { mode: 0o600 });
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((r) => listener.close(r));
  const ledger = join(dir, 'requests.json'), entry = fileURLToPath(new URL('../main.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, LLM_BACKEND: 'disabled', SECRETS_DIR: secrets, LEDGER_FILE: ledger, LLM_GATEWAY_HOST: '127.0.0.1', LLM_GATEWAY_PORT: String(port) };
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stderr.on('data', (b) => { error += b; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${error}`)), 5000);
    child.stdout.on('data', (b) => { output += b; if (output.includes('"ev":"started"')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`startup exited ${code}: ${error}`)); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'FAKE-bot' }, body: JSON.stringify({ model: 'hub-llm', max_tokens: 32, messages: [{ role: 'user', content: '測試' }] }) });
  assert.equal((await response.json()).error.code, 'BACKEND_UNCONFIGURED');
  const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'x-api-key': 'FAKE-bot' } });
  assert.equal((await status.json()).budget.usedRequests, 0);
  const other = spawn(process.execPath, [entry], { env, stdio: 'ignore' });
  const [exit] = await once(other, 'exit');
  assert.notEqual(exit, 0, 'second writer is refused');
  assert.equal(existsSync(ledger + '.lock'), true, 'second writer cannot remove the first writer lock');
  child.kill('SIGTERM'); await once(child, 'exit');
  assert.equal(existsSync(ledger + '.lock'), false);
  assert.equal(output.includes('FAKE-bot'), false);
});

test('default Groq service starts from a private file override without probing the provider', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11b-service-'));
  for (const name of ['bot', 'hindsight', 'eval']) writeFileSync(join(dir, `${name}_key`), `FAKE-${name}`, { mode: 0o600 });
  const keyFile = join(dir, 'provider.key'); writeFileSync(keyFile, 'FAKE-GROQ-FILE', { mode: 0o600 });
  const ledger = join(dir, 'requests.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../main.mjs', import.meta.url))], { env: {
    PATH: process.env.PATH, SECRETS_DIR: dir, GROQ_API_KEY_FILE: keyFile, LEDGER_FILE: ledger,
    LLM_DAILY_REQUEST_LIMIT: '0', LLM_GATEWAY_HOST: '127.0.0.1', LLM_GATEWAY_PORT: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Port 0 keeps this startup-only check fully isolated. No provider/model endpoint is called.
  let output = '';
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Groq startup timed out')), 5000);
    child.stdout.on('data', (b) => { output += b; if (output.includes('"ev":"started"')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Groq startup failed')); });
  });
  assert.equal(JSON.parse(output.trim()).backend, 'unverified');
  assert.equal(output.includes('FAKE'), false);
  assert.equal(existsSync(ledger + '.lock'), true);
});
