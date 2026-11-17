// L-02 daily budget ledger (SDS D-4: one global 500,000 micro-USD/day, Asia/Taipei day).
// Run: node --test ops/bank-proxy/test/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, taipeiDay, PRICES, costMicros, maxCostMicros } from '../budget.mjs';

const T = Date.parse('2026-11-20T03:00:00Z'); // 11:00 Taipei
function ledger(clockMs = T, capMicros = 500_000) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const clock = { now: () => clockMs, set(v) { clockMs = v; } };
  const l = createLedger({ file: join(dir, 'ledger.json'), capMicros, clock });
  return { l, clock, dir, file: join(dir, 'ledger.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Taipei day boundary: 15:59:59Z is still the same day, 16:00Z is the next', () => {
  assert.equal(taipeiDay(Date.parse('2026-11-20T15:59:59Z')), '2026-11-20');
  assert.equal(taipeiDay(Date.parse('2026-11-20T16:00:00Z')), '2026-11-21');
});

test('Haiku 5.5 price: $0.10/$0.50 per MTok ≤100K prompt, $0.50/$2.50 beyond; rounding is up', () => {
  const p = PRICES['claude-haiku-5-5'];
  assert.equal(costMicros(p, { input_tokens: 100_000, output_tokens: 0 }), 10_000); // exactly 100K is still the short tier
  assert.equal(costMicros(p, { input_tokens: 0, output_tokens: 1_000_000 }), 500_000);
  assert.equal(costMicros(p, { input_tokens: 1, output_tokens: 0 }), 1); // 0.1 µ$ → 1 µ$
  assert.equal(costMicros(p, { input_tokens: 100_001, output_tokens: 0 }), 50_001); // long tier
  // cache tokens are priced conservatively (write 2x input, read 1x input) and count toward the prompt size
  assert.equal(costMicros(p, { input_tokens: 0, cache_creation_input_tokens: 10, cache_read_input_tokens: 10, output_tokens: 0 }), 3);
});

test('max cost for a reservation: body bytes bound input tokens, max_tokens bounds output', () => {
  const p = PRICES['claude-haiku-5-5'];
  assert.equal(maxCostMicros(p, { bodyBytes: 2000, maxTokens: 1000 }), 200 + 500);
  assert.equal(maxCostMicros(p, { bodyBytes: 200_000, maxTokens: 10 }), 100_000 + 25); // long tier
});

test('reserve refuses when spent + reserved + max would exceed the cap; settle charges the actual cost', async (t) => {
  const { l, done } = ledger(T, 1000);
  t.after(done);
  const a = l.reserve({ requestId: 'a', role: 'retain', maxMicros: 600 });
  assert.equal(a.ok, true);
  const b = l.reserve({ requestId: 'b', role: 'assistant', maxMicros: 401 });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'BUDGET_EXHAUSTED');
  l.settle('a', 100);
  assert.equal(l.reserve({ requestId: 'b', role: 'assistant', maxMicros: 900 }).ok, true);
  assert.deepEqual(l.status(), { day: '2026-11-20', capMicros: 1000, spentMicros: 100, reservedMicros: 900 });
});

test('release returns the reservation; settle/release of an unknown id is a no-op', async (t) => {
  const { l, done } = ledger(T, 1000);
  t.after(done);
  l.reserve({ requestId: 'a', role: 'retain', maxMicros: 1000 });
  l.release('a');
  l.release('zzz');
  l.settle('zzz', 5);
  assert.equal(l.status().reservedMicros, 0);
  assert.equal(l.status().spentMicros, 0);
});

test('a new Taipei day starts from zero; a reservation settles against the day it was made', async (t) => {
  const { l, clock, done } = ledger(Date.parse('2026-11-20T15:59:00Z'), 1000);
  t.after(done);
  l.reserve({ requestId: 'late', role: 'retain', maxMicros: 900 });
  clock.set(Date.parse('2026-11-20T16:00:01Z'));
  assert.equal(l.reserve({ requestId: 'new', role: 'assistant', maxMicros: 1000 }).ok, true);
  l.settle('late', 800);
  assert.deepEqual(l.status(), { day: '2026-11-21', capMicros: 1000, spentMicros: 0, reservedMicros: 1000 });
  assert.equal(l.dayTotals('2026-11-20').spentMicros, 800);
});

test('crash safety: reopening the file charges unsettled reservations in full (never under-counts)', async (t) => {
  const { l, file, clock, done } = ledger(T, 1000);
  t.after(done);
  l.reserve({ requestId: 'x', role: 'retain', maxMicros: 700 });
  const reopened = createLedger({ file, capMicros: 1000, clock });
  assert.deepEqual(reopened.status(), { day: '2026-11-20', capMicros: 1000, spentMicros: 700, reservedMicros: 0 });
  assert.equal(reopened.reserve({ requestId: 'y', role: 'retain', maxMicros: 301 }).ok, false);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).days['2026-11-20']);
});
