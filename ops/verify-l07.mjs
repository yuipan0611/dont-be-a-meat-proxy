// Read-only credential loading; writes one harmless acceptance message and rejects
// synthetic samples through raw public MCP. Never uses client-side send validation.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { deviceCredentials, openSession } from './verify-h02.mjs';
import { createMailClient } from '../client/mail-client.mjs';

const {values}=parseArgs({options:{url:{type:'string',default:'https://hub.example.invalid/mcp/'},'credentials-dir':{type:'string'}}});
assert.ok(values['credentials-dir'],'--credentials-dir is required; no tokens in argv');
const c=await deviceCredentials(values['credentials-dir']);
const s=await openSession(values.url,c.mac.token);
const project='/data/projects/group-a';
const reader=createMailClient({url:values.url,token:c.windows.token,projectKey:project,agentName:c.windows.agentName,senderToken:c.windows.senderToken});
const send=body=>s.request('tools/call',{name:'send_message',arguments:{project_key:project,sender_name:c.mac.agentName,sender_token:c.mac.senderToken,to:[c.windows.agentName],subject:'L-07 operator acceptance',body_md:body,idempotency_key:randomUUID(),convert_images:false}});
function payload(r){assert.equal(r.status,200);const p=JSON.parse(r.text);assert.ok(!p.error&&!p.result.isError,'legal write rejected');return JSON.parse(p.result.content[0].text);}
try{
 const legal='L-07 合法訊息驗收 😀 '+randomUUID();
 const receipt=payload(await send(legal));
 assert.equal((await reader.readMessage(receipt.message_id)).message.body_md,legal);
 const initial=(await reader.fetchEvents({after:0})).tailCursor;
 const fake='ghp_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
 for(const body of ['文'.repeat(20001),fake,JSON.stringify({v:1,text:'😀'.repeat(20001)}),String.raw`{"v":1,"text":"\u0067hp_` + `A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`]) {
  const r=await send(body);const rpc=JSON.parse(r.text);
  assert.equal(rpc.error?.code,-32007,'raw MCP was not blocked');
  assert.ok(!r.text.includes(fake),'secret echoed in rejection');
 }
 assert.equal((await reader.fetchEvents({after:initial})).tailCursor,initial);
 console.log('PASS legal raw MCP saved/read; 4 raw rejections; durable cursor unchanged; no secret echo');
}catch{
 console.error('FAIL L-07 acceptance; inspect privately; no credentials or response bodies printed');process.exitCode=1;
}
