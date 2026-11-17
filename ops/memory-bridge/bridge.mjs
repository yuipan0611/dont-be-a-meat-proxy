// bridge.mjs — L-02b: the ONE writer from saved Mail into Hindsight (SDS API-04, GAP-16).
//
// Agents never write Hindsight themselves. A handoff/decision is first saved in Mail (the record),
// CC'd to this bridge's Mail agent. One tick:
//   1. ingest  — read new inbox events from the committed cursor; for each handoff/decision write an
//                ingest record {mailId, documentId: mail-<id>, textSha256, status: pending} and the new
//                cursor in ONE store transaction (crash before commit → the page is re-read; duplicates
//                are suppressed by Mail message ID).
//   2. process — for each due record: re-read the text from Mail (source of truth; hash must still
//                match), mark in_flight (persisted), retain into the bank with document_id mail-<id>,
//                then indexed. Failures keep the record: pending (+error, last attempt, backoff),
//                unknown (timeout: next time look the document up BEFORE retaining again), or error
//                (4xx / text changed: no automatic retry; `reindex <id>` re-queues it).
//
// Not exactly-once: Hindsight 1.2.1 replaces a document on the same document_id (black-box result in
// docs/ops/L02b-memory-bridge.md), so a repeated retain converges on one document; extracted memories
// are re-derived. The daily LLM cap (gateway 429) shows up here as a retain failure → stays pending.
//
// Store: reuses ops/lifecycle/store-file.mjs (lease lock, fencing, cursor, processed IDs) in the
// bridge's OWN state directory; ingest records live in its `requests` map keyed by document ID.

import { createHash } from 'node:crypto';
import { parseItem } from '../lifecycle/protocol.mjs';

export const INDEXED_KINDS = Object.freeze(['handoff', 'decision']);
export const documentIdFor = (mailId) => `mail-${mailId}`;
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const DUE = new Set(['pending', 'unknown']);

/**
 * @param {object} o
 * @param {object} o.mail       createMailClient(...) acting as the bridge agent (fetchEvents, readMessage)
 * @param {{retain:(bank,item)=>Promise, getDocument:(bank,id)=>Promise<null|{original_text}>}} o.hindsight
 *        errors carry .kind: 'unreachable' (not sent) | 'unknown' (sent, outcome unknown) |
 *        'failed' (5xx, includes the LLM gateway's budget refusal) | 'rejected' (4xx, .status)
 * @param {object} o.store      createFileStore(...) on the bridge state dir
 * @param {{nowMs:()=>number}} o.clock
 * @param {string} o.bank       Hindsight bank of this group (group-a)
 */
