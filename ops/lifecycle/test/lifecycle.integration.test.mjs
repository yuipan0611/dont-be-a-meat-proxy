// HubClock integration tests against a real local mcp_agent_mail_rust 0.3.40 (same binary/settings as
// client/test/mail-client.integration.test.mjs). Covers the HubClock side of TC-07, TC-08, TC-09, TC-12.
// The recipient's hook (H-04) is simulated with the real mail-client sending the control records it
// will send; the human/file-system parts of those TCs stay manual (H-08).
//
// HubClock's wall clock is real time plus a test-controlled offset, so the real 24 h / 30 min
// constants are exercised without waiting.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailClient, createStaging, syncInbox } from '../../../client/mail-client.mjs';
import { startLocalMail, mailBinAvailable } from '../../../client/test/helpers/local-mail-server.mjs';
import { createLifecycle } from '../lifecycle.mjs';
import { createFileStore } from '../store-file.mjs';
import { loadIdentity } from '../main.mjs';
import { buildClientControl, clientControlKey, tsToMicros } from '../protocol.mjs';

const PROJECT = '/data/projects/group-a';
const MIN = 60_000;
const skip = !(await mailBinAvailable()) && 'mcp-agent-mail binary not found (set MAIL_BIN)';

let hub, tmp, mac, win, clockName, clock, store, lc;

async function register(name) {
  const op = createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: name ?? 'operator' });
  await op.callTool('ensure_project', { human_key: PROJECT });
  const args = { project_key: PROJECT, program: 'h05-it', model: 'none' };
  if (name) args.name = name; // HubClock: omitted → Mail generates the name (PM decision 2026-11-17)
  const reg = await op.callTool('register_agent', args);
  await op.callTool('set_contact_policy', { project_key: PROJECT, agent_name: reg.name, policy: 'open' });
  return reg;
}

const client = (reg) => createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: reg.name, senderToken: reg.registration_token });

before(async () => {
  if (skip) return;
  hub = await startLocalMail();
  tmp = await mkdtemp(join(tmpdir(), 'hubclock-it-'));
  mac = client(await register('BlueLake'));
  win = client(await register('RedStone'));
  // Same files H-02 writes on the VPS (fixture values, mode 600).
  const hc = await register(null);
  const priv = join(tmp, 'private');
  await (await import('node:fs/promises')).mkdir(priv, { mode: 0o700 });
  await writeFile(join(priv, 'mail-a.env'), `HTTP_BEARER_TOKEN=${hub.token}\n`, { mode: 0o600 });
  await writeFile(join(priv, 'hubclock.sender.json'), JSON.stringify({ agentName: hc.name, senderToken: hc.registration_token, projectKey: PROJECT }), { mode: 0o600 });
  const id = await loadIdentity(priv);
  clockName = id.agentName;
  let offset = 0;
  clock = { nowMs: () => Date.now() + offset, jump: (ms) => { offset += ms; }, reset: () => { offset = 0; } };
  store = createFileStore({ dir: join(tmp, 'state'), clock, owner: 'it-writer' });
  assert.equal((await store.acquireLock()).acquired, true);
  const hcClient = createMailClient({ url: hub.url, token: id.token, projectKey: id.projectKey, agentName: id.agentName, senderToken: id.senderToken });
  lc = createLifecycle({ client: hcClient, store, clock, groupId: 'group-a', settleMs: 1_000 });
});

// Mail stamps created_ts with real time; HubClock and Mail share one clock in production (same VPS),
// so each test's time jump is undone before the next test creates new messages.
afterEach(() => clock?.reset());

