import { GatewayError } from './queue.mjs';

export const GROQ_MODEL = 'openai/gpt-oss-120b';
const MODELS = [GROQ_MODEL, 'openai/gpt-oss-20b'];

/** Native Groq function calling, with the gateway's existing response validation/shims. */
export function createGroqApi({ key, timeoutMs = 90_000, fetchImpl = fetch }) {
  if (!key) throw new Error('Groq API key required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('positive timeoutMs required');
  return {
    async generate({ chat, model = GROQ_MODEL, maxTokens, signal }) {
      if (!MODELS.includes(model)) throw new GatewayError('INVALID_REQUEST', 400, 'unsupported Groq model');
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let response, data;
      try {
        response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...chat, model, stream: false, max_completion_tokens: Math.min(maxTokens, 65_536),
            reasoning_effort: 'low', include_reasoning: false, ...(chat.tools?.length ? { parallel_tool_calls: false } : {}) }),
          signal: combined,
        });
        // Deadline covers the response body too; never include provider bodies in errors or logs.
        if (response.ok) data = await response.json();
      } catch {
        throw new GatewayError(signal?.aborted ? 'CANCELLED' : combined.aborted ? 'API_TIMEOUT' : response?.ok ? 'INVALID_API_JSON' : 'API_UNREACHABLE', signal?.aborted ? 499 : combined.aborted ? 504 : 502);
      }
      if (!response.ok) {
        if (response.status === 429) throw new GatewayError('UPSTREAM_QUOTA', 429);
        if ([401, 403].includes(response.status)) throw new GatewayError('AUTH_REQUIRED', 503);
        throw new GatewayError('API_FAILED', 502);
      }
      const choice = data?.choices?.[0], message = choice?.message;
      if (choice?.finish_reason === 'length') throw new GatewayError('OUTPUT_TRUNCATED', 502);
      if (!['stop', 'tool_calls'].includes(choice?.finish_reason) || !message) throw new GatewayError('API_NO_ANSWER', 502);
      if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw new GatewayError('INVALID_API_JSON', 502);
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > 1) throw new GatewayError('INVALID_TOOL_RESPONSE', 502);
      const envelope = chat.tools?.length > 0 && chat.tool_choice !== 'none';
      if ((!envelope && calls.length) || (choice.finish_reason === 'tool_calls' && !calls.length) || (calls.length && choice.finish_reason !== 'tool_calls')) throw new GatewayError('INVALID_TOOL_RESPONSE', 502);
      let text = message.content ?? '';
      if (envelope) {
        const parsed = calls.map((c) => {
          if (c?.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function.arguments !== 'string') throw new GatewayError('INVALID_TOOL_RESPONSE', 502);
          let args;
          try { args = JSON.parse(c.function.arguments); } catch { throw new GatewayError('INVALID_TOOL_RESPONSE', 502); }
          return { name: c.function.name, arguments: args };
        });
        text = JSON.stringify({ text, tool_calls: parsed });
      } else if (!text.trim()) throw new GatewayError('EMPTY_RESPONSE', 502);
      return { text, stats: { models: { [model]: { tokens: { prompt: data.usage?.prompt_tokens, candidates: data.usage?.completion_tokens } } } } };
    },
  };
}
