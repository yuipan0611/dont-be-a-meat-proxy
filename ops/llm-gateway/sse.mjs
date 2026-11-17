// Buffered protocol compatibility: generation completes before events are emitted.
// This does not claim per-token latency or use the CLI's native streaming/tool loop.
export function sendSse(res, reply, protocol, includeUsage = false) {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events = [];
  const anthropic = (data) => events.push(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const openai = (data) => events.push(`data: ${JSON.stringify(data)}\n\n`);
  if (protocol === 'anthropic') {
    anthropic({ type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: { ...reply.usage, output_tokens: 0 } } });
    reply.content.forEach((block, index) => {
      anthropic({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      anthropic({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      anthropic({ type: 'content_block_stop', index });
    });
    anthropic({ type: 'message_delta', delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: reply.usage.output_tokens } });
    anthropic({ type: 'message_stop' });
  } else {
    const base = { id: reply.id, object: 'chat.completion.chunk', created: reply.created, model: reply.model };
    const chunk = (delta, finish_reason = null) => openai({ ...base, choices: [{ index: 0, delta, finish_reason }] });
    chunk({ role: 'assistant', content: '' });
    const choice = reply.choices[0];
    if (choice.message.content) chunk({ content: choice.message.content });
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) chunk({ tool_calls: [{ index, ...call }] });
    chunk({}, choice.finish_reason);
    if (includeUsage) openai({ ...base, choices: [], usage: reply.usage });
    events.push('data: [DONE]\n\n');
  }
  res.end(events.join(''));
}
