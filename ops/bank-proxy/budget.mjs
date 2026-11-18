// budget.mjs — L-02 global daily LLM budget (SDS D-4 / MOD-01).
//
// One ledger for every paid LLM call (Hindsight extraction / consolidation / verification, and the
// L-03 assistant if it routes through the same gateway). Cap 0.50 USD = 500,000 micro-USD per
// Asia/Taipei day. A call must reserve its worst-case cost BEFORE it is sent; afterwards it settles
// at the actual cost from `usage` (or is released when the provider did not bill it).
//
// Persistence: one JSON file, rewritten atomically (tmp + fsync + rename) on every change, from a
// single process (the gateway). Reservations that were never settled (crash) are charged in full on
// the next start, so a crash can only over-count, never under-count.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CAP_MICROS = 500_000; // 0.50 USD
const TAIPEI_OFFSET_MS = 8 * 3600_000; // UTC+8, no DST

export function taipeiDay(ms) {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * µUSD per million tokens. Haiku 5.5 (claude-api skill model table, cached 2026-11-03): $0.10 / $0.50
 * per MTok for prompts ≤100K tokens, $0.50 / $2.50 beyond. Cache pricing is not in that table, so it is
 * priced conservatively: cache writes at 2x input (the 1-hour write rate), cache reads at 1x input.
 * A model missing here is refused: unknown cost is never sent (SDS: 費用未知不重試).
 */
export const PRICES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({
    input: 100_000, output: 500_000, longInput: 500_000, longOutput: 2_500_000, longThreshold: 100_000,
    cacheWriteMult: 2, cacheReadMult: 1,
  }),
});

const ceilDiv = (a, b) => Math.ceil(a / b);

function rates(p, promptTokens) {
  const long = promptTokens > p.longThreshold;
  return { inp: long ? p.longInput : p.input, out: long ? p.longOutput : p.output };
}

/** Actual cost of one response from its `usage` block. */
export function costMicros(p, usage) {
  const inp = usage.input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const r = rates(p, inp + cw + cr);
  return ceilDiv(inp * r.inp + cw * r.inp * p.cacheWriteMult + cr * r.inp * p.cacheReadMult + out * r.out, 1_000_000);
}

/**
 * Worst case before sending: input tokens ≤ request body bytes (a token is at least one UTF-8 byte),
 * all of it possibly a cache write when the request uses cache_control, and output ≤ max_tokens
 * (thinking counts inside max_tokens).
 */
export function maxCostMicros(p, { bodyBytes, maxTokens, cacheControl = false }) {
  const r = rates(p, bodyBytes);
  const inMult = cacheControl ? Math.max(1, p.cacheWriteMult) : 1;
  return ceilDiv(bodyBytes * r.inp * inMult + maxTokens * r.out, 1_000_000);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;
const invalidLedger = () => Object.assign(new Error('Invalid budget ledger; reconcile the file before restarting'), { code: 'INVALID_LEDGER' });

function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * @param {object} o
 * @param {string} o.file            ledger JSON path (0600, on the private state volume)
 * @param {number} [o.capMicros]
 * @param {{now:()=>number}} o.clock
 */
export function createLedger({ file, capMicros = DEFAULT_CAP_MICROS, clock }) {
  let state = load();

  function load() {
    let s;
    try {
      s = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) throw invalidLedger();
      if (e.code !== 'ENOENT') throw e;
      return { v: 1, days: {}, open: {} };
    }
    if (s?.v !== 1 || !isRecord(s.days) || !isRecord(s.open)) throw invalidLedger();
    for (const [day, spent] of Object.entries(s.days)) {
      if (!isDay(day) || !isRecord(spent) || !isCounter(spent.spentMicros)) throw invalidLedger();
    }
    // Crash recovery: anything still reserved was possibly billed. Charge it.
    for (const r of Object.values(s.open)) {
      if (!isRecord(r) || !isDay(r.day) || !isCounter(r.micros)) throw invalidLedger();
      const d = (s.days[r.day] ??= { spentMicros: 0 });
      d.spentMicros += r.micros;
      if (!isCounter(d.spentMicros)) throw invalidLedger();
    }
    s.open = {};
    persist(s);
    return s;
  }

  function persist(s = state) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(s));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  const reservedOn = (day) => Object.values(state.open).filter((r) => r.day === day).reduce((a, r) => a + r.micros, 0);

  function dayTotals(day) {
    return { spentMicros: state.days[day]?.spentMicros ?? 0, reservedMicros: reservedOn(day) };
  }

  /** Atomic check-and-reserve (single-threaded process; persisted before returning). */
  function reserve({ requestId, role, maxMicros }) {
    const day = taipeiDay(clock.now());
    const t = dayTotals(day);
    if (!Number.isInteger(maxMicros) || maxMicros < 0) return { ok: false, code: 'BAD_RESERVATION' };
    if (t.spentMicros + t.reservedMicros + maxMicros > capMicros) {
      return { ok: false, code: 'BUDGET_EXHAUSTED', day, ...t, capMicros };
    }
    state.open[requestId] = { day, role, micros: maxMicros, at: clock.now() };
    persist();
    return { ok: true, day };
  }

  function settle(requestId, actualMicros) {
    const r = state.open[requestId];
    if (!r) return;
    delete state.open[requestId];
    const d = (state.days[r.day] ??= { spentMicros: 0 });
    d.spentMicros += actualMicros;
    persist();
  }

  function release(requestId) {
    if (!state.open[requestId]) return;
    delete state.open[requestId];
    persist();
  }

  function status() {
    const day = taipeiDay(clock.now());
    return { day, capMicros, ...dayTotals(day) };
  }

  return { reserve, settle, release, status, dayTotals };
}
