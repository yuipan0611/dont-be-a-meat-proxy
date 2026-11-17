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
  ];
}
