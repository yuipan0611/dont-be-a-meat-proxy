import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, stat } from 'node:fs/promises';
import { createMailClient } from '../../client/mail-client.mjs';
import { memoryProof, sha256 } from './judge.mjs';

export const FIXTURE = 'TC-S1 原文：繁體中文的權杖撤銷與登入頁，請保留標點、換行和 emoji 😀。\n'.repeat(35) + '參考：https://example.com/acceptance\n';
export const fixtureFor = (runId, label, kind) => `TC-S1 ${runId} ${label} ${kind}\n` + FIXTURE;

export function searchRows(value) {
  const rows = Array.isArray(value) ? value : value?.messages ?? value?.results;
  if (!Array.isArray(rows) || rows.some((r) => !Number.isSafeInteger(r.id) || r.id <= 0)) throw new Error('INVALID_SEARCH_SCHEMA');
  return rows;
}
export function quotaTarget(mode, baseline) {
  if (!['0', 'restore'].includes(mode) || !Number.isSafeInteger(baseline?.dailyLimit) || baseline.dailyLimit <= 0) throw new Error('BASELINE_REQUIRED');
  return mode === '0' ? 0 : baseline.dailyLimit;
}

// Shell-free subprocesses; stdout/stderr are never forwarded. Callers project safe fields.
export function command(file, args, { input, env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b) => { size += b.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(b); });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('COMMAND_UNAVAILABLE')); });
    child.on('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error('COMMAND_FAILED')); else resolve(Buffer.concat(chunks).toString('utf8').trim()); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function privateText(file) {
  const s = await stat(file);
  if (!s.isFile() || (s.mode & 0o077)) throw new Error('PRIVATE_FILE_PERMISSIONS');
  return (await readFile(file, 'utf8')).trim();
}
export async function tokenFile(file) {
  const s = await privateText(file);
  const token = s.match(/^(?:HUB_TOKEN|HTTP_BEARER_TOKEN)=([A-Za-z0-9_-]{32,128})$/m)?.[1] ?? s;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('INVALID_TOKEN_FILE');
  return token;
}
export function validateConfig(c) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(c.groupId ?? '') || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.runId ?? '') ||
    !/^[a-f0-9]{40}$/.test(c.deploymentCommit ?? '') || !c.operator || !Number.isFinite(Date.parse(c.since))) throw new Error('INVALID_CONFIG');
  for (const name of Object.values(c.containers ?? {})) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('INVALID_CONTAINER');
  for (const d of Object.values(c.devices ?? {})) if (!/^tok_[a-z0-9]{8,32}$/.test(d.tokenId ?? '')) throw new Error('INVALID_DEVICE_ID');
  for (const g of [c.isolation?.a, c.isolation?.b].filter(Boolean)) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(g.mailContainer ?? '')) throw new Error('INVALID_CONTAINER');
  if (c.isolation && (!/^\/data\/[A-Za-z0-9_./-]+$/.test(c.isolation.foreignMarkerPath ?? '') || c.isolation.foreignMarkerPath.split('/').includes('..'))) throw new Error('INVALID_MARKER_PATH');
  for (const url of [c.mail?.url, c.memory?.url, c.isolation?.a?.url, c.isolation?.b?.url, ...Object.values(c.devices ?? {}).map((d) => d.url)].filter(Boolean)) {
    const u = new URL(url);
    if (u.username || u.password || u.search || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error('INVALID_URL');
  }
}
export async function dbSnapshot(c) {
  // Values are syntactically restricted above; no secrets or content columns in output.
  const group = c.groupId;
  const since = new Date(c.since).toISOString();
  const arrays = {
    audit: `select id, occurred_at, actor_id, action, target_id, request_id, jsonb_strip_nulls(jsonb_build_object('kind',details->'kind','citations',details->'citations','draft_mail_id',details->'draft_mail_id','status',details->'status')) as details from public.audit_log where group_id='${group}' and occurred_at >= '${since}' order by id`,
    devices: `select token_id, member_id, status, config_revision from public.devices where group_id='${group}' order by token_id`,
    members: `select id, role from public.members where group_id='${group}' and status='active' order by id`,
    notifications: `select id, member_id, mail_id, state, attempts, discord_message_id, digest_id, mail_created_at, updated_at from public.discord_notifications where group_id='${group}' and created_at >= '${since}' order by id`,
    decisions: `select draft_mail_id, status, version, confirmed_by, confirmed_at, encode(sha256(convert_to(text,'UTF8')),'hex') as text_sha256 from public.decisions where group_id='${group}' and created_at >= '${since}' order by draft_mail_id`,
  };
  const fields = Object.entries(arrays).map(([key, sql]) => `'${key}', (select coalesce(jsonb_agg(x),'[]'::jsonb) from (${sql}) x)`);
  const sql = `begin read only; set local timezone='UTC'; select jsonb_build_object(${fields.join(',')}); rollback;`;
  const output = await command('docker', ['exec', '-i', c.containers.db, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'hub', '-v', 'ON_ERROR_STOP=1'], { input: sql });
  return JSON.parse(output);
}
export async function settledDb(c, state, tc, label) {
  const tick = Math.min(20_000, Math.max(1000, c.botTickMs ?? 15_000));
  if (tc === 18 && label === 'repeat') await delay(tick * 2 + 1000);
  const expected = tc === 18 ? { online: 'sent', held: 'held', failed: 'failed', digest: 'digested', repeat: 'digested' }[label] : undefined;
  const labels = ['digest', 'repeat'].includes(label) ? ['held', 'failed'] : [label];
  const ids = labels.map((l) => state.seeds[l]?.messageId).filter(Number.isInteger);
  const deadline = Date.now() + 35_000;
  for (;;) {
    const db = await dbSnapshot(c);
    if (!expected || !ids.length) return db;
    const rows = db.notifications.filter((r) => ids.includes(Number(r.mail_id)) && (!c.memberId || r.member_id === c.memberId));
    if (ids.every((id) => rows.some((r) => Number(r.mail_id) === id && r.state === expected)) || Date.now() >= deadline) return db;
    // Read-only application polling, bounded; no send/Discord/model retries.
    await delay(1000);
  }
}
export async function runtimeSnapshot(c) {
  const source = `const e=process.env; const f=require('node:fs');
    const key=f.readFileSync((e.SECRETS_DIR??'/run/secrets')+'/eval_key','utf8').trim();
    const r=await fetch('http://127.0.0.1:'+(e.LLM_GATEWAY_PORT??8790)+'/status',{headers:{'x-api-key':key},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!r.ok)throw Error('STATUS'); const j=await r.json();
    console.log(JSON.stringify({backend:e.LLM_BACKEND??'groq-api',model:e.LLM_UPSTREAM_MODEL??'openai/gpt-oss-120b',dailyLimit:j.budget.dailyLimit,used:j.budget.usedRequests,reserved:j.budget.reservedRequests,day:j.budget.day,health:j.backend}));`;
  // CommonJS require plus top-level await is wrapped so Node supports both.
  return JSON.parse(await command('docker', ['exec', c.containers.gateway, 'node', '-e', `(async()=>{${source}})().catch(()=>process.exit(1))`]));
}
export async function imageSnapshot(c) {
  const out = [];
  for (const [service, name] of Object.entries(c.containers)) {
    const raw = await command('docker', ['inspect', '--format', '{{json .Image}}', name]);
    out.push({ service, image: JSON.parse(raw) });
  }
  return out;
}
export async function mailClient(c) {
  const sender = JSON.parse(await privateText(c.mail.senderFile));
  if (sender.projectKey !== `/data/projects/${c.groupId}`) throw new Error('SENDER_GROUP_MISMATCH');
  return createMailClient({ url: c.mail.url, token: await tokenFile(c.mail.tokenFile), agentName: sender.agentName, senderToken: sender.senderToken, projectKey: sender.projectKey,
    fetch: (url, options) => fetch(url, { ...options, redirect: 'error' }) });
}
export async function seed(c, label, kind, previous) {
  if (!['handoff', 'decision'].includes(kind)) throw new Error('INVALID_KIND');
  const client = await mailClient(c);
  const clientEventId = previous?.idempotencyKey ?? randomUUID();
  const text = fixtureFor(c.runId, label, kind);
  const receipt = await client.sendItem({ kind, intent: 'question', to: c.mail.to, cc: c.mail.cc ?? [],
    subject: `TC-S1 ${c.runId} ${label}`, summary: 'S1 固定驗收資料', text, sourceSession: `s1:${c.runId}`, links: ['https://example.com/acceptance'], clientEventId });
  return { ...receipt, kind, label, fixtureSha256: sha256(text) };
}

