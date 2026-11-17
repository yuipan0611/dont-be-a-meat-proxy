// bank-proxy.mjs — L-02: per-device token → exactly one Hindsight bank (SDS API-04, F-05 §4).
//
// Caddy strips /memory and forwards /mcp/<bank>/ here with the device's own bearer. For every request:
//   1. token → sha256 → registry (DB devices ⨝ members ⨝ groups, status active). Missing / unknown /
//      revoked → 401. Registry unreachable → 503 (fail-closed). Looked up on EVERY request, so a
//      revocation also cuts an MCP session that is already open.
//   2. only /mcp/<that device's bank>/ is served; any other bank, the multi-bank /mcp/, REST,
//      metrics, docs → 403.
//   3. POST JSON-RPC: tools/call must name a READ tool, else a JSON-RPC error TOOL_NOT_ALLOWED and
//      nothing is forwarded (a batch with one bad call is refused whole). tools/list responses are
//      filtered to the same set — hiding is cosmetic, the call check is the enforcement.
//   4. only Streamable-HTTP headers are forwarded (session id, protocol version, last-event-id,
//      accept, content-type); X-Bank-Id and any identity header are dropped; Authorization is
//      replaced by the Hindsight tenant master key, which never leaves this process.
//   5. responses (JSON or SSE, GET streams, DELETE) are streamed back with backpressure.
//
// Members are read-only (SR-AST-01): writes to Hindsight come only from the internal bridge (GAP-16),
// and reflect is withheld because it makes hidden LLM calls (SDS API-04).

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

export const READ_TOOLS = Object.freeze(new Set(['recall', 'list_memories', 'get_memory', 'get_document']));
const MAX_BODY = 2 * 1024 * 1024;
const FORWARD_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const BANK_PATH = /^\/mcp\/([a-z0-9][a-z0-9_-]{0,62})\/?(\?[^#]*)?$/; // raw URL: no %-escapes, no dot segments

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function plain(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function filterToolsList(msg) {
  if (msg && msg.result && Array.isArray(msg.result.tools)) {
    return { ...msg, result: { ...msg.result, tools: msg.result.tools.filter((t) => READ_TOOLS.has(t.name)) } };
  }
  return msg;
}

/** Rewrites a buffered tools/list response (JSON body or SSE events) keeping only READ_TOOLS. */
function rewriteToolsList(buf, contentType) {
  const text = buf.toString('utf8');
  if (contentType.includes('text/event-stream')) {
    return text.split('\n').map((line) => {
      if (!line.startsWith('data:')) return line;
      try {
        const m = JSON.parse(line.slice(5).trim());
        return `data: ${JSON.stringify(Array.isArray(m) ? m.map(filterToolsList) : filterToolsList(m))}`;
      } catch { return line; }
    }).join('\n');
  }
  try {
    const m = JSON.parse(text);
    return JSON.stringify(Array.isArray(m) ? m.map(filterToolsList) : filterToolsList(m));
  } catch { return text; }
}

/**
 * @param {object} o
 * @param {{lookup:(tokenHash:string)=>Promise<null|{tokenId,groupId,bankId,principal}>}} o.registry
 * @param {string} o.upstreamUrl   http://hindsight:8888 (internal network only)
 * @param {string} o.upstreamKey   Hindsight tenant API key (secret file)
 */
export function createBankProxy({ registry, upstreamUrl, upstreamKey, groupId = 'group-a', log = () => {} }) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(groupId)) throw new Error('invalid group_id');
  const upstream = new URL(upstreamUrl);
  const transport = upstream.protocol === 'https:' ? https : http;

  return async function handle(req, res) {
    const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return plain(res, 401, 'missing token');
    let dev;
    try {
      dev = await registry.lookup(sha256(token));
    } catch (e) {
      log({ ev: 'registry_error', error: String(e?.message ?? e) });
      return plain(res, 503, 'token registry unavailable');
    }
    if (!dev || dev.groupId !== groupId) return plain(res, 401, 'invalid or revoked token');

    const m = BANK_PATH.exec(req.url);
    if (!m || m[1] !== dev.bankId) {
      log({ ev: 'path_refused', token_id: dev.tokenId, method: req.method, path: req.url.slice(0, 200) });
      return plain(res, 403, 'this token may only use its own bank');
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return plain(res, 405, 'method not allowed');

    let raw = null;
    let wantsToolsList = false;
    if (req.method === 'POST') {
      try { raw = await readBody(req); } catch (e) { return plain(res, e.status ?? 400, e.message); }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return plain(res, 400, 'body is not JSON-RPC'); }
      const msgs = Array.isArray(msg) ? msg : [msg];
      const bad = msgs.filter((x) => x?.method === 'tools/call' && !READ_TOOLS.has(x?.params?.name));
      if (bad.length) {
        for (const b of bad) log({ ev: 'tool_refused', token_id: dev.tokenId, bank: dev.bankId, tool: String(b?.params?.name).slice(0, 80) });
        const errs = msgs.filter((x) => x && x.id !== undefined).map((x) => ({
          jsonrpc: '2.0', id: x.id,
          error: { code: -32601, message: `TOOL_NOT_ALLOWED: ${x?.params?.name ?? x.method} is not available through the member endpoint`, data: { reason: 'TOOL_NOT_ALLOWED' } },
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(Array.isArray(msg) ? errs : errs[0] ?? null));
      }
      const pending = [...msgs];
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        for (const [key, val] of Object.entries(value)) {
          if (key === 'bank_id' && val !== dev.bankId) return plain(res, 403, 'foreign bank argument');
          if (val && typeof val === 'object') pending.push(val);
        }
      }
      wantsToolsList = msgs.some((x) => x?.method === 'tools/list');
    }

    const headers = { authorization: `Bearer ${upstreamKey}` };
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    if (raw) headers['content-length'] = raw.length;

    const up = transport.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port,
      path: `/mcp/${dev.bankId}/${m[2] ?? ''}`, method: req.method, headers,
    }, (ures) => {
      const pass = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!['connection', 'transfer-encoding', 'keep-alive'].includes(k)) pass[k] = v;
      if (wantsToolsList && ures.statusCode < 300) {
        const chunks = [];
        ures.on('data', (c) => chunks.push(c));
        ures.on('end', () => {
          const out = rewriteToolsList(Buffer.concat(chunks), String(ures.headers['content-type'] ?? ''));
          delete pass['content-length'];
          res.writeHead(ures.statusCode, { ...pass, 'content-length': Buffer.byteLength(out) });
          res.end(out);
        });
        return;
      }
      res.writeHead(ures.statusCode, pass);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      ures.pipe(res);
    });
    up.on('error', (e) => {
      log({ ev: 'upstream_error', token_id: dev.tokenId, error: e.code ?? e.message });
      if (!res.headersSent) plain(res, 502, 'memory service unavailable');
      else res.destroy();
    });
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    up.end(raw ?? undefined);
  };
}
