// TC-14: real Caddy -> per-group validator -> per-group pinned Linux Mail; real Hindsight + Postgres.
// No paid LLM requests; all generated credentials, diagnostics and snapshots remain in .hub-local / private tmp.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,openSync,closeSync,readdirSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {startStack,hindsightRest,root} from './memory-stack.mjs';
import {deviceCredentials,openSession} from '../verify-h02.mjs';
import {waitForHealth} from './readiness.mjs';
import {mcpSession} from './mcp-http.mjs';
const scratch=join(root,'.hub-local/l08');mkdirSync(scratch,{recursive:true,mode:0o700});
const dir=mkdtempSync(join(scratch,'tc14-'));
const caddy=process.env.CADDY_BIN || join(root,'spikes/f01b/bin/caddy');
const port=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
function run(exe,args,env=process.env,options={}) {
 const r=spawnSync(exe,args,{env,encoding:'utf8',timeout:600000,...options});
 if(r.status!==0){writeFileSync(join(dir,'failure.log'),(r.stdout||'')+'\n'+(r.stderr||''),{mode:0o600});throw new Error(exe+' '+args[0]+' failed; diagnostics private');}return r.stdout.trim();
}
async function build(args,env) {const fd=openSync(join(dir,'build.log'),'a',0o600);try {const p=spawn('docker',args,{env,stdio:['ignore',fd,fd]});const [code]=await once(p,'exit');assert.equal(code,0,'Docker build failed (private log)');}finally{closeSync(fd);}}
const groups=[];let caddyProcess,memory,bankB;
const sha=v=>createHash('sha256').update(v).digest('hex');
const marker='GROUP-B-PRIVATE-FILESYSTEM-MARKER';
try {
 run(caddy,['version']);
 console.log('STEP build validator and provision two Mail containers');
 await build(['build','-t','neighbor-validator:l08-test',join(root,'server/validator')],process.env);
 for(const id of ['grp-test','grp-test2']) {
  const privateDir=join(dir,id);mkdirSync(privateDir,{mode:0o700});
  const policyDir=join(privateDir,'validator');mkdirSync(policyDir,{mode:0o700});writeFileSync(join(policyDir,'validator-allowlist.json'),'{"entries":[]}',{mode:0o600});
  run('python3',[join(root,'ops/init-secrets'),'--state-dir',privateDir,'--group-id',id]);
  const backendPort=await port(),publicPort=await port();
  const project='l08-'+id+'-'+Date.now();
  const env={...process.env,HUB_GROUP_ID:id,HUB_PRIVATE_DIR:privateDir,HUB_VALIDATOR_POLICY_DIR:policyDir,HUB_MAIL_PORT:String(backendPort),HUB_OPS_UID:String(process.getuid()),HUB_OPS_GID:String(process.getgid()),HUB_VALIDATOR_IMAGE:'neighbor-validator:l08-test'};
  const args=['compose','-p',project,'-f',join(root,'deploy/compose.yaml'),'-f',join(root,'deploy/validator/compose.validator.yaml')];
  const compose=(...a)=>run('docker',[...args,...a],env);
  const g={id,privateDir,policyDir,env,compose,project,backendPort,base:'http://127.0.0.1:'+publicPort};groups.push(g);
  compose('up','-d','--wait','--wait-timeout','120','mail-a','validator');
  run('python3',[join(root,'ops/bootstrap'),'--state-dir',privateDir,'--url',`http://127.0.0.1:${backendPort}/mcp/`]);
  g.credentials=await deviceCredentials(privateDir);g.container=compose('ps','-q','mail-a');
  const info=JSON.parse(run('docker',['inspect',g.container]))[0];
  assert.equal(Object.keys(info.HostConfig.PortBindings||{}).length,0);
  assert.equal(info.Mounts.length,1);assert.equal(info.Mounts[0].Destination,'/data');g.volume=info.Mounts[0].Name;
  assert.deepEqual(Object.keys(info.NetworkSettings.Networks),[project+'_mail_a_net']);
 }
 assert.notEqual(groups[0].volume,groups[1].volume);
 console.log('PASS two isolated Mail volumes/networks; no raw Mail host ports');
 console.log('STEP provision real Hindsight and group-bound bank proxies');
 memory=await startStack({groupId:'grp-test'});
 memory.pgc('up','-d','--wait','--wait-timeout','90','db');memory.pg('migrate');memory.pg('hindsight-init');
 for(const [i,g] of groups.entries()) {
  const member=`00000000-0000-4000-8000-0000000000${i?'b':'a'}1`;
  memory.sql(`insert into groups(id,display_name,project_key,mail_hostname,bank_id) values ('${g.id}','test','/data/projects/${g.id}','${g.id}.hub-local','${g.id}');
  insert into members(id,group_id,display_name,role) values ('${member}','${g.id}','test','owner');
  insert into discord_links(member_id,guild_id,discord_user_id,last_interaction_id) values ('${member}','10000000\x3000000000${i+1}','20000000\x3000000000${i+1}','test-${i}');
  insert into devices(member_id,group_id,label,platform,token_id,token_prefix,token_hash,allowed_agents) values ('${member}','${g.id}','test','linux','tok_grptest0${i+1}','mph_test','${sha(g.credentials.mac.token)}','{RedStone}');`);
 }
 await build(['compose','-p',memory.memProject,'-f',join(root,'deploy/memory/compose.yaml'),'build','bank-proxy'],memory.env);
 memory.memc('up','-d','--wait','--wait-timeout','600','hindsight','bank-proxy');groups[0].memoryPort=memory.port;
 const bankPort=await port();groups[1].memoryPort=bankPort;
 const state=join(dir,'bank-b');mkdirSync(state,{mode:0o777});
 bankB='l08-bank-b-'+Date.now();
 const mounts=[];
 for(const [src,dst] of [['hub-app.password','hub_app_password'],['hindsight-api.key','hindsight_api_key'],['anthropic.key','anthropic_api_key'],['llm-gateway.key','llm_gateway_key']]) mounts.push('--mount',`type=bind,src=${join(memory.env.HUB_MEMORY_PRIVATE_DIR,'bank-proxy',src)},dst=/run/secrets/${dst},readonly`);
 run('docker',['create','--name',bankB,'--network',memory.dbProject+'_hub-db-net','-p',`127.0.0.1:${bankPort}:8780`,'-e','HUB_GROUP_ID=grp-test2','-e','HUB_DB_HOST=db','-e','HINDSIGHT_URL=http://hindsight:8888','-v',state+':/state',...mounts,'neighbor-bank-proxy:l02-test']);
 run('docker',['network','connect',memory.memProject+'_memory-net',bankB]);run('docker',['start',bankB]);
 await waitForHealth('http://127.0.0.1:'+bankPort+'/healthz',{step:'second bank proxy'});
 for(const g of groups) assert.equal(hindsightRest(memory,'PUT','/v1/default/banks/'+g.id,{name:g.id}).status,200);
 const admin=await port(),officePort=await port();const office='http://127.0.0.1:'+officePort;
 let config=`{\n admin 127.0.0.1:${admin}\n auto_https off\n persist_config off\n}\n${office} {\n respond "office preserved" 200\n}\n`;
 for(const g of groups) {
  const snippet=join(g.privateDir,'auth.caddy');
  run('python3',[join(root,'ops/render-caddy'),'--state-dir',g.privateDir,'--prepare-only','--owner','self','--output',snippet,'--upstream','127.0.0.1:'+g.backendPort,'--memory-upstream','127.0.0.1:'+g.memoryPort]);
  config+=`${g.base} {\n import ${JSON.stringify(snippet)}\n}\n`;
 }
 const configPath=join(dir,'Caddyfile');writeFileSync(configPath,config,{mode:0o600});
 run(caddy,['validate','--config',configPath,'--adapter','caddyfile']);
 caddyProcess=spawn(caddy,['run','--config',configPath,'--adapter','caddyfile'],{env:{...process.env,XDG_DATA_HOME:join(dir,'caddy-data'),XDG_CONFIG_HOME:join(dir,'caddy-config')},stdio:'ignore'});
 await waitForHealth(office,{step:'Caddy'});
 const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
 const dbContainer=memory.pgc('ps','-q','db').trim();
 for(const [i,g] of groups.entries()) {
  const tokenDir=join(g.privateDir,'tokens-db'),spool=join(g.privateDir,'spool');
  mkdirSync(tokenDir,{mode:0o700});mkdirSync(spool,{mode:0o700});
  writeFileSync(join(tokenDir,'tok_grptest0'+(i+1)),g.credentials.mac.token+'\n',{mode:0o600});
  run('python3',[join(root,'ops/token-applier'),'render','--group-id',g.id,'--state',g.privateDir,'--token-dir',tokenDir,'--spool',spool,
   '--output',join(g.privateDir,'auth.caddy'),'--owner','self','--config',configPath,'--caddy-bin',caddy,
   '--reload-cmd',quote(caddy)+' reload --config '+quote(configPath)+' --adapter caddyfile',
   '--upstream','127.0.0.1:'+g.backendPort,'--memory-upstream','127.0.0.1:'+g.memoryPort,'--probe-url',g.base+'/health/liveness',
   '--psql',`docker exec -i ${dbContainer} psql -X -U postgres -d hub -v ON_ERROR_STOP=1`]);
 }
 console.log('PASS group-bound TokenApplier DB export -> Caddy validate/reload, preserving each group Mail/memory route');
 const paths=['/','/mcp','/mcp/','/health/liveness','/health/readiness','/api/','/mail/','/mail/api/unified-inbox','/mail/ws-state','/openapi.json','/metrics','/unknown','/memory/mcp/','/memory/mcp/grp-test/','/memory/mcp/grp-test2/','/memory/v1/default/banks'];
 let checks=0;
 for(const [i,g] of groups.entries()) for(const path of paths) for(const method of ['GET','POST','DELETE']) {
  const r=await fetch(g.base+path,{method,headers:{authorization:'Bearer '+groups[1-i].credentials.mac.token},redirect:'manual'});await r.text();assert.equal(r.status,401,'foreign token accepted');checks++;
 }
 console.log('PASS TC14.1 '+checks+' cross-group token requests: GET/POST/DELETE on all ingress path classes -> 401');
 for(const [i,g] of groups.entries()) {
  const own=await openSession(g.base+'/mcp/',g.credentials.mac.token);
  const legitimate=await own.request('tools/call',{name:'ensure_project',arguments:{human_key:'/data/projects/'+g.id}});
  assert.ok(!JSON.parse(legitimate.text).error,'own project must work');
  const foreign=groups[1-i];
  const denied=await own.request('tools/call',{name:'ensure_project',arguments:{human_key:'/data/projects/'+foreign.id}});
  assert.equal(JSON.parse(denied.text).error?.code,-32009);
 }
 const [a,b]=groups;const markerPath='/data/projects/grp-test2/private-marker.txt';
 run('docker',['exec',b.container,'sh','-c','mkdir -p /data/projects/grp-test2 && printf %s '+marker+' > '+markerPath]);
 run('docker',['exec',a.container,'sh','-c','test ! -e '+markerPath]);
 const session=await openSession(a.base+'/mcp/',a.credentials.mac.token);
 for(const extra of [{attachment_paths:[markerPath]},{body_md:'![private]('+markerPath+')'},{body_md:'<img src="'+markerPath+'">'}]) {
  const r=await session.request('tools/call',{name:'send_message',arguments:{project_key:'/data/projects/grp-test',sender_name:a.credentials.mac.agentName,sender_token:a.credentials.mac.senderToken,to:[a.credentials.windows.agentName],subject:'TC14 attachment',body_md:'private',...extra}});
  assert.equal(JSON.parse(r.text).error?.code,-32007);assert.ok(!r.text.includes(marker));
 }
 const snapshot=join(dir,'archive-a');run('docker',['cp',a.container+':/data/archive',snapshot]);
 const scan=p=>{for(const name of readdirSync(p)){const file=join(p,name);if(statSync(file).isDirectory())scan(file);else assert.ok(!readFileSync(file).includes(Buffer.from(marker)),'marker escaped into archive');}};scan(snapshot);
 console.log('PASS TC14.2 foreign ensure_project rejected; B marker physically absent in A; attachment_paths/Markdown/HTML rejected; A archive contains no marker');
 for(const [i,g] of groups.entries()) {
  const base=g.base+'/memory';const headers={authorization:'Bearer '+g.credentials.mac.token,'content-type':'application/json',accept:'application/json, text/event-stream'};
  const own=await mcpSession(base+'/mcp/'+g.id+'/',g.credentials.mac.token);assert.equal(own.init.status,200);
  const listing=await own.call('list_banks',{});assert.equal(listing.body.error?.data?.reason,'TOOL_NOT_ALLOWED');
  const banks=await fetch(base+'/mcp/',{method:'POST',headers,body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'});assert.equal(banks.status,403);
  const foreign=groups[1-i];assert.equal((await fetch(base+'/mcp/'+foreign.id+'/',{headers})).status,403);
  const override=await own.call('recall',{bank_id:foreign.id,query:'private'});assert.equal(override.status,403);
  for(const path of ['/mcp/'+g.id+'/','/mcp/','/v1/default/banks','/metrics']) assert.equal((await fetch('http://127.0.0.1:'+g.memoryPort+path,{headers:{authorization:'Bearer '+foreign.credentials.mac.token}})).status,401);
 }
 console.log('PASS TC14.3 real Hindsight: own bank initializes; list_banks/multi-bank/foreign bank path and bank_id refused; foreign token 401 at each proxy');
 run('docker',['run','--rm','--network',memory.dbProject+'_hub-db-net','-v',root+':/repo:ro','-v',memory.env.HUB_PRIVATE_DIR+':/run/private:ro','-e','FOREIGN_TEST_TOKEN','node:24-alpine','node','/repo/ops/test/group-db.mjs'],{...process.env,FOREIGN_TEST_TOKEN:b.credentials.mac.token});
 console.log('PASS TC14 DB application queries as hub_app/service_role: registry/member/notification/cursor/device/budget isolation');
 const officeReply=await fetch(office);assert.equal(await officeReply.text(),'office preserved');
 console.log('PASS TC14 complete: grp-test + grp-test2; office preserved; no LLM generation requested');
} catch(e) {console.error('FAIL TC14: '+e.message);process.exitCode=1;}
finally {
 if(caddyProcess?.exitCode===null){const exit=once(caddyProcess,'exit');caddyProcess.kill('SIGTERM');await exit;}
 if(bankB)try{run('docker',['rm','-f',bankB]);}catch{process.exitCode=1;}
 if(memory)memory.stop();
 for(const g of groups)try{g.compose('down','--volumes','--remove-orphans');}catch{process.exitCode=1;}
 console.log('CLEANED L08 disposable stacks');
}