export function createBridge({ mail, hindsight, store, clock, bank, retryBaseMs = 30_000, retryMaxMs = 15 * 60_000, pageLimit = 100, log = () => {} }) {
  const self = mail.agentName;
  let recovered = false;
  const backoff = (attempts) => Math.min(retryBaseMs * 2 ** Math.max(0, attempts - 1), retryMaxMs);

  function recordFor(m, item) {
    return {
      key: documentIdFor(m.id), mailId: m.id, documentId: documentIdFor(m.id), bank, kind: item.kind,
      from: m.from, threadId: m.thread_id, createdTs: m.created_ts, textSha256: sha256(item.text),
      status: 'pending', attempts: 0, nextTryAt: clock.nowMs(), lastAttemptAt: null, lastError: null, indexedAt: null,
    };
  }

  const indexable = (m, item) => m.from !== self && m.topic !== 'control' && item && INDEXED_KINDS.includes(item.kind) && typeof item.text === 'string';

  // ------------------------------------------------------------------ 1. ingest
  async function ingest() {
    let added = 0;
    for (;;) {
      const cursor = await store.transact((tx) => tx.getCursor());
      const page = await mail.fetchEvents({ after: cursor, limit: pageLimit });
      const msgs = [];
      for (const ev of page.events) msgs.push((await mail.readMessage(ev.message_id)).message);
      await store.transact((tx) => {
        for (const m of msgs) {
          if (tx.isProcessed(m.id)) continue;
          tx.markProcessed(m.id);
          const item = m.topic === 'control' ? null : parseItem(m.body_md);
          if (!indexable(m, item)) { log({ ev: 'skipped', mail_id: m.id, topic: m.topic }); continue; }
          if (tx.getRequest(documentIdFor(m.id))) continue;
          tx.putRequest(recordFor(m, item));
          added++;
          log({ ev: 'queued', mail_id: m.id, kind: item.kind });
        }
        if (page.nextCursor !== undefined && page.nextCursor !== null) tx.setCursor(page.nextCursor);
      });
      if (!page.hasMore || page.nextCursor === cursor) break;
    }
    return added;
  }

  // ------------------------------------------------------------------ 2. process
  async function update(key, patch) {
    return store.transact((tx) => {
      const r = tx.getRequest(key);
      const next = { ...r, ...patch };
      tx.putRequest(next);
      return next;
    });
  }

  async function processOne(r) {
    const now = clock.nowMs();
    // Mail is the source of truth: the text must be exactly what was queued.
    let item;
    try {
      item = parseItem((await mail.readMessage(r.mailId)).message.body_md);
    } catch (e) {
      return update(r.key, { status: 'pending', lastAttemptAt: now, nextTryAt: now + backoff(r.attempts + 1), lastError: { stage: 'mail', message: String(e.message ?? e) } });
    }
    if (!item || sha256(item.text) !== r.textSha256) {
      log({ ev: 'text_mismatch', mail_id: r.mailId });
      return update(r.key, { status: 'error', lastAttemptAt: now, lastError: { stage: 'mail', message: 'Mail text hash no longer matches the queued hash; not indexed' } });
    }
    if (r.status === 'unknown') {
      let doc;
      try {
        doc = await hindsight.getDocument(bank, r.documentId);
      } catch (e) {
        return update(r.key, { lastAttemptAt: now, nextTryAt: now + backoff(r.attempts + 1), lastError: { stage: 'lookup', kind: e.kind ?? null, message: String(e.message ?? e) } });
      }
      if (doc && typeof doc.original_text === 'string' && sha256(doc.original_text) === r.textSha256) {
        log({ ev: 'indexed_after_unknown', mail_id: r.mailId });
        return update(r.key, { status: 'indexed', indexedAt: now, lastError: null });
      }
    }
    const attempts = r.attempts + 1;
    await update(r.key, { status: 'in_flight', attempts, lastAttemptAt: now });
    const meta = { mail_id: String(r.mailId), from: r.from, kind: r.kind, created_ts: r.createdTs, thread_id: String(r.threadId ?? ''), summary: String(item.summary ?? '') };
    try {
      await hindsight.retain(bank, { content: item.text, document_id: r.documentId, context: r.kind, timestamp: r.createdTs, metadata: meta });
    } catch (e) {
      if (!e?.kind) throw e; // programming error / killed: leave in_flight → treated as unknown on restart
      const at = clock.nowMs();
      const lastError = { stage: 'retain', kind: e.kind, status: e.status ?? null, message: String(e.message).slice(0, 500) };
      log({ ev: 'retain_failed', mail_id: r.mailId, kind: e.kind, status: e.status ?? null, attempts });
      if (e.kind === 'rejected' && e.status !== 429) return update(r.key, { status: 'error', lastError });
      return update(r.key, { status: e.kind === 'unknown' ? 'unknown' : 'pending', nextTryAt: at + backoff(attempts), lastError });
    }
    log({ ev: 'indexed', mail_id: r.mailId, attempts });
    return update(r.key, { status: 'indexed', indexedAt: clock.nowMs(), lastError: null });
  }

  async function processDue() {
    if (!recovered) {
      // A record still in_flight was being retained when the previous process died: outcome unknown.
      await store.transact((tx) => {
        for (const r of tx.listRequests((x) => x.status === 'in_flight')) tx.putRequest({ ...r, status: 'unknown', nextTryAt: clock.nowMs() });
      });
      recovered = true;
    }
    const due = await store.transact((tx) => tx.listRequests((r) => DUE.has(r.status) && r.nextTryAt <= clock.nowMs()));
    due.sort((a, b) => a.mailId - b.mailId);
    let done = 0;
    for (const r of due) {
      const out = await processOne(r);
      if (out.status === 'indexed') done++;
    }
    return done;
  }

  /** Operator re-run by Mail ID (also backfills a message the bridge was never CC'd on). */
  async function reindex(mailId, { force = false } = {}) {
    const key = documentIdFor(mailId);
    const existing = await store.transact((tx) => tx.getRequest(key));
    if (existing) {
      if (existing.status === 'in_flight') throw new Error(`#${mailId} is in flight; retry after the current attempt`);
      return update(key, { status: 'pending', nextTryAt: clock.nowMs() });
    }
    const m = (await mail.readMessage(mailId)).message;
    const item = parseItem(m.body_md);
    if (!item || typeof item.text !== 'string') throw new Error(`#${mailId} is not an item-v1 message`);
    if (!force && !INDEXED_KINDS.includes(item.kind)) throw new Error(`#${mailId} is not a handoff or decision (kind ${item.kind}); use --force`);
    return store.transact((tx) => {
      const r = recordFor(m, item);
      tx.putRequest(r);
      return r;
    });
  }

  async function tick() {
    await store.renewLock();
    const queued = await ingest();
    const indexed = await processDue();
    return { queued, indexed };
  }

  return { tick, ingest, processDue, reindex };
}
