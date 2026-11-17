// budget.mjs — /status daily cost cap (SR-AST-04, AC-08.5, GAP-18: Haiku 5.5, 0.50 USD/day shared).
//
// Before every LLM call we reserve the worst case (input estimate + max_tokens of output) in one
// atomic DB statement; if spent + reserved + estimate would pass the cap, the call is refused
// BEFORE any money is spent ("超過先拒絕"). After the call the reservation is replaced by the
// actual usage. Day boundary is Asia/Taipei 00:00.

// Claude Haiku 5.5 list price (claude-api skill table, cached 2026-11-03): USD per 1M tokens,
// prompts ≤100K tokens; above that 0.50 / 2.50. Re-check before changing the model.
export const PRICES = Object.freeze({
  'claude-haiku-5-5': { inShort: 0.10, outShort: 0.50, inLong: 0.50, outLong: 2.50, longAbove: 100_000 },
});

export function priceOf(model) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price table for ${model}; refusing to run without a cost cap`);
  return p;
}

export function costUsd(model, { inputTokens, outputTokens }) {
  const p = priceOf(model);
  const long = inputTokens > p.longAbove;
  return (inputTokens * (long ? p.inLong : p.inShort) + outputTokens * (long ? p.outLong : p.outShort)) / 1e6;
}

/** Usage → billed tokens. Cache writes cost 1.25x, cache reads 0.1x of input (we do not cache; kept for safety). */
export function usageTokens(u = {}) {
  const input = (u.input_tokens ?? 0) + Math.ceil((u.cache_creation_input_tokens ?? 0) * 1.25) + Math.ceil((u.cache_read_input_tokens ?? 0) * 0.1);
  return { inputTokens: input, outputTokens: u.output_tokens ?? 0 };
}

/** Upper-bound token estimate for a request body: ≤1 token per UTF-8 byte is a safe ceiling. */
export function estimateInputTokens(params) {
  return Buffer.byteLength(JSON.stringify({ s: params.system, m: params.messages, t: params.tools }), 'utf8');
}

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
export const taipeiDay = (ms) => DAY.format(new Date(ms)); // YYYY-MM-DD

export class QuotaExceeded extends Error {
  constructor() {
    super('E-QUOTA');
    this.code = 'E-QUOTA';
  }
}

export function createBudget({ store, clock, capUsd, model, onCapReached = async () => {} }) {
  if (!(capUsd >= 0)) throw new Error('capUsd must be a number ≥ 0');
  priceOf(model);

  /** Runs `call` only if the worst case fits the cap; settles with real usage. */
  async function guarded(groupId, params, call) {
    const day = taipeiDay(clock.nowMs());
    const estimate = costUsd(model, { inputTokens: estimateInputTokens(params), outputTokens: params.max_tokens });
    const ok = await store.reserveBudget({ groupId, day, estimateUsd: estimate, capUsd });
    if (!ok) {
      if (await store.markCapNotified(groupId, day)) await onCapReached({ groupId, day, capUsd });
      throw new QuotaExceeded();
    }
    let actual = estimate; // if the outcome is unknown, keep charging the worst case
    try {
      const res = await call();
      actual = costUsd(model, usageTokens(res.usage));
      return res;
    } catch (e) {
      // A definite API rejection (4xx before generation) is not billed; anything else stays charged.
      if (typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 408) actual = 0;
      throw e;
    } finally {
      await store.settleBudget({ groupId, day, reservedUsd: estimate, actualUsd: actual });
    }
  }

  return { guarded };
}