after(async () => {
  await hub?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

// ---- what the H-04 hook sends
async function sendRequest(from, to, intent, subject) {
  return from.sendItem({ to: [to.agentName], cc: [clockName], subject, kind: 'task', intent, sourceSession: `${from.agentName}-s`, summary: subject, text: subject });
}
async function ctl(from, eventType, root, session, extra = {}) {
  const control = buildClientControl({ eventType, rootMailId: root?.messageId ?? null, recipientSession: session, agent: from.agentName, ...extra });
  return from.sendControl({
    to: [clockName], subject: `${eventType} #${root?.messageId ?? '-'}`, threadId: root?.threadId, control,
    idempotencyKey: clientControlKey({ groupId: 'group-a', eventType, rootMailId: root?.messageId, agent: from.agentName, recipientSession: session }),
  });
}

/** Results HubClock published for one root, as seen in an agent's durable inbox. */
async function resultsFor(agent, rootId) {
  const staging = createStaging({ dir: join(tmp, `inbox-${agent.agentName}`) });
  await syncInbox({ client: agent, staging });
  const out = [];
  for (const id of await staging.list()) {
    const { message } = await staging.get(id);
    if (message.topic !== 'control' || message.from !== clockName) continue;
    const body = JSON.parse(message.body_md);
    if (body.event_type === 'result' && body.root_mail_id === rootId) out.push({ message, body });
  }
  return out;
}
const reqOf = async (root, recipient) => (await store.snapshot()).requests[`${root.messageId}:${recipient.agentName}`];

test('HubClock runs under the Mail-generated name from hubclock.sender.json', { skip }, () => {
  assert.notEqual(clockName, 'HubClock');
  assert.match(clockName, /^[A-Z][a-z]+[A-Z][a-z]+$/);
});

test('TC-07: no approval is published before the choice; approve → result to both in the root thread (both directions)', { skip }, async () => {
  for (const [from, to] of [[mac, win], [win, mac]]) {
    const root = await sendRequest(from, to, 'action', `TC-07 ${from.agentName}→${to.agentName}`);
    await ctl(to, 'presented', root, `${to.agentName}-s1`);
    await lc.tick();
    assert.equal((await reqOf(root, to)).status, 'presented');
    assert.equal((await resultsFor(to, root.messageId)).length, 0, 'recipient must have no approval before choosing');
    await ctl(to, 'choice', root, `${to.agentName}-s1`, { choice: 'approve' });
    await lc.tick();
    const req = await reqOf(root, to);
    assert.equal(req.status, 'approved');
    assert.equal(req.decidedBy, to.agentName);
    for (const who of [from, to]) {
      const [r, ...extra] = await resultsFor(who, root.messageId);
      assert.equal(extra.length, 0);
      assert.equal(r.body.status, 'approved');
      assert.equal(r.message.thread_id, root.threadId);
      assert.equal(r.body.decided_by, to.agentName);
    }
  }
});

test('TC-08: reject with reason reaches the sender; a "question" the recipient presents is handled as action', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'TC-08 tc08.txt');
  await ctl(win, 'presented', root, 'win-s1');
  await ctl(win, 'choice', root, 'win-s1', { choice: 'reject', reason: '測試拒絕' });
  await lc.tick();
  const [r] = await resultsFor(mac, root.messageId);
  assert.equal(r.body.status, 'rejected');
  assert.equal(r.body.reason, '測試拒絕');
  assert.match(r.body.text, /理由：測試拒絕/);

  const q = await sendRequest(mac, win, 'question', 'TC-08 測試有沒有過？沒過就幫我修');
  await lc.tick();
  assert.equal((await reqOf(q, win)).kind, 'question');
  await ctl(win, 'presented', q, 'win-s1');
  await lc.tick();
  const req = await reqOf(q, win);
  assert.equal(req.kind, 'action');
  assert.equal(req.status, 'presented');
  assert.equal(req.reclassified, true);
});

test('TC-09: 30 minutes after presented → expired notice to sender; a later approve does not reopen it', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'TC-09 tc09.txt');
  const p = await ctl(win, 'presented', root, 'win-s1');
  await lc.tick();
  const req0 = await reqOf(root, win);
  assert.equal(req0.deadlineAt - req0.presentedAt, 30 * MIN * 1000);
  assert.equal(req0.presentedAt, tsToMicros(p.createdTs)); // t0 = presented, not the send time
  clock.jump(29 * MIN);
  await lc.tick();
  assert.equal((await reqOf(root, win)).status, 'presented');
  clock.jump(2 * MIN);
  await lc.tick();
  assert.equal((await reqOf(root, win)).status, 'expired');
  const [r] = await resultsFor(mac, root.messageId);
  assert.equal(r.body.status, 'expired');
  // Step 3: approve after timeout is not accepted.
  await ctl(win, 'choice', root, 'win-s1', { choice: 'approve' });
  await lc.tick();
  const req = await reqOf(root, win);
  assert.equal(req.status, 'expired');
  assert.ok(req.late.some((l) => /after expired/.test(l.why)));
  assert.equal((await resultsFor(mac, root.messageId)).length, 1);
});

test('TC-09 step 4: recipient session vanishes without reporting — sender still gets the timeout', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'TC-09 variant');
  await ctl(win, 'presented', root, 'win-s-crash');
  await lc.tick();
  clock.jump(31 * MIN); // Windows is gone; only HubClock keeps time
  await lc.tick();
  const [r] = await resultsFor(mac, root.messageId);
  assert.equal(r.body.status, 'expired');
});

