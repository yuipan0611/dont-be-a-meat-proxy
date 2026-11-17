// One process owns this ledger. Units are backend invocations, not tokens or USD.
// Reserve before spawning; unknown outcomes and crash reservations remain charged.
import { createLedger } from '../bank-proxy/budget.mjs';

export function createRequestBudget({ file, dailyLimit = 500, clock = { now: Date.now } }) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0) throw new Error('dailyLimit must be an integer >= 0');
  const ledger = createLedger({ file, capMicros: dailyLimit, clock });
  return {
    reserve: (requestId, role) => ledger.reserve({ requestId, role, maxMicros: 1 }).ok,
    charge: (requestId) => ledger.settle(requestId, 1),
    release: ledger.release,
    status() {
      const { day, capMicros, spentMicros, reservedMicros } = ledger.status();
      return { day, unit: 'backend_invocations', dailyLimit: capMicros, usedRequests: spentMicros, reservedRequests: reservedMicros };
    },
  };
}
