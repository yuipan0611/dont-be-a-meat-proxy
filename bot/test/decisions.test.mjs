// decisions.test.mjs — L-05 decision drafts, approvals, rejections, reminders and status integration
// Rules: SRS SR-DEC-01～05, §4.5 #12, TC-20.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './helpers/store-memory.mjs';
import { createFakeMail, createFakeDiscord, FakeClock, seed, itemBody, OWNER_DISCORD, STRANGER, 維護者, GUILD, fakeButtonInteraction, createFakeLlm, llmText, llmTool } from './helpers/fakes.mjs';
import { createBridge, createMailReader } from '../src/bridge.mjs';
import { createDelivery } from '../src/deliver.mjs';
import { createDecisionsManager, SEVEN_DAYS_MS } from '../src/decisions.mjs';
import { createRouter } from '../src/router.mjs';
import { createAssistant, createReadOnlyTools } from '../src/assistant.mjs';
import { createBudget } from '../src/budget.mjs';
const MODEL = 'claude-haiku-5-5'; // legacy budget fixture, no provider calls

function setup({ now = '2026-11-20T02:00:00.000Z' } = {}) {
  const clock = new FakeClock(now);
  const store = createMemoryStore(seed());
  const mail = createFakeMail();
  const discord = createFakeDiscord();
  const mailReader = createMailReader({ client: mail, projectKey: '/data/projects/group-a' });
  const decisions = createDecisionsManager({ store, discord, mailClient: mail, clock, defaultGuildId: GUILD });
  const bridge = createBridge({ mail: mailReader, store, clock });
  const delivery = createDelivery({ store, discord, clock });
  const router = createRouter({ store, connect: {}, assistant: {}, decisions });
  return { clock, store, mail, discord, mailReader, decisions, bridge, delivery, router };
}

test('SR-DEC-01 / TC-20: agent writes decision -> stored as draft in DB -> Discord notification has buttons', async () => {
  const s = setup();
  await s.bridge.tick(); // start at tail
  // Agent writes decision into Mail (Hub)
  const draftId = s.mail.deliver({
    from: 'BlueLake', to: ['RedStone'], subject: '決策：登入改用 OAuth', topic: 'decision',
    body: itemBody({ kind: 'decision', summary: '改用 Discord OAuth', text: '決策全文：登入改用 Discord OAuth' }),
    createdTs: s.clock.iso(),
  });

  // Bridge ingests message
  await s.bridge.tick();

  // Decision exists in store as draft
  const dec = await s.store.getDecisionByMailId(draftId);
  assert.ok(dec, 'decision recorded in store');
  assert.equal(dec.status, 'draft');
  assert.equal(dec.author_agent, 'BlueLake');
  assert.equal(dec.subject, '決策：登入改用 OAuth');
  assert.equal(dec.summary, '改用 Discord OAuth');

  // Delivery sends DM
  await s.delivery.tick();
  assert.equal(s.discord.sent.length, 1);
  const sent = s.discord.sent[0];
  assert.equal(sent.userId, OWNER_DISCORD);
  assert.match(sent.content, /決策草稿/);
  assert.match(sent.content, /改用 Discord OAuth/);
  assert.ok(sent.components, 'components attached');
  assert.equal(sent.components.length, 1);
  const buttons = sent.components[0].components;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].label, '確認');
  assert.equal(buttons[0].custom_id, `decision:confirm:${draftId}`);
  assert.equal(buttons[1].label, '駁回');
  assert.equal(buttons[1].custom_id, `decision:reject:${draftId}`);
});

