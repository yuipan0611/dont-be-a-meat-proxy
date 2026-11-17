import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMailClient,validateItem} from '../../client/mail-client.mjs';
const item={to:['Peer'],subject:'checkpoint',kind:'handoff',summary:'saved',text:'next step',sourceSession:'session',clientEventId:'d4567a01-1020-4030-8050-123456789012',workContext:{components:['client'],paths:['client/hub-hook.mjs'],stage:'blocked'}};
test('optional work metadata survives actual wire envelope, legacy shape unchanged',async()=>{
 const calls=[];
 const client=createMailClient({url:'http://fixture',token:'private',projectKey:'/group-a',agentName:'Agent',fetch:async(url,opts)=>{const rpc=JSON.parse(opts.body);calls.push(rpc);return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='tools/call'?{content:[{type:'text',text:'{"message_id":1}'}]}:{}}),{headers:{'content-type':'application/json'}});}});
 await client.sendItem(item);assert.deepEqual(JSON.parse(calls.at(-1).params.arguments.body_md).work_context,item.workContext);
 await client.sendItem({...item,workContext:undefined});assert.equal('work_context' in JSON.parse(calls.at(-1).params.arguments.body_md),false);
});
test('work metadata cannot bypass normal secret checks',()=>{assert.throws(()=>validateItem({...item,workContext:{test_result:'-----\x42EGIN RSA PRIVATE KEY-----'}}),e=>e.code==='E-SECRET');});
