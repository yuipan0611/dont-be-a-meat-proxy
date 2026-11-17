import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionMailWriter } from '../src/decision-mail.mjs';

test('decision writer rejects public files, symlinks and foreign identities without exposing their contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p3-writer-'));
  try {
    const file = join(dir, 'sender.json'), url = 'http://127.0.0.1:1/mcp/';
    const cfg = { url, token: 'synthetic-device', projectKey: '/data/projects/group-a', senderFile: file };
    await writeFile(file, JSON.stringify({ projectKey: cfg.projectKey, agentName: 'JadeBluff', senderToken: 'SYNTHETIC_PRIVATE_VALUE' }), { mode: 0o644 });
    const refusal = e => /identity unavailable or invalid/.test(e.message) && !e.message.includes('SYNTHETIC_PRIVATE_VALUE');
    await assert.rejects(createDecisionMailWriter(cfg), refusal);
    await chmod(file, 0o600);
    const link = join(dir, 'link.json'); await symlink(file, link);
    await assert.rejects(createDecisionMailWriter({ ...cfg, senderFile: link }), refusal);
    await assert.rejects(createDecisionMailWriter({ ...cfg, projectKey: '/data/projects/group-b' }), refusal);
    const writer = await createDecisionMailWriter(cfg);
    await assert.rejects(writer.sendDecision({ project_key: '/data/projects/group-b' }), /group boundary/);
    await writeFile(file, '{SYNTHETIC_PRIVATE_VALUE');
    await assert.rejects(createDecisionMailWriter(cfg), refusal);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
