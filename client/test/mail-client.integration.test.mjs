// Integration tests against a real local mcp_agent_mail_rust (0.3.40) process.
// Skipped (not failed) when the binary is absent; see client/README.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailClient, createStaging, syncInbox, MailError } from '../mail-client.mjs';
import { startLocalMail, mailBinAvailable } from './helpers/local-mail-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = '/data/projects/group-a';
const skip = !(await mailBinAvailable()) && 'mcp-agent-mail binary not found (set MAIL_BIN)';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

let hub, mac, win, tmp;

async function bootstrap(name) {
  // Operator bootstrap (H-02 does this on the VPS): register + open contact policy.
  const op = createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: name });
  await op.callTool('ensure_project', { human_key: PROJECT });
  const reg = await op.callTool('register_agent', { project_key: PROJECT, name, program: 'h03-it', model: 'none' });
  await op.callTool('set_contact_policy', { project_key: PROJECT, agent_name: name, policy: 'open' });
  return createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: name, senderToken: reg.registration_token });
}

before(async () => {
  if (skip) return;
  hub = await startLocalMail();
  tmp = await mkdtemp(join(tmpdir(), 'hub-staging-it-'));
  mac = await bootstrap('BlueLake');
  win = await bootstrap('RedStone');
});

after(async () => {
  await hub?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

function item(text, over = {}) {
  return {
    to: ['RedStone'],
    subject: 'TC-03 交接',
    kind: 'handoff',
    intent: 'question',
    sourceSession: 'mac-session-it',
    summary: '逐字取回測試',
    text,
    links: ['https://github.com/example-org/example-repo/pull/128'],
    unfinished: [],
    ...over,
  };
}

test('TC-03: 1,500-char Traditional Chinese handoff is retrieved byte-for-byte via staging', { skip }, async () => {
  const fixture = await readFile(join(here, 'fixtures', 'handoff-1500.txt'), 'utf8');
  const expectedSha = (await readFile(join(here, 'fixtures', 'handoff-1500.sha256'), 'utf8')).trim();
  const sent = await mac.sendItem(item(fixture));
  assert.equal(sent.status, 'saved');

  const staging = createStaging({ dir: join(tmp, 'tc03') });
  const result = await syncInbox({ client: win, staging });
  assert.ok(result.staged.includes(sent.messageId));

  const staged = await staging.get(sent.messageId);
  const envelope = JSON.parse(staged.message.body_md);
  assert.equal(sha256(envelope.text), expectedSha);
  // AC-01.1: type, sender, recipient, time are all retrievable.
  assert.equal(envelope.kind, 'handoff');
  assert.equal(staged.message.topic, 'handoff');
  assert.equal(staged.message.from, 'BlueLake');
  assert.deepEqual(staged.message.to, ['RedStone']);
  assert.equal(staged.message.created_ts, sent.createdTs);
});

test('TC-03: emoji, code block and CRLF survive verbatim, and the raw Hub text is staged unmodified', { skip }, async () => {
  const text = '繁中 😀👨‍👩‍👧 🙏\r\n```js\nconst a = "引號";\n\tindent();\n```\n尾行沒有換行';
  const sent = await mac.sendItem(item(text));
  const staging = createStaging({ dir: join(tmp, 'tc03b') });
  await syncInbox({ client: win, staging });
  const staged = await staging.get(sent.messageId);
  assert.equal(JSON.parse(staged.message.body_md).text, text);
  // staging keeps the exact resource text returned by the Hub
  assert.equal(JSON.parse(staged.raw).body_md, staged.message.body_md);
});

test('sync does not mark messages read (mark_read=false semantics)', { skip }, async () => {
  const sent = await mac.sendItem(item('peek only'));
  const staging = createStaging({ dir: join(tmp, 'peek') });
  await syncInbox({ client: win, staging });
  const unread = await win.callTool('fetch_inbox', {
    project_key: PROJECT, agent_name: 'RedStone', unread_only: true, mark_read: false, include_bodies: false, limit: 100,
  });
  assert.ok(unread.some((m) => m.id === sent.messageId));
});

test('sync resumes from the committed cursor and only stages new deliveries', { skip }, async () => {
  const staging = createStaging({ dir: join(tmp, 'cursor') });
  await syncInbox({ client: win, staging });
  const cursor1 = await staging.getCursor();
  const sent = await mac.sendItem(item('after cursor'));
  const r2 = await syncInbox({ client: win, staging });
  assert.deepEqual(r2.staged, [sent.messageId]);
  assert.ok((await staging.getCursor()) > cursor1);
});

test('same idempotency key resend returns the original ID without a second message', { skip }, async () => {
  const id = randomUUID();
  const a = await mac.sendItem(item('idempotent', { clientEventId: id }));
  const b = await mac.sendItem(item('idempotent', { clientEventId: id }));
  assert.equal(b.messageId, a.messageId);
  assert.equal(b.replay, true);
});

test('same key with a changed payload is rejected and the original stands', { skip }, async () => {
  const id = randomUUID();
  await mac.sendItem(item('original', { clientEventId: id }));
  await assert.rejects(mac.sendItem(item('changed', { clientEventId: id })), (e) => {
    assert.ok(e instanceof MailError);
    assert.equal(e.code, 'E-CONFLICT');
    assert.equal(e.delivery, 'not_saved');
    return true;
  });
});

test('TC-11: unknown recipient is rejected as E-RCPT and nothing is saved', { skip }, async () => {
  const staging = createStaging({ dir: join(tmp, 'tc11') });
  await syncInbox({ client: win, staging });
  const before = await staging.getCursor();
  const tailBefore = (await win.fetchEvents({ after: before })).tailCursor;

  await assert.rejects(mac.sendItem(item('typo', { to: ['win-claud'] })), (e) => {
    assert.equal(e.code, 'E-RCPT');
    assert.equal(e.delivery, 'not_saved');
    assert.deepEqual(e.details.unknown, ['win-claud']);
    return true;
  });
  const after = await win.fetchEvents({ after: before });
  assert.equal(after.events.length, 0);
  assert.equal(after.tailCursor, tailBefore);
});

test('wrong bearer token maps to E-AUTH', { skip }, async () => {
  const bad = createMailClient({ url: hub.url, token: 'wrong-token', projectKey: PROJECT, agentName: 'BlueLake', senderToken: 'x' });
  await assert.rejects(bad.sendItem(item('nope')), (e) => e.code === 'E-AUTH' && e.delivery === 'not_saved');
});
