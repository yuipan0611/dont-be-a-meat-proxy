// In-memory stand-in for the Hub, exposing the same client interface as mail-client.mjs
// (sendItem, sendWithRetry, fetchEvents, readMessage, markRead, callTool). Used by hub-hook
// unit tests; the real Mail server is covered by the integration tests.
import { MailError, validateItem } from '../../mail-client.mjs';
import { randomUUID } from 'node:crypto';

export function createFakeHub({ projectKey = '/data/projects/group-a', clock = { now: () => Date.now() } } = {}) {
  const messages = []; // { id, from, to, cc, subject, topic, thread_id, body_md, created_ts }
  const deliveries = []; // { cursor, agent, message_id }
  const reads = new Map(); // agent -> Set(id)
  const byKey = new Map();
  const calls = [];
  let down = null; // MailError to throw on every call, or null
  const failQueue = []; // one-shot errors

  function gate(op) {
    calls.push(op);
    if (failQueue.length) throw failQueue.shift();
    if (down) throw down;
  }

  function store({ from, to, cc = [], subject, topic, thread_id, body_md, key }) {
    if (key && byKey.has(key)) return { ...byKey.get(key), idempotent_replay: true };
    const id = messages.length + 1;
    const m = { id, from, to, cc, subject, topic, thread_id, body_md, created_ts: new Date(clock.now()).toISOString() };
    messages.push(m);
    for (const a of [...to, ...cc]) deliveries.push({ cursor: deliveries.length + 1, agent: a, message_id: id });
    const receipt = { message_id: id, created_ts: m.created_ts, thread_id };
    if (key) byKey.set(key, receipt);
    return receipt;
  }

  function client(agentName) {

    const api = {
      agentName,
      projectKey,
      async sendItem(item) {
        gate({ agent: agentName, op: 'sendItem', key: item.clientEventId });
        const clientEventId = item.clientEventId ?? randomUUID();
        validateItem({ ...item, clientEventId });
        const body = {
          v: 1, client_event_id: clientEventId, kind: item.kind, intent: item.intent ?? 'action',
          source_session: item.sourceSession, summary: item.summary, text: item.text,
          links: item.links ?? [], unfinished: item.unfinished ?? [],
        };
        const r = store({
          from: agentName, to: item.to, cc: item.cc ?? [], subject: item.subject, topic: item.kind,
          thread_id: item.threadId ?? clientEventId, body_md: JSON.stringify(body), key: clientEventId,
        });
        return { status: 'saved', messageId: r.message_id, createdTs: r.created_ts, threadId: r.thread_id, idempotencyKey: clientEventId, replay: !!r.idempotent_replay };
      },
      async sendWithRetry(item) { return { ...(await api.sendItem(item)), attempts: 1 }; },
      async sendControl({ to, cc, subject, threadId, control, idempotencyKey }) {
        gate({ agent: agentName, op: 'sendControl', key: idempotencyKey });
        const r = store({ from: agentName, to, cc: cc ?? [], subject, topic: 'control', thread_id: threadId ?? idempotencyKey, body_md: JSON.stringify(control), key: idempotencyKey });
        return { status: 'saved', messageId: r.message_id, createdTs: r.created_ts, threadId: r.thread_id, idempotencyKey, replay: !!r.idempotent_replay };
      },
      async fetchEvents({ after, limit = 100 } = {}) {
        gate({ agent: agentName, op: 'fetchEvents', after });
        const mine = deliveries.filter((d) => d.agent === agentName && d.cursor > (after ?? 0));
        const page = mine.slice(0, limit);
        const last = page.length ? page[page.length - 1].cursor : after ?? 0;
        return {
          events: page.map((d) => {
            const m = messages[d.message_id - 1];
            return { cursor: d.cursor, message_id: d.message_id, kind: 'to', subject: m.subject, from: m.from, delivered_ts: m.created_ts };
          }),
          nextCursor: last, hasMore: mine.length > page.length, oldestAvailableCursor: 1, tailCursor: deliveries.length,
        };
      },
      async readMessage(id) {
        gate({ agent: agentName, op: 'readMessage', id });
        const m = messages[id - 1];
        if (!m) throw new MailError('E-HUB', 'not found', { reason: 'rpc_error', delivery: 'n/a' });
        const raw = JSON.stringify({ ...m, attachments: [], bcc: [] });
        return { raw, message: JSON.parse(raw) };
      },
      async markRead(id) {
        gate({ agent: agentName, op: 'markRead', id });
        if (!reads.has(agentName)) reads.set(agentName, new Set());
        reads.get(agentName).add(id);
        return { message_id: id, read: true };
      },
      async callTool(name, args) {
        gate({ agent: agentName, op: name, args });
        if (name === 'fetch_topic') {
          return messages.filter((m) => m.topic === args.topic_name)
            .sort((a, b) => (a.created_ts === b.created_ts ? b.id - a.id : a.created_ts < b.created_ts ? 1 : -1))
            .slice(0, args.limit).map((m) => ({ ...m }));
        }
        if (name === 'send_message') {
          return store({
            from: args.sender_name, to: args.to, cc: args.cc ?? [], subject: args.subject, topic: args.topic,
            thread_id: args.thread_id, body_md: args.body_md, key: args.idempotency_key,
          });
        }
        throw new Error(`fake hub: unsupported tool ${name}`);
      },
    };
    return api;
  }

  return {
    client,
    messages,
    calls,
    readsOf: (agent) => [...(reads.get(agent) ?? [])],
    inboxOf: (agent) => deliveries.filter((d) => d.agent === agent).map((d) => messages[d.message_id - 1]),
    /** Hub unreachable for every call until up() (not_saved, like ECONNREFUSED). */
    down(err = new MailError('E-HUB', '未送達：Hub 連不上', { reason: 'network', delivery: 'not_saved', retryable: true })) { down = err; },
    up() { down = null; },
    failNext(err) { failQueue.push(err); },
    /** Deliver a message as another agent would (convenience for tests). */
    send(from, item) { return client(from).sendItem(item); },
  };
}
