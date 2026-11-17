// Runs inside the isolated Compose network: replay the SAME saved 20k message
// over both paths. This isolates proxy overhead from Mail's asynchronous archive
// IO; every receipt must identify the original saved message. Credentials are files.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const dir='/run/private';
const token=(await readFile(dir+'/mail-a.env','utf8')).match(/^HTTP_BEARER_TOKEN=(.+)$/m)[1];
const mac=JSON.parse(await readFile(dir+'/mac.sender.json','utf8'));
const win=JSON.parse(await readFile(dir+'/windows.sender.json','utf8'));
async function session(url){
 let sid,id=0;
 async function request(method,params,notify=false){
  let r;
  try {
   r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,...(sid?{'mcp-session-id':sid}:{})},
    body:JSON.stringify({jsonrpc:'2.0',method,params,...(!notify?{id:++id}:{})}),signal:AbortSignal.timeout(10000)});
  } catch(e) {throw new Error(new URL(url).hostname+' '+method+' transport '+(e.cause?.code||e.name));}
  sid=r.headers.get('mcp-session-id')||sid;
  const text=await r.text();
  if(notify) assert.ok(r.status>=200&&r.status<300); else assert.equal(r.status,200);
  return {rpc:text?JSON.parse(text):null,timing:r.headers.get('server-timing')};
 }
 await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'l07-paired-latency',version:'1'}});
 assert.ok(sid);await request('notifications/initialized',{},true);
 return request;
}
const direct=await session('http://mail-a:8765/mcp/');
const validated=await session('http://validator:8766/mcp/');
const body='😀'.repeat(20000);
const key=randomUUID();let messageID,firstWriteValidation;
async function send(request){
 const start=performance.now();
 const r=await request('tools/call',{name:'send_message',arguments:{project_key:mac.projectKey,sender_name:mac.agentName,sender_token:mac.senderToken,to:[win.agentName],subject:'L07 maximum-length paired latency',body_md:body,idempotency_key:key,convert_images:false}});
 const elapsed=performance.now()-start;
 assert.ok(!r.rpc.error&&!r.rpc.result.isError,'benchmark write not saved');
 const saved=JSON.parse(r.rpc.result.content[0].text);assert.equal(typeof saved.message_id,'number');
 if(messageID===undefined) {
  messageID=saved.message_id;assert.ok(!saved.idempotent_replay);
  firstWriteValidation=Number(r.timing?.split('dur=')[1]);
  assert.ok(Number.isFinite(firstWriteValidation)&&firstWriteValidation<100,'initial write validation exceeded 100 ms');
 }
 else {assert.equal(saved.message_id,messageID);assert.equal(saved.idempotent_replay,true);}
 return {elapsed,validation:r.timing?Number(r.timing.split('dur=')[1]):null};
}
const a=[],b=[],deltas=[],validation=[];
for(let i=-3;i<30;i++){
 let x,y;
 if(i%2===0){x=await send(direct);y=await send(validated);}else{y=await send(validated);x=await send(direct);}
 if(i>=0){a.push(x.elapsed);b.push(y.elapsed);deltas.push(y.elapsed-x.elapsed);assert.ok(Number.isFinite(y.validation));validation.push(y.validation);}
}
function stats(values){values.sort((a,b)=>a-b);return {n:values.length,p50_ms:+values[Math.floor(values.length*.5)].toFixed(3),p95_ms:+values[Math.floor(values.length*.95)].toFixed(3),max_ms:+values.at(-1).toFixed(3)};}
const result={mode:'same saved message / idempotent replay',code_points:20000,utf8_bytes:80000,first_write_validation_ms:firstWriteValidation,baseline:stats(a),validated:stats(b),paired_added:stats(deltas),validation:stats(validation)};
console.log(JSON.stringify(result));
assert.ok(result.paired_added.p95_ms<100,'paired p95 added latency exceeded 100 ms');
assert.ok(result.paired_added.max_ms<100,'a paired replay added more than 100 ms');
assert.ok(result.validation.max_ms<100,'validator computation exceeded 100 ms');
