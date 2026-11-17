// hindsight-client.mjs — L-02b: the bridge's operator-side REST client for Hindsight (memory-net only).
// Errors carry .kind so the bridge can decide pending / unknown / error:
//   unreachable — connection refused / DNS: the request was not delivered
//   unknown     — timeout or connection dropped after sending: it may or may not have been stored
//   failed      — 5xx, or 200 with success:false (includes the LLM gateway's daily-cap refusal)
//   rejected    — 4xx (.status); 429 is treated as retryable by the bridge

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function classify(err) {
  const code = err?.cause?.code ?? err?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return Object.assign(new Error(`Hindsight timeout: ${err.message}`), { kind: 'unknown' });
  if (NOT_SENT.has(code)) return Object.assign(new Error(`Hindsight unreachable (${code})`), { kind: 'unreachable' });
  return Object.assign(new Error(`Hindsight connection error (${code ?? err?.message})`), { kind: 'unknown' });
}

async function statusError(res) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 400); } catch {}
  const kind = res.status >= 500 ? 'failed' : 'rejected';
  return Object.assign(new Error(`Hindsight HTTP ${res.status}: ${detail}`), { kind, status: res.status });
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
      let j;
      try { j = await res.json(); } catch (e) { throw classify(e); }
      if (j && j.success === false) throw Object.assign(new Error(`Hindsight retain success:false ${JSON.stringify(j).slice(0, 300)}`), { kind: 'failed' });
      return { ok: true };
    },
    async getDocument(bank, documentId) {
      const res = await call('GET', `${bankPath(bank)}/documents/${encodeURIComponent(documentId)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await statusError(res);
      return res.json();
    },
  };
}
