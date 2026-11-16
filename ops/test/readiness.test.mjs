import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { waitForHealth } from './readiness.mjs';

test('waits through a dropped connection and non-200 health before proceeding', async (t) => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    if (calls === 1) return request.socket.destroy();
    response.writeHead(calls === 2 ? 503 : 200);
    response.end('synthetic health');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await waitForHealth('http://127.0.0.1:' + server.address().port + '/health/liveness', {
    step: 'TC-05 after Mail restart', timeoutMs: 1000, intervalMs: 5,
  });
  assert.equal(calls, 3, 'later acceptance steps must wait for an actual HTTP 200');
});

test('unready health times out with the step and last outcome, without leaking credentials or body', { timeout: 2000 }, async (t) => {
  const secret = 'synthetic-private-readiness-value';
  const server = createServer((request, response) => {
    response.writeHead(503);
    response.end(secret);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await assert.rejects(waitForHealth('http://127.0.0.1:' + server.address().port, {
    step: 'TC-10 before Windows MCP session', timeoutMs: 80, intervalMs: 5,
    headers: { authorization: 'Bearer ' + secret },
  }), (error) => {
    assert.match(error.message, /TC-10 before Windows MCP session/);
    // The final probe can exhaust its remaining request budget instead of receiving another 503.
    assert.match(error.message, /within 80 ms; last=(HTTP 503|TimeoutError)/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('a stalled health body cannot exceed the readiness deadline or count as ready', { timeout: 2000 }, async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    response.write('incomplete');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await assert.rejects(waitForHealth('http://127.0.0.1:' + server.address().port, {
    step: 'TC-05 after Mail restart', timeoutMs: 80, intervalMs: 5,
  }), /\[TC-05 after Mail restart\] health did not reach HTTP 200 within 80 ms/);
});
