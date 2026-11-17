import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MANUAL, evaluate, redact, renderReport, sha256 } from './judge.mjs';
import { command, validateConfig, settledDb, runtimeSnapshot, imageSnapshot, seed, deviceProbes, applierReceipts, memoryProbes, unknownRecipient, mailClient, searchRows, quotaTarget } from './collect.mjs';
import { isolationProbes } from './isolation.mjs';
import { missingTokenTask } from './negative-task.mjs';

async function atomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(redact(value), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}
export async function main(tc, argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, live: { type: 'boolean', default: false }, step: { type: 'string' }, verify: { type: 'boolean' },
    seed: { type: 'string' }, observe: { type: 'string' }, verdict: { type: 'string' }, reference: { type: 'string' },
    observations: { type: 'string' },
    quota: { type: 'string' }, 'allow-recreate': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (v.help || !v.config) {
    console.log(`TC-${tc}: --config /private/s1.json [--live --step LABEL | --live --seed handoff|decision --step LABEL | --verify | --observe KEY --verdict pass|fail --reference REDACTED_FILE | --live --quota 0|restore --allow-recreate]\nManual keys: ${MANUAL[tc].join(', ')}\nNo network, Docker or credentials are accessed without --live. See ops/acceptance/README.md.`);
    return;
  }
  const modes = [!!v.verify, !!v.observe, !!v.quota, !!v.step];
  if (modes.filter(Boolean).length !== 1 || (v.seed && !v.step)) throw new Error('CHOOSE_ONE_MODE');
  if ((v.step || v.quota) && !v.live) throw new Error('LIVE_FLAG_REQUIRED');
  const c = JSON.parse(await readFile(v.config, 'utf8'));
  validateConfig(c);
  if (v.step && !/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(v.step)) throw new Error('INVALID_STEP');
  const dir = resolve(`docs/evidence/S1/TC-${tc}`);
  await mkdir(dir, { recursive: true });
  const stateFile = `${dir}/state-${c.runId}.json`;
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('INVALID_STATE'); }
  state ??= { deploymentCommit: c.deploymentCommit, runId: c.runId, operator: c.operator, since: c.since, steps: {}, observations: {}, seeds: {} };
  if (state.deploymentCommit !== c.deploymentCommit || state.since !== c.since) throw new Error('RUN_CONFIG_CHANGED');
  const utc = new Date().toISOString();
  const operations = [];
  let collectionFailed = false;
  try {
    if (v.observations) {
      if (!v.verify) throw new Error('OBSERVATIONS_REQUIRE_VERIFY');
      const supplied = JSON.parse(await readFile(v.observations, 'utf8'))[`TC-${tc}`] ?? {};
      for (const [key, o] of Object.entries(supplied)) {
        if (!MANUAL[tc].includes(key)) throw new Error('INVALID_OBSERVATION');
        if (o.ok === null) continue; // unobserved template entries stay pending
        if (typeof o.ok !== 'boolean' || !o.actor || !Number.isFinite(Date.parse(o.utc)) || !/^[A-Za-z0-9_./:#-]{1,240}$/.test(o.evidence ?? '')) throw new Error('INVALID_OBSERVATION');
        state.observations[key] = o;
      }
    }
    if (v.observe) {
      if (!MANUAL[tc].includes(v.observe) || !['pass', 'fail'].includes(v.verdict) || !/^[A-Za-z0-9_./:#-]{1,240}$/.test(v.reference ?? '')) throw new Error('INVALID_OBSERVATION');
      state.observations[v.observe] = { ok: v.verdict === 'pass', actor: c.operator, utc, evidence: v.reference };
      operations.push({ command: `observe ${v.observe}`, exit: 0 });
    } else if (v.live && !v.verify) {
      const head = await command('git', ['rev-parse', 'HEAD']);
      if (head !== c.deploymentCommit) throw new Error('DEPLOYMENT_COMMIT_MISMATCH');
      if (v.quota) {
        if (tc !== 17 || !v['allow-recreate'] || !['0', 'restore'].includes(v.quota) || !Array.isArray(c.memoryCompose)) throw new Error('QUOTA_RECREATE_REQUIRED');
        const limit = quotaTarget(v.quota, state.steps.baseline?.runtime);
        const rt = await runtimeSnapshot(c);
        if (rt.reserved !== 0) throw new Error('GATEWAY_HAS_INFLIGHT_CALLS');
        await command('docker', ['compose', ...c.memoryCompose, 'up', '-d', '--no-deps', '--force-recreate', 'llm-gateway'], { env: { ...process.env, HUB_LLM_DAILY_REQUEST_LIMIT: String(limit) }, timeoutMs: 90_000 });
        operations.push({ command: `docker compose <configured memory files> up -d --no-deps --force-recreate llm-gateway (dailyLimit=${limit})`, exit: 0 });
      } else if (v.seed) {
        if (state.seeds[v.step]) throw new Error('SEED_EXISTS_CHECK_MAIL_NOT_RESEND');
        state.seeds[v.step] = { idempotencyKey: randomUUID(), status: 'requested', kind: v.seed };
        // Persist intent BEFORE sending: crashes/timeouts cannot cause accidental new sends.
        await atomic(stateFile, state);
        state.seeds[v.step] = await seed(c, v.step, v.seed, state.seeds[v.step]);
        operations.push({ command: 'Hub MCP send_message fixed Traditional Chinese fixture', exit: 0 });
      } else {
        const s = { deploymentCommit: head, runId: c.runId, utc, db: await settledDb(c, state, tc, v.step), images: await imageSnapshot(c) };
        operations.push({ command: 'docker exec <db> psql -X -qAt (read-only safe projection)', exit: 0 });
        if (tc === 17 || tc === 21) {
          s.runtime = await runtimeSnapshot(c);
          operations.push({ command: 'docker exec <gateway> node (authenticated GET /status, backend/model allowlist)', exit: 0 });
        }
        if (tc === 17 && ['answered', 'unknown', 'offline', 'quotaAfter'].includes(v.step)) {
          s.db.audit = s.db.audit.filter((r) => Number(r.id) > (state.auditCursor ?? 0));
        }
        state.auditCursor = Math.max(state.auditCursor ?? 0, ...s.db.audit.map((r) => Number(r.id)));
        if (tc === 17) {
          const client = await mailClient(c);
          s.mailTail = (await client.fetchEvents({ after: 0 })).tailCursor;
          s.sourceItems = [];
          const ids = new Set([...Object.values(state.seeds).filter((r) => r.status === 'saved').map((r) => r.messageId), ...(c.statusSourceMailIds ?? []), ...s.db.decisions.map((d) => Number(d.draft_mail_id))]);
          for (const id of ids) {
            if (!Number.isSafeInteger(id) || id <= 0) throw new Error('INVALID_SOURCE_MAIL_ID');
            const m = (await client.readMessage(id)).message;
            s.sourceItems.push({ id: m.id, created_ts: m.created_ts, kind: JSON.parse(m.body_md).kind });
          }
        }
        if (tc === 16 && v.step === 'final') {
          s.probes = await deviceProbes(c); s.receipts = await applierReceipts(c, s.db.audit);
          s.deviceIds = Object.fromEntries(Object.entries(c.devices).map(([label, d]) => [label, d.tokenId]));
          operations.push({ command: 'Hub MCP initialize old/other/fresh + read applier receipts', exit: 0 });
        }
        if (tc === 18) {
          const labels = ['digest', 'repeat'].includes(v.step) ? ['held', 'failed'] : [v.step];
          const ids = labels.map((label) => state.seeds[label]?.messageId).filter(Number.isInteger);
          s.notifications = s.db.notifications.filter((r) => ids.includes(Number(r.mail_id)) && (!c.memberId || r.member_id === c.memberId));
          if (v.step === 'negative') s.negative = await unknownRecipient(c);
        }
        if (tc === 19 && v.step === 'negative') {
          const harness = missingTokenTask.toString();
          const source = `import {createTaskService} from '/app/bot/src/task.mjs'; import {createGitHubClient} from '/app/bot/src/github.mjs'; console.log(JSON.stringify(await (${harness})({createTaskService,createGitHubClient})));`;
          s.negative = JSON.parse(await command('docker', ['exec', '-i', c.containers.bot, 'node', '--input-type=module'], { input: source }));
          const absentSource = `const fs=require('node:fs'), e=process.env; const p=e.GITHUB_TOKEN_FILE; let filePresent=false; if(p){try{filePresent=fs.statSync(p).size>0}catch(x){if(x.code!=='ENOENT')process.exit(1)}} console.log(JSON.stringify(!e.GITHUB_TOKEN&&!e.GITHUB_PAT&&!filePresent));`;
          s.negative.runtimeTokenAbsent = JSON.parse(await command('docker', ['exec', c.containers.bot, 'node', '-e', absentSource]));
          const client = await mailClient(c);
          const found = await client.callTool('search_messages', { project_key: `/data/projects/${c.groupId}`, query: '\"TC19\"', limit: 100 });
          const rows = searchRows(found);
          s.negative.savedTaskMailIds = [];
          for (const row of rows) {
            const m = (await client.readMessage(row.id)).message;
            const ts = Date.parse(m.created_ts.endsWith('Z') || /[+-]\d\d:\d\d$/.test(m.created_ts) ? m.created_ts : m.created_ts + 'Z');
            if (ts >= Date.parse(c.since)) {
              try { if (JSON.parse(m.body_md).kind === 'task') s.negative.savedTaskMailIds.push(m.id); } catch {}
            }
          }
          s.negative.searchComplete = rows.length < 100;
          operations.push({ command: 'docker exec <bot> node (deployed task service, explicit null token, network/write tripwires)', exit: 0 });
        }
        if (tc === 20) {
          const id = state.seeds.draft?.messageId;
          if (!id) throw new Error('SEED_DRAFT_REQUIRED');
          s.decisions = s.db.decisions.filter((d) => Number(d.draft_mail_id) === id);
          const original = (await (await mailClient(c)).readMessage(id)).message;
          s.originalSha256 = sha256(JSON.parse(original.body_md).text);
          s.fixtureSha256 = state.seeds.draft.fixtureSha256;
          if (v.step === 'confirmed') {
            // Confirm notification is a separate Mail decision_status item, linked to the draft.
            const client = await mailClient(c);
            const found = await client.callTool('search_messages', { project_key: `/data/projects/${c.groupId}`, query: `\"決策已確認\"`, limit: 100 });
            const rows = searchRows(found);
            const statuses = [];
            for (const row of rows) {
              const message = (await client.readMessage(row.id)).message;
              try { const body = JSON.parse(message.body_md); if (body.kind === 'decision_status' && body.draft_mail_id === id) statuses.push(body); } catch {}
            }
            if (statuses.length === 1 && rows.length < 100) s.mailStatus = { draft_mail_id: statuses[0].draft_mail_id, status: statuses[0].status, decided_at: statuses[0].decided_at };
          }
        }
        if (tc === 21 && v.step === 'final') {
          s.memory = await memoryProbes(c, state.seeds);
          operations.push({ command: 'Mail resources/read + bridge state + Hindsight get_document / recall include_chunks (SHA256 only)', exit: 0 });
        }
        if (tc === 14 && v.step === 'final') {
          s.isolation = await isolationProbes(c);
          operations.push({ command: 'cross-group HTTP/MCP/attachment/archive/volume/bank/bound-store probes', exit: 0 });
        }
        state.steps[v.step] = s;
      }
    }
  } catch (e) {
    collectionFailed = true;
    const safeErrors = ['COMMAND_UNAVAILABLE', 'COMMAND_FAILED', 'PRIVATE_FILE_PERMISSIONS', 'INVALID_TOKEN_FILE', 'DEPLOYMENT_COMMIT_MISMATCH', 'QUOTA_RECREATE_REQUIRED', 'BASELINE_REQUIRED', 'GATEWAY_HAS_INFLIGHT_CALLS', 'SEED_EXISTS_CHECK_MAIL_NOT_RESEND', 'SENDER_GROUP_MISMATCH', 'MEMORY_UNAUTHORIZED', 'INVALID_RECEIPT_ID', 'SEED_DRAFT_REQUIRED', 'INVALID_SOURCE_MAIL_ID', 'ISOLATION_CONFIG_REQUIRED', 'ISOLATION_MARKER_MISSING', 'INVALID_KIND', 'INVALID_OBSERVATION', 'OBSERVATIONS_REQUIRE_VERIFY'];
    const code = safeErrors.includes(e.message) ? e.message : 'COLLECTION_FAILED';
    operations.push({ command: 'collection stopped; inspect privately, no raw error output', exit: 1, error: code });
    if (v.step) state.steps[v.step] = { deploymentCommit: c.deploymentCommit, runId: c.runId, utc, error: code };
  }
  await atomic(stateFile, state);
  const result = evaluate(tc, state);
  if (collectionFailed) result.status = 'fail';
  const exit = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
  const suffix = utc.replaceAll(':', '-');
  const report = `${dir}/run-${suffix}.md`;
  // Reconstruct command from parsed, restricted values: never print original argv or config contents.
  const safeCommand = `node ops/acceptance/tc-${tc}.mjs --config <private-config> ${v.verify ? '--verify' : v.observe ? `--observe ${v.observe}` : v.quota ? `--live --quota ${v.quota}` : `--live --step ${v.step}${v.seed ? ` --seed ${v.seed}` : ''}`}`;
  await writeFile(report, renderReport({ tc, utc, deploymentCommit: c.deploymentCommit, runId: c.runId, operator: c.operator, command: safeCommand, exit, result, data: { operations, ...state } }), { mode: 0o600, flag: 'wx' });
  console.log(`TC-${tc} ${result.status}; exit=${exit}; receipt=${report}`);
  process.exitCode = exit;
}

export function cli(tc) {
  main(tc).catch(() => { console.error(`TC-${tc} configuration/usage failed; exit=1; no credentials or raw errors printed`); process.exitCode = 1; });
}
