// protocol.mjs — HubClock control records (SDS API-06). Shared by ops/lifecycle and client/hub-hook (H-04).
//
// Every control record is a Mail message with topic 'control' whose body_md is JSON:
//   { v:1, event_type, root_mail_id, recipient_session, agent, choice?, reason?, ... }
// The outer Mail message decides who (from) and when (created_ts); body fields never prove identity.

import { createHash } from 'node:crypto';

export const CONTROL_VERSION = 1;

/** Events a controlled client sends (CC or To the HubClock agent). */
export const CLIENT_EVENTS = Object.freeze(['presented', 'answer', 'choice', 'session.closed', 'auto.on', 'auto.off', 'auto.executed']);
/** Result records HubClock publishes into the root thread. */
export const RESULT_EVENT = 'result';
export const CHOICES = Object.freeze(['approve', 'reject']);
export const AUTO_OUTCOMES = Object.freeze(['succeeded', 'failed']);

// L-06 auto mode (SR-AUTO-02): default 60 min, integer 1..240.
export const AUTO_DEFAULT_MINUTES = 60;
export const AUTO_MAX_MINUTES = 240;

export const QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // SRS §4.4 / 維護者
export const ACTION_TIMEOUT_MS = 30 * 60 * 1000; // SR-CFM-02/03, from `presented`

/**
 * Deterministic UUID-shaped key (same derivation as client/hub-hook.mjs), so resending the same
 * logical event always reuses one idempotency key and the Hub replays instead of storing twice.
 */
export function stableUuid(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Mail created_ts ("2026-11-16T17:40:46.138370Z") → integer microseconds since epoch. */
export function tsToMicros(ts) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts ?? '');
  if (!m) throw new Error(`unparseable Mail timestamp: ${ts}`);
  const secMs = Date.parse(`${m[1]}${m[3]}`);
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6);
  return secMs * 1000 + Number(frac);
}

export function microsToIso(us) {
  const ms = Math.floor(us / 1000);
  const rest = String(us % 1000).padStart(3, '0');
  return new Date(ms).toISOString().replace('Z', `${rest}Z`);
}

/** Parses a control body; returns null if it is not a v1 control record. Never throws. */
export function parseControl(bodyMd) {
  let c;
  try {
    c = JSON.parse(bodyMd);
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object' || c.v !== CONTROL_VERSION || typeof c.event_type !== 'string') return null;
  return c;
}

/** Parses an item-v1 body (client/mail-client.mjs envelope); null if not an item. */
export function parseItem(bodyMd) {
  let b;
  try {
    b = JSON.parse(bodyMd);
  } catch {
    return null;
  }
  if (!b || b.v !== 1 || typeof b.kind !== 'string' || typeof b.client_event_id !== 'string') return null;
  return b;
}

/** What a client sends; exported so H-04 builds the exact shape HubClock consumes. */
// auto.on fields are passed through unvalidated on purpose: HubClock is the only judge (SR-AUTO-01/02).
export function buildClientControl({ eventType, rootMailId, recipientSession, agent, choice, reason, recipientAgent, target, minutes, outcome }) {
  if (!CLIENT_EVENTS.includes(eventType)) throw new Error(`unknown control event_type ${eventType}`);
  if (eventType === 'choice' && !CHOICES.includes(choice)) throw new Error('choice must be approve|reject');
  if (eventType === 'auto.executed' && !AUTO_OUTCOMES.includes(outcome)) throw new Error('outcome must be succeeded|failed');
  const c = { v: CONTROL_VERSION, event_type: eventType, root_mail_id: rootMailId ?? null, recipient_session: recipientSession, agent };
  if (choice) c.choice = choice;
  if (reason) c.reason = reason;
  if (recipientAgent !== undefined) c.recipient_agent = recipientAgent;
  if (target !== undefined) c.target = target;
  if (minutes !== undefined) c.minutes = minutes;
  if (outcome !== undefined) c.outcome = outcome;
  return c;
}

/** Idempotency key a client should use for one control event. */
export function clientControlKey({ groupId, eventType, rootMailId, agent, recipientSession }) {
  return stableUuid(`control:${groupId}:${eventType}:${rootMailId ?? '-'}:${agent}:${recipientSession}`);
}

/** Idempotency key for a HubClock result: one terminal result per (root, recipient). */
export function resultKey({ groupId, rootMailId, recipientAgent, status }) {
  return stableUuid(`hubclock:${groupId}:${rootMailId}:${recipientAgent}:${status}`);
}

const RESULT_TEXT = {
  unanswered: '24 小時內沒有回答，標為「未回答」。原問題仍可讀，HubClock 不代答。',
  approved: '已同意，收件端可以開始執行。',
  rejected: '已拒絕，未執行。',
  expired: '確認提示顯示後 30 分鐘未回應，已逾時，視同拒絕，未執行。',
  invalidated: '對方 session 已結束，此確認已失效，未執行；需要的話請重送。',
  auto_approved: 'auto mode 生效中，寄件者是指定對象：不需確認，收件端可直接執行，執行結果會另行記錄。',
};

/** Idempotency key for an auto-mode notice; `ref` is the grant key or the rejected control's Mail ID. */
export function autoNoticeKey({ groupId, ref, status }) {
  return stableUuid(`hubclock:${groupId}:auto:${ref}:${status}`);
}

export function resultText(status, reason) {
  const base = RESULT_TEXT[status] ?? status;
  return reason ? `${base}理由：${reason}` : base;
}
