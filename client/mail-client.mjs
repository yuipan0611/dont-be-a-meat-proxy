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
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new MailError('E-AUTH', '連線未授權或已撤銷', { reason: 'unauthorized' });
    }
    if (notify) return null;
    return JSON.parse(text);
  }

  async function ensureSession() {
    if (initialized) return;
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'hub-mail-client', version: '1' },
    });
    await rpc('notifications/initialized', {}, { notify: true });
    initialized = true;
  }

  /** Calls a native Mail tool; returns the parsed tool payload or throws MailError. */
  async function callTool(name, args) {
    await ensureSession();
    const msg = await rpc('tools/call', { name, arguments: args });
    if (msg.error) {
      throw new MailError('E-HUB', msg.error.message, { reason: 'rpc_error', details: msg.error });
    }
    const payload = JSON.parse(msg.result.content[0].text);
    if (msg.result.isError) throw toolError(payload);
    return payload;
  }

  async function sendItem(item) {
    const clientEventId = item.clientEventId ?? randomUUID();
    const envelope = {
      v: 1,
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

  return { sendItem, fetchEvents, readMessage, callTool, agentName, projectKey };
}

function toolError(payload) {
  const err = payload?.error ?? {};
  switch (err.type) {
    case 'RECIPIENT_NOT_FOUND':
      return new MailError('E-RCPT', '收件者不存在', {
        reason: 'recipient_not_found',
        details: { unknown: err.data?.unknown_local ?? [], hint: err.data?.hint },
      });
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return new MailError('E-CONFLICT', '同一個 idempotency key 已用於不同內容；原訊息保留，不覆寫', {
        reason: 'idempotency_conflict',
      });
    default:
      return new MailError('E-HUB', err.message ?? 'Hub tool error', { reason: 'tool_error', details: { type: err.type } });
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
        return { raw, message: JSON.parse(raw) };
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
