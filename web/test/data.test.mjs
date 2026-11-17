import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createData} from '../src/data.mjs';
test('Mail integration uses only non-consuming topics; cache and failure preserve source age',async t=>{
 const calls=[];let fail=false,clock=0;
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const rpc=JSON.parse(body);res.setHeader('content-type','application/json');if(rpc.method==='notifications/initialized'){res.writeHead(202);res.end();return;}if(rpc.method==='initialize'){res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fake',version:'1'}}}));return;}calls.push(rpc.params);const result=fail?{isError:true,content:[{type:'text',text:'down'}]}:{content:[{type:'text',text:JSON.stringify([{id:1,created_ts:'2026-11-17T10:00:00Z',body_md:'{"kind":"handoff","summary":"saved"}'}])}]};res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const data=createData({pool:{async query(sql,args){assert.match(sql,/m.status='active'/);assert.equal(args[2],'group-a');return {rows:[]};}},map:{repo:'o/r',nodes:[]},mailConfig:{url:`http://127.0.0.1:${server.address().port}`,token:'x',projectKey:'/group-a',agentName:'Guide',groupId:'group-a',guildId:'guild'},now:()=>clock,fetchImpl:async()=>fail?new Response('',{status:503}):new Response(JSON.stringify([{number:1,title:'t',state:'closed',html_url:'https://github.com/o/r/issues/1'}]))});
 await assert.rejects(data.snapshot('group-b'));
 assert.equal(await data.member('42'),null);
 const first=await data.snapshot('group-a');assert.equal(first.items.length,1);assert.equal(first.issues[0].state,'closed');assert.equal(calls.length,4);assert(calls.every(c=>c.name==='fetch_topic'));assert(calls.every(c=>c.arguments.project_key==='/group-a'));
 await data.snapshot('group-a');assert.equal(calls.length,4);clock=31_000;fail=true;const last=await data.snapshot('group-a');assert.equal(last.items[0].summary,'saved');assert.equal(last.sources.mail.ok,false);assert.equal(last.sources.mail.updatedAt,first.sources.mail.updatedAt);assert.equal(last.sources.github.ok,false);
});
