// TC-17 (AC-08.1～08.7, SR-AST-01～05) with an LLM double. No real Anthropic call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistant, createReadOnlyTools, createToolRegistry, NO_INFO, QUOTA_TEXT, MODEL } from '../src/assistant.mjs';
import { createBudget, costUsd, taipeiDay, PRICES } from '../src/budget.mjs';
import { createRouter, EPHEMERAL, NOT_MEMBER } from '../src/router.mjs';
import { createMemoryStore } from './helpers/store-memory.mjs';
import { createFakeLlm, createFakeMail, FakeClock, seed, itemBody, llmText, llmTool, fakeInteraction, STRANGER, 維護者 } from './helpers/fakes.mjs';

const CAP = 0.5;

function rig({ script = [], cap = CAP } = {}) {
  const clock = new FakeClock('2026-11-20T02:00:00.000Z');
  const store = createMemoryStore(seed());
  const mail = createFakeMail();
  const id1 = mail.deliver({ from: 'BlueLake', to: ['RedStone'], subject: 'L-03 交接', body: itemBody({ summary: 'bot 通知完成，待 token' }), createdTs: '2026-11-20T01:00:00.000000Z' });
  const id2 = mail.deliver({ from: 'RedStone', to: ['BlueLake'], subject: '決策：用 Haiku', body: itemBody({ kind: 'decision', summary: '查進度用 Haiku 5.5', clientEventId: 'e2' }), createdTs: '2026-11-20T01:30:00.000000Z' });
  for (const [id, agent] of [[id1, 'RedStone'], [id2, 'BlueLake']]) {
    const m = mail.messages.get(id);
    store.db.notifs.push({ id: id, group_id: 'group-a', member_id: 維護者, mail_id: id, recipient_agent: agent, label: id === id2 ? '決策／問答' : '交接', sender: m.from, subject: m.subject, summary: JSON.parse(m.body_md).summary, mail_created_at: m.created_ts, state: 'sent', attempts: 1 });
  }
  const llm = createFakeLlm(script);
  const notified = [];
  const budget = createBudget({ store, clock, capUsd: cap, model: MODEL, onCapReached: async (x) => notified.push(x) });
  const assistant = createAssistant({ llm, tools: createReadOnlyTools({ store, mail }), budget });
  const router = createRouter({ store, connect: {}, assistant });
  return { clock, store, mail, llm, budget, assistant, router, notified, id1, id2 };
}