// Small bounded MCP session; do not return body text to the evidence layer.
export async function mcp(url, token) {
  let session, id = 0;
  async function request(method, params, notify = false) {
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(!notify ? { id: ++id } : {}) }) });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    let body;
    if (text && res.status < 400) body = JSON.parse(res.headers.get('content-type')?.includes('text/event-stream') ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).at(-1) : text);
    return { status: res.status, body };
  }
  const init = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'S1-acceptance', version: '1' } });
  if (init.status === 200) {
    if (!init.body?.result?.serverInfo) throw new Error('INVALID_MCP_INITIALIZE');
    await request('notifications/initialized', {}, true);
  }
  return { status: init.status, call: async (name, args) => {
    const r = await request('tools/call', { name, arguments: args });
    if (r.status !== 200 || r.body?.error || r.body?.result?.isError) throw new Error('MCP_TOOL_REJECTED');
    return r.body.result.structuredContent ?? JSON.parse(r.body.result.content[0].text);
  } };
}
export async function deviceProbes(c) {
  const result = {};
  for (const label of ['old', 'other', 'fresh']) {
    const d = c.devices[label];
    result[label] = (await mcp(d.url, await tokenFile(d.tokenFile))).status;
  }
  return result;
}
export async function applierReceipts(c, audit) {
  const out = [];
  for (const a of audit.filter((r) => /^device\.(issue|revoke)\.applied$/.test(r.action))) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(a.request_id)) throw new Error('INVALID_RECEIPT_ID');
    const r = JSON.parse(await readFile(`${c.receiptDir}/${a.request_id}.json`, 'utf8'));
    out.push({ request_id: r.request_id, op: a.action.split('.')[1], status: r.status, probe: r.probe, config_revision: r.config_revision });
  }
  return out;
}
export async function memoryProbes(c, seeds) {
  const client = await mailClient(c);
  const memory = await mcp(c.memory.url, await tokenFile(c.memory.tokenFile));
  if (memory.status !== 200) throw new Error('MEMORY_UNAUTHORIZED');
  const bridge = JSON.parse(await readFile(c.bridgeStateFile, 'utf8'));
  const rows = [];
  for (const s of Object.values(seeds)) {
    const message = (await client.readMessage(s.messageId)).message;
    const text = JSON.parse(message.body_md).text;
    const documentId = `mail-${s.messageId}`;
    const document = await memory.call('get_document', { document_id: documentId });
    const recall = await memory.call('recall', { query: `TC-S1 ${c.runId} ${s.label} ${s.kind} 權杖撤銷 登入頁`, include_chunks: true, max_tokens: 4096 });
    rows.push({ ...memoryProof({ text, document, recall, documentId }), kind: s.kind, bridgeStatus: bridge.requests?.[documentId]?.status,
      fixtureMatches: sha256(text) === s.fixtureSha256 });
  }
  return rows;
}
export async function unknownRecipient(c) {
  const client = await mailClient(c);
  const before = await client.fetchEvents({ after: 0 });
  const dbBefore = await dbSnapshot(c);
  let error;
  try { await client.sendItem({ kind: 'handoff', intent: 'question', to: [`Missing${c.runId.replace(/[^A-Za-z]/g, '')}`], subject: 'TC18 not saved', summary: '不保存驗收', text: FIXTURE, sourceSession: `s1:${c.runId}` }); }
  catch (e) { error = e.code; }
  await delay(2 * Math.min(20_000, Math.max(1000, c.botTickMs ?? 15_000)) + 1000);
  const after = await client.fetchEvents({ after: before.tailCursor });
  const dbAfter = await dbSnapshot(c);
  return { error, mailUnchanged: after.tailCursor === before.tailCursor && after.events.length === 0,
    notificationsUnchanged: JSON.stringify(dbBefore.notifications) === JSON.stringify(dbAfter.notifications) };
}
