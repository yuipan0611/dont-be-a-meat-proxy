import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,extname,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {serviceNotes,moduleNotes,connectionNotes} from './architecture-notes.mjs';

export const sourceRoots=['client','ops','server','bot','web','deploy','supabase'];
const sha=s=>createHash('sha256').update(s).digest('hex');
const lineAt=(text,offset)=>text.slice(0,offset).split('\n').length;
const isTest=path=>/(^|\/)(test|tests|fixtures)(\/|$)|(?:_test\.go|\.test\.mjs)$/.test(path);
const isSensitive=path=>/(^|\/)(private|\.local|\.hub-local|\.generated|node_modules|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:key|pem|token|password|secret)$/.test(path);
const isSource=path=>!isSensitive(path)&&(/\.(mjs|js|jsx|css|py|go|sql|sh|yaml|yml|caddy|routes|service|timer|path)$/.test(path)||/\/Dockerfile$/.test(path)||/^ops\/[^/.]+$/.test(path));
const language=path=>({'.mjs':'javascript','.js':'javascript','.jsx':'jsx','.css':'css','.py':'python','.go':'go','.sql':'sql','.yaml':'compose','.yml':'compose','.caddy':'caddy','.routes':'caddy','.sh':'shell'})[extname(path)]??(/Dockerfile$/.test(path)?'dockerfile':'configuration');
export function serviceFor(path){
 if(path.startsWith('client/'))return 'client';
 if(path.startsWith('server/validator/'))return 'validator';
 if(path.startsWith('bot/'))return 'bot';
 if(path.startsWith('web/'))return 'web';
 if(path.startsWith('ops/lifecycle/'))return 'clock';
 if(path.startsWith('ops/memory-bridge/'))return 'bridge';
 if(path.startsWith('ops/bank-proxy/'))return 'bank-proxy';
 if(path.includes('token_applier')||path.includes('token-applier'))return 'token-applier';
 if(path.startsWith('supabase/')||path.startsWith('deploy/postgres/'))return 'postgres';
 if(path.startsWith('deploy/caddy/'))return 'gateway';
 if(path.startsWith('deploy/memory/'))return 'memory';
 if(path.startsWith('deploy/memory-bridge/'))return 'bridge';
 if(path.startsWith('deploy/hubclock/'))return 'clock';
 if(path.startsWith('deploy/validator/'))return 'validator';
 if(path.startsWith('deploy/bot/'))return 'bot';
 if(path.startsWith('deploy/web/'))return 'web';
 if(path==='deploy/compose.yaml')return 'mail';
 return 'ops';
}

export function extractJavaScript(text,path){
 const ast=parse(text,{ecmaVersion:'latest',sourceType:'module',locations:true,allowHashBang:true}),symbols={},imports=[],calls=[];
 function walk(node,scope=[],parent=null){
  if(!node||typeof node!=='object')return;
  let name=null;
  if(node.type==='FunctionDeclaration')name=node.id?.name;
  if(['FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
   if(parent?.type==='VariableDeclarator')name=parent.id?.type==='Identifier'?parent.id.name:null;
   if(['Property','MethodDefinition','PropertyDefinition'].includes(parent?.type)&&!parent.computed)name=parent.key?.name??parent.key?.value;
   if(parent?.type==='AssignmentExpression'&&parent.left.type==='Identifier')name=parent.left.name;
  }
  let next=scope;
  if(['ClassDeclaration','ClassExpression'].includes(node.type)&&node.id?.name)next=[...scope,node.id.name];
  if(name){
   next=[...scope,name];let full=next.join('.'),id=`${path}#${full}`;
   // Distinct block-local functions may share a name. Preserve exact ranges with a line suffix.
   if(symbols[id]){full+=`@${node.loc.start.line}`;id=`${path}#${full}`;}
   symbols[id]={id,name:full,path,startLine:node.loc.start.line,endLine:node.loc.end.line,params:node.params.map(p=>text.slice(p.start,p.end)),code:text.slice(node.start,node.end),fileHash:sha(text),language:'javascript',extraction:'acorn AST'};
  }
  if(node.type==='ImportDeclaration')imports.push({path,specifier:node.source.value,line:node.loc.start.line});
  if(node.type==='CallExpression'&&node.callee.type==='Identifier')calls.push({path,from:scope.join('.'),callee:node.callee.name,line:node.loc.start.line});
  for(const [key,value]of Object.entries(node))if(!['loc','start','end'].includes(key)){
   if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,next,node);}
   else if(value?.type)walk(value,next,node);
  }
 }
 walk(ast);return {symbols,imports,calls};
}

