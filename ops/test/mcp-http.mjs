// Minimal Streamable-HTTP MCP client for tests (initialize → initialized → calls). JSON or SSE replies.
export async function mcpSession(url, token, { protocolVersion = '2025-06-18' } = {}) {
  let sessionId = null;
  let id = 0;
  async function post(msg) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg) });
    sessionId = r.headers.get('mcp-session-id') ?? sessionId;
    const text = await r.text();
    if (!text) return { status: r.status, body: null };
    let body;
    if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5).trim()));
      body = datas.find((d) => d.id === msg.id) ?? datas.at(-1);
    } else {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: r.status, body };
  }
  const init = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'l02-test', version: '1' } } });
  if (init.status === 200) await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    init,
    get sessionId() { return sessionId; },
    call: (name, args) => post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    list: () => post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} }),
    raw: post,
  };
}

/** Text of a tools/call result (FastMCP puts JSON in content[0].text). */
export function resultText(r) {
  return r.body?.result?.content?.map((c) => c.text ?? '').join('') ?? '';
}
