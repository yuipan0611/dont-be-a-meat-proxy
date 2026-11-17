import { createHash } from 'node:crypto';

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const MANUAL = {
  14: ['realTlsHostnames'],
  16: ['ephemeral', 'retentionNotice', 'nonMemberRefused', 'newConfig'],
  17: ['ephemeral', 'citationsAndTaipeiTime', 'draftConfirmedSeparate', 'readOnly', 'unknownRefused', 'bothComputersOff', 'quotaText'],
  18: ['dmTypeSenderSummary', 'oneDigest', 'noPublicFallback'],
  19: ['realDiscordGithubError', 'discordCancel', 'discordStranger', 'discordDoubleClick', 'discordEmptyTitle'],
  20: ['draftNotification', 'memberRefused', 'repeatRefused'],
  21: ['traditionalChineseResponse', 'groqCostGate'],
};

// Pure acceptance rules. Missing evidence is pending, never success.
export function evaluate(tc, evidence = {}) {
  const checks = [];
  const add = (name, value) => checks.push({ name, status: value === undefined || value === null ? 'pending' : value === true ? 'pass' : 'fail' });
  const steps = evidence.steps ?? {};
  add('same deployment and run', Object.keys(steps).length ? Object.values(steps).every((s) =>
    /^[a-f0-9]{40}$/.test(s.deploymentCommit ?? '') && s.deploymentCommit === evidence.deploymentCommit && s.runId === evidence.runId && Number.isFinite(Date.parse(s.utc))) : undefined);
  for (const s of Object.values(steps)) if (s.error) add('collection completed', false);
  const audit = (s, name) => s?.db?.audit?.filter((r) => r.action === name);
  const has = (s, name) => s ? !!audit(s, name)?.length : undefined;
  const final = steps.final;
  if (tc === 14) {
    const i = final?.isolation;
    add('complete isolation probes', i ? i.expected === 19 && i.results?.length === i.expected && i.results.every((x) => x.ok === true) &&
      i.results.filter((x) => x.category === 'crossBearer').length === 16 && ['foreignProject', 'attachment', 'archiveMarker'].every((k) => i.results.some((x) => x.category === k)) : undefined);
    for (const k of ['volumeSeparated', 'dbSeparated', 'bankSeparated', 'decisionsSeparated', 'originalHealthy']) add(k, i?.[k]);
  } else if (tc === 16) {
    for (const [key, expected] of Object.entries({ old: 401, other: 200, fresh: 200 })) add(`${key} HTTP ${expected}`, final?.probes?.[key] === undefined ? undefined : final.probes[key] === expected);
    add('non-member denied audit', has(final, 'discord.connect.denied'));
    for (const op of ['issue', 'revoke']) {
      const rows = audit(final, `device.${op}.applied`);
      add(`${op} receipt matches audit`, final ? !!rows?.length && rows.some((a) => a.target_id === final.deviceIds?.[op === 'issue' ? 'fresh' : 'old'] && final.receipts?.some((r) =>
        r.op === op && r.request_id === a.request_id && r.status === 'applied' && !!r.config_revision && (op !== 'revoke' || r.probe === 401))) : undefined);
    }
    const devices = final?.db?.devices;
    add('revoked and new device recorded', devices && final.deviceIds ? devices.some((x) => x.token_id === final.deviceIds.old && x.status === 'revoked') &&
      devices.some((x) => x.token_id === final.deviceIds.fresh && x.status === 'active') && final.deviceIds.old !== final.deviceIds.fresh : undefined);
  } else if (tc === 17) {
    const a = steps.quotaBefore?.runtime, b = steps.quotaAfter?.runtime;
    add('zero quota without backend invocation', a && b ? a.dailyLimit === 0 && b.dailyLimit === 0 && a.day === b.day && a.used === b.used && a.reserved === 0 && b.reserved === 0 : undefined);
    add('quota reply audit', audit(steps.quotaAfter, 'discord.status')?.some((r) => r.details?.kind === 'quota'));
    const items = steps.answered?.sourceItems;
    const handoffs = items?.filter((i) => i.kind === 'handoff');
    add('real answer citations', items ? items.length >= 2 && audit(steps.answered, 'discord.status')?.some((r) => r.details?.kind === 'answer' &&
      r.details.citations?.length >= 1 && r.details.citations.every((id) => items.some((m) => m.id === id)) &&
      handoffs.length >= 2 && r.details.citations.includes([...handoffs].sort((a, b) => Date.parse(b.created_ts) - Date.parse(a.created_ts))[0].id)) : undefined);
    add('status leaves Mail and decisions unchanged', steps.baseline?.mailTail !== undefined && steps.answered?.mailTail !== undefined ?
      steps.baseline.mailTail === steps.answered.mailTail && JSON.stringify(steps.baseline.db.decisions ?? []) === JSON.stringify(steps.answered.db.decisions ?? []) : undefined);
    add('unknown answer refused', audit(steps.unknown, 'discord.status')?.some((r) => r.details?.kind === 'no_info'));
    add('workstations off answer', audit(steps.offline, 'discord.status')?.some((r) => r.details?.kind === 'answer' && r.details.citations?.length));
    add('quota restored', steps.restored?.runtime && steps.baseline?.runtime ? steps.restored.runtime.dailyLimit === steps.baseline.runtime.dailyLimit && steps.restored.runtime.dailyLimit > 0 : undefined);
  } else if (tc === 18) {
    const online = steps.online?.notifications;
    add('each online DM within 15 seconds of Mail creation', online ? online.length > 0 && online.every((r) => {
      const delta = Date.parse(r.updated_at) - Date.parse(r.mail_created_at);
      return r.state === 'sent' && r.attempts === 1 && !!r.discord_message_id && delta >= 0 && delta <= 15_000;
    }) : undefined);
    const n = steps.negative?.negative;
    add('unsaved recipient produces no notification', n ? n.error === 'E-RCPT' && n.mailUnchanged === true && n.notificationsUnchanged === true : undefined);
    const held = steps.held?.notifications, failed = steps.failed?.notifications;
    add('offline held without DM', held ? held.length > 0 && held.every((r) => r.state === 'held' && !r.discord_message_id && r.attempts === 0) : undefined);
    add('DM failure recorded', failed ? failed.length > 0 && failed.every((r) => r.state === 'failed' && r.attempts === 1) : undefined);
    const digest = steps.digest?.notifications, repeat = steps.repeat?.notifications;
    add('one digest covers held and failed, no replay', held && failed && digest && repeat ?
      [...held, ...failed].every((r) => digest.some((d) => d.id === r.id && d.state === 'digested')) &&
      digest.length > 0 && digest.every((r) => r.state === 'digested' && !!r.discord_message_id) &&
      new Set(digest.map((r) => r.discord_message_id)).size === 1 && JSON.stringify(digest) === JSON.stringify(repeat) : undefined);
  } else if (tc === 19) {
    const n = steps.negative?.negative;
    add('missing-token fail-closed', n ? n.error === 'E-GITHUB' && n.networkCalls === 0 && n.hubWrites === 0 && n.createdAudit === 0 : undefined);
    add('deployed GitHub credential absent', n?.runtimeTokenAbsent);
    add('deployed run has no saved task or created audit', n?.searchComplete ? n.savedTaskMailIds?.length === 0 && !audit(steps.negative, 'discord.task.created')?.length : undefined);
    for (const k of ['emptyTitle', 'cancel', 'stranger', 'doubleClick']) add(k, n?.[k]);
    // A direct missing-token test is never evidence of a real Issue + unique Hub task.
    add('real GitHub positive', undefined);
  } else if (tc === 20) {
    const draft = steps.draft?.decisions?.[0], denied = steps.denied?.decisions?.[0];
    const confirmed = steps.confirmed?.decisions?.[0], repeat = steps.repeat?.decisions?.[0];
    add('draft saved before interaction', draft ? draft.status === 'draft' : undefined);
    add('Mail original and DB draft text match', draft && steps.draft?.originalSha256 ? draft.text_sha256 === steps.draft.originalSha256 && steps.draft.originalSha256 === steps.draft.fixtureSha256 : undefined);
    add('member cannot alter draft', draft && denied ? draft.draft_mail_id === denied.draft_mail_id && denied.status === 'draft' && draft.text_sha256 === denied.text_sha256 && has(steps.denied, 'discord.decision.denied') : undefined);
    add('owner confirmation preserves original', draft && confirmed ? confirmed.draft_mail_id === draft.draft_mail_id && confirmed.status === 'confirmed' && confirmed.text_sha256 === draft.text_sha256 && !!confirmed.confirmed_at &&
      steps.confirmed.db?.members?.some((m) => m.id === confirmed.confirmed_by && m.role === 'owner') : undefined);
    const m = steps.confirmed?.mailStatus;
    add('Mail status matches DB', confirmed && m ? m.draft_mail_id === confirmed.draft_mail_id && m.status === confirmed.status && Date.parse(m.decided_at) === Date.parse(confirmed.confirmed_at) : undefined);
    add('second interaction has no duplicate confirmation', confirmed && repeat ? JSON.stringify(confirmed) === JSON.stringify(repeat) &&
      audit(steps.repeat, 'discord.decision.confirmed')?.filter((a) => a.details?.draft_mail_id === confirmed.draft_mail_id).length === 1 : undefined);
  } else if (tc === 21) {
    const rows = final?.memory;
    const indexed = rows && ['handoff', 'decision'].every((k) => rows.some((r) => r.kind === k && r.bridgeStatus === 'indexed'));
    add('handoff and decision via MemoryBridge', indexed ? true : rows?.some((r) => r.bridgeStatus === 'error') ? false : undefined);
    add('Mail/get_document/recall SHA256', rows ? rows.length >= 2 && rows.every((r) => r.fixtureMatches === true && r.documentMatches === true && r.recallMatches === true && /^[a-f0-9]{64}$/.test(r.mailSha256)) : undefined);
  } else throw new Error('unsupported TC');
  if (tc === 17 || tc === 21) {
    const runtimes = Object.values(steps).filter((s) => s.runtime).map((s) => s.runtime);
    add('Groq gpt-oss-120b runtime', runtimes.length ? runtimes.every((r) => r.backend === 'groq-api' && r.model === 'openai/gpt-oss-120b') : undefined);
    add('configured daily request gate', runtimes.length ? runtimes.every((r) => Number.isSafeInteger(r.dailyLimit) && r.dailyLimit >= 0) : undefined);
  }
  for (const k of MANUAL[tc]) {
    const o = evidence.observations?.[k];
    add(`manual: ${k}`, o && typeof o.ok === 'boolean' && o.actor && o.evidence && Number.isFinite(Date.parse(o.utc)) ? o.ok : undefined);
  }
  return { status: checks.some((c) => c.status === 'fail') ? 'fail' : checks.every((c) => c.status === 'pass') ? 'pass' : 'pending', checks };
}