test('session.closed reported by the hook → pending confirmation becomes invalidated, sender notified', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'session closed');
  await ctl(win, 'presented', root, 'win-s9');
  await lc.tick();
  await ctl(win, 'session.closed', null, 'win-s9');
  await lc.tick();
  assert.equal((await reqOf(root, win)).status, 'invalidated');
  const [r] = await resultsFor(mac, root.messageId);
  assert.equal(r.body.status, 'invalidated');
  assert.match(r.body.text, /session 已結束/);
});

test('TC-12: recipient offline — the action only waits (no timer, no result) until a new session presents it', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'TC-12 tc12.txt');
  await lc.tick();
  clock.jump(5 * MIN);
  await lc.tick();
  clock.jump(3 * 60 * MIN);
  await lc.tick();
  let req = await reqOf(root, win);
  assert.equal(req.status, 'pending');
  assert.equal(req.deadlineAt, null);
  assert.equal((await resultsFor(mac, root.messageId)).length, 0);
  // Windows starts a new session and shows the prompt: only now does the 30-minute clock start.
  // (Back to real time: the presented record is stamped by Mail's real clock.)
  clock.reset();
  await ctl(win, 'presented', root, 'win-s-new');
  await lc.tick();
  req = await reqOf(root, win);
  assert.equal(req.status, 'presented');
  assert.equal(req.deadlineAt - req.presentedAt, 30 * MIN * 1000);
});

test('question: 24 h without answer → "unanswered" notice to the asker only', { skip }, async () => {
  const q = await sendRequest(mac, win, 'question', 'Q 24h');
  await lc.tick();
  clock.jump(24 * 60 * MIN + 2_000);
  await lc.tick();
  assert.equal((await reqOf(q, win)).status, 'unanswered');
  const [r] = await resultsFor(mac, q.messageId);
  assert.equal(r.body.status, 'unanswered');
  assert.deepEqual(r.message.to, [mac.agentName]);
  assert.equal((await resultsFor(win, q.messageId)).length, 0);
});

test('rerun / crash-before-commit: the same result key is replayed by Mail, never a second message', { skip }, async () => {
  const root = await sendRequest(mac, win, 'action', 'replay');
  await ctl(win, 'presented', root, 'win-s1');
  await ctl(win, 'choice', root, 'win-s1', { choice: 'approve' });
  await lc.tick();
  // Pretend the process died after Mail stored the result but before we recorded it.
  await store.transact((tx) => {
    for (const e of tx.listOutbox((x) => x.requestKey === `${root.messageId}:${win.agentName}`)) {
      tx.putOutbox({ ...e, state: 'pending', resultMailId: null, nextTryAt: 0 });
    }
  });
  await lc.tick();
  await lc.tick();
  const results = await resultsFor(mac, root.messageId);
  assert.equal(results.length, 1);
  const [e] = (await store.transact((tx) => tx.listOutbox((x) => x.requestKey === `${root.messageId}:${win.agentName}`)));
  assert.equal(e.state, 'sent');
  assert.equal(e.resultMailId, results[0].message.id);
});

// ---- CLI (what systemd / the container runs)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const MAIN = fileURLToPath(new URL('../main.mjs', import.meta.url));

function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
}

test('CLI: `once` runs one tick with the private-dir identity; a second writer stands by (exit 3); no secrets printed', { skip }, async () => {
  const dataDir = join(tmp, 'cli-state');
  const args = ['--private-dir', join(tmp, 'private'), '--data-dir', dataDir, '--url', hub.url];
  const r1 = await runCli(['once', ...args]);
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /"ev":"tick"/);
  assert.equal(r1.out.includes(hub.token), false);
  // Hold the lock as another live writer, then run again.
  const other = createFileStore({ dir: dataDir, clock: { nowMs: () => Date.now() }, owner: 'other-live-writer' });
  assert.equal((await other.acquireLock()).acquired, true);
  const r2 = await runCli(['once', ...args]);
  assert.equal(r2.code, 3, r2.out);
  assert.match(r2.out, /"ev":"standby"/);
  await other.releaseLock();
  const st = await runCli(['status', '--data-dir', dataDir]);
  assert.equal(st.code, 0, st.out);
  assert.ok(JSON.parse(st.out).cursor !== undefined);
});
