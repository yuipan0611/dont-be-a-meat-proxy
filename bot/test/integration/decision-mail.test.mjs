// Real pinned Mail + validator, generated identities only. No spikes/native Mail/Discord/provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createDecisionMailWriter } from '../../src/decision-mail.mjs';
import { createDecisionsManager } from '../../src/decisions.mjs';
import { createMemoryStore } from '../helpers/store-memory.mjs';
import { seed, fakeButtonInteraction, FakeClock, GUILD } from '../helpers/fakes.mjs';
import { createMailClient } from '../../../client/mail-client.mjs';

const root = resolve(import.meta.dirname, '../../..');
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
test('R-05 real Mail via validator: registered writer, failed reply, restart and idempotent retry',
  { skip: !docker && 'Docker unavailable', timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-decision-'));
    const project = 'p3-decision-' + process.pid;
    const privateDir = join(dir, 'private'), policy = join(dir, 'policy');
    mkdirSync(policy, { mode: 0o700 });
    writeFileSync(join(policy, 'validator-allowlist.json'), '{"entries":[]}', { mode: 0o600 });
    const listener = createServer();
    await new Promise(r => listener.listen(0, '127.0.0.1', r));
    const port = listener.address().port;
    await new Promise(r => listener.close(r));
    const env = { ...process.env, HUB_PRIVATE_DIR: privateDir, HUB_VALIDATOR_POLICY_DIR: policy,
      HUB_GROUP_ID: 'group-a', HUB_MAIL_PORT: String(port), HUB_OPS_UID: String(process.getuid()),
      HUB_OPS_GID: String(process.getgid()), HUB_VALIDATOR_IMAGE: 'p3-decision-validator:' + process.pid,
      HUB_VALIDATOR_PLATFORM: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64' };
    const run = (exe, args) => {
      const r = spawnSync(exe, args, { env, cwd: root, encoding: 'utf8', timeout: 180_000 });
      assert.equal(r.status, 0, 'local fixture failed; private output suppressed');
      return r.stdout;
    };
    const dc = (...args) => run('docker', ['compose', '-p', project, '-f', 'deploy/compose.yaml',
      '-f', 'deploy/validator/compose.validator.yaml', ...args]);
    try {
      run('python3', ['ops/init-secrets', '--state-dir', privateDir]);
      dc('build', 'validator');
      dc('up', '-d', '--wait', '--wait-timeout', '120', 'mail-a', 'validator');
      const url = `http://127.0.0.1:${port}/mcp/`;
      run('python3', ['ops/bootstrap', '--state-dir', privateDir, '--url', url]);
      const token = JSON.parse(readFileSync(join(privateDir, 'tokens.json'), 'utf8')).upstream;
      const writer = await createDecisionMailWriter({ url, token, projectKey: '/data/projects/group-a',
        senderFile: join(privateDir, 'hubbot.sender.json') });
      const sender = JSON.parse(readFileSync(join(privateDir, 'mac.sender.json'), 'utf8'));
      const mail = createMailClient({ url, token, projectKey: sender.projectKey,
        agentName: sender.agentName, senderToken: sender.senderToken });
      const draft = await mail.sendItem({ to: ['RedStone'], subject: 'synthetic decision draft', kind: 'decision',
        intent: 'question', sourceSession: 'p3-local-test', summary: 'synthetic summary', text: '合成測試決策' });
      const store = createMemoryStore(seed()), clock = new FakeClock();
      await store.recordDecisionDraft({ groupId: 'group-a', draftMailId: draft.messageId, authorAgent: sender.agentName });
      let calls = 0;
      const flaky = { async sendDecision(message) {
        const receipt = await writer.sendDecision(message);
        if (++calls === 1) throw new Error('synthetic response loss after actual Mail save');
        return receipt;
      } };
      const manager = () => createDecisionsManager({ store, discord: {}, mailClient: flaky, clock, defaultGuildId: GUILD });
      const first = fakeButtonInteraction(`decision:confirm:${draft.messageId}`);
      await manager().handleButton(first);
      assert.match(first.log.find(x => x.type === 'edit').content, /失敗.*重試/);
      assert.equal((await store.getDecisionByMailId(draft.messageId)).status, 'draft');
      const before = await mail.fetchEvents({ after: 0 });
      assert.equal(before.events.length, 1, 'actual confirmation saved despite the lost response');
      clock.advance(60_000);
      const retry = fakeButtonInteraction(`decision:confirm:${draft.messageId}`);
      await manager().handleButton(retry);
      assert.match(retry.log.find(x => x.type === 'edit').content, /已轉為正式決策/);
      assert.equal((await store.getDecisionByMailId(draft.messageId)).status, 'confirmed');
      const after = await mail.fetchEvents({ after: 0 });
      assert.deepEqual(after.events, before.events, 'real Mail idempotency returns the same saved message');
      assert.equal(calls, 2);
      const second = await mail.readMessage(after.events[0].message_id);
      assert.equal(JSON.parse(second.message.body_md).status, 'confirmed');
    } finally {
      try { dc('down', '-v', '--remove-orphans'); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
