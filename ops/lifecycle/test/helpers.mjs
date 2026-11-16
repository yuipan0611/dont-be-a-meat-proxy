// Test doubles for HubClock unit tests: a wall FakeClock and an in-memory Mail that speaks the same
// client interface the lifecycle uses (agentName, fetchEvents, readMessage, sendControl).
// Real Mail behaviour is covered by lifecycle.integration.test.mjs.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailError } from '../../../client/mail-client.mjs';
import { microsToIso, buildClientControl } from '../protocol.mjs';

export const T0 = Date.parse('2026-12-01T00:00:00Z');
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export class FakeWallClock {
  constructor(ms = T0) { this.ms = ms; this.extraMicros = 0; }
  nowMs() { return this.ms; }
  set(ms) { this.ms = ms; }
  advance(ms) { this.ms += ms; }
}

/** In-memory Mail. Message created_ts comes from the clock (+ optional µs offset per message). */
export class FakeHub {
  constructor(clock) {
    this.clock = clock;
    this.messages = [];
    this.inbox = new Map(); // agent -> [{cursor, message_id}]
    this.cursorSeq = 0;
    this.keys = new Map(); // idempotency key -> message id
    this.sendFailures = []; // queued MailErrors to throw from sendControl
  }

  post(from, { to, cc = [], topic, body, threadId, micros, key }) {
    if (key && this.keys.has(key)) return { message: this.messages[this.keys.get(key) - 1], replay: true };
    const id = this.messages.length + 1;
    const us = micros ?? this.clock.nowMs() * 1000;
    const message = {
      id, thread_id: threadId ?? `thread-${id}`, topic, subject: topic, body_md: JSON.stringify(body),
      created_ts: microsToIso(us), from, to, cc, bcc: [], attachments: [],
    };
    this.messages.push(message);
    if (key) this.keys.set(key, id);
    for (const a of new Set([...to, ...cc])) {
      if (!this.inbox.has(a)) this.inbox.set(a, []);
      this.inbox.get(a).push({ cursor: ++this.cursorSeq, message_id: id });
    }
    return { message, replay: false };
  }

  /** Re-deliver an already stored message as a new inbox event (duplicate-event simulation). */
  redeliver(agent, messageId) {
    this.inbox.get(agent).push({ cursor: ++this.cursorSeq, message_id: messageId });
  }

  clientFor(agentName) {
    const hub = this;
    const client = {
      agentName,
      calls: { send: 0 },
      async fetchEvents({ after, limit = 100 } = {}) {
        const all = (hub.inbox.get(agentName) ?? []).filter((e) => after === null || after === undefined || e.cursor > after);
        const events = all.slice(0, limit);
        const nextCursor = events.length ? events[events.length - 1].cursor : after ?? null;
        return { events, nextCursor, hasMore: all.length > limit };
      },
      async readMessage(id) {
        const m = hub.messages[id - 1];
        return { raw: JSON.stringify(m), message: structuredClone(m) };
      },
      async sendControl({ to, cc, subject, threadId, control, idempotencyKey }) {
        client.calls.send++;
        const f = hub.sendFailures.shift();
        if (f) {
          if (f.storeAnyway) hub.post(agentName, { to, cc, topic: 'control', body: control, threadId, key: idempotencyKey });
          throw f.error;
        }
        const { message, replay } = hub.post(agentName, { to, cc, topic: 'control', body: control, threadId, key: idempotencyKey });
        return { status: 'saved', messageId: message.id, createdTs: message.created_ts, threadId: message.thread_id, idempotencyKey, replay };
      },
    };
    return client;
  }

  // ---- convenience for tests (what H-04 clients will send)
  root(from, to, intent, { micros, clockName = 'clock-agent' } = {}) {
    const body = { v: 1, client_event_id: `00000000-0000-4000-8000-${String(this.messages.length + 1).padStart(12, '0')}`, kind: 'help', intent, source_session: 's', summary: 's', text: 't', links: [], unfinished: [] };
    return this.post(from, { to, cc: [clockName], topic: 'help', body, micros }).message;
  }
  control(from, clockName, eventType, root, session, { choice, reason, micros } = {}) {
    const body = buildClientControl({ eventType, rootMailId: root?.id ?? null, recipientSession: session, agent: from, choice, reason });
    return this.post(from, { to: [clockName], topic: 'control', body, threadId: root?.thread_id, micros }).message;
  }
  results() {
    return this.messages.filter((m) => m.topic === 'control' && JSON.parse(m.body_md).event_type === 'result').map((m) => ({ ...m, body: JSON.parse(m.body_md) }));
  }
}

export function unconfirmed() {
  return new MailError('E-HUB', '保存結果未確認', { reason: 'timeout', delivery: 'unconfirmed', retryable: true });
}

export async function tempDir(prefix = 'hubclock-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
