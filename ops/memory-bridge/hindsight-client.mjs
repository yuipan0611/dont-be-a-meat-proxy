// hindsight-client.mjs — L-02b: the bridge's operator-side REST client for Hindsight (memory-net only).
// Errors carry .kind so the bridge can decide pending / unknown / error:
//   unreachable — connection refused / DNS: the request was not delivered
//   unknown     — timeout or connection dropped after sending: it may or may not have been stored
//   failed      — 5xx, or 200 with success:false (includes the LLM gateway's daily-cap refusal)
//   rejected    — 4xx (.status); 429 is treated as retryable by the bridge

import { createHash } from 'node:crypto';
import { fingerprint, HindsightError } from './diagnostics.mjs';

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function classify(err) {
  const code = err?.cause?.code ?? err?.code;
  const details = fingerprint(String(err?.message ?? err));
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new HindsightError('HINDSIGHT_TIMEOUT', 'unknown', undefined, details);
  if (NOT_SENT.has(code)) return new HindsightError(code, 'unreachable', undefined, details);
  return new HindsightError('HINDSIGHT_CONNECTION', 'unknown', undefined, details);
}

async function statusError(res) {
  const hash = createHash('sha256');
  let length = 0;
  try {
    if (res.body) for await (const chunk of res.body) {
      length += chunk.byteLength;
      hash.update(chunk);
    }
  } catch {} // retain the HTTP classification even if the body was cut short
  const kind = res.status >= 500 ? 'failed' : 'rejected';
  return new HindsightError('HINDSIGHT_HTTP', kind, res.status, { length, sha256: hash.digest('hex') });
}

async function readJson(res) {
  let body;
  try { body = Buffer.from(await res.arrayBuffer()); } catch (e) { throw classify(e); }
  try {
    return { body, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    throw new HindsightError('HINDSIGHT_INVALID_JSON', 'unknown', res.status, fingerprint(body));
  }
}

/**
 * @param {object} o
 * @param {string} o.url       http://hindsight:8888
 * @param {string} o.apiKey    tenant key (secret file)
 * @param {number} [o.timeoutMs]  sync retain runs extraction; Haiku is seconds, local models a minute+
 */
export function createHindsightClient({ url, apiKey, timeoutMs = 300_000 }) {
  const base = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const bankPath = (bank) => `/v1/default/banks/${encodeURIComponent(bank)}`;

  async function call(method, path, body) {
    try {
      return await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw classify(e);
    }
  }

  return {
    async retain(bank, item) {
      const res = await call('POST', `${bankPath(bank)}/memories`, { items: [item], async: false });
      if (!res.ok) throw await statusError(res);
      const { body, value } = await readJson(res);
      if (value?.success === false) throw new HindsightError('HINDSIGHT_RETAIN_FAILED', 'failed', res.status, fingerprint(body));
      return { ok: true };
    },
    async getDocument(bank, documentId) {
      const res = await call('GET', `${bankPath(bank)}/documents/${encodeURIComponent(documentId)}`);
      if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
      if (!res.ok) throw await statusError(res);
      return (await readJson(res)).value;
    },
  };
}
