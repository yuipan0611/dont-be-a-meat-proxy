import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore } from '../../lifecycle/store-file.mjs';
import { tempDir } from '../../lifecycle/test/helpers.mjs';

const entry = fileURLToPath(new URL('../main.mjs', import.meta.url));

async function setup(t, projectKey = '/data/projects/group-a') {
  const { dir, cleanup } = await tempDir('bridge-main-');
  t.after(cleanup);
  const privateDir = join(dir, 'private');
  const dataDir = join(dir, 'state');
  await mkdir(privateDir);
  for (const [name, value] of Object.entries({
    'mail-a.env': `HTTP_BEARER_TOKEN=${'x'.repeat(32)}\n`,
    'memorybridge.sender.json': JSON.stringify({ agentName: 'BridgeAgent', senderToken: 'fixture', projectKey }),
    'hindsight-api.key': 'fixture',
  })) await writeFile(join(privateDir, name), value, { mode: 0o600 });
  const store = createFileStore({ dir: dataDir, clock: { nowMs: Date.now } });
  const run = (...args) => spawnSync(process.execPath, [entry, '--private-dir', privateDir, '--data-dir', dataDir, ...args], {
    encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH },
  });
  return { store, run };
}

test('status redacts historical errors and the next writer removes them from state', async (t) => {
  const { store, run } = await setup(t);
  const message = 'legacy upstream 私密 fixture';
  await store.acquireLock();
  await store.transact((tx) => tx.putRequest({
    key: 'mail-7', mailId: 7, bank: 'group-a', status: 'error',
    lastError: { stage: 'retain', kind: 'rejected', status: 422, message },
  }));
  await store.releaseLock();
  const expected = {
    stage: 'retain', kind: 'rejected', status: 422, code: 'LEGACY_ERROR',
    length: Buffer.byteLength(message), sha256: createHash('sha256').update(message).digest('hex'),
  };
  const status = run('status');
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).notIndexed[0].lastError, expected);
  const reindex = run('reindex', '7');
  assert.equal(reindex.status, 0, reindex.stdout + reindex.stderr);
  assert.deepEqual((await store.snapshot()).requests['mail-7'].lastError, expected);
});