test('SR-DEC-02 / TC-20: non-owner / stranger clicks button -> ephemeral refusal, status unchanged', async () => {
  const s = setup();
  await s.bridge.tick();
  const draftId = s.mail.deliver({
    from: 'BlueLake', to: ['RedStone'], subject: '決策：資料庫架構', topic: 'decision',
    body: itemBody({ kind: 'decision', summary: '使用 Postgres 17', text: '決策全文' }),
    createdTs: s.clock.iso(),
  });
  await s.bridge.tick();

  // Stranger (non-維護者) clicks Confirm
  const ix = fakeButtonInteraction(`decision:confirm:${draftId}`, { userId: STRANGER });
  await s.router.handleButton(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  assert.ok(edit, 'replied to stranger');
  assert.match(edit.content, /沒有確認或駁回決策的權限/);
  assert.match(edit.content, /只有 維護者 可以確認/);
  assert.match(edit.content, /狀態保持不變/);

  // Status must remain draft
  const dec = await s.store.getDecisionByMailId(draftId);
  assert.equal(dec.status, 'draft');
  assert.equal(dec.confirmed_by, null);

  // Audit log has denial
  const audit = s.store.db.audit.find((a) => a.action === 'discord.decision.denied');
  assert.ok(audit, 'audit log recorded denial');
  assert.equal(audit.details.reason, 'not_owner');
});

test('SR-DEC-03 / TC-20: 維護者 clicks confirm -> status becomes confirmed, records confirmer, buttons single-use', async () => {
  const s = setup();
  await s.bridge.tick();
  const draftId = s.mail.deliver({
    from: 'BlueLake', to: ['RedStone'], subject: '決策：採用 Haiku 5.5', topic: 'decision',
    body: itemBody({ kind: 'decision', summary: '查進度改用 Haiku', text: '決策全文' }),
    createdTs: s.clock.iso(),
  });
  await s.bridge.tick();

  // 維護者 clicks Confirm
  const ix = fakeButtonInteraction(`decision:confirm:${draftId}`, { userId: OWNER_DISCORD });
  await s.router.handleButton(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  assert.match(edit.content, /已確認決策草稿/);
  assert.match(edit.content, /確認者：維護者/);
  assert.match(edit.content, /正式決策/);

  // State in store is confirmed
  const dec = await s.store.getDecisionByMailId(draftId);
  assert.equal(dec.status, 'confirmed');
  assert.equal(dec.confirmed_by_name, '維護者');
  assert.ok(dec.confirmed_at);

  // Check buttons disabled on original message
  assert.ok(ix.log.some((x) => x.type === 'message.edit' && Array.isArray(x.components) && x.components.length === 0));

  // Second click by 維護者 -> single use check rejects
  const ix2 = fakeButtonInteraction(`decision:confirm:${draftId}`, { userId: OWNER_DISCORD });
  await s.router.handleButton(ix2);
  const edit2 = ix2.log.find((x) => x.type === 'edit');
  assert.match(edit2.content, /按鈕只能使用一次/);
  assert.match(edit2.content, /已確認/);
});

test('SR-DEC-03: 維護者 clicks reject -> status becomes rejected, records rejecter, retained for audit', async () => {
  const s = setup();
  await s.bridge.tick();
  const draftId = s.mail.deliver({
    from: 'BlueLake', to: ['RedStone'], subject: '決策：廢除測試', topic: 'decision',
    body: itemBody({ kind: 'decision', summary: '不寫單元測試', text: '決策全文' }),
    createdTs: s.clock.iso(),
  });
  await s.bridge.tick();

  // 維護者 clicks Reject
  const ix = fakeButtonInteraction(`decision:reject:${draftId}`, { userId: OWNER_DISCORD });
  await s.router.handleButton(ix);

  const edit = ix.log.find((x) => x.type === 'edit');
  assert.match(edit.content, /已駁回決策草稿/);
  assert.match(edit.content, /駁回者：維護者/);
  assert.match(edit.content, /不作為正式決策引用/);

  const dec = await s.store.getDecisionByMailId(draftId);
  assert.equal(dec.status, 'rejected');
  assert.equal(dec.confirmed_by_name, '維護者');

  // Single-use check: cannot confirm after rejection
  const ix2 = fakeButtonInteraction(`decision:confirm:${draftId}`, { userId: OWNER_DISCORD });
  await s.router.handleButton(ix2);
  const edit2 = ix2.log.find((x) => x.type === 'edit');
  assert.match(edit2.content, /按鈕只能使用一次/);
});

test('§4.5 #12: draft 7 days unconfirmed -> reminds once, not automatically deleted', async () => {
  // Start clock 8 days after draft creation
  const t0 = Date.parse('2026-11-10T00:00:00.000Z');
  const s = setup({ now: '2026-11-18T01:00:00.000Z' }); // 8+ days later

  // Insert a draft with t0 creation date
  await s.store.recordDecisionDraft({
    groupId: 'group-a', draftMailId: 88, draftId: 'dec_88', authorAgent: 'BlueLake',
    subject: '決策：陳舊草稿', summary: '7 天前草稿', text: '全文',
    createdAt: new Date(t0).toISOString(),
  });

  // DecisionsManager tick checks reminders
  const r1 = await s.decisions.tick();
  assert.equal(r1.reminded, 1);
  assert.equal(s.discord.sent.length, 1);
  const sent = s.discord.sent[0];
  assert.equal(sent.userId, OWNER_DISCORD);
  assert.match(sent.content, /決策草稿提醒/);
  assert.match(sent.content, /超過 7 天尚未轉為正式/);
  assert.match(sent.content, /不會自動刪除/);
  assert.ok(sent.components && sent.components[0].components.length === 2);

  // Still draft, NOT deleted
  const dec = await s.store.getDecisionByMailId(88);
  assert.equal(dec.status, 'draft');
  assert.equal(dec.reminder_sent, true);

  // Second tick: reminder not sent again
  const r2 = await s.decisions.tick();
  assert.equal(r2.reminded, 0);
  assert.equal(s.discord.sent.length, 1);
});

test('按鈕過期可重新叫出: recall action or expired button re-issues fresh buttons', async () => {
  const s = setup();
  await s.store.recordDecisionDraft({
    groupId: 'group-a', draftMailId: 99, draftId: 'dec_99', authorAgent: 'BlueLake',
    subject: '決策：按鈕過期測試', summary: '過期草稿', text: '全文',
  });

  // 1. Programmatic / slash command recall
  const recallRes = await s.decisions.recallButtons({ draftMailId: 99, actorDiscordId: OWNER_DISCORD });
  assert.equal(recallRes.ok, true);
  assert.match(recallRes.text, /已重新叫出/);
  assert.ok(recallRes.components[0].components.length === 2);

  // 2. Stranger cannot recall
  const deniedRecall = await s.decisions.recallButtons({ draftMailId: 99, actorDiscordId: STRANGER });
  assert.equal(deniedRecall.ok, false);
  assert.match(deniedRecall.text, /沒有權限/);

  // 3. Expired button click re-issues buttons
  const pastTimestamp = s.clock.nowMs() - 1000;
  const ixExpired = fakeButtonInteraction(`decision:confirm:99:${pastTimestamp}`, { userId: OWNER_DISCORD });
  await s.router.handleButton(ixExpired);
  const edit = ixExpired.log.find((x) => x.type === 'edit');
  assert.match(edit.content, /按鈕已過期.*已為您重新叫出/);
  assert.ok(edit.components && edit.components.length === 1);
});

test('SR-DEC-04 / AC-08.3: /status and recent_items distinguish confirmed vs draft decisions', async () => {
  const s = setup();
  // 1 draft, 1 confirmed
  await s.store.recordDecisionDraft({
    groupId: 'group-a', draftMailId: 1, draftId: 'dec_1', authorAgent: 'BlueLake',
    subject: '決策：草稿一', summary: '草稿決策', text: '全文',
  });
  await s.store.recordDecisionDraft({
    groupId: 'group-a', draftMailId: 2, draftId: 'dec_2', authorAgent: 'RedStone',
    subject: '決策：正式一', summary: '已確認決策', text: '全文',
  });
  await s.store.updateDecisionStatus({
    draftMailId: 2, status: 'confirmed', memberId: 維護者, discordUserId: OWNER_DISCORD,
    memberName: '維護者', now: s.clock.iso(),
  });

  // Seed notification rows for them
  s.store.db.notifs.push(
    { id: 1, group_id: 'group-a', member_id: 維護者, mail_id: 1, recipient_agent: 'RedStone', label: '決策', sender: 'BlueLake', subject: '決策：草稿一', summary: '草稿決策', mail_created_at: '2026-11-20T01:00:00.000Z', state: 'sent', attempts: 1 },
    { id: 2, group_id: 'group-a', member_id: 維護者, mail_id: 2, recipient_agent: 'BlueLake', label: '決策', sender: 'RedStone', subject: '決策：正式一', summary: '已確認決策', mail_created_at: '2026-11-20T01:30:00.000Z', state: 'sent', attempts: 1 },
  );

  const [recent] = createReadOnlyTools({ store: s.store, mail: s.mail });
  const out = await recent.run({ limit: 10 }, { groupId: 'group-a' });
  const item2 = out.find((x) => x.mail_id === 2);
  const item1 = out.find((x) => x.mail_id === 1);

  assert.equal(item2.decision_status, '已確認');
  assert.equal(item1.decision_status, '草稿');
});
