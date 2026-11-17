// Behaviour both stores must share. `make()` returns a fresh store seeded with fakes.seed()
// (維護者 owner, guild link, tok_fakemac01/BlueLake, tok_fakewin01/RedStone).
import assert from 'node:assert/strict';
import { GUILD, OWNER_DISCORD, STRANGER, 維護者 } from './fakes.mjs';

const row = (mailId, over = {}) => ({
  groupId: 'group-a', memberId: 維護者, mailId, recipientAgent: 'RedStone', label: '交接', sender: 'BlueLake',
  subject: `s${mailId}`, summary: '摘要', mailCreatedAt: '2026-11-20T01:00:00.000000Z', state: 'pending', ...over,
});

export function storeContract(t, make) {
  return [
    t('membership: active link + active member only', async () => {
      const s = await make();
      const m = await s.findMemberByDiscord(GUILD, OWNER_DISCORD);
      assert.equal(m.memberId, 維護者);
      assert.equal(m.groupId, 'group-a');
      assert.equal(await s.findMemberByDiscord(GUILD, STRANGER), null);
      assert.equal(await s.findMemberByDiscord('10000000\x30000000002', OWNER_DISCORD), null);
      assert.deepEqual(await s.ownerDiscordIds('group-a'), [OWNER_DISCORD]);
    }),
    t('device lifecycle: issue → request revocation (owner only, once) → revoked', async () => {
      const s = await make();
      await s.issueDevice({ memberId: 維護者, groupId: 'group-a', label: '維護者 / x', platform: 'linux', tokenId: 'tok_contract01', tokenPrefix: 'mph_abcd', tokenHash: 'c'.repeat(64), actorId: OWNER_DISCORD, requestId: '1' });
      assert.equal(await s.requestRevocation({ tokenId: 'tok_contract01', memberId: '00000000-0000-4000-8000-0000000000ff', actorId: 'x', reason: 'r', requestId: '2' }), false);
      assert.equal(await s.requestRevocation({ tokenId: 'tok_contract01', memberId: 維護者, actorId: 'x', reason: 'r', requestId: '3' }), true);
      assert.equal(await s.requestRevocation({ tokenId: 'tok_contract01', memberId: 維護者, actorId: 'x', reason: 'r', requestId: '4' }), false);
      await s.completeRevocation({ tokenId: 'tok_contract01', actorId: 'bot', requestId: '5', configRevision: 9 });
      assert.equal(await s.requestRevocation({ tokenId: 'tok_contract01', memberId: 維護者, actorId: 'x', reason: 'r', requestId: '6' }), false);
    }),
    t('watched agents come from active devices of linked members', async () => {
      const s = await make();
      const w = await s.watchedAgents();
      assert.deepEqual(w.map((x) => [x.agentName, x.groupId, x.memberIds]), [['BlueLake', 'group-a', [維護者]], ['RedStone', 'group-a', [維護者]]]);
    }),
    t('ingest is idempotent per (member, mail) and the cursor only moves forward', async () => {
      const s = await make();
      assert.equal(await s.getCursor('RedStone'), null);
      assert.equal(await s.commitIngest({ agentName: 'RedStone', groupId: 'group-a', cursor: 5, rows: [row(1), row(2)] }), 2);
      assert.equal(await s.commitIngest({ agentName: 'RedStone', groupId: 'group-a', cursor: 3, rows: [row(2)] }), 0);
      assert.equal(await s.getCursor('RedStone'), 5);
      assert.deepEqual((await s.membersWithWork()).map((m) => [m.memberId, m.discordUserId]), [[維護者, OWNER_DISCORD]]);
    }),
    t('pending → sent only once; hold/backlog/digest; recent items newest-first and distinct', async () => {
      const s = await make();
      await s.commitIngest({ agentName: 'RedStone', groupId: 'group-a', cursor: 9, rows: [row(1), row(2), row(3, { state: 'held' })] });
      await s.commitIngest({ agentName: 'BlueLake', groupId: 'group-a', cursor: 9, rows: [row(3, { recipientAgent: 'BlueLake' })] });
      const pending = await s.listPending(維護者);
      assert.deepEqual(pending.map((p) => p.mail_id), [1, 2]);
      assert.equal(typeof pending[0].mail_created_at, 'string');
      assert.ok(!Number.isNaN(Date.parse(pending[0].mail_created_at)));
      await s.markNotification(pending[0].id, 'sent', { discordMessageId: 'dm1' });
      await s.markNotification(pending[0].id, 'failed', { error: 'late' }); // not pending any more → no-op
      await s.markNotification(pending[1].id, 'failed', { error: 'down' });
      const backlog = await s.listBacklog(維護者);
      assert.deepEqual(backlog.map((b) => b.mail_id), [2, 3]);
      await s.markDigested(backlog.map((b) => b.id), 'dm2');
      assert.deepEqual(await s.listBacklog(維護者), []);
      assert.deepEqual((await s.recentItems('group-a', 10)).map((r) => r.mail_id), [3, 2, 1]);
      assert.equal(await s.itemBelongsToGroup('group-a', 2), true);
      assert.equal(await s.itemBelongsToGroup('group-b', 2), false);
      await s.commitIngest({ agentName: 'RedStone', groupId: 'group-a', cursor: 10, rows: [row(4)] });
      await s.setPresenceByDiscord(GUILD, OWNER_DISCORD, 'offline');
      assert.equal(await s.getPresence(維護者), 'offline');
      assert.equal(await s.holdPending(維護者), 1);
      assert.deepEqual((await s.listBacklog(維護者)).map((b) => b.mail_id), [4]);
    }),
    t('budget: reserve within cap, refuse beyond, settle, notify once', async () => {
      const s = await make();
      const k = { groupId: 'group-a', day: '2026-11-20' };
      assert.equal(await s.reserveBudget({ ...k, estimateUsd: 0.3, capUsd: 0.5 }), true);
      assert.equal(await s.reserveBudget({ ...k, estimateUsd: 0.3, capUsd: 0.5 }), false);
      await s.settleBudget({ ...k, reservedUsd: 0.3, actualUsd: 0.1 });
      assert.equal(await s.reserveBudget({ ...k, estimateUsd: 0.3, capUsd: 0.5 }), true);
      const b = await s.budgetRow(k.groupId, k.day);
      assert.ok(Math.abs(b.spent - 0.1) < 1e-9 && Math.abs(b.reserved - 0.3) < 1e-9);
      assert.equal(b.rejected, 1);
      assert.equal(await s.markCapNotified(k.groupId, k.day), true);
      assert.equal(await s.markCapNotified(k.groupId, k.day), false);
    }),
    t('gateway quota notification: a fresh day with no local USD reservation is notified only once', async () => {
      const s = await make();
      const results = await Promise.all(Array.from({ length: 20 }, () => s.markCapNotified('group-a', '2026-11-21')));
      assert.equal(results.filter(Boolean).length, 1);
      const row = await s.budgetRow('group-a', '2026-11-21');
      assert.equal(row.spent, 0);
      assert.equal(row.reserved, 0);
      assert.equal(await s.markCapNotified('group-a', '2026-11-22'), true);
    }),
    t('decision delivery persists intent before IO and serializes retries after an unknown outcome', async () => {
      const s = await make();
      await s.recordDecisionDraft({ groupId: 'group-a', draftMailId: 777, authorAgent: 'BlueLake' });
      const request = { draftMailId: 777, status: 'confirmed', memberId: 維護者, discordUserId: OWNER_DISCORD,
        memberName: '維護者', now: '2026-11-20T02:00:00.000Z' };
      const attempted = [];
      await assert.rejects(async () => s.deliverDecision(request, async action => {
        attempted.push(structuredClone(action));
        throw new Error('synthetic outage');
      }), /synthetic outage/);
      const pending = await s.getDecisionByMailId(777);
      assert.equal(pending.status, 'draft');
      assert.ok(pending.mail_action, 'intent survives failed delivery');
      await assert.rejects(async () => s.deliverDecision({ ...request, status: 'rejected' }, async () => {
        assert.fail('opposite action must not write Mail');
      }), /pending/);
      const results = await Promise.all([0, 1].map(() => s.deliverDecision({ ...request, now: '2026-11-21T00:00:00.000Z' }, async action => {
        attempted.push(structuredClone(action));
        return { messageId: 888 };
      })));
      assert.equal(results.filter(r => !r.already).length, 1);
      assert.equal(attempted.length, 2, 'only one retry sends; the other sees committed status');
      assert.deepEqual(attempted[0], attempted[1]);
      const final = await s.getDecisionByMailId(777);
      assert.equal(final.status, 'confirmed');
      assert.equal(Number(final.mail_message_id), 888);
      assert.equal(final.confirmed_at, '2026-11-20T02:00:00.000000Z');
    }),
    t('decision lifecycle: record draft → update status (once) → reminders & list', async () => {
      const s = await make();
      const draft = await s.recordDecisionDraft({
        groupId: 'group-a', draftMailId: 101, draftId: 'dec_101', authorAgent: 'BlueLake',
        subject: '決策：登入改用 OAuth', summary: '改用 Discord OAuth', text: '全文...',
        createdAt: '2026-11-10T00:00:00.000000Z',
      });
      assert.equal(draft.status, 'draft');
      assert.equal(draft.draft_mail_id, 101);

      const byMail = await s.getDecisionByMailId(101);
      assert.equal(byMail.author_agent, 'BlueLake');
      assert.equal(byMail.status, 'draft');

      const byDraft = await s.getDecisionByDraftId('dec_101');
      assert.equal(byDraft.draft_mail_id, 101);

      const drafts = await s.listDecisions('group-a', { status: 'draft' });
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].draft_mail_id, 101);

      // Overdue 7 days reminder check (2026-11-10 is > 7 days before 2026-11-20)
      const due = await s.listDueDraftReminders(Date.parse('2026-11-20T00:00:00.000Z'));
      assert.equal(due.length, 1);
      assert.equal(due[0].draft_mail_id, 101);

      await s.markDraftReminderSent(101, '2026-11-20T01:00:00.000Z');
      const dueAfter = await s.listDueDraftReminders(Date.parse('2026-11-20T00:00:00.000Z'));
      assert.equal(dueAfter.length, 0);

      // Confirm decision (once)
      const confirmed = await s.updateDecisionStatus({
        draftMailId: 101, status: 'confirmed', memberId: 維護者, discordUserId: OWNER_DISCORD,
        memberName: '維護者', now: '2026-11-20T02:00:00.000Z',
      });
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.confirmed_by_name, '維護者');

      // Second update must fail (buttons can only be used once)
      const secondTry = await s.updateDecisionStatus({
        draftMailId: 101, status: 'rejected', memberId: 維護者, discordUserId: OWNER_DISCORD,
        memberName: '維護者', now: '2026-11-20T03:00:00.000Z',
      });
      assert.equal(secondTry, null);

      const allDec = await s.listDecisions('group-a');
      assert.equal(allDec.length, 1);
      assert.equal(allDec[0].status, 'confirmed');
    }),
  ];
}
