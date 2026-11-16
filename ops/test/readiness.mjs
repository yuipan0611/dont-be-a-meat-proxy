import { setTimeout as sleep } from 'node:timers/promises';

// Only health GETs are retried; the acceptance requests themselves still run once.
export async function waitForHealth(url, { step, headers = {}, timeoutMs = 30_000, intervalMs = 250 }) {
  const deadline = performance.now() + timeoutMs;
  let last = 'not probed';
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      const response = await fetch(url, {
        headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(remaining, 2000)),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
      last = 'HTTP ' + response.status;
    } catch (error) {
      last = error.cause?.code || error.name;
    }
    const pause = Math.min(intervalMs, deadline - performance.now());
    if (pause > 0) await sleep(pause);
  }
  // Do not include response bodies, URLs or authorization headers in diagnostics.
  throw new Error('[' + step + '] health did not reach HTTP 200 within ' + timeoutMs + ' ms; last=' + last);
}
