// Test doubles for the things mail-client does not own: the clock and the network.

/** Manual clock: time only moves when the test calls advance(). */
export class FakeClock {
  constructor(startMs = 0) {
    this.t = startMs;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const timer = { at: this.t + ms, fn, id: ++this.seq };
    this.timers.push(timer);
    return timer.id;
  }
  clearTimeout(id) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  sleep(ms) {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }
  /** Move time forward, firing due timers in order, letting promises settle between them. */
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = target;
    await flush();
  }
}

export async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Builds an MCP-style tools/call success body. */
export function toolResult(id, value, isError = false) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (isError) result.isError = true;
  return { jsonrpc: '2.0', id, result };
}

/**
 * Fake fetch. `handler(rpc, req)` returns either a JSON-RPC body object
 * or { status, body, headers } for raw HTTP control. Records every request.
 */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, rpc, signal: init.signal });
    const out = await handler(rpc, { url, init, calls });
    if (out instanceof Error) throw out;
    const raw = out && out.status !== undefined ? out : { status: 200, body: out };
    const text = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body ?? '');
    return new Response(text, {
      status: raw.status,
      headers: { 'content-type': 'application/json', ...(raw.headers || {}) },
    });
  };
  fn.calls = calls;
  return fn;
}

/** Default handler pieces for MCP handshake. */
export function handshake(rpc) {
  if (rpc.method === 'initialize') {
    return { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: {} } };
  }
  if (rpc.method === 'notifications/initialized') return { status: 202, body: '' };
  return null;
}

/** A fetch that never answers until its AbortSignal fires (simulates a hung Hub). */
export function hangingFetch() {
  const calls = [];
  const fn = (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ rpc });
    const hs = handshake(rpc);
    if (hs) {
      const raw = hs.status !== undefined ? hs : { status: 200, body: hs };
      return Promise.resolve(new Response(typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body), { status: raw.status }));
    }
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
    });
  };
  fn.calls = calls;
  return fn;
}
