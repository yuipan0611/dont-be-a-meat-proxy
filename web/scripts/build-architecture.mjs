import {extractJavaScript,scanArchitecture} from './scan-architecture.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=s=>createHash('sha256').update(s).digest('hex');
export function extractFunctions(text,path){
 return extractJavaScript(text,path).symbols;
}
const definitions=[
 ['client/mail-client.mjs','createMailClient.sendItem','準備並送出訊息','驗證訊息、建立 envelope，成功後回傳保存回執。'],
 ['client/mail-client.mjs','createMailClient.callTool','呼叫 MCP 工具','封裝 tools/call，檢查 RPC 與工具回傳錯誤。'],
 ['client/mail-client.mjs','createMailClient.rpc','HTTP 傳輸','以 POST 傳送 JSON-RPC，處理 session、逾時與 HTTP 錯誤。'],
 ['client/mail-client.mjs','validateItem','驗證寄件內容','檢查欄位、收件者、長度與疑似密鑰；不代表上游保存成功。'],
 ['client/mail-client.mjs','createMailClient.fetchEvents','取得收件事件','以事件游標讀 fetch_inbox_events。'],
 ['client/mail-client.mjs','createMailClient.readMessage','取回訊息原文','透過 resources/read 取得訊息原文。'],
 ['client/mail-client.mjs','syncInbox','同步本機收件','依序取得事件與原文，更新本機 staging。'],
 ['client/mail-client.mjs','createMailClient.sendControl','送出控制事件','保存 presented／choice／session.closed 等控制紀錄。'],
 ['client/hub-hook.mjs','modeStart','開工讀取','讀取未讀與最近交接，附加到開工上下文。'],
 ['client/hub-hook.mjs','modeWatch','閒置收件','輪詢並通知目前 session 有新訊息。'],
 ['client/hub-hook.mjs','modeSend','保存訊息或交接','依 checkpoint 建立 handoff，加入待送佇列並嘗試保存。'],
 ['client/hub-hook.mjs','queueItem','加入待送佇列','寫入本機 outbox，保留重送識別。'],
 ['client/hub-hook.mjs','flushOutbox','重送待保存項目','重用既有識別，回報已保存或保存結果未確認。'],
 ['client/hub-hook.mjs','modeControl','記錄呈現與選擇','驗證請求 ID 與選擇，保存控制事件；不是動作執行器。'],
 ['ops/lifecycle/lifecycle.mjs','createLifecycle.ingest','讀取 HubClock 事件','取得事件與原文，再於交易中套用狀態。'],
 ['ops/lifecycle/lifecycle.mjs','createLifecycle.applyMessage','分派控制事件','依事件類型分派 presented、choice 與 session.closed。'],
 ['ops/lifecycle/lifecycle.mjs','createLifecycle.onChoice','處理確認結果','依請求與時限檢查選擇，不直接修改工作站程式碼。']
];
export async function build(){
 const {symbols,atlas}=await scanArchitecture(root);
 for(const [path,name,title,description]of definitions){const id=`${path}#${name}`,s=symbols[id];if(!s)throw Error(`missing required symbol: ${id}`);symbols[id]={...s,title,description};}
 let revision=process.env.SOURCE_REVISION??'unavailable',dirty=true;
 try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();dirty=!!execFileSync('git',['status','--porcelain','--',...atlas.coverage.roots],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 const map=JSON.parse(await readFile(resolve(root,'web/architecture.json'),'utf8'));
 const metadata={revision,dirty,snapshotHash:sha(JSON.stringify({symbols,atlas})),source:'建置時全庫語法快照；關係與說明為人工核對，非即時執行追蹤'};
 const output={...map,codeSnapshot:metadata,symbols,atlas};
 await mkdir(resolve(root,'web/.generated'),{recursive:true});
 await writeFile(resolve(root,'web/.generated/architecture.json'),JSON.stringify(output));
 return output;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await build();
