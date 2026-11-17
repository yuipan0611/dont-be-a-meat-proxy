// llm-gateway.mjs — L-02 hard daily cap in front of the Anthropic Messages API (SDS D-4 / MOD-01).
//
// Hindsight is configured with HINDSIGHT_API_LLM_BASE_URL=http://bank-proxy:8790 and an INTERNAL key;
// its own Anthropic SDK then sends POST /v1/messages here. For each call:
//   1. authenticate the internal client key (never the real Anthropic key),
//   2. refuse unpriced models / missing max_tokens (unknown cost is never sent),
//   3. reserve the worst-case cost in the global ledger — over the cap → 429, nothing sent,
//   4. forward byte-for-byte with the real key, streaming the response back unchanged,
//   5. settle at the actual cost from `usage` (JSON or SSE); upstream error status → release;
//      200 without readable usage, or a broken stream → charge the full reservation.
//
// A pure pass-through proxy: it does not build Claude requests itself, so it uses node:http, not the SDK.

import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { PRICES, costMicros, maxCostMicros } from './budget.mjs';

const MAX_BODY = 8 * 1024 * 1024;
const FORWARD_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

function anthropicError(res, status, type, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Incremental SSE usage reader: message_start carries input/cache usage, message_delta the running output. */
function sseUsageTracker() {
  let buf = '';
  const usage = {};
  let seen = false;
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const u = ev.type === 'message_start' ? ev.message?.usage : ev.type === 'message_delta' ? ev.usage : null;
          if (u) { Object.assign(usage, u); seen = true; }
        }
      }
    },
    result: () => (seen ? usage : null),
  };
}

/**
 * @param {object} o
 * @param {object} o.ledger            createLedger(...)
 * @param {string} o.upstreamUrl       https://api.anthropic.com
 * @param {string} o.upstreamKey       real Anthropic key (from a secret file)
 * @param {Record<string,string>} o.clientKeys  internal key → role (e.g. hindsight, assistant)
 */
export function createLlmGateway({ ledger, upstreamUrl, upstreamKey, clientKeys, prices = PRICES, log = () => {} }) {
  const upstream = new URL(upstreamUrl);
  const transport = upstream.protocol === 'https:' ? https : http;
  const keys = new Map(Object.entries(clientKeys));

  return async function handle(req, res) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const role = keys.get(req.headers['x-api-key'] ?? bearer ?? '');
    if (!role) return anthropicError(res, 401, 'authentication_error', 'invalid gateway key');
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/messages') return anthropicError(res, 404, 'not_found_error', 'only POST /v1/messages');

    let raw;
    try { raw = await readBody(req); } catch (e) { return anthropicError(res, e.status ?? 400, 'invalid_request_error', e.message); }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return anthropicError(res, 400, 'invalid_request_error', 'body is not JSON'); }
    const price = prices[body?.model];
    if (!price) return anthropicError(res, 400, 'invalid_request_error', `model ${body?.model} is not priced in the gateway; refused`);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return anthropicError(res, 400, 'invalid_request_error', 'max_tokens is required');

    const requestId = randomUUID();
    const maxMicros = maxCostMicros(price, { bodyBytes: raw.length, maxTokens: body.max_tokens, cacheControl: raw.includes('"cache_control"') });
    const r = ledger.reserve({ requestId, role, maxMicros });
    if (!r.ok) {
      log({ ev: 'budget_refused', role, maxMicros, code: r.code, spent: r.spentMicros, reserved: r.reservedMicros });
      return anthropicError(res, 429, 'rate_limit_error', '今日 LLM 額度已用完（每日 0.50 USD，台北時間 00:00 恢復）', { 'x-should-retry': 'false' });
    }

    const headers = { 'x-api-key': upstreamKey, 'content-length': raw.length };
    for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    let settled = false;
    const finish = (how, micros) => {
      if (settled) return;
      settled = true;
      if (how === 'release') ledger.release(requestId);
      else ledger.settle(requestId, micros);
      log({ ev: 'llm_call', role, model: body.model, how, micros: how === 'release' ? 0 : micros, reserved: maxMicros });
    };

    const up = transport.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port,
      path: `${upstream.pathname.replace(/\/$/, '')}/v1/messages`, method: 'POST', headers,
    }, (ures) => {
      const pass = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!['connection', 'transfer-encoding', 'content-length'].includes(k)) pass[k] = v;
      res.writeHead(ures.statusCode, pass);
      if (ures.statusCode >= 400) {
        ures.pipe(res);
        ures.on('end', () => finish('release'));
        ures.on('error', () => finish('release'));
        return;
      }
      const isSse = String(ures.headers['content-type'] ?? '').includes('text/event-stream');
      const sse = isSse ? sseUsageTracker() : null;
      const chunks = [];
      ures.on('data', (c) => {
        if (sse) sse.push(c); else chunks.push(c);
        if (!res.write(c)) { ures.pause(); res.once('drain', () => ures.resume()); }
      });
      ures.on('end', () => {
        res.end();
        let usage = sse?.result() ?? null;
        if (!sse) { try { usage = JSON.parse(Buffer.concat(chunks).toString('utf8')).usage ?? null; } catch { usage = null; } }
        finish('settle', usage ? costMicros(price, usage) : maxMicros);
      });
      ures.on('error', () => { finish('settle', maxMicros); res.destroy(); });
    });
    up.on('error', (e) => {
      // Refused before anything was sent → not billed; otherwise assume it may have been.
      finish(e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' ? 'release' : 'settle', maxMicros);
      if (!res.headersSent) anthropicError(res, 502, 'api_error', `upstream unreachable (${e.code ?? e.message})`);
      else res.destroy();
    });
    res.on('close', () => { if (!settled && !res.writableEnded) { up.destroy(); finish('settle', maxMicros); } });
    up.end(raw);
  };
}
