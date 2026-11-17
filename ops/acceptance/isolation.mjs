import { readFile } from 'node:fs/promises';
import { command, mailClient, tokenFile, mcp } from './collect.mjs';

const PATHS = ['/mcp/', '/api/', '/mail/', '/mail/api/unified-inbox', '/mail/ws-state', '/health/liveness', '/openapi.json', '/memory/mcp/'];
export async function isolationProbes(c) {
  const i = c.isolation;
  if (!i || !/^[a-z][a-z0-9-]{1,62}$/.test(i.otherGroup) || i.otherGroup === c.groupId) throw new Error('ISOLATION_CONFIG_REQUIRED');
  const results = [];
  const groups = [i.a, i.b];
  for (let n = 0; n < 2; n++) {
    const token = await tokenFile(groups[n].tokenFile);
    for (const path of PATHS) {
      const r = await fetch(new URL(path, groups[1 - n].url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      await r.body?.cancel();
      results.push({ category: 'crossBearer', direction: n, path, status: r.status, ok: r.status === 401 });
    }
  }
  const client = await mailClient(c);
  async function rejected(category, tool, args) {
    let ok = false;
    try { await client.callTool(tool, args); }
    catch (e) { ok = e.code === 'E-HUB' && ['tool_error', 'rpc_error'].includes(e.reason); }
    results.push({ category, ok });
  }
  await rejected('foreignProject', 'ensure_project', { human_key: `/data/projects/${i.otherGroup}` });
  const identity = JSON.parse(await readFile(c.mail.senderFile, 'utf8'));
  await rejected('attachment', 'send_message', { project_key: identity.projectKey, sender_name: identity.agentName, sender_token: identity.senderToken,
    to: c.mail.to, subject: 'TC14 attachment boundary', body_md: 'S1 isolation fixture', attachment_paths: [i.foreignMarkerPath], convert_images: false });
  // Archive marker check reads only group A's approved /data mount; outputs a boolean.
  const marker = 'GROUP-B-PRIVATE-FILESYSTEM-MARKER';
  const bMarker = await command('docker', ['exec', i.b.mailContainer, 'cat', i.foreignMarkerPath]);
  if (bMarker.trim() !== marker) throw new Error('ISOLATION_MARKER_MISSING');
  const escaped = await command('docker', ['exec', i.a.mailContainer, 'sh', '-c', 'if grep -R -q GROUP-B-PRIVATE-FILESYSTEM-MARKER /data; then echo escaped; else r=$?; if [ "$r" = 1 ]; then echo absent; else exit "$r"; fi; fi']);
  results.push({ category: 'archiveMarker', ok: escaped === 'absent' });
  const mounts = [];
  for (const g of groups) mounts.push(JSON.parse(await command('docker', ['inspect', '--format', '{{json .Mounts}}', g.mailContainer])).filter((m) => m.Destination === '/data').map((m) => m.Source));
  const volumeSeparated = mounts.every((m) => m.length === 1) && mounts[0][0] !== mounts[1][0] &&
    !mounts[0][0].startsWith(mounts[1][0] + '/') && !mounts[1][0].startsWith(mounts[0][0] + '/');
  const session = await mcp(c.memory.url, await tokenFile(c.memory.tokenFile));
  if (session.status !== 200) throw new Error('MEMORY_UNAUTHORIZED');
  let bankSeparated = false;
  try { await session.call('recall', { query: 'GROUP-B-PRIVATE-FILESYSTEM-MARKER', bank_id: i.otherGroup }); }
  catch (e) { bankSeparated = e.message === 'MCP_TOOL_REJECTED'; }
  const foreignBank = await fetch(new URL(`/memory/mcp/${i.otherGroup}/`, i.a.url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${await tokenFile(i.a.tokenFile)}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  await foreignBank.body?.cancel();
  bankSeparated &&= foreignBank.status === 403;
  // Execute the deployed bot's own bound store against its real DB, without Discord login.
  const source = `import {loadConfig} from '/app/bot/src/main.mjs'; import {createPool,createPgStore} from '/app/bot/src/store-pg.mjs';
    const cfg=await loadConfig(); if(cfg.groupId!==${JSON.stringify(c.groupId)})throw Error('BOUND_GROUP_MISMATCH'); const pool=await createPool(cfg.pg); const store=createPgStore({pool,groupId:cfg.groupId});
    try { const other=${JSON.stringify(i.otherGroup)};
      const present=await pool.query('select count(*)::int as n from public.members where group_id=$1',[other]);
      const dbSeparated=(await store.recentItems(other,20)).length===0 && present.rows[0].n>0;
      const decisions=await pool.query('select count(*)::int as n from public.decisions where group_id=$1',[other]);
      const decisionsSeparated=(await store.listDecisions(other,{})).length===0 && decisions.rows[0].n>0;
      console.log(JSON.stringify({dbSeparated,decisionsSeparated})); } finally {await pool.end();}`;
  const db = JSON.parse(await command('docker', ['exec', '-i', c.containers.bot, 'node', '--input-type=module'], { input: source }));
  let originalHealthy = true;
  for (const g of groups) originalHealthy &&= (await mcp(new URL('/mcp/', g.url).href, await tokenFile(g.tokenFile))).status === 200;
  return { expected: PATHS.length * 2 + 3, results, volumeSeparated, ...db, bankSeparated, originalHealthy };
}
