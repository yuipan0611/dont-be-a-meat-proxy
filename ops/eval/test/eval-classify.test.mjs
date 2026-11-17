// ops/eval/test/eval-classify.test.mjs — Unit tests for EVAL-01 dataset and runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFixtures,
  calculateMetrics,
  parseClassificationResponse,
  buildClassificationPrompt,
  formatReport,
  createFakeProvider,
  runEval,
  DEFAULT_FIXTURES_PATH,
} from '../eval-classify.mjs';

test('dataset: fixtures/eval-classify-v1.jsonl contains 30 valid samples with balanced categories', async () => {
  const fixtures = await loadFixtures(DEFAULT_FIXTURES_PATH);
  assert.equal(fixtures.length, 30, 'must have exactly 30 samples');

  const pureQuestions = fixtures.filter((f) => f.category === 'pure_question');
  const pureActions = fixtures.filter((f) => f.category === 'pure_action');
  const mixedAmbiguous = fixtures.filter((f) => f.category === 'mixed_ambiguous');

  assert.equal(pureQuestions.length, 10, 'must have 10 pure questions');
  assert.equal(pureActions.length, 10, 'must have 10 pure actions');
  assert.equal(mixedAmbiguous.length, 10, 'must have 10 mixed/ambiguous items');

  const ids = new Set();
  for (const item of fixtures) {
    assert.ok(item.id !== undefined && !ids.has(item.id), `duplicate or missing id: ${item.id}`);
    ids.add(item.id);
    assert.ok(typeof item.text === 'string' && item.text.trim().length > 0, `text must be non-empty for id ${item.id}`);
    assert.ok(['question', 'action'].includes(item.ground_truth), `ground_truth invalid for id ${item.id}`);
    assert.ok(typeof item.reason === 'string' && item.reason.trim().length > 0, `reason must be non-empty for id ${item.id}`);
  }

  // Pure questions must all be question
  assert.ok(pureQuestions.every((q) => q.ground_truth === 'question'));
  // Pure actions must all be action
  assert.ok(pureActions.every((a) => a.ground_truth === 'action'));
  // Mixed / ambiguous with action commands under FR-15 must all be action
  assert.ok(mixedAmbiguous.every((m) => m.ground_truth === 'action'));
});

test('parseClassificationResponse: parses JSON, code blocks, text, and falls back safely', () => {
  // Pure JSON
  assert.deepEqual(parseClassificationResponse('{"classification": "question", "reason": "query"}'), {
    classification: 'question',
    reason: 'query',
  });
  assert.deepEqual(parseClassificationResponse('{"classification": "action", "reason": "modifies code"}'), {
    classification: 'action',
    reason: 'modifies code',
  });

  // Markdown code block
  const markdown = 'Here is the answer:\n```json\n{"classification":"action","reason":"git push"}\n```';
  assert.equal(parseClassificationResponse(markdown).classification, 'action');

  // Text keywords
  assert.equal(parseClassificationResponse('判定為 question。理由是詢問狀態。').classification, 'question');
  assert.equal(parseClassificationResponse('判定為 action。要求重啟服務。').classification, 'action');

  // Fallback to action on ambiguity / unparseable (FR-15 safe default)
  assert.equal(parseClassificationResponse('無法確定').classification, 'action');
  assert.equal(parseClassificationResponse('').classification, 'action');
  assert.equal(parseClassificationResponse(null).classification, 'action');
});

test('buildClassificationPrompt: includes classification rules and target text', () => {
  const prompt = buildClassificationPrompt('測試有沒有過？沒過就幫我修。');
  assert.match(prompt, /client\/hub-hook\.mjs/);
  assert.match(prompt, /FR-15/);
  assert.match(prompt, /測試有沒有過？沒過就幫我修。/);
});

test('calculateMetrics: passes on perfect evaluation', () => {
  const results = [
    // 10 questions correctly classified as question
    ...Array.from({ length: 10 }, (_, i) => ({ ground_truth: 'question', prediction: 'question', id: i + 1 })),
    // 20 actions correctly classified as action
    ...Array.from({ length: 20 }, (_, i) => ({ ground_truth: 'action', prediction: 'action', id: i + 11 })),
  ];

  const m = calculateMetrics(results);
  assert.equal(m.total, 30);
  assert.equal(m.trueQuestion, 10);
  assert.equal(m.falseAction, 0);
  assert.equal(m.trueAction, 20);
  assert.equal(m.falseQuestion, 0);
  assert.equal(m.actionAsQuestionCount, 0);
  assert.equal(m.actionAsQuestionPass, true);
  assert.equal(m.questionAsActionRate, 0.0);
  assert.equal(m.questionAsActionPass, true);
  assert.equal(m.passed, true);
});