export function extractGo(text,path){
 // Preserve offsets while masking comments and all Go string forms. This is not a Go AST.
 const masked=text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,s=>s.replace(/[^\n]/g,' '));
 const found={};
 for(const match of masked.matchAll(/^func\s+(?:\(([^\n]*?)\)\s+)?([A-Za-z_]\w*)\s*\(/gm)){
  const start=match.index,open=masked.indexOf('{',start);if(open<0)continue;
  let depth=1,end=open+1;while(end<masked.length&&depth){if(masked[end]==='{')depth++;if(masked[end]==='}')depth--;end++;}
  if(depth)throw Error(`unclosed Go function ${path}:${lineAt(text,start)}`);
  const receiver=match[1]?.trim().split(/\s+/).at(-1)?.replace(/^\*/,'');
  const name=receiver?`${receiver}.${match[2]}`:match[2],id=`${path}#${name}`;
  const signature=text.slice(start,open).trim();
  found[id]={id,name,path,startLine:lineAt(text,start),endLine:lineAt(text,end-1),params:[signature],code:text.slice(start,end),fileHash:sha(text),language:'go',extraction:'lexical declaration and balanced braces (not AST)'};
 }
 return found;
}

export function extractTables(text,path){
 return [...text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(\w+)\.)?(\w+)\s*\(/gi)].map(m=>{
  let depth=1,end=m.index+m[0].length;while(end<text.length&&depth){if(text[end]==='(')depth++;if(text[end]===')')depth--;end++;}
  const schema=m[1]??'public',name=m[2],body=text.slice(m.index+m[0].length,end-1);
  const comment=new RegExp(`comment\\s+on\\s+table\\s+(?:${schema}\\.)?${name}\\s+is\\s+'((?:''|[^'])*)'`,'i').exec(text)?.[1]?.replaceAll("''", "'");
  const columns=[...body.matchAll(/^\s*(\w+)\s+([\w]+(?:\[\])?)/gm)].filter(c=>!['constraint','primary','unique','check','foreign'].includes(c[1].toLowerCase())).map(c=>({name:c[1],type:c[2],line:lineAt(text,m.index+m[0].length+c.index)}));
  const purposes={groups:'每一組使用哪個 project、Mail 與記憶 bank。',members:'各組有哪些有效成員。',devices:'哪台裝置可存取哪一組，以及通行證的狀態。',discord_links:'Discord 帳號與專案成員的綁定。',hub_clock_requests:'待確認問題或動作的期限與狀態。',hub_clock_outbox:'還沒成功寄出的確認結果。',hub_clock_cursors:'確認計時器已讀到哪個 Mail 事件。',audit_log:'誰在什麼時間變更了權限與重要設定。',hub_clock_processed:'哪些 Mail 事件已經處理過。',bridge_cursors:'Discord 通知搬運已讀到哪裡。',discord_notifications:'哪些通知待送、已送出或需要重試。',discord_presence:'Discord 成員的在線狀態。',assistant_budget:'各組每天已使用或預留的問答額度。',decisions:'需要確認的決策與按鈕處理狀態。'};
  return {id:`${schema}.${name}`,schema,name,path,line:lineAt(text,m.index),description:purposes[name]??comment??`保存 ${name} 的資料列；欄位由 migration 擷取。`,why:comment??'讓服務狀態可以保存並在下次啟動時繼續使用。',input:`SQL INSERT／UPDATE 的欄位：${columns.map(c=>c.name).join('、')}`,output:'限定權限與查詢條件的資料列。',errors:'型別、關聯或權限不符合時資料庫拒絕；交易失敗不代表已保存。',columns,sources:[{path,line:lineAt(text,m.index)}],extraction:'CREATE TABLE / COMMENT ON TABLE syntax scan; not a live schema'};
 });
}