test('TC-17: answer cites the latest handoff ID and time; reply is ephemeral', async () => {
  const r = rig({ script: [llmTool('recent_items', { limit: 5 }), (p) => llmText(`- L-03 bot 通知完成，待 token（#1）\n- 決策（草稿）：查進度用 Haiku（#2）`)] });
  const ix = fakeInteraction('status', { question: '現在做到哪' });
  await r.router.handle(ix);
  assert.deepEqual(ix.log[0], { type: 'defer', flags: EPHEMERAL });
  const edit = ix.log.find((x) => x.type === 'edit');
  assert.match(edit.content, /#1（2026-11-20 09:00（台北））/);
  assert.match(edit.content, /草稿/);
  assert.ok(!ix.log.some((x) => x.type === 'followUp'), 'not public unless chosen');
  // Request shape: Haiku 5.5, only read-only tools, low effort.
  assert.equal(r.llm.calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(r.llm.calls[0].tools.map((t) => t.name).sort(), ['get_item', 'recent_items']);
  assert.equal(r.llm.calls[0].output_config.effort, 'low');
});

test('TC-17: recent_items marks decisions as drafts (AC-08.3)', async () => {
  const r = rig();
  const [recent] = createReadOnlyTools({ store: r.store, mail: r.mail });
  const out = await recent.run({ limit: 5 }, { groupId: 'group-a' });
  assert.equal(out.find((x) => x.mail_id === 2).decision_status, '草稿');
  assert.equal(out[0].mail_id, 2, 'newest first');
});

test('AC-08.2: an answer that cites nothing the tools returned becomes 記憶中沒有這項資訊', async () => {
  const uncited = rig({ script: [llmText('應該快做完了')] });
  assert.equal((await uncited.assistant.answer({ groupId: 'group-a', question: 'x' })).text, NO_INFO);
  const invented = rig({ script: [llmTool('recent_items', {}), llmText('完成了（#1）、還有（#999）')] });
  assert.equal((await invented.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'no_info');
  const honest = rig({ script: [llmText(NO_INFO)] });
  assert.equal((await honest.assistant.answer({ groupId: 'group-a', question: '火星基地進度' })).text, NO_INFO);
});

test('get_item reads the original but only for this group; unknown tool → error result, not a crash', async () => {
  const r = rig({ script: [llmTool('get_item', { mail_id: 1 }), llmTool('delete_everything', {}, 'tu_2'), llmText('原文寫 bot 通知完成（#1）')] });
  const a = await r.assistant.answer({ groupId: 'group-a', question: 'x' });
  assert.equal(a.kind, 'answer');
  const second = r.llm.calls[2].messages.at(-1).content[0];
  assert.equal(second.is_error, true);
  const [, getItem] = createReadOnlyTools({ store: r.store, mail: r.mail });
  assert.deepEqual(await getItem.run({ mail_id: 1 }, { groupId: 'group-b' }), { error: 'not found in this group' });
});

test('SR-AST-01: a tool that is not read-only cannot be mounted', () => {
  assert.throws(() => createToolRegistry([{ name: 'create_issue', run() {} }]), /readOnly/);
  assert.throws(() => createToolRegistry([{ name: 'x', readOnly: true }, { name: 'x', readOnly: true }]), /duplicate/);
});

test('TC-17 / AC-08.5: cap 0 → 今日額度已用完, the LLM is never called, owner notified once', async () => {
  const r = rig({ cap: 0, script: [llmText('x')] });
  const ix = fakeInteraction('status', { question: '現在做到哪' });
  await r.router.handle(ix);
  assert.equal(ix.log.find((x) => x.type === 'edit').content, QUOTA_TEXT);
  assert.equal(r.llm.calls.length, 0);
  await r.router.handle(fakeInteraction('status', { question: 'again' }));
  assert.equal(r.notified.length, 1);
  assert.equal((await r.store.budgetRow('group-a', '2026-11-20')).rejected, 2);
});

test('budget: reserve worst case before the call, settle to actual usage after', async () => {
  const r = rig({ script: [llmText(NO_INFO, { input_tokens: 1000, output_tokens: 100 })] });
  await r.assistant.answer({ groupId: 'group-a', question: 'x' });
  const b = await r.store.budgetRow('group-a', '2026-11-20');
  assert.equal(b.reserved, 0);
  assert.ok(Math.abs(b.spent - costUsd(MODEL, { inputTokens: 1000, outputTokens: 100 })) < 1e-12);
  assert.ok(Math.abs(b.spent - 0.00015) < 1e-12); // 1000×0.10/1M + 100×0.50/1M
});

test('budget: when the remaining cap cannot cover a worst-case call, refuse before calling', async () => {
  const r = rig({ cap: 0.0004, script: [llmTool('recent_items', {}), llmText('x（#1）')] });
  // One worst-case step (≈ few KB input + 1024 output) fits once at most; the second step is refused.
  const a = await r.assistant.answer({ groupId: 'group-a', question: 'x' });
  assert.ok(r.llm.calls.length <= 1);
  assert.equal(a.kind, 'quota');
  const b = await r.store.budgetRow('group-a', '2026-11-20');
  assert.ok(b.spent <= 0.0004);
});

test('budget: day boundary is Asia/Taipei 00:00 and a new day starts fresh', async () => {
  assert.equal(taipeiDay(Date.parse('2026-11-20T15:59:59Z')), '2026-11-20');
  assert.equal(taipeiDay(Date.parse('2026-11-20T16:00:00Z')), '2026-11-21');
  const r = rig({ cap: 0.001, script: [llmText(NO_INFO, { input_tokens: 9000, output_tokens: 0 }), llmText(NO_INFO)] });
  r.store.db.budget.set('group-a|2026-11-20', { spent: 0.001, reserved: 0, calls: 5, rejected: 0, cap_notified: false });
  assert.equal((await r.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'quota');
  r.clock.advance(14 * 3600_000); // 2026-11-20T16:00Z = 11-21 00:00 Taipei
  assert.equal((await r.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'no_info');
});

test('budget: a 4xx before generation is not charged; a 5xx/timeout keeps the worst case charged', async () => {
  const fail = (status) => () => { throw Object.assign(new Error('api'), { status }); };
  const r1 = rig({ script: [fail(400)] });
  assert.equal((await r1.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'error');
  assert.equal((await r1.store.budgetRow('group-a', '2026-11-20')).spent, 0);
  const r2 = rig({ script: [fail(529)] });
  await r2.assistant.answer({ groupId: 'group-a', question: 'x' });
  assert.ok((await r2.store.budgetRow('group-a', '2026-11-20')).spent > 0);
  assert.throws(() => createBudget({ store: r2.store, clock: r2.clock, capUsd: 1, model: 'claude-unknown' }), /no price table/);
  assert.ok(PRICES['claude-haiku-5-5']);
});

test('AC-08.6 / FR-22: a non-member gets one fixed refusal, no LLM call, no content', async () => {
  const r = rig({ script: [llmText('secret (#1)')] });
  const ix = fakeInteraction('status', { question: '現在做到哪' }, { userId: STRANGER });
  await r.router.handle(ix);
  assert.equal(ix.log[0].flags, EPHEMERAL);
  assert.equal(ix.log.find((x) => x.type === 'edit').content, NOT_MEMBER);
  assert.equal(r.llm.calls.length, 0);
  const dm = fakeInteraction('status', { question: 'x' }, { guildId: null });
  await r.router.handle(dm);
  assert.equal(dm.log.find((x) => x.type === 'edit').content, NOT_MEMBER);
});

test('AC-08.7: public only when the asker explicitly chooses it', async () => {
  const r = rig({ script: [llmTool('recent_items', {}), llmText('完成（#1）')] });
  const ix = fakeInteraction('status', { question: 'x', public: true });
  await r.router.handle(ix);
  const pub = ix.log.find((x) => x.type === 'followUp');
  assert.match(pub.content, /#1/);
  assert.deepEqual(pub.allowedMentions, { parse: [] });
});

test('refusal and step limit give a plain error, never a fabricated answer', async () => {
  const r = rig({ script: [{ stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } }] });
  assert.equal((await r.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'error');
  const loop = rig({ script: Array.from({ length: 6 }, (_, i) => llmTool('recent_items', {}, `tu_${i}`)) });
  assert.equal((await loop.assistant.answer({ groupId: 'group-a', question: 'x' })).kind, 'error');
  assert.equal(loop.llm.calls.length, 5);
});
