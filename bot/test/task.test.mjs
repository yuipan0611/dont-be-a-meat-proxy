// TC-19: 從 Discord 建 GitHub Issue（SRS SR-TASK-01～05、§4.5 #10、AC-10.1～10.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubClient, loadGitHubToken, GitHubError } from '../src/github.mjs';
import { createTaskService, TASK_CONFIRM_PREFIX, TASK_CANCEL_PREFIX } from '../src/task.mjs';
import { createRouter, EPHEMERAL, NOT_MEMBER } from '../src/router.mjs';
import { createMemoryStore } from './helpers/store-memory.mjs';
import {
  createFakeGitHub,
  createFakeMail,
  fakeInteraction,
  fakeButtonInteraction,
  seed,
  GUILD,
  OWNER_DISCORD,
  STRANGER,
} from './helpers/fakes.mjs';

function setupTaskRig({ gitHubFail = null, defaultRepo = 'example-org/dont-be-a-meat-proxy', now = Date.now } = {}) {
  const store = createMemoryStore(seed());
  const mail = createFakeMail();
  const github = createFakeGitHub({ failNext: gitHubFail, defaultRepo });
  const taskService = createTaskService({ store, github, mailClient: mail, defaultRepo, now });
  const router = createRouter({ store, connect: {}, assistant: {}, taskService });
  return { store, mail, github, taskService, router, defaultRepo };
}

async function stage(rig) {
  const ix = fakeInteraction('task', { title: '待確認任務' });
  await rig.router.handle(ix);
  return ix.log.find((x) => x.type === 'edit').components[0].components[0].custom_id;
}

test('task confirmation rechecks the active member and Discord link in its original guild', async (t) => {
  for (const table of ['members', 'links']) {
    await t.test(`revoked ${table}`, async () => {
      const rig = setupTaskRig();
      const id = await stage(rig);
      const member = await rig.store.findMemberByDiscord(GUILD, OWNER_DISCORD);
      const row = rig.store.db[table].find((r) => (r.member_id ?? r.id) === member.memberId);
      row.status = 'revoked';
      const click = fakeButtonInteraction(id);
      await rig.router.handle(click);
      assert.equal(rig.github.issues.length, 0);
      assert.equal(rig.mail.messages.size, 0);
      assert.ok(click.log.some((x) => x.flags === EPHEMERAL && /成員/.test(x.content)));
    });
  }
  const rig = setupTaskRig();
  const id = await stage(rig);
  const otherGuild = fakeButtonInteraction(id, { guildId: 'other-guild' });
  await rig.router.handle(otherGuild);
  assert.equal(rig.github.issues.length, 0);
  assert.ok(otherGuild.log.some((x) => x.flags === EPHEMERAL));
  await rig.router.handle(fakeButtonInteraction(id));
  assert.equal(rig.github.issues.length, 1, 'the correct guild can still confirm');
});

test('task confirmation denies expiry at five minutes, including during membership lookup', async (t) => {
  const ttl = 5 * 60_000;
  for (const delay of [0, 1]) {
    await t.test(`lookup delay ${delay}`, async () => {
      let time = 0;
      const rig = setupTaskRig({ now: () => time });
      const id = await stage(rig);
      time = ttl - delay;
      const lookup = rig.store.findMemberByDiscord;
      rig.store.findMemberByDiscord = async (...args) => {
        time += delay;
        return lookup(...args);
      };
      const click = fakeButtonInteraction(id);
      await rig.router.handle(click);
      assert.equal(rig.github.issues.length, 0);
      assert.ok(click.log.some((x) => x.flags === EPHEMERAL && /已過期/.test(x.content)));
    });
  }
});

test('simultaneous confirmations claim the task before the membership await', async () => {
  const rig = setupTaskRig();
  const id = await stage(rig);
  const lookup = rig.store.findMemberByDiscord;
  let checks = 0;
  rig.store.findMemberByDiscord = async (...args) => { checks++; return lookup(...args); };
  await Promise.all([rig.router.handle(fakeButtonInteraction(id)), rig.router.handle(fakeButtonInteraction(id))]);
  assert.equal(checks, 1);
  assert.equal(rig.github.issues.length, 1);
});

// --------------------------------------------------------------------------
// 1. GitHub REST Client unit tests
// --------------------------------------------------------------------------

