import { GatewayError } from './queue.mjs';

/** Official Gemini Developer REST API; free and paid projects use the same API contract. */
export function createGeminiApi({ key, timeoutMs = 90_000, fetchImpl = fetch, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' }) {
  if (!key) throw new Error('Gemini API key required');
  return {
    async generate({ prompt, model, maxTokens, signal }) {
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }), signal: combined,
        });
      } catch {
        throw new GatewayError(signal?.aborted ? 'CANCELLED' : combined.aborted ? 'API_TIMEOUT' : 'API_UNREACHABLE', signal?.aborted ? 499 : combined.aborted ? 504 : 502);
      }
      if (!response.ok) {
        // Neither response bodies nor credentials appear in errors/logs.
        if (response.status === 429) throw new GatewayError('UPSTREAM_QUOTA', 429);
        if ([401, 403].includes(response.status)) throw new GatewayError('AUTH_REQUIRED', 503);
        if (response.status === 400) {
          let error;
          try { error = (await response.json()).error; } catch {}
          if (error?.details?.some((d) => d.reason === 'API_KEY_INVALID') || /API key not valid/i.test(error?.message ?? '')) throw new GatewayError('AUTH_REQUIRED', 503);
        }
        throw new GatewayError('API_FAILED', 502);
      }
      let data;
      try { data = await response.json(); } catch { throw new GatewayError('INVALID_API_JSON', 502); }
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') throw new GatewayError('OUTPUT_TRUNCATED', 502);
      if (candidate?.finishReason !== 'STOP') throw new GatewayError('API_NO_ANSWER', 502);
      const text = candidate.content?.parts?.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      if (!text?.trim()) throw new GatewayError('EMPTY_RESPONSE', 502);
      const usage = data.usageMetadata ?? {};
      return { text, stats: { models: { [model]: { tokens: { prompt: usage.promptTokenCount, candidates: usage.candidatesTokenCount } } } } };
    },
  };
}
