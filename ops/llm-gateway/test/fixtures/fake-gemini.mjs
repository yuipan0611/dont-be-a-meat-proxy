#!/usr/bin/env node
// No network, accounts or provider SDK. Implements only Gemini CLI's stdout envelope for tests.
import { readFileSync, appendFileSync } from 'node:fs';
const raw = readFileSync(0, 'utf8');
const agy = process.argv.includes('--input-format');
const prompt = agy ? JSON.parse(raw.trim()).message.content : raw;
const data = JSON.parse(prompt.trim().split('\n').at(-1));
let fixture = {};
try { fixture = JSON.parse(data.messages[0].content).fake ?? {}; } catch {}
if (fixture.record) appendFileSync(fixture.record, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd(), prompt }) + '\n');
if (fixture.delay) await new Promise((r) => setTimeout(r, fixture.delay));
if (fixture.stderr) process.stderr.write(fixture.stderr);
if (fixture.mode === 'fail') process.exit(1);
if (fixture.mode === 'bad-json') { process.stdout.write('not-json'); process.exit(0); }
if (fixture.mode === 'overflow') { process.stdout.write('x'.repeat(20000)); process.exit(0); }
if (fixture.mode === 'empty') { process.stdout.write('{"response":""}'); process.exit(0); }
if (fixture.mode === 'error') { process.stdout.write(JSON.stringify({ error: { message: fixture.error } })); process.exit(0); }
let response = fixture.response ?? '已確認：繁體中文測試。';
if (fixture.response === undefined && data.tools.length && data.tool_choice !== 'none') {
  const second = data.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  response = JSON.stringify(second ? { text: '交接已完成（#1）', tool_calls: [] }
    : { text: '', tool_calls: [{ name: data.tools[0].name, arguments: { limit: 5 } }] });
}
if (agy) {
  if (fixture.mode === 'tool-run') process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response, usage: { input_tokens: 8, output_tokens: 9 } } }) + '\n');
} else process.stdout.write(JSON.stringify({ response, stats: { models: { 'gemini-2.5-flash': { api: { totalRequests: 1 }, tokens: { prompt: 8, candidates: 9 } } } } }));
