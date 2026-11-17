export class GatewayError extends Error {
  constructor(code, status, message = code) { super(message); this.code = code; this.status = status; }
}

// Serial execution also prevents concurrent CLI writes/refreshes in the same OAuth profile.
export function createQueue({ maxQueued = 20, waitMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0 || !Number.isFinite(waitMs) || waitMs < 1) throw new Error('invalid queue settings');
  const pending = [];
  let active = false;
  function next() {
    if (active || !pending.length) return;
    const item = pending.shift();
    active = true;
    item.cleanup();
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { active = false; next(); });
  }
  return {
    run(work, signal) {
      if (signal?.aborted) return Promise.reject(new GatewayError('CANCELLED', 499));
      if (active && pending.length >= maxQueued) return Promise.reject(new GatewayError('QUEUE_FULL', 503));
      return new Promise((resolve, reject) => {
        let timer;
        const remove = (code, status) => {
          const i = pending.indexOf(item);
          if (i < 0) return;
          pending.splice(i, 1); item.cleanup(); reject(new GatewayError(code, status));
        };
        const abort = () => remove('CANCELLED', 499);
        const item = { work, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
        pending.push(item);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => remove('QUEUE_TIMEOUT', 503), waitMs);
        next();
      });
    },
    status: () => ({ active: Number(active), queued: pending.length }),
  };
}
