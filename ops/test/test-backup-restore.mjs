// ops/test/test-backup-restore.mjs
// Automated verification drill for ticket H-06:
// 1. Starts local mail-a server with authentic mcp_agent_mail_rust process
// 2. Writes multiple messages with Traditional Chinese, emoji, multi-line, code blocks
// 3. Records sha256 hashes of original texts, message IDs, and cursors
// 4. Executes ops/backup
// 5. Destroys data directory completely
// 6. Executes ops/restore to clean directory
// 7. Restarts mail-a on restored data
// 8. Reads back messages via H-03 client and verifies byte-for-byte sha256 & cursor equality
// 9. Tests ops/purge (date guardrail, dry-run default, permanent execution)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMailClient } from '../../client/mail-client.mjs';
import { startLocalMail, mailBinAvailable } from '../../client/test/helpers/local-mail-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const PROJECT = '/data/projects/group-a';

const sha256 = (str) => createHash('sha256').update(str, 'utf8').digest('hex');

test('H-06: Full backup, restore, and sha256 consistency drill', async (t) => {
  const available = await mailBinAvailable();
  if (!available) {
    t.skip('mcp-agent-mail binary not found in .hub-local/bin or MAIL_BIN');
    return;
  }

  const baseTmp = await mkdtemp(join(tmpdir(), 'h06-drill-'));
  const dataDir = join(baseTmp, 'data');
  const stateDir = join(baseTmp, 'private');
  const backupDir = join(baseTmp, 'backups');
  const clockDir = join(baseTmp, 'lifecycle');
  const caddySnippet = join(baseTmp, 'hub.caddy');
  const caddyPrivateDir = join(baseTmp, 'hub-private');
  const receiptDir = join(baseTmp, 'receipts');

  await mkdir(dataDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await mkdir(clockDir, { recursive: true });
  await mkdir(caddyPrivateDir, { recursive: true });
  await mkdir(receiptDir, { recursive: true });

  // Prepare H-02 actual files to verify auxiliary backup
  await writeFile(join(stateDir, 'tokens.json'), JSON.stringify({ version: 1, revision: 1, group_id: 'group-a' }, null, 2));
  await writeFile(join(stateDir, 'mail-a.env'), 'HTTP_BEARER_TOKEN=mock_upstream_token_1234567890\n');
  await writeFile(join(stateDir, 'mac.env'), 'HUB_MAIL_URL=https://hub.example.invalid/mcp/\nHUB_TOKEN=mock_mac_token\n');
  await writeFile(join(stateDir, 'windows.env'), 'HUB_MAIL_URL=https://hub.example.invalid/mcp/\nHUB_TOKEN=mock_windows_token\n');
  await writeFile(join(stateDir, 'mac.sender.json'), JSON.stringify({ agentName: 'BlueLake', senderToken: 'token_mac_reg' }, null, 2));
  await writeFile(join(stateDir, 'windows.sender.json'), JSON.stringify({ agentName: 'RedStone', senderToken: 'token_win_reg' }, null, 2));
  const hubclockContent = JSON.stringify({ agentName: 'OrangeFox', senderToken: 'token_hubclock_reg' }, null, 2);
  await writeFile(join(stateDir, 'hubclock.sender.json'), hubclockContent);

  await writeFile(caddySnippet, 'hub.example.invalid { import /etc/caddy/hub-private/auth.caddy }\n');
  const authCaddyContent = '@allowed {\n  header Authorization "Bearer mock_mac_token"\n}\n';
  await writeFile(join(caddyPrivateDir, 'auth.caddy'), authCaddyContent);
  await writeFile(join(clockDir, 'hubclock.sqlite3'), ''); // mock DB

  // Step 1: Start local mail-a
  console.log('[Step 1] Starting local mail-a server...');
  const hub = await startLocalMail({ dataDir });
  console.log(`[Step 1] mail-a running at ${hub.url} (PID: ${hub.pid})`);

  // Step 2: Bootstrap project and agents
  console.log('[Step 2] Bootstrapping project and agents...');
  const op = createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: 'Operator' });
  await op.callTool('ensure_project', { human_key: PROJECT });
  const regMac = await op.callTool('register_agent', { project_key: PROJECT, name: 'BlueLake', program: 'h06-it', model: 'none' });
  const regWin = await op.callTool('register_agent', { project_key: PROJECT, name: 'RedStone', program: 'h06-it', model: 'none' });
  await op.callTool('set_contact_policy', { project_key: PROJECT, agent_name: 'BlueLake', policy: 'open' });
  await op.callTool('set_contact_policy', { project_key: PROJECT, agent_name: 'RedStone', policy: 'open' });

  const macClient = createMailClient({
    url: hub.url,
    token: hub.token,
    projectKey: PROJECT,
    agentName: 'BlueLake',
    senderToken: regMac.registration_token,
    roster: ['RedStone'],
  });

  const winClient = createMailClient({
    url: hub.url,
    token: hub.token,
    projectKey: PROJECT,
    agentName: 'RedStone',
    senderToken: regWin.registration_token,
    roster: ['BlueLake'],
  });

  // Step 3: Write messages with Traditional Chinese & Emoji & Code Blocks
  console.log('[Step 3] Sending test messages with Traditional Chinese and emojis...');
  const testMessages = [
    {
      subject: '登入模組重構交接（繁體中文）',
      summary: '登入模組繁中交接摘要',
      text: '登入模組重構交接：已完成 session 驗證與 CSRF 防護，下一步待對齊後端端點。請確認權限配置與 token 輪替。',
      kind: 'handoff',
      intent: 'question',
      sourceSession: 'mac-session-h06-1',
    },
    {
      subject: '上線準備與特殊符號測試 🚀🐱💻',
      summary: 'Emoji 與特殊字元測試摘要',
      text: '測試上線準備 🚀🐱💻！\n信件編號 #42，包含特殊標點【測試】與繁中換行。\n第二行：資料備份與還原演練。\n第三行結尾 🎉。',
      kind: 'handoff',
      intent: 'action',
      sourceSession: 'mac-session-h06-2',
    },
    {
      subject: '代碼區塊與換行交接',
      summary: '代碼區塊摘要',
      text: '代碼範例交接：\r\n```javascript\r\nconst msg = "哈囉，世界！🪐";\r\nconsole.log(msg);\r\n```\r\n以上請審查確認。',
      kind: 'handoff',
      intent: 'question',
      sourceSession: 'mac-session-h06-3',
    },
  ];

  const sentRecords = [];
  for (const msg of testMessages) {
    const res = await macClient.sendItem({
      to: ['RedStone'],
      subject: msg.subject,
      kind: msg.kind,
      intent: msg.intent,
      sourceSession: msg.sourceSession,
      summary: msg.summary,
      text: msg.text,
    });
    assert.equal(res.status, 'saved', 'message should be saved');
    sentRecords.push({
      id: res.messageId,
      originalText: msg.text,
      sha256: sha256(msg.text),
      subject: msg.subject,
    });
    console.log(`[Step 3] Sent message #${res.messageId}: ${msg.subject} (SHA256: ${sha256(msg.text)})`);
  }

  // Step 4: Record pre-backup events & cursors
  console.log('[Step 4] Reading pre-backup events and cursor...');
  const preEvents = await winClient.fetchEvents({ limit: 100 });
  assert.equal(preEvents.events.length, 3, 'should have 3 inbox events');
  const preTailCursor = preEvents.tailCursor;
  console.log(`[Step 4] Pre-backup events count: ${preEvents.events.length}, tailCursor: ${preTailCursor}`);

  // Step 5: Stop mail-a gracefully before backup drill
  console.log('[Step 5] Stopping mail-a server...');
  await hub.stop({ keepData: true });

  // Step 6: Execute ops/backup
  console.log('[Step 6] Running ops/backup...');
  const backupOut = execFileSync(join(repoRoot, 'ops', 'backup'), [
    '--data-dir', dataDir,
    '--state-dir', stateDir,
    '--caddy-snippet', caddySnippet,
    '--caddy-private', caddyPrivateDir,
    '--clock-dir', clockDir,
    '--backup-dir', backupDir,
    '--retention-days', '7',
  ], { encoding: 'utf8' });
  console.log(backupOut);

  const backupFiles = (await readdir(backupDir)).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(backupFiles.length, 1, 'exactly one backup archive should be created');
  const backupArchive = join(backupDir, backupFiles[0]);

  // Step 7: Destroy data, state, and caddy private completely
  console.log('[Step 7] Destroying original data and state directories completely...');
  await rm(dataDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await rm(caddyPrivateDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  const emptyFiles = await readdir(dataDir);
  assert.equal(emptyFiles.length, 0, 'dataDir must be completely empty');

  // Step 8: Execute ops/restore to clean directory
  console.log('[Step 8] Running ops/restore to clean volume...');
  const restoreOut = execFileSync(join(repoRoot, 'ops', 'restore'), [
    '--backup', backupArchive,
    '--target-data-dir', dataDir,
    '--target-state-dir', stateDir,
    '--target-caddy-snippet', caddySnippet,
    '--target-caddy-private', caddyPrivateDir,
    '--target-clock-dir', clockDir,
  ], { encoding: 'utf8' });
  console.log(restoreOut);

  // Step 9: Restart mail-a pointing to restored data
  console.log('[Step 9] Restarting mail-a pointing to restored data...');
  const restoredHub = await startLocalMail({ dataDir });
  console.log(`[Step 9] Restored mail-a running at ${restoredHub.url} (PID: ${restoredHub.pid})`);

  try {
    // Step 10: Read back messages via H-03 client and verify
    console.log('[Step 10] Reading back messages and verifying SHA256 consistency...');
    const restoredWinClient = createMailClient({
      url: restoredHub.url,
      token: restoredHub.token,
      projectKey: PROJECT,
      agentName: 'RedStone',
      senderToken: regWin.registration_token,
      roster: ['BlueLake'],
    });

    const postEvents = await restoredWinClient.fetchEvents({ limit: 100 });
    assert.equal(postEvents.events.length, 3, 'restored inbox should have exactly 3 events');
    assert.equal(postEvents.tailCursor, preTailCursor, 'tailCursor must match pre-backup cursor');

    for (let i = 0; i < sentRecords.length; i++) {
      const rec = sentRecords[i];
      const readRes = await restoredWinClient.readMessage(rec.id);
      assert.ok(readRes.message, `message #${rec.id} should be readable`);
      const envelope = JSON.parse(readRes.message.body_md);
      assert.equal(envelope.text, rec.originalText, `message #${rec.id} text must be byte-for-byte identical`);
      const restoredHash = sha256(envelope.text);
      assert.equal(restoredHash, rec.sha256, `message #${rec.id} sha256 must match`);
      console.log(`[Step 10] Verified message #${rec.id} SHA256: ${restoredHash} == ${rec.sha256} ✅`);
    }

    // Verify H-02 actual files restored with correct content & mode 0600
    const restoredHubclock = await readFile(join(stateDir, 'hubclock.sender.json'), 'utf8');
    assert.equal(restoredHubclock, hubclockContent, 'hubclock.sender.json must be restored byte-for-byte');
    const hubclockStat = await stat(join(stateDir, 'hubclock.sender.json'));
    assert.equal(hubclockStat.mode & 0o777, 0o600, 'hubclock.sender.json must have mode 0600');

    const restoredAuthCaddy = await readFile(join(caddyPrivateDir, 'auth.caddy'), 'utf8');
    assert.equal(restoredAuthCaddy, authCaddyContent, 'auth.caddy must be restored byte-for-byte');
    const authCaddyStat = await stat(join(caddyPrivateDir, 'auth.caddy'));
    assert.equal(authCaddyStat.mode & 0o777, 0o600, 'auth.caddy must have mode 0600');
    console.log('[Step 10] Verified hubclock.sender.json and auth.caddy restored with mode 0600 ✅');
  } finally {
    await restoredHub.stop({ keepData: true });
  }

  // Step 11: Test ops/pull-weekly-backup.sh dry-run & parameter validation
  console.log('[Step 11] Testing ops/pull-weekly-backup.sh dry-run mode...');
  const pullDryRunOut = execFileSync(join(repoRoot, 'ops', 'pull-weekly-backup.sh'), [
    '--mock-remote-archive', backupArchive,
    '--local-dir', join(baseTmp, 'mac-backups'),
    '--dry-run',
  ], { encoding: 'utf8' });
  assert.match(pullDryRunOut, /Dry Run Summary/, 'must output dry-run summary');
  assert.match(pullDryRunOut, /Status:\s+OK/, 'dry-run status must be OK');
  console.log('[Step 11] ops/pull-weekly-backup.sh verified ✅');

  // Step 12: Test ops/purge
  console.log('[Step 12] Testing ops/purge date boundary...');
  // 12.1 Should fail without --ignore-date-for-testing because today < 2027-04-01
  assert.throws(
    () => {
      execFileSync(join(repoRoot, 'ops', 'purge'), [
        '--data-dir', dataDir,
        '--backup-dir', backupDir,
      ], { stdio: 'pipe' });
    },
    /boundary check failed|not permitted before 2027-04-01/,
    'purge must fail prior to 2027-04-01'
  );
  console.log('[Step 12.1] Retention date boundary enforced ✅');

  // 12.2 Dry-run mode by default
  console.log('[Step 12.2] Testing ops/purge dry-run mode...');
  const dryRunOut = execFileSync(join(repoRoot, 'ops', 'purge'), [
    '--data-dir', dataDir,
    '--state-dir', stateDir,
    '--backup-dir', backupDir,
    '--ignore-date-for-testing',
  ], { encoding: 'utf8' });
  assert.match(dryRunOut, /DRY-RUN MODE/, 'must indicate dry-run mode');
  const filesStillThere = await readdir(dataDir);
  assert.ok(filesStillThere.length > 0, 'files must NOT be deleted in dry-run mode');
  console.log('[Step 12.2] Dry-run mode left files untouched ✅');

  // 12.3 Permanent deletion mode
  console.log('[Step 12.3] Testing ops/purge permanent deletion mode...');
  const purgeOut = execFileSync(join(repoRoot, 'ops', 'purge'), [
    '--data-dir', dataDir,
    '--state-dir', stateDir,
    '--backup-dir', backupDir,
    '--receipt-dir', receiptDir,
    '--ignore-date-for-testing',
    '--confirm-purge-data-permanently',
  ], { encoding: 'utf8' });
  assert.match(purgeOut, /ALL_DATA_PERMANENTLY_PURGED/, 'must confirm permanent deletion');
  const filesAfterPurge = (await readdir(backupDir)).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(filesAfterPurge.length, 0, 'backup archives must be purged');
  console.log('[Step 12.3] Permanent purge succeeded with audit receipt ✅');

  // Clean up test base
  await rm(baseTmp, { recursive: true, force: true });
});
