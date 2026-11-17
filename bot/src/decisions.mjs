// decisions.mjs — Decision drafts, approvals, rejections, reminders and button interactions (L-05).
// Rules: SRS SR-DEC-01～05, §4.5 #12, TC-20.
//  - Agent writes decision -> Hub saves draft -> Discord gets notification with Confirm/Reject buttons.
//  - Permissions: S1 only 維護者 (owner) can confirm/reject. Others get ephemeral refusal, status unchanged.
//  - Confirm/reject records confirmer, time, draft ID. Buttons can only be used once.
//  - 7 days without confirmation -> reminder sent once; not automatically deleted.
//  - Expired buttons can be recalled.

import { taipeiTime, escapeDiscord } from './notify-format.mjs';

export const EPHEMERAL = 64; // MessageFlags.Ephemeral
const NO_MENTIONS = { parse: [] };
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createDecisionsManager({ store, discord, mailClient, clock, reminderTimeoutMs = SEVEN_DAYS_MS, buttonTtlMs = 24 * 60 * 60 * 1000, defaultGuildId, log = () => {} }) {
  async function handleButton(ix) {
    if (!ix.isButton?.()) return;
    const parts = String(ix.customId ?? '').split(':');
    if (parts[0] !== 'decision') return;
    const action = parts[1]; // 'confirm' | 'reject' | 'recall'
    const draftMailId = Number(parts[2]);
    if (!['confirm', 'reject', 'recall'].includes(action) || !Number.isInteger(draftMailId) || draftMailId <= 0) return;

    await ix.deferReply({ flags: EPHEMERAL });
    const reply = (content, extra = {}) => ix.editReply({ content, allowedMentions: NO_MENTIONS, ...extra });

    try {
      const guildId = ix.guildId ? String(ix.guildId) : defaultGuildId;
      const member = guildId ? await store.findMemberByDiscord(guildId, String(ix.user.id)) : null;

      // SR-DEC-02 / TC-20: S1 only 維護者 has confirmation rights.
      // Non-owner / stranger gets ephemeral refusal, status remains unchanged.
      if (!member || member.role !== 'owner') {
        await store.audit({
          groupId: member?.groupId ?? null,
          actorType: 'member',
          actorId: String(ix.user.id),
          action: 'discord.decision.denied',
          requestId: String(ix.id),
          details: { reason: 'not_owner', draft_mail_id: draftMailId, action },
        });
        return reply('你沒有確認或駁回決策的權限。S1 只有 維護者 可以確認或駁回決策。決策狀態保持不變。');
      }

      const dec = await store.getDecisionByMailId(draftMailId);
      if (!dec) {
        return reply(`找不到決策草稿 #${draftMailId} 的紀錄。`);
      }

      // Recall button action
      if (action === 'recall') {
        if (dec.status !== 'draft') {
          return reply(`此決策草稿已於 ${taipeiTime(dec.confirmed_at)} 由 ${dec.confirmed_by_name ?? '維護者'} ${dec.status === 'confirmed' ? '已確認' : '已駁回'}，非草稿狀態。`);
        }
        const freshButtons = [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: '確認', custom_id: `decision:confirm:${draftMailId}` },
              { type: 2, style: 4, label: '駁回', custom_id: `decision:reject:${draftMailId}` },
            ],
          },
        ];
        return reply(`已重新叫出決策草稿 #${draftMailId}「${escapeDiscord(dec.subject)}」的確認按鈕：`, { components: freshButtons });
      }

      // Check if button expired (e.g. custom_id contains an expiry timestamp, or check buttonTtlMs)
      const buttonTs = parts[3] ? Number(parts[3]) : null;
      const nowMs = clock ? clock.nowMs() : Date.now();
      if (buttonTs && nowMs > buttonTs) {
        if (dec.status !== 'draft') {
          return reply(`此按鈕已過期。該決策草稿已於 ${taipeiTime(dec.confirmed_at)} 由 ${dec.confirmed_by_name ?? '維護者'} ${dec.status === 'confirmed' ? '已確認' : '已駁回'}。`);
        }
        const freshButtons = [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: '確認', custom_id: `decision:confirm:${draftMailId}` },
              { type: 2, style: 4, label: '駁回', custom_id: `decision:reject:${draftMailId}` },
            ],
          },
        ];
        return reply(`此確認按鈕已過期。已為您重新叫出決策草稿 #${draftMailId}「${escapeDiscord(dec.subject)}」的確認按鈕：`, { components: freshButtons });
      }

      // SR-DEC-03: 按鈕只能用一次 (Button can only be used once)
      if (dec.status !== 'draft') {
        if (ix.message?.editable) await ix.message.edit({ components: [] }).catch(() => {});
        return reply(`此決策草稿已於 ${taipeiTime(dec.confirmed_at)} 由 ${dec.confirmed_by_name ?? '維護者'} ${dec.status === 'confirmed' ? '已確認' : '已駁回'}。按鈕只能使用一次。`);
      }

      const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
      const nowIso = clock?.iso ? clock.iso() : new Date(nowMs).toISOString();

      const updated = await store.updateDecisionStatus({
        draftMailId,
        status: newStatus,
        memberId: member.memberId,
        discordUserId: String(ix.user.id),
        memberName: member.displayName ?? '維護者',
        now: nowIso,
      });

      if (!updated) {
        if (ix.message?.editable) await ix.message.edit({ components: [] }).catch(() => {});
        return reply('此決策草稿已被處理過，按鈕只能使用一次。');
      }

      await store.audit({
        groupId: member.groupId,
        actorType: 'member',
        actorId: String(ix.user.id),
        action: `discord.decision.${newStatus}`,
        requestId: String(ix.id),
        details: {
          draft_mail_id: draftMailId,
          status: newStatus,
          confirmed_by: member.displayName ?? '維護者',
          confirmed_at: updated.confirmed_at,
        },
      });

      // Write back to Hub Mail if mailClient available
      if (mailClient) {
        try {
          await mailClient.callTool('send_message', {
            project_key: `/data/projects/${member.groupId}`,
            sender_name: 'HubBot',
            to: [dec.author_agent],
            subject: `[決策${newStatus === 'confirmed' ? '已確認' : '已駁回'}] #${draftMailId}`,
            topic: 'decision',
            thread_id: String(draftMailId),
            body_md: JSON.stringify({
              v: 1,
              kind: 'decision_status',
              draft_mail_id: draftMailId,
              status: newStatus,
              decided_by: member.displayName ?? '維護者',
              decided_at: nowIso,
            }),
          });
        } catch (e) {
          log({ ev: 'decision.mail_sync_error', error: e.message });
        }
      }

      // Disable buttons on original message
      if (ix.message?.editable) {
        await ix.message.edit({ components: [] }).catch(() => {});
      }

      if (newStatus === 'confirmed') {
        return reply(`已確認決策草稿 #${draftMailId}（確認者：${member.displayName ?? '維護者'}，時間：${taipeiTime(updated.confirmed_at)}）。此決策已轉為正式決策。`);
      } else {
        return reply(`已駁回決策草稿 #${draftMailId}（駁回者：${member.displayName ?? '維護者'}，時間：${taipeiTime(updated.confirmed_at)}）。此決策仍保留可查，不作為正式決策引用。`);
      }
    } catch (e) {
      log({ ev: 'decision.button_error', error: e.message });
      return reply('處理決策按鈕失敗，請稍後再試。');
    }
  }

  // Recall button helper for programmatic or slash command use
  async function recallButtons({ draftMailId, actorDiscordId, guildId }) {
    const gid = guildId ?? defaultGuildId;
    const member = gid ? await store.findMemberByDiscord(gid, actorDiscordId) : null;
    if (!member || member.role !== 'owner') {
      return { ok: false, text: '你沒有權限重新叫出確認按鈕。S1 只有 維護者 可以操作。' };
    }
    const dec = await store.getDecisionByMailId(draftMailId);
    if (!dec) return { ok: false, text: `找不到決策草稿 #${draftMailId}。` };
    if (dec.status !== 'draft') {
      return { ok: false, text: `此決策已於 ${taipeiTime(dec.confirmed_at)} 由 ${dec.confirmed_by_name ?? '維護者'} ${dec.status === 'confirmed' ? '確認' : '駁回'}，非草稿狀態。` };
    }
    const components = [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: '確認', custom_id: `decision:confirm:${draftMailId}` },
          { type: 2, style: 4, label: '駁回', custom_id: `decision:reject:${draftMailId}` },
        ],
      },
    ];
    return {
      ok: true,
      text: `已重新叫出決策草稿 #${draftMailId}「${escapeDiscord(dec.subject)}」的確認按鈕：`,
      components,
    };
  }

  // §4.5 #12: 7 days draft reminder (not automatically deleted)
  async function tick() {
    const nowMs = clock ? clock.nowMs() : Date.now();
    const due = await store.listDueDraftReminders(nowMs, reminderTimeoutMs);
    let reminded = 0;
    for (const draft of due) {
      const ownerDiscordIds = await store.ownerDiscordIds(draft.group_id);
      for (const ownerId of ownerDiscordIds) {
        const payload = {
          content: [
            `**【決策草稿提醒】**｜來自 ${escapeDiscord(draft.author_agent)}`,
            draft.subject ? `主旨：${escapeDiscord(draft.subject)}` : null,
            `摘要：${escapeDiscord(draft.summary)}`,
            `查看：Mail #${draft.draft_mail_id}（${taipeiTime(draft.created_at)}）。`,
            `此草稿已建立超過 7 天尚未轉為正式。依規則（SRS §4.5 #12），此草稿不會自動刪除。請確認或駁回：`,
          ].filter(Boolean).join('\n'),
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: '確認', custom_id: `decision:confirm:${draft.draft_mail_id}` },
                { type: 2, style: 4, label: '駁回', custom_id: `decision:reject:${draft.draft_mail_id}` },
              ],
            },
          ],
        };
        try {
          await discord.sendDm(ownerId, payload);
        } catch (e) {
          log({ ev: 'decision.reminder_send_error', draftId: draft.draft_mail_id, error: e.message });
        }
      }
      await store.markDraftReminderSent(draft.draft_mail_id, new Date(nowMs).toISOString());
      await store.audit({
        groupId: draft.group_id,
        actorType: 'system',
        actorId: 'bot',
        action: 'decision.reminder_sent',
        details: { draft_mail_id: draft.draft_mail_id },
      });
      reminded++;
    }
    return { reminded };
  }

  return { handleButton, recallButtons, tick };
}