test('loadGitHubToken: reads from private file or env var, handles missing file', async () => {
  const dir = join(tmpdir(), `gh-token-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'token.txt');
  await writeFile(file, '  ghp_m\x6fcktoken1234567890  \n');

  const tokenFromFile = await loadGitHubToken({ tokenFile: file });
  assert.equal(tokenFromFile, 'ghp_m\x6fcktoken1234567890');

  const tokenFromEnv = await loadGitHubToken({ tokenFile: null, envToken: 'ghp_envtoken999' });
  assert.equal(tokenFromEnv, 'ghp_envtoken999');

  const tokenEmpty = await loadGitHubToken({ tokenFile: null, envToken: '' });
  assert.equal(tokenEmpty, null);

  await assert.rejects(
    () => loadGitHubToken({ tokenFile: join(dir, 'nonexistent.txt') }),
    (err) => err instanceof GitHubError && err.code === 'E-GITHUB',
  );

  await rm(dir, { recursive: true, force: true });
});

test('createGitHubClient: official REST API headers and success response (201)', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, opts) => {
    capturedRequest = { url, ...opts, body: JSON.parse(opts.body) };
    return {
      status: 201,
      async json() {
        return {
          number: 19,
          title: capturedRequest.body.title,
          html_url: `https://github.com/example-org/dont-be-a-meat-proxy/issues/19`,
        };
      },
    };
  };

  const client = createGitHubClient({
    token: 'ghp_test_token',
    defaultRepo: 'example-org/dont-be-a-meat-proxy',
    fetch: mockFetch,
  });

  const issue = await client.createIssue({ title: 'TC19 測試任務', body: '詳細說明' });
  assert.equal(issue.number, 19);
  assert.equal(issue.url, 'https://github.com/example-org/dont-be-a-meat-proxy/issues/19');
  assert.equal(issue.title, 'TC19 測試任務');

  // Verify headers and endpoint
  assert.equal(capturedRequest.url, 'https://api.github.com/repos/example-org/dont-be-a-meat-proxy/issues');
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.headers['Authorization'], 'Bearer ghp_test_token');
  assert.equal(capturedRequest.headers['Accept'], 'application/vnd.github+json');
  assert.equal(capturedRequest.headers['User-Agent'], 'neighbor-hub-bot');
  assert.equal(capturedRequest.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual(capturedRequest.body, { title: 'TC19 測試任務', body: '詳細說明' });
});

test('createGitHubClient: rejects empty title with E-TITLE', async () => {
  const client = createGitHubClient({ token: 'ghp_test_token' });
  await assert.rejects(
    () => client.createIssue({ title: '   ' }),
    (err) => err instanceof GitHubError && err.code === 'E-TITLE' && err.message.includes('標題必填'),
  );
});

test('createGitHubClient: converts non-201 response and network error to E-GITHUB', async () => {
  const failClient = (status, message) =>
    createGitHubClient({
      token: 'ghp_test',
      fetch: async () => ({
        status,
        async json() {
          return { message };
        },
      }),
    });

  await assert.rejects(
    () => failClient(401, 'Bad credentials').createIssue({ title: 'task' }),
    (err) => err instanceof GitHubError && err.code === 'E-GITHUB' && err.message.includes('Bad credentials'),
  );

  await assert.rejects(
    () => failClient(404, 'Not Found').createIssue({ title: 'task' }),
    (err) => err instanceof GitHubError && err.code === 'E-GITHUB' && err.message.includes('Not Found'),
  );

  const netErrorClient = createGitHubClient({
    token: 'ghp_test',
    fetch: async () => {
      throw new Error('fetch failed: ENOTFOUND');
    },
  });

  await assert.rejects(
    () => netErrorClient.createIssue({ title: 'task' }),
    (err) => err instanceof GitHubError && err.code === 'E-GITHUB' && err.message.includes('連線失敗'),
  );
});

// --------------------------------------------------------------------------
// 2. TC-19 Full flow: Discord -> Two-step Confirmation -> GitHub -> Hub
// --------------------------------------------------------------------------

