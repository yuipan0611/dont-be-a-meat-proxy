// lifecycle.mjs — HubClock: question 24 h / action 30 min / session.closed (SDS API-06, H-05).
//
// One tick:
//   1. ingest   — read new inbox events from the committed cursor, apply them, commit state+cursor
//                 in one transaction (a crash before commit just re-reads the page; duplicates are
//                 suppressed by message ID).
//   2. evaluate — terminal results for deadlines already passed (after ingest, so a choice saved
//                 before the deadline always wins over the timeout).
//   3. flush    — send pending outbox results with their fixed idempotency key; mark sent only
//                 after the Hub returns a message ID.
//
// HubClock only records state and notifies. It never answers a question, never executes an action
// and has no LLM. All Mail I/O goes through client/mail-client.mjs.

import { MailError } from '../../client/mail-client.mjs';
import {
  parseControl, parseItem, tsToMicros, microsToIso, resultKey, resultText, autoNoticeKey,
  QUESTION_TIMEOUT_MS, ACTION_TIMEOUT_MS, RESULT_EVENT, CONTROL_VERSION, CHOICES,
  AUTO_DEFAULT_MINUTES, AUTO_MAX_MINUTES, AUTO_OUTCOMES,
} from './protocol.mjs';

const OPEN = new Set(['pending', 'presented']);
const reqKey = (rootMailId, recipientAgent) => `${rootMailId}:${recipientAgent}`;
const MIN_US = 60_000_000;
const AUTO_REJECT_TEXT = {
  owner: '只有收件人能開啟 auto mode（不能替別的 agent 開）。未生效。',
  target: '必須指定對象：一個具體的 agent（不能是所有人或自己）。未生效。',
  minutes: '時長必須是 1～240 分鐘的整數（最長 4 小時）。未生效。',
};

/**
 * @param {object} o
 * @param {object} o.client      createMailClient(...) acting as the HubClock agent
 * @param {object} o.store       createFileStore(...) (or the later Postgres store)
 * @param {{nowMs:()=>number}} o.clock  VPS wall clock (tests: FakeClock)
 * @param {string} o.groupId
 * @param {number} [o.settleMs]  wait after a deadline before declaring timeout, so events saved
 *                               just before the deadline are ingested first (default 5 s)
 */