export function extractCompose(text,path){
 const lines=text.split('\n'),containers=[];let inside=false,current=null;
 lines.forEach((line,i)=>{
  if(/^services:\s*(?:#.*)?$/.test(line)){inside=true;return;}
  if(inside&&/^\S/.test(line)&&!line.startsWith('#')){inside=false;current=null;}
  const service=inside&&line.match(/^  ([\w-]+):\s*(?:#.*)?$/);
  if(service){current={id:`${path}#${service[1]}`,name:service[1],path,line:i+1,properties:[],sources:[{path,line:i+1}],extraction:'Compose indentation syntax scan; overlays are not merged'};containers.push(current);return;}
  const property=current&&line.match(/^    (image|build|command|ports|networks|depends_on|working_dir):\s*(.*)$/);
  if(property)current.properties.push({name:property[1],value:property[2].split(/\s+#/)[0],line:i+1});
 });
 return containers;
}

async function inventoryPaths(root){
 try{return {method:'git ls-files (tracked repository files)',paths:execFileSync('git',['ls-files','-z','--',...sourceRoots],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean)};}
 catch{
  const paths=[];
  async function walk(dir){let entries;try{entries=await readdir(resolve(root,dir),{withFileTypes:true});}catch{return;}for(const entry of entries){if(['node_modules','.generated','private','.local','.hub-local','.git','__pycache__'].includes(entry.name)||entry.isSymbolicLink())continue;const path=`${dir}/${entry.name}`;if(entry.isDirectory())await walk(path);else paths.push(path);}}
  for(const dir of sourceRoots)await walk(dir);
  return {method:'filesystem fallback (build image without .git; private/generated/dependencies excluded)',paths:paths.sort()};
 }
}

export async function scanArchitecture(root){
 const inventory=await inventoryPaths(root),texts=new Map(),symbols={},modules=[],imports=[],calls=[],tables=[],containers=[],entrypoints=[],warnings=[];
 const files=[];
 for(const path of inventory.paths){
  const test=isTest(path),eligible=isSource(path)&&!test;
  const row={path,language:language(path),category:isSensitive(path)?'excluded-sensitive-or-generated':test?'test-or-fixture':eligible?'source-or-deployment':'documentation-or-manifest',serviceId:serviceFor(path)};files.push(row);
  if(!eligible)continue;
  const text=await readFile(resolve(root,path),'utf8');texts.set(path,text);row.fileHash=sha(text);
  let extracted={};
  if(/\.(mjs|js)$/.test(path)){
   const js=extractJavaScript(text,path);extracted=js.symbols;imports.push(...js.imports);calls.push(...js.calls);row.extraction='acorn AST';
  }else if(path.endsWith('.jsx')){row.extraction='JSX module inventory; compiled by esbuild, functions not extracted';}
  else if(path.endsWith('.py')){
   const values=JSON.parse(execFileSync('python3',[resolve(root,'web/scripts/python-symbols.py')],{input:text,encoding:'utf8',maxBuffer:8*1024*1024}));
   for(const value of values){const id=`${path}#${value.name}`;extracted[id]={...value,id,path,fileHash:sha(text),language:'python',extraction:'Python ast (source inspected without execution)'};}row.extraction='Python ast';
  }else if(path.endsWith('.go')){extracted=extractGo(text,path);row.extraction='Go lexical declaration scanner';}
  if(path.endsWith('.sql'))tables.push(...extractTables(text,path));
  if(/\.ya?ml$/.test(path))containers.push(...extractCompose(text,path));
  if(/\.(caddy|routes)$/.test(path))for(const m of text.matchAll(/^\s*(reverse_proxy|handle_path|handle|import)\s+([^\n{]+)/gm))entrypoints.push({path,line:lineAt(text,m.index),directive:m[1],value:m[2].trim(),sources:[{path,line:lineAt(text,m.index)}]});
  const note=moduleNotes[path],service=serviceNotes.find(s=>s.id===row.serviceId);
  const [name,description,input,output]=note??[path.split('/').at(-1),`${service?.name??'系統'}的${row.language==='sql'?'資料結構與權限設定':row.language==='compose'?'容器部署設定':'程式或維運零件'}；請依來源核對細節。`,service?.input??'呼叫參數與設定',service?.output??'處理結果'];
  modules.push({id:`module:${path}`,path,serviceId:row.serviceId,name,description,why:service?.why??'支援所屬服務的工作。',input,output,errors:service?.errors??'請以程式中的錯誤處理為準。',sources:[{path,line:1}],symbolIds:Object.keys(extracted),language:row.language,explanation:note?'human-reviewed':'service-context; exact behavior requires source review'});
  for(const [id,value]of Object.entries(extracted))symbols[id]={...value,title:value.name,description:`${name}中的「${value.name}」函式。${description}`,why:service?.why,input:value.params.join(', ')||'無明列參數；仍可能讀取所屬模組狀態。',output:`請看下方原始碼的 return／回傳值及副作用。模組輸出：${output}`,errors:service?.errors,sources:[{path,line:value.startLine}]};
 }
 function source(path,anchor){const text=texts.get(path);if(!text)throw Error(`curation source absent: ${path}`);const index=text.indexOf(anchor);if(index<0)throw Error(`curation anchor absent: ${path} ${anchor}`);return {path,line:lineAt(text,index)};}
 // The generated Caddy auth block is Python source, not a checked-in rendered secret file.
 for(const [serviceId,route,method,path,anchor,description]of [
  ['gateway','https://hub.example.invalid','HTTPS','deploy/caddy/hub.caddy','hub.example.invalid','對外 TLS 網域；實際可用狀態需部署驗證。'],
  ['gateway','/mcp/','POST','ops/hub_ops.py','def render(','裝置通行證通過後轉送 validator，並非直接公開 Mail。'],
  ['gateway','/memory/mcp/{bank}/','POST','ops/hub_ops.py','def memory_block(','移除 /memory 前綴，交給 bank-proxy 再核對裝置與 bank。'],
  ['web','/auth/login → /auth/callback','GET','web/src/server.mjs',"u.pathname === '/auth/login'",'Discord OAuth；登入後仍會重新核對固定組別的成員。'],
  ['web','/api/architecture','GET','web/src/server.mjs',"u.pathname === '/api/architecture'",'已登入成員的架構模型；原碼由另一個白名單端點提供。'],
  ['web','/api/code/{symbolId}','GET','web/src/server.mjs','const codeMatch=','已登入且符號位於建置白名單時才能讀取原碼。'],
 ]){const evidence=source(path,anchor);entrypoints.push({serviceId,route,method,description,...evidence,sources:[evidence],extraction:'human-reviewed source anchor'});}
 const services=serviceNotes.map(({path,anchor,...note})=>({...note,sources:[source(path,anchor)],modules:modules.filter(m=>m.serviceId===note.id).map(m=>m.path)}));
 const connections=connectionNotes.map(({path,anchor,...note})=>({...note,sources:[source(path,anchor)]}));
 const messageInfo={handoff:['工作交接','交代已完成與未完成事項，供下個 session 接手。'],help:['請求協助','提出問題或待確認動作。'],decision:['決策紀錄','保存需要人確認的選擇與決定。'],task:['工作任務','保存任務內容與相關 GitHub Issue。'],presented:['已顯示確認','告訴計時器使用者已看到確認提示。'],answer:['回答問題','把回答與原始問題連結。'],choice:['選擇同意或拒絕','讓計時器核對人類選擇。'],'session.closed':['session 已結束','讓舊 session 的確認失效。'],'auto.on':['啟用自動模式','申請有限時、指定對象的自動授權。'],'auto.off':['停用自動模式','取消現有自動授權。'],'auto.executed':['自動執行回報','記錄自動模式下的成功或失敗。'],result:['確認結果','由 HubClock 寄回 approved／expired 等結果。']};
 const messages=[];
 for(const [path,exportName]of [['client/mail-client.mjs','KINDS'],['ops/lifecycle/protocol.mjs','CLIENT_EVENTS']]){
  const text=texts.get(path),m=new RegExp(`export const ${exportName} = Object\\.freeze\\(\\[([^\\]]+)\\]`).exec(text);if(!m)throw Error(`message enum absent ${path}`);
  for(const value of m[1].matchAll(/'([^']+)'/g)){const name=value[1],[title,description]=messageInfo[name]??[name,name];messages.push({id:`message:${name}`,name,title,description,why:'用明確種類讓收件端判斷該怎麼處理，並保留原始紀錄。',input:exportName==='KINDS'?'item-v1 envelope：kind／summary／text／client_event_id':'control-v1：event_type／root_mail_id／recipient_session',output:'保存在 Mail 的訊息原文',errors:'欄位或身分不合法會被拒絕；逾時時不能假設已保存或已執行。',sources:[{path,line:lineAt(text,m.index)}]});}
 }
 messages.push({id:'message:result',name:'result',title:messageInfo.result[0],description:messageInfo.result[1],why:'讓原工作站知道確認是否有效，不能只靠對話猜測。',input:'HubClock 確認狀態',output:'帶有 root_mail_id 的結果訊息',errors:'只有有效結果可以驅動動作；寄回失敗仍需重試。',sources:[source('ops/lifecycle/protocol.mjs',"export const RESULT_EVENT = 'result'")]});
 const resolvedImports=imports.map(item=>({...item,from:item.path,...(item.specifier.startsWith('.')?{to:posix.normalize(posix.join(posix.dirname(item.path),item.specifier)),target:posix.normalize(posix.join(posix.dirname(item.path),item.specifier))}:{external:true})}));
 warnings.push('JSX／CSS 納入來源模組盤點；JSX 由 esbuild 編譯，不假裝已由 Acorn 擷取其函式。');
 warnings.push('JavaScript 使用 Acorn AST；僅對具名宣告、具名變數函式與具名方法建立符號；匿名 callback 不另建節點。');
 warnings.push('Python 使用標準 ast，只讀取語法，不匯入或執行被掃描程式。Go 使用註解／字串遮罩與括號計數，不宣稱 Go AST 或型別分析。');
 warnings.push('Compose 只擷取 services 區塊與明列屬性，不合併 override、不展開環境變數；容器條目可能重複代表同一服務。');
 warnings.push('SQL 由 CREATE TABLE／COMMENT 語法擷取，未執行 migration，不代表目前 VPS schema；Mail 與 Hindsight 上游內部函式未包含在此 repo。');
 warnings.push('服務連線與白話解釋由人工核對，import／本地呼叫為靜態候選，不推測動態調用或即時健康狀態。');
 const coverage={roots:sourceRoots,inventoryMethod:inventory.method,files:files.length,sourceFiles:modules.length,testOrFixtureFiles:files.filter(f=>f.category==='test-or-fixture').length,symbols:Object.keys(symbols).length,services:services.length,tables:tables.length,containers:containers.length,byRoot:Object.fromEntries(sourceRoots.map(r=>[r,files.filter(f=>f.path.startsWith(r+'/')).length])),warnings};
 return {symbols,atlas:{version:3,services,modules,connections,tables,messages,inventory:files,containers,entrypoints,imports:resolvedImports,calls,coverage}};
}
