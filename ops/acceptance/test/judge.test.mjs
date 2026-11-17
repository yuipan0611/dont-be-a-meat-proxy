import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, redact, memoryProof, renderReport } from '../judge.mjs';

const obs = () => ({ ok: true, actor: '維護者', utc: '2026-11-18T01:00:00Z', evidence: 'redacted-screen-1' });
const observation = (keys) => Object.fromEntries(keys.map((k) => [k, obs()]));
const runtime = { backend: 'groq-api', model: 'openai/gpt-oss-120b', dailyLimit: 500, used: 4, reserved: 0, day: '2026-11-18' };
const meta = { deploymentCommit: 'a'.repeat(40), runId: 'test-run', utc: '2026-11-18T01:00:00Z' };
const step = (data = {}) => ({ ...meta, db: { audit: [], devices: [], notifications: [], decisions: [] }, ...data });
const envelope = (steps, observations = {}) => ({ ...meta, steps, observations });

test('all TCs remain pending with no evidence; empty arrays do not pass', () => {
  for (const tc of [14, 16, 17, 18, 19, 20, 21]) assert.equal(evaluate(tc, envelope({})).status, 'pending');
});
test('evidence from another deployment/run is rejected', () => {
  const e = envelope({ baseline: step({ deploymentCommit: 'b'.repeat(40) }) });
  assert.equal(evaluate(16, e).status, 'fail');
});
test('TC16 requires revoke audit and receipt, old 401, other and new 200', () => {
  const e = envelope({ final: step({ probes: { old: 401, other: 200, fresh: 200 }, deviceIds: { old: 'old', fresh: 'fresh' },
    receipts: [{ op: 'issue', status: 'applied', request_id: 'i', config_revision: 'r' }, { op: 'revoke', status: 'applied', request_id: 'r', probe: 401, config_revision: 'r' }],
    db: { devices: [{ token_id: 'old', status: 'revoked' }, { token_id: 'fresh', status: 'active' }],
      audit: [{ action: 'device.issue.applied', request_id: 'i', target_id: 'fresh' }, { action: 'device.revoke.applied', request_id: 'r', target_id: 'old' }, { action: 'discord.connect.denied' }] } }),
  }, observation(['ephemeral', 'retentionNotice', 'nonMemberRefused', 'newConfig']));
  assert.equal(evaluate(16, e).status, 'pass');
  e.steps.final.probes.old = 200;
  assert.equal(evaluate(16, e).status, 'fail');
});
test('TC17 quota must not call backend or cross Taipei day; requires Groq', () => {
  const e = envelope({ baseline: step({ runtime, mailTail: 30 }), answered: step({ runtime, mailTail: 30, sourceItems: [{ id: 11, kind: 'handoff', created_ts: meta.utc }, { id: 12, kind: 'handoff', created_ts: '2026-11-18T01:00:01Z' }], db: { audit: [{ action: 'discord.status', details: { kind: 'answer', citations: [11, 12] } }] } }),
    quotaBefore: step({ runtime: { ...runtime, dailyLimit: 0 } }), quotaAfter: step({ runtime: { ...runtime, dailyLimit: 0 }, db: { audit: [{ action: 'discord.status', details: { kind: 'quota' } }] } }),
    offline: step({ runtime, db: { audit: [{ action: 'discord.status', details: { kind: 'answer', citations: [11] } }] } }),
    unknown: step({ runtime, db: { audit: [{ action: 'discord.status', details: { kind: 'no_info' } }] } }),
    restored: step({ runtime }) }, observation(['ephemeral', 'citationsAndTaipeiTime', 'draftConfirmedSeparate', 'readOnly', 'unknownRefused', 'bothComputersOff', 'quotaText']));
  assert.equal(evaluate(17, e).status, 'pass');
  e.steps.quotaAfter.runtime.used++;
  assert.equal(evaluate(17, e).status, 'fail');
  e.steps.quotaAfter.runtime = { ...runtime, dailyLimit: 0, day: '2026-11-19' };
  assert.notEqual(evaluate(17, e).status, 'pass');
  e.steps.answered.runtime = { ...runtime, backend: 'anthropic' };
  assert.equal(evaluate(17, e).status, 'fail');
});
test('TC18 latency starts at Mail creation, failure/offline digest exactly once', () => {
  const row = { id: 1, mail_id: 11, state: 'sent', attempts: 1, discord_message_id: 'dm1', mail_created_at: '2026-11-18T01:00:00Z', updated_at: '2026-11-18T01:00:14Z' };
  const e = envelope({ online: step({ notifications: [row] }), negative: step({ negative: { error: 'E-RCPT', mailUnchanged: true, notificationsUnchanged: true } }),
    held: step({ notifications: [{ ...row, state: 'held', attempts: 0, discord_message_id: null }] }),
    failed: step({ notifications: [{ ...row, id: 2, state: 'failed', discord_message_id: null }] }),
    digest: step({ notifications: [1, 2].map((id) => ({ ...row, id, state: 'digested', discord_message_id: 'digest1' })) }),
    repeat: step({ notifications: [1, 2].map((id) => ({ ...row, id, state: 'digested', discord_message_id: 'digest1' })) }) }, observation(['dmTypeSenderSummary', 'oneDigest', 'noPublicFallback']));
  assert.equal(evaluate(18, e).status, 'pass');
  e.steps.online.notifications[0].updated_at = '2026-11-18T01:00:16Z';
  assert.equal(evaluate(18, e).status, 'fail');
});
test('TC19 missing token passes only negative subcase, positive always pending', () => {
  const negative = { error: 'E-GITHUB', runtimeTokenAbsent: true, searchComplete: true, savedTaskMailIds: [], networkCalls: 0, hubWrites: 0, createdAudit: 0, emptyTitle: true, cancel: true, stranger: true, doubleClick: true };
  const e = envelope({ negative: step({ negative }) }, observation(['realDiscordGithubError', 'discordCancel', 'discordStranger', 'discordDoubleClick', 'discordEmptyTitle']));
  const r = evaluate(19, e);
  assert.equal(r.status, 'pending');
  assert.equal(r.checks.find((x) => x.name === 'missing-token fail-closed').status, 'pass');
  assert.equal(r.checks.find((x) => x.name === 'real GitHub positive').status, 'pending');
  negative.hubWrites = 1;
  assert.equal(evaluate(19, e).status, 'fail');
});
test('TC20 rejects member, only owner may confirm, original content unchanged', () => {
  const draft = { draft_mail_id: 5, status: 'draft', version: 1, text_sha256: 'x' };
  const confirmed = { ...draft, status: 'confirmed', confirmed_by: 'owner-id', confirmed_at: meta.utc };
  const e = envelope({ draft: step({ decisions: [draft], originalSha256: 'x', fixtureSha256: 'x' }), denied: step({ decisions: [draft], db: { audit: [{ action: 'discord.decision.denied' }] } }),
    confirmed: step({ decisions: [confirmed], db: { audit: [{ action: 'discord.decision.confirmed', details: { draft_mail_id: 5 } }], members: [{ id: 'owner-id', role: 'owner' }] }, mailStatus: { draft_mail_id: 5, status: 'confirmed', decided_at: meta.utc } }),
    repeat: step({ decisions: [confirmed], db: { audit: [{ action: 'discord.decision.confirmed', details: { draft_mail_id: 5 } }] } }) }, observation(['draftNotification', 'memberRefused', 'repeatRefused']));
  assert.equal(evaluate(20, e).status, 'pass');
  e.steps.confirmed.decisions[0].text_sha256 = 'changed';
  assert.equal(evaluate(20, e).status, 'fail');
});
test('TC21 hashes original text, not envelope or extracted facts; empty chunks fail', () => {
  const text = '繁體中文權杖，登入頁。\r\n😀';
  const proof = memoryProof({ text, document: { original_text: text }, recall: { chunks: { a: { document_id: 'mail-7', text } } }, documentId: 'mail-7' });
  assert.equal(proof.documentMatches, true);
  assert.equal(proof.recallMatches, true);
  const e = envelope({ final: step({ runtime, memory: [{ ...proof, fixtureMatches: true, kind: 'handoff', bridgeStatus: 'indexed' }, { ...proof, fixtureMatches: true, kind: 'decision', bridgeStatus: 'indexed' }] }) }, observation(['traditionalChineseResponse', 'groqCostGate']));
  assert.equal(evaluate(21, e).status, 'pass');
  assert.equal(memoryProof({ text, document: { original_text: text.replace('體', '体') }, recall: {}, documentId: 'mail-7' }).documentMatches, false);
  assert.equal(memoryProof({ text, document: {}, recall: { chunks: {} }, documentId: 'mail-7' }).recallMatches, false);
  e.steps.final.memory[0].bridgeStatus = 'unknown';
  assert.notEqual(evaluate(21, e).status, 'pass');
});
test('TC14 requires complete declared probe set and no marker escape', () => {
  const results = [...Array.from({ length: 16 }, () => ({ category: 'crossBearer', ok: true })), ...['foreignProject', 'attachment', 'archiveMarker'].map((category) => ({ category, ok: true }))];
  const e = envelope({ final: step({ isolation: { expected: 19, results, volumeSeparated: true, dbSeparated: true, bankSeparated: true, decisionsSeparated: true, originalHealthy: true } }) }, observation(['realTlsHostnames']));
  assert.equal(evaluate(14, e).status, 'pass');
  e.steps.final.isolation.results.pop();
  assert.notEqual(evaluate(14, e).status, 'pass');
});
test('manual flags need attribution/evidence, and failed checks dominate pending', () => {
  const e = envelope({ final: step({ probes: { old: 200 } }) }, { ephemeral: { ok: true } });
  const r = evaluate(16, e);
  assert.equal(r.status, 'fail');
  assert.equal(r.checks.find((c) => c.name === 'manual: ephemeral').status, 'pending');
});
test('reports mask token, OAuth code and arbitrary DM content without relying on patterns', () => {
  const raw = { token: 'unusual-secret', oauth_code: 'abc', content: '私人原文', body_md: 'hidden', summary: 'secret summary',
    error: 'Bearer mph_a\x62cdefghijklmnopqrstuvwxyz123456 https://x/?code=CODE&state=STATE', safe: 'ghp_a\x62cdefghijklmnopqrstuv' };
  const out = JSON.stringify(redact(raw));
  for (const s of ['unusual-secret', '私人原文', 'hidden', 'secret summary', 'CODE', 'STATE', 'ghp_abcdef', 'mph_abcdef']) assert.ok(!out.includes(s), s);
  const report = renderReport({ tc: 19, ...meta, command: 'tc-19.mjs --step negative', exit: 2, result: evaluate(19, envelope({})), data: raw });
  assert.match(report, /UTC/);
  assert.match(report, /pending/);
  assert.ok(!report.includes('私人原文'));
});
