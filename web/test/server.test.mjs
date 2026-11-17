import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { projectItem, safeLink } from '../src/data.mjs';
import { validateWorkContext } from '../../client/mail-client.mjs';
const map={symbols:{'allowed.mjs#fn':{id:'allowed.mjs#fn',code:'function fn() {}'}},codeSnapshot:{revision:'fixture'},repo:'owner/repo',nodes:[{id:'client',paths:['client/']}],edges:[]};
async function fixture(t){
 let active=true,clock=0,calls=0;
 const data={async member(id){return active && id==='42'?{group_id:'group-a',display_name:'Member'}:null;},async snapshot(group){assert.equal(group,'group-a');calls++;return {items:[{id:'1'}]};}};
 const server=createApp({map,data,origin:'https://hub.example',clientId:'id',clientSecret:'secret',now:()=>clock,fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/token')?{access_token:'private'}:{id:'42'}))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=(path,opts={})=>fetch(base+path,{redirect:'manual',...opts});
 async function login(){const r=await get('/auth/login');const state=new URL(r.headers.get('location')).searchParams.get('state');const done=await get('/auth/callback?code=code&state='+state,{headers:{cookie:'hub_oauth='+state}});assert.equal(done.status,302);return {cookie:done.headers.get('set-cookie').match(/hub_session=[^;]+/)[0],state};}
 return {get,login,revoke(){active=false;},expire(){clock=5*3600_000;},calls:()=>calls};
}
test('anonymous shell is public, data is private, invalid OAuth state rejected',async t=>{const f=await fixture(t);assert.equal((await f.get('/')).status,200);assert.equal((await f.get('/api/overview')).status,401);assert.equal((await f.get('/auth/callback?code=x&state=wrong')).status,400);assert.equal(f.calls(),0);});
test('OAuth state single use, member rechecked, no group override',async t=>{const f=await fixture(t),l=await f.login();assert.equal((await f.get('/auth/callback?code=x&state='+l.state,{headers:{cookie:'hub_oauth='+l.state}})).status,400);assert.equal((await f.get('/api/overview?group_id=other',{headers:l})).status,200);assert.equal(f.calls(),1);f.revoke();assert.equal((await f.get('/api/architecture',{headers:l})).status,401);assert.equal((await f.get('/api/overview',{headers:l})).status,401);});
test('session expiry and same-origin logout',async t=>{const f=await fixture(t),l=await f.login();assert.equal((await f.get('/auth/logout',{method:'POST',headers:l})).status,403);assert.equal((await f.get('/auth/logout',{method:'POST',headers:{...l,origin:'https://hub.example'}})).status,200);assert.equal((await f.get('/api/overview',{headers:l})).status,401);const l2=await f.login();f.expire();assert.equal((await f.get('/api/overview',{headers:l2})).status,401);});
test('only safe fixed assets; data responses deny framing/cache',async t=>{const f=await fixture(t),l=await f.login();const r=await f.get('/api/architecture',{headers:l});assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal((await f.get('/architecture.json')).status,404);assert.equal((await f.get('/api/overview',{method:'POST',headers:l})).status,405);});
test('legacy, malformed and malicious metadata are handled without fabricating verification',()=>{
 for(const body of ['null','[]','old text'])assert.equal(projectItem({id:1,body_md:body},map).stage,'unreported');
 const item=projectItem({id:2,body_md:JSON.stringify({summary:'<script>x</script>',work_context:{components:4,paths:['client/hook.mjs','../secret','/private'],stage:'completed',test_result:'pass'},links:['javascript:x','https://github.com/other/repo/commit/1','https://github.com/owner/repo/pull/2']})},map);
 assert.deepEqual(item.paths,['client/hook.mjs']);assert.deepEqual(item.components,['client']);assert.equal(item.hasCommit,true);assert.equal(item.verification,'AI 回報：pass');assert.equal(item.links.length,1);assert.equal(item.summary,'<script>x</script>');
 assert.equal(safeLink('https://github.com/owner/repo-other/issues/2',map.repo),null);
});
test('metadata validation rejects invalid stage, traversal, secrets handled by normal item validation',()=>{assert.throws(()=>validateWorkContext({stage:'verified'}));assert.throws(()=>validateWorkContext({paths:['../secret']}));assert.throws(()=>validateWorkContext({paths:['a\nkey']}));validateWorkContext({stage:'blocked',components:['mail'],paths:['client/a.mjs','web/src/main.mjs']});});

test('source API requires membership and whitelist, map excludes code',async t=>{const f=await fixture(t);const path='/api/code/'+encodeURIComponent('allowed.mjs#fn');assert.equal((await f.get(path)).status,401);const login=await f.login();assert.equal((await(await f.get(path,{headers:login})).json()).code,'function fn() {}');const mapResponse=await(await f.get('/api/architecture',{headers:login})).json();assert.equal(mapResponse.symbols['allowed.mjs#fn'].code,undefined);assert.equal((await f.get('/api/code/'+encodeURIComponent('../../private#key'),{headers:login})).status,404);f.revoke();assert.equal((await f.get(path,{headers:login})).status,401);});