test('TC-19: create task with title "TC19 測試任務" -> confirm -> GitHub issue created, bot returns number & url, Hub task item saved', async () => {
  const rig = setupTaskRig();

  // 1. User runs /task
  const ix = fakeInteraction('task', { title: 'TC19 測試任務' });
  await rig.router.handle(ix);

  // Defer is ephemeral
  assert.deepEqual(ix.log[0], { type: 'defer', flags: EPHEMERAL });

  // Confirmation prompt displayed
  const edit = ix.log.find((x) => x.type === 'edit');
  assert.ok(edit, 'editReply must be called');
  assert.match(edit.content, /將建立任務：/);
  assert.match(edit.content, /TC19 測試任務/);
  assert.match(edit.content, /example-org\/dont-be-a-meat-proxy/);

  // Components: ActionRow with confirm and cancel buttons
  assert.equal(edit.components.length, 1);
  const row = edit.components[0];
  const confirmBtn = row.components.find((c) => c.custom_id.startsWith(TASK_CONFIRM_PREFIX));
  const cancelBtn = row.components.find((c) => c.custom_id.startsWith(TASK_CANCEL_PREFIX));
  assert.ok(confirmBtn, 'confirm button must exist');
  assert.ok(cancelBtn, 'cancel button must exist');

  // Before clicking confirm: no GitHub issue, no Hub mail
  assert.equal(rig.github.issues.length, 0);
  assert.equal(rig.mail.messages.size, 0);

  // 2. User clicks confirm button
  const confirmIx = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(confirmIx);

  // Button interaction acknowledged via deferUpdate
  assert.ok(confirmIx.log.some((l) => l.type === 'deferUpdate'));

  // Message updated with issue number and URL
  const updateLog = confirmIx.log.find((l) => l.type === 'edit' || l.type === 'update');
  assert.ok(updateLog, 'interaction must update message');
  assert.match(updateLog.content, /已建立任務 #1/);
  assert.match(updateLog.content, /https:\/\/github.com\/example-org\/dont-be-a-meat-proxy\/issues\/1/);
  assert.deepEqual(updateLog.components, [], 'buttons should be cleared');

  // 3. Verify GitHub issue created (Single Source of Truth)
  assert.equal(rig.github.issues.length, 1);
  const createdIssue = rig.github.issues[0];
  assert.equal(createdIssue.number, 1);
  assert.equal(createdIssue.title, 'TC19 測試任務');
  assert.equal(createdIssue.url, 'https://github.com/example-org/dont-be-a-meat-proxy/issues/1');

  // 4. Verify Hub (Agent Mail) item saved (SR-TASK-01, SR-TASK-02)
  assert.equal(rig.mail.messages.size, 1);
  const hubMsg = rig.mail.messages.get(1);
  assert.equal(hubMsg.topic, 'task');
  assert.match(hubMsg.subject, /\[任務 #1\] TC19 測試任務/);

  const envelope = JSON.parse(hubMsg.body_md);
  assert.equal(envelope.kind, 'task');
  assert.equal(envelope.intent, 'action');
  assert.deepEqual(envelope.links, ['https://github.com/example-org/dont-be-a-meat-proxy/issues/1']);
  assert.match(envelope.text, /https:\/\/github.com\/example-org\/dont-be-a-meat-proxy\/issues\/1/);

  // 5. Verify audit log
  const audit = rig.store.db.audit.find((a) => a.action === 'discord.task.created');
  assert.ok(audit, 'audit log must record discord.task.created');
  assert.equal(audit.details.issueNumber, 1);
  assert.equal(audit.details.issueUrl, createdIssue.url);
});

test('TC-19 negative: empty or whitespace title -> prompt 標題必填, GitHub count unchanged, no Hub item', async () => {
  const rig = setupTaskRig();

  // Test empty string and whitespace-only
  for (const emptyTitle of ['', '   ', '\t\n']) {
    const ix = fakeInteraction('task', { title: emptyTitle });
    await rig.router.handle(ix);

    const edit = ix.log.find((x) => x.type === 'edit');
    assert.ok(edit);
    assert.match(edit.content, /標題必填/);
    assert.ok(!edit.components || edit.components.length === 0, 'no buttons on validation error');
  }

  // Issue count remains 0, nothing sent to Hub
  assert.equal(rig.github.issues.length, 0);
  assert.equal(rig.mail.messages.size, 0);
});

test('TC-19 negative: GitHub token fails (401 Bad credentials) -> E-GITHUB with reason, not reported as success, no Hub item', async () => {
  const rig = setupTaskRig({ gitHubFail: 'Bad credentials' });

  // 1. Stage task
  const ix = fakeInteraction('task', { title: 'TC19 測試任務' });
  await rig.router.handle(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  const confirmBtn = edit.components[0].components.find((c) => c.custom_id.startsWith(TASK_CONFIRM_PREFIX));

  // 2. Click confirm
  const confirmIx = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(confirmIx);

  // Message must report failure reason, must NOT report success
  const updateLog = confirmIx.log.find((l) => l.type === 'edit' || l.type === 'update');
  assert.ok(updateLog);
  assert.match(updateLog.content, /E-GITHUB/);
  assert.match(updateLog.content, /Bad credentials/);
  assert.ok(!updateLog.content.includes('已建立任務'), 'must never report success on failure');

  // No issue created, no Hub item sent
  assert.equal(rig.github.issues.length, 0);
  assert.equal(rig.mail.messages.size, 0);
});

test('§4.5 #10: two-step confirmation cancellation -> click cancel -> cancelled, no Issue created, no Hub item', async () => {
  const rig = setupTaskRig();

  const ix = fakeInteraction('task', { title: '想建但後悔的任務' });
  await rig.router.handle(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  const cancelBtn = edit.components[0].components.find((c) => c.custom_id.startsWith(TASK_CANCEL_PREFIX));

  // Click cancel
  const cancelIx = fakeButtonInteraction(cancelBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(cancelIx);

  const updateLog = cancelIx.log.find((l) => l.type === 'update' || l.type === 'edit');
  assert.ok(updateLog);
  assert.match(updateLog.content, /已取消建立任務/);
  assert.deepEqual(updateLog.components, []);

  // No Issue created, no Hub item sent
  assert.equal(rig.github.issues.length, 0);
  assert.equal(rig.mail.messages.size, 0);
});

test('§4.5 #10: only initiator can confirm or cancel; stranger is rejected, task remains pending', async () => {
  const rig = setupTaskRig();

  const ix = fakeInteraction('task', { title: '重要任務' }, { userId: OWNER_DISCORD });
  await rig.router.handle(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  const confirmBtn = edit.components[0].components.find((c) => c.custom_id.startsWith(TASK_CONFIRM_PREFIX));
  const cancelBtn = edit.components[0].components.find((c) => c.custom_id.startsWith(TASK_CANCEL_PREFIX));

  // 1. Stranger tries to cancel
  const strangerCancel = fakeButtonInteraction(cancelBtn.custom_id, { userId: STRANGER });
  await rig.router.handle(strangerCancel);
  const cancelReply = strangerCancel.log.find((l) => l.type === 'reply');
  assert.ok(cancelReply, 'stranger must get ephemeral reply');
  assert.match(cancelReply.content, /只有發起人能取消/);
  assert.equal(cancelReply.flags, EPHEMERAL);

  // 2. Stranger tries to confirm
  const strangerConfirm = fakeButtonInteraction(confirmBtn.custom_id, { userId: STRANGER });
  await rig.router.handle(strangerConfirm);
  const confirmReply = strangerConfirm.log.find((l) => l.type === 'reply');
  assert.ok(confirmReply, 'stranger must get ephemeral reply');
  assert.match(confirmReply.content, /只有發起人能確認/);
  assert.equal(confirmReply.flags, EPHEMERAL);

  // Issue is still not created
  assert.equal(rig.github.issues.length, 0);

  // 3. Real initiator now clicks confirm -> succeeds!
  const realConfirm = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(realConfirm);

  const updateLog = realConfirm.log.find((l) => l.type === 'edit' || l.type === 'update');
  assert.match(updateLog.content, /已建立任務 #1/);
  assert.equal(rig.github.issues.length, 1);
});

test('double click protection: second click reports already handled / expired, no duplicate issue', async () => {
  const rig = setupTaskRig();

  const ix = fakeInteraction('task', { title: '防連點任務' });
  await rig.router.handle(ix);

  const confirmBtn = ix.log.find((x) => x.type === 'edit').components[0].components[0];

  // First click -> success
  const click1 = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(click1);
  assert.equal(rig.github.issues.length, 1);

  // Second click with same actionId -> already handled
  const click2 = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(click2);
  const update2 = click2.log.find((l) => l.type === 'followUp' && l.flags === EPHEMERAL);
  assert.match(update2.content, /已過期或不存在/);

  // No duplicate issue created
  assert.equal(rig.github.issues.length, 1);
});

test('non-member cannot use /task: refused with NOT_MEMBER', async () => {
  const rig = setupTaskRig();

  const ix = fakeInteraction('task', { title: '非成員想建任務' }, { userId: STRANGER });
  await rig.router.handle(ix);

  assert.equal(ix.log[0].flags, EPHEMERAL);
  const edit = ix.log.find((x) => x.type === 'edit');
  assert.equal(edit.content, NOT_MEMBER);
  assert.equal(rig.github.issues.length, 0);
  assert.equal(rig.mail.messages.size, 0);
});

test('custom options: repo, body, assignee are preserved and forwarded', async () => {
  const rig = setupTaskRig();

  const ix = fakeInteraction('task', {
    title: '自訂選項任務',
    repo: 'my-org/custom-repo',
    body: '詳細步驟與驗收標準',
    assignee: 'RedStone',
  });
  await rig.router.handle(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  assert.match(edit.content, /my-org\/custom-repo/);
  assert.match(edit.content, /詳細步驟與驗收標準/);

  const confirmBtn = edit.components[0].components.find((c) => c.custom_id.startsWith(TASK_CONFIRM_PREFIX));
  const confirmIx = fakeButtonInteraction(confirmBtn.custom_id, { userId: OWNER_DISCORD });
  await rig.router.handle(confirmIx);

  // GitHub issue created in custom repo
  assert.equal(rig.github.issues.length, 1);
  assert.equal(rig.github.issues[0].repo, 'my-org/custom-repo');
  assert.equal(rig.github.issues[0].body, '詳細步驟與驗收標準');

  // Hub mail forwarded to designated assignee RedStone
  const hubMsg = rig.mail.messages.get(1);
  assert.deepEqual(hubMsg.to, ['RedStone']);
  const env = JSON.parse(hubMsg.body_md);
  assert.match(env.text, /詳細步驟與驗收標準/);
  assert.deepEqual(env.links, ['https://github.com/my-org/custom-repo/issues/1']);
});
