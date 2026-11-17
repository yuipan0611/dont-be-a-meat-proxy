// notify-format.mjs — turns one saved Mail message into a Discord notification (SR-NTF-02, AC-09.1).
// Pure functions; no I/O. Labels follow client/hub-hook.mjs (L-00) so Discord and the agent
// inbox say the same thing.

import { detectSecrets } from '../../client/mail-client.mjs';

export const SUMMARY_MAX = 200; // SRS §4.5 #9
export const CLOCK_STATUS = Object.freeze({
  unanswered: '未回答', approved: '已同意', rejected: '已拒絕', expired: '已逾時', invalidated: '已失效',
});
const KIND = Object.freeze({ handoff: '交接', help: '求助', decision: '決策', task: '任務' });
const INTENT = Object.freeze({ question: '問答', action: '動手請求' });

function parseBody(bodyMd) {
  try {
    const e = JSON.parse(bodyMd);
    return e && typeof e === 'object' && e.v === 1 ? e : null;
  } catch {
    return null;
  }
}

/** Code-point aware clip; never splits an emoji. */
export function clip(s, max) {
  const cps = [...String(s ?? '')];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

/**
 * Discord-safe text: neutralises @everyone/@here, user/role/channel mentions and markdown links.
 * Delivery also sends allowed_mentions: { parse: [] }, this is the second layer.
 */
export function escapeDiscord(s) {
  return String(s ?? '')
    .replace(/@(everyone|here)/g, '@​$1')
    .replace(/<(@[!&]?|#)(\d+)>/g, '<$1​$2>')
    .replace(/([\\*_~`|>\[\]()])/g, '\\$1');
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @returns {null | {label, sender, subject, summary, mailId, createdTs, isClockResult}}
 *   null = do not notify (HubClock control traffic, unknown control records).
 */
export function classifyMessage(message) {
  const env = parseBody(message.body_md);
  if (message.topic === 'control') {
    if (!env || env.event_type !== 'result') return null; // presented/choice/answer/session.closed are plumbing
    return build(message, `HubClock 通知：${CLOCK_STATUS[env.status] ?? env.status ?? '結果'}`,
      env.text ?? '', true);
  }
  if (!env || typeof env.kind !== 'string') return build(message, '格式不明', '（不是標準格式，請在 agent 收件匣查看原文）', false);
  const isReply = env.client_event_id && message.thread_id && env.client_event_id !== message.thread_id;
  let label;
  if (isReply) label = '回覆';
  else if (env.kind === 'handoff') label = '交接';
  else label = `${KIND[env.kind] ?? env.kind}／${INTENT[env.intent] ?? env.intent ?? ''}`.replace(/／$/, '');
  return build(message, label, env.summary || env.text || '', false);
}

function build(message, label, rawSummary, isClockResult) {
  // AC-09.1: no sensitive full text. If the summary looks like it carries a secret, hide it entirely.
  const hidden = detectSecrets(rawSummary, message.subject ?? '').length > 0;
  const summary = hidden ? '（摘要疑似含密鑰，已隱藏；請在 agent 收件匣查看）' : clip(oneLine(rawSummary), SUMMARY_MAX);
  return {
    label,
    sender: String(message.from ?? '?'),
    subject: hidden ? '（已隱藏）' : clip(oneLine(message.subject), 120),
    summary,
    mailId: message.id,
    createdTs: message.created_ts,
    isClockResult,
  };
}

const TPE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** "2026-11-20 09:00（台北）" — built from parts so ICU spacing quirks never leak into IDs/tests. */
export function taipeiTime(iso) {
  const p = Object.fromEntries(TPE.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}（台北）`;
}

/** One DM. Contains type, sender, summary and how to view (AC-09.1); never the full text. */
export function renderNotification(n) {
  return [
    `**${escapeDiscord(n.label)}**｜來自 ${escapeDiscord(n.sender)} → ${escapeDiscord(n.recipient_agent ?? n.recipientAgent)}`,
    n.subject ? `主旨：${escapeDiscord(n.subject)}` : null,
    `摘要：${escapeDiscord(n.summary)}`,
    `查看：Mail #${n.mail_id ?? n.mailId}（${taipeiTime(n.mail_created_at ?? n.createdTs)}），下次在該 agent 開工時會自動讀到；Discord 只通知，不能在這裡同意。`,
  ].filter(Boolean).join('\n');
}

/** The single "while you were away" digest (§4.5 #9): count + a short list, not each item. */
export function renderDigest(rows, { listMax = 5 } = {}) {
  const lines = [`**你不在時有 ${rows.length} 則**通知（不逐則補發）：`];
  for (const r of rows.slice(0, listMax)) {
    lines.push(`• Mail #${r.mail_id}｜${escapeDiscord(r.label)}｜來自 ${escapeDiscord(r.sender)}｜${escapeDiscord(clip(r.subject || r.summary, 60))}`);
  }
  if (rows.length > listMax) lines.push(`…另外 ${rows.length - listMax} 則`);
  lines.push('細節請在 agent 開工時的收件匣查看。');
  return lines.join('\n');
}