export function memoryProof({ text, document, recall, documentId }) {
  const chunks = Object.values(recall?.chunks ?? {}).filter((c) => c.document_id === documentId);
  const original = document?.original_text;
  const joined = chunks.map((c) => c.text ?? c.chunk_text ?? '').join('');
  return { documentId, mailSha256: sha256(text), documentSha256: typeof original === 'string' ? sha256(original) : null,
    recallSha256: chunks.length ? sha256(joined) : null,
    documentMatches: typeof original === 'string' && sha256(text) === sha256(original),
    recallMatches: chunks.length > 0 && sha256(text) === sha256(joined) };
}

export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (/^(error|code)$/i.test(k) && typeof v === 'string' && /^[A-Z][A-Z0-9_-]{1,60}$/.test(v)) return [k, v];
    if (k === 'state' && ['pending', 'sent', 'failed', 'held', 'digested', 'unknown'].includes(v)) return [k, v];
    return [k, /^(token|access_token|refresh_token|oauth_code|code|state|authorization|password|secret|content|body|body_md|text|summary|dm|original_text|error)$/i.test(k) ? '[REDACTED]' : redact(v, secrets)];
  }));
  if (typeof value !== 'string') return value;
  let s = value;
  for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED]');
  return s.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\b(?:mph_|ghp_|github_pat_|gsk_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/([?&](?:code|state|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
}

export function renderReport({ tc, utc, deploymentCommit, runId, operator = 'unspecified', command, exit, result, data }) {
  return `# TC-${tc} acceptance receipt\n\nUTC: ${utc}\n\nDeployment commit: ${deploymentCommit}\n\nOperator: ${operator}\n\nRun: ${runId}\n\nCommand: ${redact(command)}\n\nExit: ${exit}\n\nVerdict: **${result.status}**\n\n` +
    result.checks.map((c) => `- ${c.status}: ${c.name}`).join('\n') + '\n\nNon-secret output (content omitted; hashes/IDs only):\n\n```json\n' + JSON.stringify(redact(data), null, 2) + '\n```\n';
}
