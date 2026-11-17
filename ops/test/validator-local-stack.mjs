// L-07 acceptance: real Caddy -> real validator -> pinned Agent Mail Linux image.
// All credentials and intentionally rejected synthetic samples stay in .hub-local scratch.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, chmod, open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceCredentials } from '../verify-h02.mjs';
import { waitForHealth } from './readiness.mjs';
import { createMailClient } from '../../client/mail-client.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
await mkdir(join(root, '.hub-local/l07'), { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, '.hub-local/l07/stack-'));
const privateDir = join(dir, 'private');
const policyDir = join(privateDir, 'validator');
await mkdir(policyDir, { recursive: true, mode: 0o700 });
const policy = join(policyDir, 'validator-allowlist.json');
await writeFile(policy, '{"entries":[]}\n', { mode: 0o600 });
const caddy = process.env.CADDY_BIN || join(root, 'spikes/f01b/bin/caddy');
const project = 'neighbor-l07-' + Date.now();
async function port() {
 const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const chosen = server.address().port; await new Promise(r => server.close(r)); return chosen;
}
const [backendPort, hubPort, officePort, adminPort] = await Promise.all([port(), port(), port(), port()]);
const base = 'http://127.0.0.1:' + hubPort;
const office = 'http://127.0.0.1:' + officePort;
const env = { ...process.env, HUB_GROUP_ID: 'group-a', HUB_PRIVATE_DIR: privateDir, HUB_VALIDATOR_POLICY_DIR: policyDir,
 HUB_MAIL_PORT: String(backendPort), HUB_OPS_UID: String(process.getuid()), HUB_OPS_GID: String(process.getgid()),
 HUB_VALIDATOR_IMAGE: project + ':test', XDG_DATA_HOME: join(dir, 'caddy-data'), XDG_CONFIG_HOME: join(dir, 'caddy-config') };
const baseArgs = ['compose', '-p', project, '-f', join(root, 'deploy/compose.yaml')];
const validatorArgs = [...baseArgs, '-f', join(root, 'deploy/validator/compose.validator.yaml')];
function run(exe, args, options = {}) {
 const r = spawnSync(exe, args, { cwd: root, env, encoding: 'utf8', timeout: 240_000, ...options });
 if (r.status !== 0) {
  writeFileSync(join(dir,'failed-command.log'),(r.stdout||'')+'\n'+(r.stderr||''),{mode:0o600});
  throw new Error(exe + ' ' + args[0] + ' exit=' + r.status + '; private diagnostics in scratch');
 }
 return r.stdout.trim();
}
async function build() {
 const log = await open(join(dir, 'build.log'), 'w', 0o600);
 try {
  const p = spawn('docker', [...validatorArgs, 'build', 'validator'], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
  const [code] = await once(p, 'exit'); if (code !== 0) throw new Error('validator build exit=' + code);
 } finally { await log.close(); }
}
const ops = (name,...args) => run('python3',[join(root, 'ops',name),'--state-dir',privateDir,...args]);
const compose = (...args) => run('docker',[...validatorArgs,...args]);
const sha = value => createHash('sha256').update(value).digest('hex');
const projectKey = '/data/projects/group-a';
const fakePAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const fakeSlack = '\x78oxb-781236542736-2364535789652-' + 'GkwFDQoHqzXDVsC6GzqYUypD';
let caddyProc, created = false, credentials, container;
let phase = 'setup';
const parse = r => JSON.parse(r.text);
function toolPayload(r) {
 const rpc = parse(r);
 assert.equal(r.status, 200); assert.equal(rpc.error, undefined, 'unexpected RPC error');
 assert.ok(!rpc.result.isError, 'Mail rejected a legitimate tool request');
 return JSON.parse(rpc.result.content[0].text);
}
async function session(token) {
 let id=0,sid;
 async function request(method,params,notify=false) {
  const r=await fetch(base+'/mcp/',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,...(sid?{'mcp-session-id':sid}:{})},
   body:JSON.stringify({jsonrpc:'2.0',method,params,...(!notify?{id:'l07-sdk-'+(++id)}:{})}),signal:AbortSignal.timeout(10000)});
  sid=r.headers.get('mcp-session-id')||sid;
  const text=await r.text();
  if(!notify&&r.status===200) assert.equal(JSON.parse(text).id,'l07-sdk-'+id,'SDK string ID lost correlation');
  return {status:r.status,text,serverTiming:r.headers.get('server-timing')};
 }
 const init=await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'l07-raw-mcp',version:'1'}});
 assert.equal(init.status,200);assert.ok(parse(init).result.serverInfo);assert.ok(sid);
 assert.ok((await request('notifications/initialized',{},true)).status<300);
 return {request};
}
const sendArgs = body => ({ project_key: projectKey, sender_name: credentials.mac.agentName, sender_token: credentials.mac.senderToken,
 to: [credentials.windows.agentName], subject: 'L07 synthetic acceptance', body_md: body, idempotency_key: randomUUID(), convert_images: false });