test('calculateMetrics: allows question_as_action rate up to 20%', () => {
  // 2 out of 10 questions misclassified as action = 20% -> PASS
  const results20 = [
    ...Array.from({ length: 8 }, (_, i) => ({ ground_truth: 'question', prediction: 'question', id: i + 1 })),
    ...Array.from({ length: 2 }, (_, i) => ({ ground_truth: 'question', prediction: 'action', id: i + 9 })),
    ...Array.from({ length: 20 }, (_, i) => ({ ground_truth: 'action', prediction: 'action', id: i + 11 })),
  ];
  const m20 = calculateMetrics(results20);
  assert.equal(m20.actionAsQuestionCount, 0);
  assert.equal(m20.questionAsActionRate, 0.20);
  assert.equal(m20.questionAsActionPass, true);
  assert.equal(m20.passed, true);

  // 3 out of 10 questions misclassified as action = 30% -> FAIL
  const results30 = [
    ...Array.from({ length: 7 }, (_, i) => ({ ground_truth: 'question', prediction: 'question', id: i + 1 })),
    ...Array.from({ length: 3 }, (_, i) => ({ ground_truth: 'question', prediction: 'action', id: i + 8 })),
    ...Array.from({ length: 20 }, (_, i) => ({ ground_truth: 'action', prediction: 'action', id: i + 11 })),
  ];
  const m30 = calculateMetrics(results30);
  assert.equal(m30.questionAsActionRate, 0.30);
  assert.equal(m30.questionAsActionPass, false);
  assert.equal(m30.passed, false);
});

test('calculateMetrics: fails immediately if any action is judged as question (action_as_question > 0)', () => {
  // Even a single action misclassified as question violates the safety bottom line (0 required)
  const resultsViolation = [
    ...Array.from({ length: 10 }, (_, i) => ({ ground_truth: 'question', prediction: 'question', id: i + 1 })),
    ...Array.from({ length: 19 }, (_, i) => ({ ground_truth: 'action', prediction: 'action', id: i + 11 })),
    { ground_truth: 'action', prediction: 'question', id: 30 }, // 1 dangerous false question
  ];
  const m = calculateMetrics(resultsViolation);
  assert.equal(m.actionAsQuestionCount, 1);
  assert.equal(m.actionAsQuestionPass, false);
  assert.equal(m.passed, false);
});

test('formatReport: renders confusion matrix and evaluation gates accurately', () => {
  const results = [
    { id: 1, category: 'pure_question', ground_truth: 'question', prediction: 'action', text: 'Q1', reason: 'r1', modelReason: 'mr1' },
    { id: 2, category: 'pure_action', ground_truth: 'action', prediction: 'action', text: 'A1', reason: 'r2' },
  ];
  const m = calculateMetrics(results);
  const report = formatReport({ metrics: m, results, providerName: 'test-fake' });

  assert.match(report, /EVAL-01 評測報告/);
  assert.match(report, /混淆矩陣/);
  assert.match(report, /action 被判成 question 次數/);
  assert.match(report, /question 被判成 action 比例/);
  assert.match(report, /分類偏差紀錄/);
  assert.match(report, /#1/);
});

test('runEval: end-to-end evaluation with fake provider passes gate', async () => {
  const { metrics, report, results } = await runEval({
    fixturesPath: DEFAULT_FIXTURES_PATH,
    provider: createFakeProvider({ mode: 'ground_truth' }),
  });

  assert.equal(results.length, 30);
  assert.equal(metrics.actionAsQuestionCount, 0);
  assert.equal(metrics.questionAsActionRate, 0);
  assert.equal(metrics.passed, true);
  assert.match(report, /✅ 通過（PASSED）/);
});

test('runEval: detects safety bottom line violation with injected override', async () => {
  // Inject an error: sample 11 (pure action) misclassified as question
  const badProvider = createFakeProvider({
    mode: 'ground_truth',
    overrides: { 11: 'question' },
  });

  const { metrics, report } = await runEval({
    fixturesPath: DEFAULT_FIXTURES_PATH,
    provider: badProvider,
  });

  assert.equal(metrics.actionAsQuestionCount, 1);
  assert.equal(metrics.actionAsQuestionPass, false);
  assert.equal(metrics.passed, false);
  assert.match(report, /❌ 未通過（FAILED）/);
  assert.match(report, /#11/);
});

test('runEval: provider runtime failure falls back safely to action', async () => {
  const failProvider = {
    name: 'failing-provider',
    async classify() {
      throw new Error('network down');
    },
  };

  const { results, metrics } = await runEval({
    fixturesPath: DEFAULT_FIXTURES_PATH,
    provider: failProvider,
  });

  // Since all fail, all predictions fall back to 'action'.
  // Thus no action is judged as question (actionAsQuestionCount = 0).
  assert.equal(metrics.actionAsQuestionCount, 0);
  assert.equal(metrics.actionAsQuestionPass, true);
  // All 10 questions become action -> questionAsActionRate = 100% -> fails rate gate
  assert.equal(metrics.questionAsActionRate, 1.0);
  assert.equal(metrics.questionAsActionPass, false);
  assert.equal(metrics.passed, false);
});