export function createLifecycle({
  client, store, clock, groupId,
  settleMs = 5_000,
  questionTimeoutMs = QUESTION_TIMEOUT_MS,
  actionTimeoutMs = ACTION_TIMEOUT_MS,
  pageLimit = 100,
  retryBaseMs = 15_000,
  retryMaxMs = 15 * 60_000,
  log = () => {},
}) {
  const self = client.agentName; // the generated canonical name from hubclock.sender.json
  const nowMicros = () => clock.nowMs() * 1000;

  // ---------------------------------------------------------------- 1. ingest
  async function ingest() {
    let applied = 0;
    for (;;) {
      const cursor = await store.transact((tx) => tx.getCursor());
      const page = await client.fetchEvents({ after: cursor, limit: pageLimit });
      // Network reads happen outside the transaction; the transaction itself is local and short.
      const messages = [];
      for (const ev of page.events) {
        const { message } = await client.readMessage(ev.message_id);
        let root = null;
        const c = message.topic === 'control' ? parseControl(message.body_md) : null;
        if (c && c.event_type === 'presented' && Number.isInteger(c.root_mail_id)) {
          root = (await client.readMessage(c.root_mail_id)).message;
        }
        messages.push({ message, root });
      }
      await store.transact((tx) => {
        for (const { message, root } of messages) {
          if (tx.isProcessed(message.id)) {
            log({ ev: 'duplicate_event', message_id: message.id });
            continue;
          }
          applyMessage(tx, message, root);
          tx.markProcessed(message.id);
          applied++;
        }
        if (page.nextCursor !== undefined && page.nextCursor !== null) tx.setCursor(page.nextCursor);
      });
      if (!page.hasMore || page.nextCursor === cursor) break;
    }
    return applied;
  }

  function applyMessage(tx, m, root) {
    if (m.from === self) return; // our own published results
    if (m.topic === 'control') {
      const c = parseControl(m.body_md);
      if (!c) return log({ ev: 'ignored_control', message_id: m.id, why: 'not a v1 control record' });
      switch (c.event_type) {
        case 'presented': return onPresented(tx, m, c, root);
        case 'choice': return onChoice(tx, m, c);
        case 'answer': return onAnswer(tx, m, c.root_mail_id);
        case 'session.closed': return onSessionClosed(tx, m, c);
        case 'auto.on': return onAutoOn(tx, m, c);
        case 'auto.off': return onAutoOff(tx, m, c);
        case 'auto.executed': return onAutoExecuted(tx, m, c);
        default: return log({ ev: 'ignored_control', message_id: m.id, why: `event_type ${c.event_type}` });
      }
    }
    const item = parseItem(m.body_md);
    if (!item) return log({ ev: 'ignored_message', message_id: m.id });
    const addressedToClock = (m.cc ?? []).includes(self) || (m.to ?? []).includes(self);
    // A reply from a question's recipient in the same thread counts as the answer.
    for (const req of tx.listRequests((r) => r.threadId === m.thread_id && r.recipientAgent === m.from && r.kind === 'question')) {
      onAnswer(tx, m, req.rootMailId);
    }
    if (addressedToClock && (item.intent === 'question' || item.intent === 'action')) registerRoot(tx, m, item);
  }

  function registerRoot(tx, m, item) {
    const created = tsToMicros(m.created_ts);
    for (const recipient of m.to ?? []) {
      if (recipient === self || recipient === m.from) continue;
      const key = reqKey(m.id, recipient);
      if (tx.getRequest(key)) continue;
      const base = {
        key, groupId, rootMailId: m.id, threadId: m.thread_id, requester: m.from, recipientAgent: recipient,
        recipientSession: null, rootCreatedAt: created, presentedMailId: null, presentedAt: null,
        deadlineAt: null, resolvedAt: null, decidedBy: null, decisionMailId: null, reason: null,
        reclassified: false, late: [], version: 0,
      };
      if (item.intent === 'question') {
        tx.putRequest({ ...base, kind: 'question', status: 'pending', deadlineAt: created + questionTimeoutMs * 1000 });
      } else {
        // Action: no timer until the recipient actually shows the prompt (SR-CFM-02, TC-12).
        const req = { ...base, kind: 'action', status: 'pending' };
        tx.putRequest(req);
        const grant = grantCovering(tx, recipient, m.from, created);
        if (grant) {
          req.grantKey = grant.key;
          resolve(tx, req, 'auto_approved', { at: created, by: self, mailId: grant.openMailId });
        }
      }
      log({ ev: 'registered', key, kind: item.intent });
    }
  }

  function onPresented(tx, m, c, root) {
    const key = reqKey(c.root_mail_id, m.from);
    let req = tx.getRequest(key);
    if (!req) {
      // The root was not CC'd to HubClock; build the request from the root message itself.
      if (!root || !(root.to ?? []).includes(m.from)) {
        return log({ ev: 'ignored_control', message_id: m.id, why: 'presented: sender is not a recipient of the root' });
      }
      req = {
        key, groupId, rootMailId: root.id, threadId: root.thread_id, requester: root.from, recipientAgent: m.from,
        recipientSession: null, rootCreatedAt: tsToMicros(root.created_ts), presentedMailId: null, presentedAt: null,
        deadlineAt: null, resolvedAt: null, decidedBy: null, decisionMailId: null, reason: null,
        reclassified: false, late: [], version: 0, kind: 'action', status: 'pending',
      };
    }
    if (!OPEN.has(req.status)) return noteLate(tx, req, m, 'presented after terminal');
    if (req.status === 'presented') return noteLate(tx, req, m, 'presented again; first t0 kept');
    if (req.kind === 'question') {
      // The recipient judged a "question" to need action (AC-05.2 / TC-08): the 30-minute rule now governs.
      req.kind = 'action';
      req.reclassified = true;
    }
    const t0 = tsToMicros(m.created_ts);
    Object.assign(req, {
      status: 'presented', recipientSession: c.recipient_session ?? null, presentedMailId: m.id,
      presentedAt: t0, deadlineAt: t0 + actionTimeoutMs * 1000, version: req.version + 1,
    });
    tx.putRequest(req);
    log({ ev: 'presented', key, deadline: microsToIso(req.deadlineAt) });
  }

  function onChoice(tx, m, c) {
    const req = tx.getRequest(reqKey(c.root_mail_id, m.from));
    if (!req) return log({ ev: 'ignored_control', message_id: m.id, why: 'choice for unknown request' });
    if (!CHOICES.includes(c.choice)) return noteLate(tx, req, m, 'invalid choice value');
    if (!OPEN.has(req.status)) return noteLate(tx, req, m, `choice after ${req.status}`); // SR-CFM-06: once only
    if (req.status !== 'presented') return noteLate(tx, req, m, 'choice before presented'); // fail-closed
    if ((c.recipient_session ?? null) !== req.recipientSession) return noteLate(tx, req, m, 'choice from another session');
    const t = tsToMicros(m.created_ts);
    if (t >= req.deadlineAt) return noteLate(tx, req, m, 'choice at/after deadline'); // SR-CFM-03: ≥30:00 is late
    resolve(tx, req, c.choice === 'approve' ? 'approved' : 'rejected', { at: t, by: m.from, mailId: m.id, reason: c.reason ?? null });
  }

  function onAnswer(tx, m, rootMailId) {
    const req = tx.getRequest(reqKey(rootMailId, m.from));
    if (!req || req.kind !== 'question') return;
    if (req.status !== 'pending') return noteLate(tx, req, m, `answer after ${req.status}`);
    const t = tsToMicros(m.created_ts);
    if (t >= req.deadlineAt) return noteLate(tx, req, m, 'answer at/after 24 h'); // evaluator marks unanswered; late answer kept
    resolve(tx, req, 'answered', { at: t, by: m.from, mailId: m.id, notify: false });
  }

  function onSessionClosed(tx, m, c) {
    const open = tx.listRequests((r) => r.recipientAgent === m.from && r.status === 'presented' && r.recipientSession === c.recipient_session);
    for (const req of open) resolve(tx, req, 'invalidated', { at: tsToMicros(m.created_ts), by: m.from, mailId: m.id });
    log({ ev: 'session_closed', agent: m.from, session: c.recipient_session, invalidated: open.length });
  }

  // ---------------------------------------------------------------- L-06 auto mode
  // A grant covers an action that ARRIVED (root created_ts, server time) in [startAt, endedAt ?? endAt)
  // (SR-AUTO-03). Purely time-based, so late ingest or a HubClock restart never changes the answer.
  function grantCovering(tx, recipient, sender, t) {
    return tx.listGrants((g) => g.recipientAgent === recipient && g.target === sender
      && g.startAt <= t && t < (g.endedAt ?? g.endAt))[0] ?? null;
  }

  const NOT_A_TARGET = new Set(['*', 'all', 'everyone', 'anyone', '所有人']);

  function validateAutoOn(m, c) {
    if (c.recipient_agent !== undefined && c.recipient_agent !== m.from) return { code: 'E-NOT-OWNER', what: 'owner' };
    const t = c.target;
    if (typeof t !== 'string' || !t.trim() || NOT_A_TARGET.has(t.trim().toLowerCase()) || t === m.from || t === self) {
      return { code: 'E-AUTO', what: 'target' };
    }
    const minutes = c.minutes ?? AUTO_DEFAULT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > AUTO_MAX_MINUTES) return { code: 'E-AUTO', what: 'minutes' };
    return { minutes };
  }

  function onAutoOn(tx, m, c) {
    const v = validateAutoOn(m, c);
    if (v.code) {
      // SR-AUTO-01/02: rejected → no grant at all, only a notice to the one who tried.
      queueAutoNotice(tx, { ref: `mail-${m.id}`, status: 'auto_rejected', to: [m.from], threadId: m.thread_id, fields: {
        recipient_agent: c.recipient_agent ?? m.from, target: c.target ?? null, minutes: c.minutes ?? null,
        opened_by: m.from, open_mail_id: m.id, error_code: v.code, text: AUTO_REJECT_TEXT[v.what],
      } });
      return log({ ev: 'auto_rejected', message_id: m.id, code: v.code, what: v.what });
    }
    const start = tsToMicros(m.created_ts);
    let replaced = false;
    for (const old of tx.listGrants((g) => g.status === 'active' && g.recipientAgent === m.from && g.target === c.target && start < g.endAt)) {
      tx.putGrant({ ...old, status: 'replaced', endedAt: start, replacedBy: `grant:${m.id}` }); // SR-AUTO-05: no stacking
      replaced = true;
    }
    const grant = {
      key: `grant:${m.id}`, groupId, recipientAgent: m.from, openedBy: m.from, target: c.target, minutes: v.minutes,
      startAt: start, endAt: start + v.minutes * MIN_US, endedAt: null, status: 'active',
      openMailId: m.id, threadId: m.thread_id, session: c.recipient_session ?? null, closedMailId: null,
    };
    tx.putGrant(grant);
    queueGrantNotice(tx, grant, 'auto_on', replaced);
    log({ ev: 'auto_on', key: grant.key, target: grant.target, end: microsToIso(grant.endAt) });
  }

  function onAutoOff(tx, m, c) {
    const t = tsToMicros(m.created_ts);
    const open = tx.listGrants((g) => g.status === 'active' && g.recipientAgent === m.from
      && (c.target === undefined || c.target === null || g.target === c.target) && t < g.endAt);
    for (const g of open) endGrant(tx, { ...g, status: 'closed', endedAt: t, closedMailId: m.id });
    log({ ev: 'auto_off', agent: m.from, target: c.target ?? null, closed: open.length });
  }

  function endGrant(tx, g) {
    tx.putGrant(g);
    queueGrantNotice(tx, g, 'auto_ended');
  }

  function onAutoExecuted(tx, m, c) {
    const req = tx.getRequest(reqKey(c.root_mail_id, m.from));
    if (!req) return log({ ev: 'ignored_control', message_id: m.id, why: 'auto.executed for unknown request' });
    if (req.status !== 'auto_approved') return noteLate(tx, req, m, `auto.executed but status ${req.status}`);
    if (req.execution) return noteLate(tx, req, m, 'auto.executed reported twice; first kept');
    if (!AUTO_OUTCOMES.includes(c.outcome)) return noteLate(tx, req, m, 'auto.executed: invalid outcome');
    req.execution = { outcome: c.outcome, reason: c.reason ?? null, at: tsToMicros(m.created_ts), mailId: m.id };
    req.version += 1;
    tx.putRequest(req);
    const eventKey = resultKey({ groupId, rootMailId: req.rootMailId, recipientAgent: req.recipientAgent, status: 'auto_executed' });
    if (!tx.getOutbox(eventKey)) {
      const entry = buildResult(req, eventKey);
      Object.assign(entry.payload.control, {
        status: 'auto_executed', outcome: c.outcome, reason: c.reason ?? null,
        executed_at: microsToIso(req.execution.at), execution_mail_id: m.id,
        text: `auto mode 執行${c.outcome === 'succeeded' ? '成功' : '失敗'}：#${req.rootMailId}（寄件 ${req.requester}）。${c.reason ? `原因：${c.reason}` : ''}`,
      });
      entry.payload.subject = `[HubClock] auto_executed ${c.outcome}｜#${req.rootMailId}`;
      tx.putOutbox(entry);
    }
    log({ ev: 'auto_executed', key: req.key, outcome: c.outcome });
  }

  function queueGrantNotice(tx, g, status, replaced = false) {
    const endedBy = g.status === 'expired' ? 'expired' : g.status === 'closed' ? 'closed' : null;
    const text = status === 'auto_on'
      ? `auto mode 已開啟：${g.recipientAgent} 對 ${g.target}，${g.minutes} 分鐘，到 ${microsToIso(g.endAt)}。期間 ${g.target} 送來的動作請求不需確認、直接執行，每次都記錄。${replaced ? '（取代先前的設定，時間重新計算）' : ''}`
      : `auto mode 已結束（${endedBy === 'expired' ? '到期' : '收件人提前關閉'}）：${g.recipientAgent} 對 ${g.target}。之後的動作請求需要確認。`;
    queueAutoNotice(tx, { ref: g.key, status, to: [...new Set([g.recipientAgent, g.target])], threadId: g.threadId, fields: {
      grant_key: g.key, recipient_agent: g.recipientAgent, target: g.target, minutes: g.minutes,
      opened_by: g.openedBy, open_mail_id: g.openMailId, start_at: microsToIso(g.startAt), end_at: microsToIso(g.endAt),
      ended_at: g.endedAt === null ? null : microsToIso(g.endedAt), ended_by: endedBy, replaced, text,
    } });
  }

  function queueAutoNotice(tx, { ref, status, to, threadId, fields }) {
    const eventKey = autoNoticeKey({ groupId, ref, status });
    if (tx.getOutbox(eventKey)) return;
    tx.putOutbox({
      eventKey, requestKey: null, target: 'mail', state: 'pending', attempts: 0,
      nextTryAt: clock.nowMs(), resultMailId: null, lastError: null,
      payload: {
        to, subject: `[HubClock] ${status}｜${fields.recipient_agent} → ${fields.target ?? '?'}`, threadId,
        control: { v: CONTROL_VERSION, event_type: RESULT_EVENT, kind: 'auto', status, root_mail_id: null, ...fields },
      },
    });
  }

  function noteLate(tx, req, m, why) {
    if (!req.late.some((l) => l.mailId === m.id)) {
      req.late.push({ mailId: m.id, at: tsToMicros(m.created_ts), why });
      tx.putRequest(req);
    }
    log({ ev: 'late_or_rejected_event', key: req.key, message_id: m.id, why });
  }

  function resolve(tx, req, status, { at, by, mailId, reason = null, notify = true }) {
    Object.assign(req, { status, resolvedAt: at, decidedBy: by, decisionMailId: mailId, reason, version: req.version + 1 });
    tx.putRequest(req);
    if (notify) {
      const eventKey = resultKey({ groupId, rootMailId: req.rootMailId, recipientAgent: req.recipientAgent, status });
      if (!tx.getOutbox(eventKey)) tx.putOutbox(buildResult(req, eventKey));
    }
    log({ ev: 'resolved', key: req.key, status });
  }

  function buildResult(req, eventKey) {
    const to = req.kind === 'question' ? [req.requester] : [...new Set([req.requester, req.recipientAgent])];
    return {
      eventKey, requestKey: req.key, target: 'mail', state: 'pending', attempts: 0,
      nextTryAt: clock.nowMs(), resultMailId: null, lastError: null,
      payload: {
        to,
        subject: `[HubClock] ${req.status}｜#${req.rootMailId}`,
        threadId: req.threadId,
        control: {
          v: CONTROL_VERSION, event_type: RESULT_EVENT, root_mail_id: req.rootMailId,
          kind: req.kind, status: req.status, requester: req.requester,
          recipient_agent: req.recipientAgent, recipient_session: req.recipientSession,
          deadline_at: req.deadlineAt === null ? null : microsToIso(req.deadlineAt),
          decided_at: microsToIso(req.resolvedAt), decided_by: req.decidedBy,
          decision_mail_id: req.decisionMailId, reason: req.reason,
          ...(req.grantKey ? { grant_key: req.grantKey } : {}),
          text: resultText(req.status, req.reason),
        },
      },
    };
  }

  // ---------------------------------------------------------------- 2. evaluate
  async function evaluate() {
    const now = nowMicros();
    const settle = settleMs * 1000;
    return store.transact((tx) => {
      let n = 0;
      for (const req of tx.listRequests((r) => OPEN.has(r.status) && r.deadlineAt !== null)) {
        if (now < req.deadlineAt + settle) continue;
        if (req.kind === 'question' && req.status === 'pending') {
          resolve(tx, req, 'unanswered', { at: req.deadlineAt, by: self, mailId: null });
          n++;
        } else if (req.kind === 'action' && req.status === 'presented') {
          resolve(tx, req, 'expired', { at: req.deadlineAt, by: self, mailId: null });
          n++;
        }
      }
      for (const g of tx.listGrants((x) => x.status === 'active')) {
        if (now < g.endAt + settle) continue;
        endGrant(tx, { ...g, status: 'expired', endedAt: g.endAt }); // notice dated at the end time, as for H-05 deadlines
        n++;
      }
      return n;
    });
  }

  // ---------------------------------------------------------------- 3. flush
  async function flush() {
    const due = await store.transact((tx) => tx.listOutbox((e) => e.state === 'pending' && e.nextTryAt <= clock.nowMs()));
    let sent = 0;
    for (const e of due) {
      try {
        const r = await client.sendControl({
          to: e.payload.to, subject: e.payload.subject, threadId: e.payload.threadId,
          control: e.payload.control, idempotencyKey: e.eventKey,
        });
        await store.transact((tx) => {
          const cur = tx.getOutbox(e.eventKey);
          tx.putOutbox({ ...cur, state: 'sent', resultMailId: r.messageId, attempts: cur.attempts + 1, lastError: null });
          const req = tx.getRequest(e.requestKey);
          if (req) tx.putRequest({ ...req, resultMailId: r.messageId });
        });
        sent++;
        log({ ev: 'result_sent', event_key: e.eventKey, message_id: r.messageId, replay: r.replay });
      } catch (err) {
        if (!(err instanceof MailError)) throw err;
        const attempts = e.attempts + 1;
        const fatal = !err.retryable && err.code !== 'E-AUTH';
        await store.transact((tx) => {
          const cur = tx.getOutbox(e.eventKey);
          tx.putOutbox({
            ...cur, attempts, state: fatal ? 'failed' : 'pending',
            nextTryAt: clock.nowMs() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs),
            lastError: { code: err.code, reason: err.reason, delivery: err.delivery },
          });
        });
        log({ ev: 'result_send_failed', event_key: e.eventKey, code: err.code, reason: err.reason, delivery: err.delivery });
        if (err.code === 'E-AUTH') throw err; // revoked / wrong token: stop, operator must act
      }
    }
    return sent;
  }

  async function tick() {
    await store.renewLock();
    const ingested = await ingest();
    const resolved = await evaluate();
    const sent = await flush();
    return { ingested, resolved, sent };
  }

  return { tick, ingest, evaluate, flush };
}
