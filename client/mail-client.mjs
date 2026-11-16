// mail-client.mjs — Hub message send/receive glue (H-03; SDS v0.3 API-02, API-03).
// Zero dependencies; Node >= 20 (global fetch, AbortController, crypto.randomUUID).

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const systemClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Every failure the client surfaces. `delivery` tells the caller what is known about the Hub copy:
 *  - 'not_saved'   : the Hub definitely did not store it (validation, 401, 429, tool rejection)
 *  - 'unconfirmed' : the request may have been stored (timeout, 5xx, dropped connection) — show
 *                    「保存結果未確認」, keep the same idempotency key, never claim success or failure.
 *  - 'n/a'         : read-side errors.
 */
export class MailError extends Error {
  constructor(code, message, { reason, delivery = 'not_saved', retryable = false, idempotencyKey, details } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.reason = reason;
    this.delivery = delivery;
    this.retryable = retryable;
    this.idempotencyKey = idempotencyKey;
    this.details = details;
  }
}

const UNCONFIRMED = '保存結果未確認';
// Errors where the TCP connection never opened, so the request cannot have reached the Hub.
const NOT_CONNECTED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function parseRpcBody(text, contentType) {
  if (contentType && contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

export function createMailClient(opts) {
  const {
    url,
    token,
    projectKey,
    agentName,
    senderToken,
    clock = systemClock,
    fetch = globalThis.fetch,
    randomUUID = nodeRandomUUID,
    timeoutMs = 10_000, // SDS SR-ERR-05 engineering value; recalibrate after WAN test
    roster = null, // optional canonical peer names (hub-client.json); null = let the Hub decide
  } = opts;
  let nextId = 0;
  let sessionId = null;
  let initialized = false;

  async function rpc(method, params, { notify = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const body = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = ++nextId;

    const ac = new AbortController();
    const timer = clock.setTimeout(() => ac.abort(new Error('hub request timeout')), timeoutMs);
    let res, text;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
      text = await res.text();
    } catch (e) {
      if (ac.signal.aborted) {
        throw new MailError('E-HUB', UNCONFIRMED, { reason: 'timeout', delivery: 'unconfirmed', retryable: true });
      }
      const code = e?.cause?.code ?? e?.code;
      if (NOT_CONNECTED_CODES.has(code)) {
        throw new MailError('E-HUB', '未送達：Hub 連不上', { reason: 'network', delivery: 'not_saved', retryable: true, details: { code } });
      }
      throw new MailError('E-HUB', UNCONFIRMED, { reason: 'network', delivery: 'unconfirmed', retryable: true, details: { code } });
    } finally {
      clock.clearTimeout(timer);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new MailError('E-AUTH', '連線未授權或已撤銷', { reason: 'unauthorized' });
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new MailError('E-HUB', '未送達：Hub 忙碌，稍後用同一 key 重送', {
        reason: 'rate_limited', retryable: true, details: { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null },
      });
    }
    if (res.status >= 500) {
      throw new MailError('E-HUB', UNCONFIRMED, { reason: 'unavailable', delivery: 'unconfirmed', retryable: true, details: { status: res.status } });
    }
    if (res.status >= 400) {
      throw new MailError('E-HUB', `Hub 拒絕請求（HTTP ${res.status}）`, { reason: 'rejected', details: { status: res.status } });
    }
    if (notify) return null;
    try {
      return parseRpcBody(text, res.headers.get('content-type'));
    } catch {
      throw new MailError('E-HUB', UNCONFIRMED, { reason: 'protocol', delivery: 'unconfirmed', retryable: true, details: { status: res.status } });
    }
  }

  async function ensureSession() {
    if (initialized) return;
    try {
      await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'hub-mail-client', version: '1' },
      });
      await rpc('notifications/initialized', {}, { notify: true });
    } catch (e) {
      // Nothing but the handshake was sent, so no message can have been stored.
      if (e instanceof MailError && e.delivery === 'unconfirmed') {
        e.delivery = 'not_saved';
        e.message = '未送達：無法連線 Hub';
      }
      throw e;
    }
    initialized = true;
  }

  /** Calls a native Mail tool; returns the parsed tool payload or throws MailError. */
  async function callTool(name, args) {
    await ensureSession();
    const msg = await rpc('tools/call', { name, arguments: args });
    if (msg.error) {
      throw new MailError('E-HUB', msg.error.message, { reason: 'rpc_error', details: msg.error });
    }
    const payload = tryParse(msg.result?.content?.[0]?.text);
    if (payload === null || payload === undefined) {
      throw new MailError('E-HUB', UNCONFIRMED, { reason: 'protocol', delivery: 'unconfirmed', retryable: true });
    }
    if (msg.result.isError) throw toolError(payload);
    return payload;
  }

  async function sendItem(item) {
    const clientEventId = item.clientEventId ?? randomUUID();
    validateItem({ ...item, clientEventId }, { roster });
    const envelope = {
      v: ENVELOPE_VERSION,
      client_event_id: clientEventId,
      kind: item.kind,
      intent: item.intent ?? 'action',
      source_session: item.sourceSession,
      summary: item.summary,
      text: item.text,
      links: item.links ?? [],
      unfinished: item.unfinished ?? [],
    };
    let receipt;
    try {
      receipt = await callTool('send_message', {
        project_key: projectKey,
        sender_name: agentName,
        sender_token: senderToken,
        to: item.to,
        ...(item.cc?.length ? { cc: item.cc } : {}),
        subject: item.subject,
        topic: item.kind,
        thread_id: item.threadId ?? clientEventId,
        body_md: JSON.stringify(envelope),
        idempotency_key: clientEventId,
        convert_images: false,
      });
    } catch (e) {
      if (e instanceof MailError) e.idempotencyKey = clientEventId;
      throw e;
    }
    return {
      status: 'saved',
      messageId: receipt.message_id,
      createdTs: receipt.created_ts,
      threadId: receipt.thread_id,
      idempotencyKey: clientEventId,
      replay: receipt.idempotent_replay === true,
    };
  }

  async function fetchEvents({ after, limit = 100 } = {}) {
    const args = { project_key: projectKey, agent_name: agentName, limit };
    if (after !== undefined && after !== null) args.after = after;
    const r = await callTool('fetch_inbox_events', args);
    return {
      events: r.events,
      nextCursor: r.next_cursor,
      hasMore: r.has_more,
      oldestAvailableCursor: r.oldest_available_cursor,
      tailCursor: r.tail_cursor,
    };
  }

  /** Full original message via resources/read; returns { raw, message } with raw = Hub text untouched. */
  async function readMessage(messageId) {
    await ensureSession();
    const uri = `resource://message/${messageId}?project=${encodeURIComponent(projectKey)}`;
    const msg = await rpc('resources/read', { uri });
    if (msg.error) {
      throw new MailError('E-HUB', msg.error.message, { reason: 'rpc_error', delivery: 'n/a', details: msg.error });
    }
    const raw = msg.result.contents[0].text;
    return { raw, message: JSON.parse(raw) };
  }

  /**
   * Runs one send with backoff on retryable errors, always reusing the same idempotency key.
   * 401 / validation / recipient errors stop immediately. If any attempt ended 'unconfirmed',
   * the final error stays 'unconfirmed' even if a later attempt was a clean 429.
   */
  async function withRetry(sendOnce, key, { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 30_000 } = {}) {
    let sawUnconfirmed = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await sendOnce();
        return { ...res, attempts: attempt };
      } catch (e) {
        if (!(e instanceof MailError) || !e.retryable) throw e;
        if (e.delivery === 'unconfirmed') sawUnconfirmed = true;
        if (attempt >= maxAttempts) {
          if (sawUnconfirmed && e.delivery !== 'unconfirmed') {
            throw new MailError('E-HUB', UNCONFIRMED, {
              reason: e.reason, delivery: 'unconfirmed', retryable: true, idempotencyKey: key, details: e.details,
            });
          }
          throw e;
        }
        const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await clock.sleep(e.details?.retryAfterMs ?? backoff);
      }
    }
  }

  async function sendWithRetry(item, opts) {
    const fixed = { ...item, clientEventId: item.clientEventId ?? randomUUID() };
    return withRetry(() => sendItem(fixed), fixed.clientEventId, opts);
  }

  /**
   * Sends a typed control record (SDS API-06: presented / answer / choice / session.closed / result)
   * as topic 'control'. Not an item: no kind/intent, never shown as work to do.
   * `idempotencyKey` is required and must be deterministic for the event, so a resend is a replay.
   */
  async function sendControl({ to, cc, subject, threadId, control, idempotencyKey }) {
    if (!Array.isArray(to) || to.length === 0 || !to.every(nonEmpty)) throw fieldError('to', '收件者至少一位');
    if (!nonEmpty(subject)) throw fieldError('subject', '主旨必填');
    if (!control || control.v !== CONTROL_VERSION || !nonEmpty(control.event_type)) {
      throw fieldError('control', `control 須為 { v:${CONTROL_VERSION}, event_type, ... }`);
    }
    if (!UUID_RE.test(idempotencyKey ?? '')) throw fieldError('idempotencyKey', 'idempotency key 須為 UUID');
    let receipt;
    try {
      receipt = await callTool('send_message', {
        project_key: projectKey,
        sender_name: agentName,
        sender_token: senderToken,
        to,
        ...(cc?.length ? { cc } : {}),
        subject,
        topic: 'control',
        thread_id: threadId ?? idempotencyKey,
        body_md: JSON.stringify(control),
        idempotency_key: idempotencyKey,
        convert_images: false,
      });
    } catch (e) {
      if (e instanceof MailError) e.idempotencyKey = idempotencyKey;
      throw e;
    }
    return {
      status: 'saved',
      messageId: receipt.message_id,
      createdTs: receipt.created_ts,
      threadId: receipt.thread_id,
      idempotencyKey,
      replay: receipt.idempotent_replay === true,
    };
  }

  async function sendControlWithRetry(msg, opts) {
    return withRetry(() => sendControl(msg), msg.idempotencyKey, opts);
  }

  /** Marks one message read for this agent. Call only after the agent has actually taken the original. */
  async function markRead(messageId) {
    return callTool('mark_message_read', { project_key: projectKey, agent_name: agentName, message_id: messageId });
  }

  return { sendItem, sendWithRetry, sendControl, sendControlWithRetry, fetchEvents, readMessage, markRead, callTool, agentName, projectKey };
}

