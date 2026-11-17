import { GatewayError } from './queue.mjs';

const bad = () => { throw new GatewayError('INVALID_REQUEST', 400, 'only text and function tool messages are supported'); };
const text = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type !== 'text' || typeof b.text !== 'string')) bad();
  return content.map((b) => b.text).join('\n');
};

/** Preserve actual roles and tool IDs for native chat APIs; never execute a tool here. */
export function chatMessages(body, protocol) {
  const messages = [{ role: 'system', content: 'Reply in Traditional Chinese (zh-TW) unless another language is explicitly requested.' }];
  if (body.system !== undefined) messages.push({ role: 'system', content: text(body.system) });
  for (const m of body.messages) {
    if (protocol === 'openai') {
      const message = { role: m.role, content: m.content == null && m.role === 'assistant' ? null : text(m.content) };
      if (m.tool_call_id !== undefined) message.tool_call_id = m.tool_call_id;
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.some((t) => t?.type !== 'function' || typeof t.id !== 'string' || typeof t.function?.name !== 'string' || typeof t.function.arguments !== 'string')) bad();
        message.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } }));
      }
      messages.push(message);
    } else if (typeof m.content === 'string') messages.push({ role: m.role, content: m.content });
    else {
      if (!Array.isArray(m.content)) bad();
      const words = [], calls = [], results = [];
      for (const b of m.content) {
        if (b?.type === 'text' && typeof b.text === 'string') words.push(b.text);
        else if (b?.type === 'tool_use' && m.role === 'assistant' && typeof b.id === 'string' && typeof b.name === 'string') {
          calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        } else if (b?.type === 'tool_result' && m.role === 'user' && typeof b.tool_use_id === 'string') {
          results.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? 'Tool error: ' + text(b.content) : text(b.content) });
        } else bad();
      }
      messages.push(...results);
      if (words.length || calls.length) messages.push({ role: m.role, content: words.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return messages;
}
