import { randomUUID } from 'node:crypto';
import { createQueue, GatewayError } from './queue.mjs';
import { prepare } from './protocol.mjs';
import { sendSse } from './sse.mjs';

export function createGateway({ budget, gemini, clientKeys, models = ['gemini-2.5-flash'], queue = createQueue(), log = () => {} }) {
  const keys = new Map(Object.entries(clientKeys));
  if (!keys.size || [...keys.keys()].some((k) => !k)) throw new Error('client keys required');
  let backendState = 'unverified';
  const json = (res, status, data, extra = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(data));
  };
  const fail = (res, e) => json(res, e.status ?? 500, { type: 'error', error: {
    type: e.status === 429 ? 'rate_limit_error' : e.status === 401 ? 'authentication_error' : e.status === 400 ? 'invalid_request_error' : 'api_error',
    code: e.code ?? 'INTERNAL_ERROR', message: e instanceof GatewayError ? e.message : 'gateway unavailable',
  } }, { 'x-should-retry': 'false' });
  const status = () => ({ backend: backendState, budget: budget.status(), queue: queue.status() });

  const handle = async (req, res) => {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/readyz') return json(res, backendState === 'ready' ? 200 : 503, { backend: backendState });
    const role = keys.get(req.headers['x-api-key'] ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!role) return fail(res, new GatewayError('INVALID_KEY', 401));
    if (req.method === 'GET' && path === '/status') return json(res, 200, status());
    const protocol = path === '/v1/messages' ? 'anthropic' : path === '/v1/chat/completions' ? 'openai' : null;
    if (req.method !== 'POST' || !protocol) return fail(res, new GatewayError('NOT_FOUND', 404));
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new GatewayError('BODY_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GatewayError('INVALID_JSON', 400); }
      const request = prepare(body, protocol, models);
      const id = randomUUID();
      const reply = await queue.run(async () => {
        if (controller.signal.aborted) throw new GatewayError('CANCELLED', 499);
        if (!budget.reserve(id, role)) throw new GatewayError('DAILY_LIMIT', 429, '今日 LLM 請求數額度已用完，台北時間 00:00 恢復');
        const started = Date.now();
        try {
          const result = await gemini.generate({ ...request, signal: controller.signal });
          backendState = 'ready';
          return request.finish(result);
        } catch (e) {
          if (e.code === 'AUTH_REQUIRED') backendState = 'auth_required';
          else if (e.code === 'UPSTREAM_QUOTA') backendState = 'quota';
          else backendState = 'error';
          // ENOENT is the only proven pre-execution failure. Everything else may have used quota.
          if (['CLI_UNAVAILABLE', 'BACKEND_UNCONFIGURED', 'UNSAFE_CLI_PROFILE'].includes(e.code)) budget.release(id);
          throw e;
        } finally {
          budget.charge(id);
          log({ ev: 'llm_call', role, model: request.model, backend: backendState, durationMs: Date.now() - started, ...budget.status() });
        }
      }, controller.signal);
      if (body.stream) sendSse(res, reply, protocol, body.stream_options?.include_usage === true);
      else json(res, 200, reply);
    } catch (e) {
      log({ ev: 'llm_refused', role, code: e.code ?? 'INTERNAL_ERROR' });
      fail(res, e);
    }
  };
  return { handle, status };
}
