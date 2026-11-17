// deliver.mjs — sends queued notifications as Discord DMs (US-09, SR-NTF-04, SRS §4.5 #9).
//
// Rules:
//  - member offline (presence) → pending rows become `held`; nothing is sent.
//  - member available → first one digest「你不在時有 N 則」for every held/failed row, then the new
//    pending rows one by one.
//  - a failed DM is NOT resent by itself (no per-item replay); it joins the next digest.
//  - a send whose outcome is unknown (timeout) is recorded `unknown` and never resent.
//  - DM failure never falls back to a public channel.

import { renderNotification, renderDigest } from './notify-format.mjs';

export class DiscordSendError extends Error {
  constructor(message, { outcome = 'failed', code } = {}) {
    super(message);
    this.outcome = outcome; // 'failed' = definitely not delivered; 'unknown' = may have been delivered
    this.code = code;
  }
}

export function createDelivery({ store, discord, clock, presenceEnabled = false, digestRetryMs = 5 * 60_000, log = () => {} }) {
  const lastDigestTry = new Map();

  async function available(memberId) {
    if (!presenceEnabled) return true;
    const p = await store.getPresence(memberId);
    return p === null || p !== 'offline';
  }

  async function sendDigest(memberId, discordUserId) {
    const backlog = await store.listBacklog(memberId);
    if (!backlog.length) return 0;
    const last = lastDigestTry.get(memberId);
    if (last !== undefined && clock.nowMs() - last < digestRetryMs) return 0;
    lastDigestTry.set(memberId, clock.nowMs());
    try {
      const { messageId } = await discord.sendDm(discordUserId, renderDigest(backlog));
      await store.markDigested(backlog.map((r) => r.id), messageId);
      lastDigestTry.delete(memberId);
      log({ ev: 'deliver.digest', member: memberId, count: backlog.length });
      return backlog.length;
    } catch (e) {
      log({ ev: 'deliver.digest_failed', member: memberId, error: e.code ?? e.message });
      return 0;
    }
  }

  async function tick() {
    const stats = { sent: 0, held: 0, failed: 0, unknown: 0, digested: 0 };
    const members = await store.membersWithWork();
    for (const { memberId, discordUserId } of members) {
      if (!(await available(memberId))) {
        stats.held += await store.holdPending(memberId);
        continue;
      }
      stats.digested += await sendDigest(memberId, discordUserId);
      for (const row of await store.listPending(memberId)) {
        try {
          const { messageId } = await discord.sendDm(discordUserId, renderNotification(row));
          await store.markNotification(row.id, 'sent', { discordMessageId: messageId });
          stats.sent++;
        } catch (e) {
          const state = e.outcome === 'unknown' ? 'unknown' : 'failed';
          await store.markNotification(row.id, state, { error: String(e.code ?? e.message).slice(0, 200) });
          stats[state]++;
          log({ ev: 'deliver.failed', id: row.id, state, error: e.code ?? e.message });
        }
      }
    }
    return stats;
  }

  return { tick };
}