export const ENVELOPE_VERSION = 1;
export const CONTROL_VERSION = 1;
export const MAX_TEXT_CODE_POINTS = 20_000;
export const KINDS = Object.freeze(['handoff', 'help', 'decision', 'task']);
export const INTENTS = Object.freeze(['question', 'action']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unicode code points, not UTF-16 units: one emoji = 1. */
export function countCodePoints(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// SR-MSG-04 minimum categories. Length thresholds are engineering defaults (SDS: undecided);
// bump SECRET_RULES_VERSION whenever a rule changes so server/client stay comparable.
export const SECRET_RULES_VERSION = '2026-11-17.1';
export const SECRET_RULES = Object.freeze([
  { id: 'openai-sk', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'github-ghp', re: /\bghp_[A-Za-z0-9]{30,}/ },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'private-key-pem', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
]);

/** Returns the rule IDs that match (never the matched text). */
export function detectSecrets(...values) {
  const hits = new Set();
  for (const v of values.flat()) {
    if (typeof v !== 'string') continue;
    for (const r of SECRET_RULES) if (r.re.test(v)) hits.add(r.id);
  }
  return [...hits];
}

function fieldError(field, message, extra = {}) {
  return new MailError('E-FIELD', message, { reason: 'field', details: { field, ...extra } });
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
function isUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Client-side pre-check (SDS API-02). Throws MailError; never mutates the item. */
export function validateItem(item, { roster = null } = {}) {
  if (item.attachments !== undefined || item.attachmentPaths !== undefined) {
    throw new MailError('E-ATTACH', 'Hub 不收附件，請放 PR／commit 連結', { reason: 'attachment' });
  }
  if (!Array.isArray(item.to) || item.to.length === 0 || !item.to.every(nonEmpty)) {
    throw fieldError('to', '收件者至少一位');
  }
  if (!nonEmpty(item.subject)) throw fieldError('subject', '主旨必填');
  if (!KINDS.includes(item.kind)) throw fieldError('kind', `類型須為 ${KINDS.join('|')}`);
  if (item.intent !== undefined && !INTENTS.includes(item.intent)) throw fieldError('intent', `性質須為 ${INTENTS.join('|')}`);
  if (!nonEmpty(item.sourceSession)) throw fieldError('sourceSession', 'source_session 必填');
  if (!nonEmpty(item.summary)) throw fieldError('summary', '摘要必填');
  if (!nonEmpty(item.text)) throw fieldError('text', '內容必填');
  const n = countCodePoints(item.text);
  if (n > MAX_TEXT_CODE_POINTS) {
    throw fieldError('text', `內容超過 ${MAX_TEXT_CODE_POINTS} 字，請改放 GitHub 連結`, { limit: MAX_TEXT_CODE_POINTS, actual: n });
  }
  const links = item.links ?? [];
  if (!Array.isArray(links) || !links.every(isUrl)) throw fieldError('links', 'links 須為 http(s) URL 字串陣列');
  const unfinished = item.unfinished ?? [];
  if (!Array.isArray(unfinished) || !unfinished.every((u) => typeof u === 'string')) {
    throw fieldError('unfinished', 'unfinished 須為字串陣列');
  }
  if (!UUID_RE.test(item.clientEventId)) throw fieldError('clientEventId', 'client_event_id 須為 UUID');
  const rules = detectSecrets(item.subject, item.summary, item.text, links, unfinished);
  if (rules.length) {
    throw new MailError('E-SECRET', 'Hub 禁止存放密碼／API key', {
      reason: 'secret', details: { rules, rulesVersion: SECRET_RULES_VERSION },
    });
  }
  if (roster) {
    const unknown = item.to.filter((r) => !roster.includes(r));
    if (unknown.length) {
      throw new MailError('E-RCPT', '收件者不存在', { reason: 'recipient_not_found', details: { unknown, roster: [...roster] } });
    }
  }
}

function toolError(payload) {
  const err = payload?.error ?? {};
  switch (err.type) {
    case 'RECIPIENT_NOT_FOUND':
      return new MailError('E-RCPT', '收件者不存在', {
        reason: 'recipient_not_found',
        details: { unknown: err.data?.unknown_local ?? [], hint: err.data?.hint },
      });
    case 'CURSOR_EXPIRED':
    case 'CURSOR_AHEAD':
      return new MailError('E-CURSOR', '收件游標需恢復', { reason: err.type.toLowerCase(), delivery: 'n/a', details: err.data });
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return new MailError('E-CONFLICT', '同一個 idempotency key 已用於不同內容；原訊息保留，不覆寫', {
        reason: 'idempotency_conflict',
      });
    default:
      return new MailError('E-HUB', err.message ?? 'Hub tool error', { reason: 'tool_error', details: { type: err.type } });
  }
}

function tryParse(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Local durable staging of raw Hub messages + the committed event cursor. */
export function createStaging({ dir }) {
  const msgDir = join(dir, 'messages');
  const cursorFile = join(dir, 'cursor.json');

  async function atomicWrite(path, data) {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  }

  return {
    async has(id) {
      try {
        await readFile(join(msgDir, `${id}.json`));
        return true;
      } catch {
        return false;
      }
    },
    /** Stores the Hub's resource text exactly as received. Never overwrites an existing entry. */
    async put(id, raw) {
      if (await this.has(id)) return false;
      await atomicWrite(join(msgDir, `${id}.json`), raw);
      return true;
    },
    async get(id) {
      try {
        const raw = await readFile(join(msgDir, `${id}.json`), 'utf8');
        return { raw, message: tryParse(raw) };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async list() {
      try {
        const names = await readdir(msgDir);
        return names.filter((n) => n.endsWith('.json')).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
    async getCursor() {
      try {
        return JSON.parse(await readFile(cursorFile, 'utf8')).cursor;
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async setCursor(cursor) {
      await atomicWrite(cursorFile, JSON.stringify({ cursor }));
    },
  };
}

/**
 * Durable receive: pages fetch_inbox_events oldest-first from the committed cursor, stages each
 * message's raw text, and commits the cursor only after the whole page is staged. Never marks read.
 */
export async function syncInbox({ client, staging, limit = 100 }) {
  const staged = [];
  let cursor = await staging.getCursor();
  for (;;) {
    const page = await client.fetchEvents({ after: cursor, limit });
    for (const ev of page.events) {
      if (await staging.has(ev.message_id)) continue;
      const { raw } = await client.readMessage(ev.message_id);
      await staging.put(ev.message_id, raw);
      staged.push(ev.message_id);
    }
    if (page.nextCursor !== undefined && page.nextCursor !== null && page.nextCursor !== cursor) {
      cursor = page.nextCursor;
      await staging.setCursor(cursor);
    }
    if (!page.hasMore) break;
  }
  return { staged, cursor };
}