async function rawSend(s, body, name = 'send_message', extra = {}) {return s.request('tools/call', { name, arguments: { ...sendArgs(body), ...extra } });}
async function cursor(s) {return toolPayload(await s.request('tools/call',{name:'fetch_inbox_events',arguments:{project_key:projectKey,agent_name:credentials.windows.agentName,after:0,limit:1000}}));}
async function assertOffice() {const r=await fetch(office);assert.equal(r.status,200);assert.equal(await r.text(),'office preserved');assert.equal(caddyProc.exitCode,null);}
async function savePolicy(entries) {
 const temp = policy + '.tmp'; await writeFile(temp,JSON.stringify({entries}),{mode:0o600});await rename(temp,policy);
 // macOS VirtioFS can briefly expose ENOENT across an atomic host rename.
 // Retry only a read-only health probe, never a message submission.
 await waitForHealth(base+'/health/readiness',{step:'policy file visibility',headers:{authorization:'Bearer '+credentials.mac.token}});
}
try {
 ops('init-secrets');
 compose('config','--quiet');
 phase='build';console.log('STEP build pinned Go / gitleaks v8.30.1 validator');await build();
 phase='baseline';created=true;run('docker',[...baseArgs,'up','-d','--wait','--wait-timeout','120','mail-a']);
 const snippet=join(dir,'auth.caddy');
 ops('render-caddy','--prepare-only','--owner','self','--output',snippet,'--upstream','127.0.0.1:'+backendPort);
 const config=join(dir,'Caddyfile');
 await writeFile(config,'{\n admin 127.0.0.1:'+adminPort+'\n auto_https off\n persist_config off\n}\n'+office+' {\n respond "office preserved" 200\n}\n'+base+' {\n import '+JSON.stringify(snippet)+'\n}\n',{mode:0o600});
 run(caddy,['validate','--config',config,'--adapter','caddyfile']);
 caddyProc=spawn(caddy,['run','--config',config,'--adapter','caddyfile'],{env,stdio:'ignore'});
 await waitForHealth(office,{step:'office baseline'});
 ops('bootstrap','--url','http://127.0.0.1:'+backendPort+'/mcp/');
 credentials=await deviceCredentials(privateDir);
 await waitForHealth(base+'/health/liveness',{step:'baseline',headers:{authorization:'Bearer '+credentials.mac.token}});

 phase='activate production topology';console.log('STEP enable validator; remove every mail-a host port');
 compose('up','-d','--wait','--wait-timeout','120','mail-a','validator');
 container=compose('ps','-q','mail-a');
 const inspect=JSON.parse(run('docker',['inspect',container]))[0];
 assert.equal(Object.keys(inspect.HostConfig.PortBindings||{}).length,0);
 const vid=compose('ps','-q','validator');
 const vi=JSON.parse(run('docker',['inspect',vid]))[0];
 assert.equal(vi.HostConfig.Memory,192*1024*1024);assert.equal(vi.HostConfig.MemorySwap,192*1024*1024);assert.ok(vi.Config.Env.includes('GOMEMLIMIT=96MiB'));assert.equal(vi.HostConfig.ReadonlyRootfs,true);assert.deepEqual(vi.HostConfig.CapDrop,['ALL']);
 assert.deepEqual(vi.HostConfig.PortBindings['8766/tcp'].map(x=>x.HostIp),['127.0.0.1']);
 await waitForHealth(base+'/health/liveness',{step:'validator ingress',headers:{authorization:'Bearer '+credentials.mac.token}});
 await assertOffice();
 console.log('PASS no mail-a host port; validator loopback-only / 192 MiB / GOMEMLIMIT 96 MiB / read-only / cap_drop ALL; office unchanged');
 phase='direct raw MCP';
 const mac=await session(credentials.mac.token),win=await session(credentials.windows.token);
 const legit='繁體中文與 emoji 😀\n不改原文';
 const saved=toolPayload(await rawSend(mac,legit));
 const reader=createMailClient({url:base+'/mcp/',token:credentials.windows.token,projectKey,agentName:credentials.windows.agentName,senderToken:credentials.windows.senderToken});
 assert.equal((await reader.readMessage(saved.message_id)).message.body_md,legit);
 for(const body of ['😀'.repeat(20000),JSON.stringify({v:1,text:'文'.repeat(20000),summary:'合法 envelope'})]) {
  const saved=toolPayload(await rawSend(mac,body));assert.equal((await reader.readMessage(saved.message_id)).message.body_md,body);
 }
 console.log('PASS raw MCP legal content + 20,000 emoji + envelope boundary saved and retrieved verbatim');
 const initial=(await cursor(win)).tail_cursor;
 assert.equal(typeof initial,'number','Mail must expose a real durable delivery cursor');
 const rejected=[['send_message','L07_REJECT_LONG_'+ '文'.repeat(20001)],['send_message',fakePAT],['send_message',fakeSlack],['send_message',fakePAT+' # gitleaks:allow'],['send_message',String.raw`{"v":1,"text":"\u0067hp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`],['reply_message',fakePAT],['macro_contact_handshake',fakeSlack],['send_message',JSON.stringify({v:1,text:'😀'.repeat(20001)})]];
 for(const [name,body] of rejected) {
  const r=await rawSend(mac,body,name);
  const error=parse(r).error;
  assert.equal(error?.code,-32007,'direct MCP write was not rejected');
  assert.ok(!r.text.includes(fakePAT) && !r.text.includes(fakeSlack),'secret echoed');
 }
 assert.equal((await cursor(win)).tail_cursor,initial,'rejections created inbox events');
 console.log('PASS 8 direct MCP rejections: long/plain+envelope, PAT, official Slack sample, inline allow, Unicode escape, reply, macro; delivery cursor unchanged');
 // Inspect persistence BEFORE any explicitly allowlisted copy is stored.
 const copied=join(dir,'mail-snapshot');await mkdir(copied,{mode:0o700});
 run('docker',['cp',container+':/data/.',copied]);
 const script=`import pathlib,sqlite3,sys\nroot=pathlib.Path(sys.argv[1]);c=sqlite3.connect(root/'mail.sqlite3')\nneedles=[${JSON.stringify(fakePAT)},${JSON.stringify(fakeSlack)},'L07_REJECT_LONG_']\nfor row in c.iterdump():\n assert not any(n in row for n in needles), 'rejected input in SQLite'\nfor p in (root/'archive').rglob('*'):\n if p.is_file():\n  b=p.read_bytes(); assert not any(n.encode() in b for n in needles), 'rejected input in archive'\nprint('PASS SQLite and archive contain no rejected sample')`;
 const check=spawnSync('python3',['-c',script,copied],{env,encoding:'utf8'});
 assert.equal(check.status,0,'persistence inspection failed; no contents printed');console.log(check.stdout.trim());
 phase='allowlist';await savePolicy([{rule_id:'github-pat',sha256:sha(fakePAT),reason:'維護者 synthetic local acceptance'}]);
 const allowedResponse=await rawSend(mac,fakePAT);
 await writeFile(join(dir,'allowlist-response.json'),allowedResponse.text,{mode:0o600});
 const allowed=toolPayload(allowedResponse);
 assert.equal((await reader.readMessage(allowed.message_id)).message.body_md,fakePAT);
 await savePolicy([]);assert.equal(parse(await rawSend(mac,fakePAT)).error.code,-32007);
 await writeFile(policy,'broken policy',{mode:0o600});assert.equal((await rawSend(mac,'ordinary')).status,503);
 await savePolicy([]);
 for(const path of ['/api/messages','/mail/api/send']) assert.equal((await fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+credentials.mac.token},body:'{}'})).status,404);
 assert.equal((await fetch(base+'/mcp/',{method:'POST',body:'{}'})).status,401);
 console.log('PASS exact allowlist atomic reload/removal; invalid policy 503; alternate APIs 404; missing auth 401');
 console.log(run('node',[join(root,'ops/verify-l07.mjs'),'--url',base+'/mcp/','--credentials-dir',privateDir]));
 phase='latency';console.log('STEP 30 paired maximum-length legal replays per path, same saved message / alternating order');
 const latencyOutput=run('docker',['run','--rm','--network',project+'_mail_a_net','--user',env.HUB_OPS_UID+':'+env.HUB_OPS_GID,
  '-v',privateDir+':/run/private:ro','-v',join(root,'ops/test/validator-latency.mjs')+':/bench.mjs:ro',
  'node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5','node','/bench.mjs']);
 console.log('LATENCY '+latencyOutput);
 await assertOffice();
 const logResult=spawnSync('docker',['logs',vid],{env,encoding:'utf8'});
 assert.equal(logResult.status,0);const logs=logResult.stdout+logResult.stderr;assert.ok(!logs.includes(fakePAT)&&!logs.includes(fakeSlack));
 console.log('PASS <100 ms measured added latency; validator logs contain no samples; office HTTP/content and Caddy process unchanged');
 assert.equal(JSON.parse(run('docker',['inspect',vid]))[0].RestartCount,0,'validator restarted during core acceptance');
 phase='HubClock through validator';
 const clockDir=join(dir,'hubclock');await mkdir(clockDir,{mode:0o700});env.HUBCLOCK_STATE_DIR=clockDir;
 const clockArgs=[...baseArgs,'-f',join(root,'deploy/hubclock/compose.hubclock.yaml'),'-f',join(root,'deploy/validator/compose.validator.yaml'),'-f',join(root,'deploy/validator/compose.hubclock-validator.yaml')];
 run('docker',[...clockArgs,'up','-d','--no-recreate','--wait','--wait-timeout','120','hubclock']);
 const clockID=run('docker',[...clockArgs,'ps','-q','hubclock']);
 const clockInspect=JSON.parse(run('docker',['inspect',clockID]))[0];
 assert.ok(clockInspect.Config.Env.includes('HUBCLOCK_MAIL_URL=http://validator:8766/mcp/'));
 const deadline=performance.now()+30000;let tick=false;
 while(performance.now()<deadline){
  const r=spawnSync('docker',['logs',clockID],{encoding:'utf8'});
  const events=(r.stdout+'\n'+r.stderr).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  assert.ok(!events.some(e=>['fatal','crash','tick_failed'].includes(e.ev)),'HubClock failed through validator');
  if(events.some(e=>e.ev==='tick')){tick=true;break;}
  await new Promise(r=>setTimeout(r,250));
 }
 assert.ok(tick,'HubClock did not complete a tick');await assertOffice();
 console.log('PASS HubClock primary tick through validator; office unchanged');
 run('docker',[...clockArgs,'stop','hubclock']);
 // Give each existing integration suite its original fresh-DB contract.
 const regressionSuites=process.env.L07_REGRESSION==='0'?[]:['client/test/mail-client.integration.test.mjs','client/test/hub-hook.integration.test.mjs','ops/lifecycle/test/lifecycle.integration.test.mjs'];
 if(!regressionSuites.length) console.log('REGRESSIONS omitted by explicit L07_REGRESSION=0; only core acceptance requested');
 for(const suite of regressionSuites) {
  phase='regression '+suite;console.log('STEP '+phase);
  run('docker',[...clockArgs,'down','--volumes','--remove-orphans']);
  compose('up','-d','--wait','--wait-timeout','120','mail-a','validator');
  const output=run('node',['--test',suite],{timeout:1_200_000,env:{...env,MAIL_TEST_URL:'http://127.0.0.1:'+backendPort+'/mcp/',MAIL_TEST_ENV_FILE:join(privateDir,'mail-a.env')}});
  const summary=output.split('\n').filter(line=>/^(ℹ|#) (tests|pass|fail|skipped)/.test(line));console.log(summary.join('\n'));
  assert.ok(/(?:ℹ|#) skipped 0/.test(output),'regression must not skip');
  const runtime=JSON.parse(run('docker',['inspect',compose('ps','-q','validator')]))[0];
  assert.equal(runtime.RestartCount,0,'validator restarted during '+suite);
  assert.equal(runtime.State.OOMKilled,false,'validator OOM during '+suite);
  console.log('PASS validator zero restarts / no OOM during '+suite);
  await assertOffice();
 }
 console.log('PASS L-07 local-stack acceptance (Linux/amd64 Mail+validator on macOS ARM Docker; VPS/TLS remain operator checks)');
} catch(e) {
 console.error('FAIL L-07 phase='+phase+': '+e.message);process.exitCode=1;
 if(created) {
  try {
   const id=compose('ps','-aq','validator');
   if(id){const info=JSON.parse(run('docker',['inspect',id]))[0];console.log('VALIDATOR_STATE '+JSON.stringify({state:info.State.Status,oom:info.State.OOMKilled,restarts:info.RestartCount,exit:info.State.ExitCode}));}
  } catch {}
 }
}
finally {
 if(caddyProc?.exitCode===null){const done=once(caddyProc,'exit');caddyProc.kill('SIGTERM');await done;}
 if(created){try {compose('down','--volumes','--remove-orphans');console.log('CLEANED '+project);}catch {console.error('FAIL cleanup '+project);process.exitCode=1;}}
}
