// Internal Messages client for bot/EVAL. It cannot reach a provider directly.
export function createGatewayClient({ baseUrl, key, timeoutMs = 125_000, fetchImpl = fetch }) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid gateway URL');
  if (!key) throw new Error('gateway key required');
  return {
    async status() {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/status`, {
        headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('gateway status unavailable');
      return response.json();
    },
    async create(body) {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (!response.ok) {
        const e = new Error('LLM gateway unavailable'); e.status = response.status; e.code = data.error?.code ?? 'GATEWAY_ERROR'; throw e;
      }
      return data;
    },
  };
}
