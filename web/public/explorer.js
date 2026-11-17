// Architecture relationships are curated. A source snapshot is not a runtime trace.
const $=s=>document.querySelector(s), NS='http://www.w3.org/2000/svg';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const svg=(tag,attrs={})=>{const n=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));return n;};
const btn=(text,fn)=>{const b=el('button',text,'secondary');b.addEventListener('click',fn);return b;};
const symbol=(file,name)=>`${file}#${name}`;
const mail='client/mail-client.mjs',hook='client/hub-hook.mjs',clock='ops/lifecycle/lifecycle.mjs';
const interfaces=[
 {id:'send',name:'傳送訊息',protocol:'HTTPS · JSON-RPC / MCP',method:'POST',path:'/mcp/',operation:'tools/call → send_message',from:'工作站',to:'Caddy → 驗證代理 → Agent Mail',auth:'HTTPS 入口檢查裝置 bearer；代理以組別後端憑證轉送。',input:'project_key, sender_name, to, subject, body_md, idempotency_key',output:'message_id, created_ts, thread_id；錯誤不等於已保存。',errors:'401 憑證失效；欄位拒絕；逾時顯示保存結果未確認。',symbols:[[mail,'createMailClient.sendItem'],[mail,'validateItem'],[mail,'createMailClient.callTool'],[mail,'createMailClient.rpc']]},
 {id:'receive',name:'接收訊息',protocol:'HTTPS · JSON-RPC / MCP',method:'POST',path:'/mcp/',operation:'tools/call → fetch_inbox_events；resources/read',from:'工作站輪詢',to:'Agent Mail → 本機 staging',auth:'入口 bearer；MCP session header 由 transport 維護。',input:'project_key, agent_name, after, limit；resource://message/{id}',output:'events, next_cursor, has_more；原始訊息。',errors:'來源失聯不當成零筆；保留游標，避免漏收。',symbols:[[hook,'modeWatch'],[mail,'syncInbox'],[mail,'createMailClient.fetchEvents'],[mail,'createMailClient.readMessage'],[mail,'createMailClient.rpc']]},
 {id:'handoff',name:'工作交接',protocol:'本地 hook → MCP 訊息',method:'本地 checkpoint → POST',path:'/mcp/',operation:'checkpoint → handoff → send_message',from:'結束本段工作的 session',to:'本機 outbox → Agent Mail → 下一次開工',auth:'沿用該裝置與 agent 身分；交接不是批准動作。',input:'summary, text, unfinished, links；選填 workContext',output:'已保存 #ID，或保留待送項目與明確失敗狀態。',errors:'斷線時不假稱成功；相同識別重送；原文不由摘要取代。',symbols:[[hook,'modeSend'],[hook,'queueItem'],[hook,'flushOutbox'],[hook,'modeStart'],[mail,'createMailClient.sendItem']]},
 {id:'confirm',name:'動作確認',protocol:'控制事件 · MCP',method:'本地 presented/choice → POST',path:'/mcp/',operation:'presented → choice → HubClock result',from:'收件工作站／擁有者',to:'Agent Mail → HubClock → 原工作站',auth:'人類選擇與請求綁定；收到 approved 結果後才可動手。',input:'event_type, root_mail_id, recipient_session, agent, choice',output:'approved / rejected / expired / invalidated 等結果。',errors:'顯示後 30 分鐘逾時；session 結束失效；狀態未知不執行。',symbols:[[hook,'modeControl'],[mail,'createMailClient.sendControl'],[clock,'createLifecycle.ingest'],[clock,'createLifecycle.applyMessage'],[clock,'createLifecycle.onChoice']]}
];
export function createExplorer({map,api,onItem,onClear=()=>{}}){
 const panel=$('#architecture');panel.replaceChildren();
 panel.classList.add('workbench');
 const bar=el('div',undefined,'explorer-bar'),crumbs=el('div',undefined,'crumbs'),search=el('input');search.placeholder='搜尋元件、API、函式…';search.setAttribute('aria-label','搜尋架構');bar.append(crumbs,search);
 const results=el('div',undefined,'search-results');results.hidden=true;
 const flows=el('div',undefined,'flow-tabs');flows.setAttribute('aria-label','核心流程');
 const body=el('div',undefined,'explorer-body'),surface=el('div',undefined,'canvas-surface'),inspector=el('aside');inspector.id='architecture-inspector';inspector.setAttribute('aria-label','架構詳細資訊');
 const viewport=svg('svg',{viewBox:'0 0 1000 650',tabindex:0,'aria-label':'架構畫布；可拖曳縮放，Tab 選元件，Enter 看詳情'}),layer=svg('g');viewport.append(layer);
 const minimap=svg('svg',{viewBox:'0 0 1000 650',class:'minimap',tabindex:0,role:'button','aria-label':'小地圖；點選移動視野，Enter 適合畫面'});
 const controls=el('div',undefined,'zoom-controls'),hint=el('div','拖曳移動 · 滾輪縮放 · 點選看概要 · 進入內部探索下一層','canvas-hint');
 const list=el('div',undefined,'explorer-list');const toggle=btn('切換清單',()=>{surface.classList.toggle('list-mode');toggle.textContent=surface.classList.contains('list-mode')?'切換畫布':'切換清單';});
 const protocolStrip=el('div',undefined,'protocol-strip');surface.append(viewport,protocolStrip,minimap,controls,hint,list);body.append(surface,inspector);panel.append(bar,results,flows,body);
 const nodes=new Map(),edges=[];
 const add=(n)=>{nodes.set(n.id,n);return n.id;};
 add({id:'root',name:'系統全貌',type:'system',description:map.description});
 add({id:'workstation',parent:'root',name:'AI 工作站',type:'system',description:'Mac／Windows 上使用的 AI 工具，透過 hook 與 MCP 接上 Hub。',components:['client']});
 add({id:'hub',parent:'root',name:'Hub 協作服務',type:'system',description:'HTTPS 入口、訊息保存與確認計時，各有明確責任邊界。',components:['gateway','mail','clock','memory']});
 for(const n of map.nodes.filter(n=>!['client','guide'].includes(n.id))){add({...n,id:'service:'+n.id,parent:['discord','github'].includes(n.id)?'root':'hub',type:'service',components:[n.id]});}
 add({id:'guide',parent:'root',name:'架構工作台',type:'service',description:'唯讀呈現設計、原始碼快照與工作回報。OAuth 驗證不取代 MCP 裝置驗證。',components:['guide']});
 for(const [id,name,desc]of [['transport','Mail client','封裝 MCP 傳輸、訊息格式與收件事件。'],['hooks','Session hooks','開工、輪詢、交接與確認的本地入口。']])add({id,parent:'workstation',name,type:'service',description:desc,components:['client']});
 edges.push({from:'workstation',to:'hub',label:'HTTPS · MCP · POST /mcp/',interfaceId:'send'},{from:'hub',to:'service:discord',label:'已保存訊息 → 通知'},{from:'service:discord',to:'service:github',label:'HTTPS · GitHub Issues API'});
 for(const e of map.edges){const convert=id=>id==='client'?'workstation':id==='guide'?'guide':'service:'+id;edges.push({from:convert(e.from),to:convert(e.to),label:e.label,description:e.description});}
 for(const f of interfaces){
  const parent=['handoff','confirm'].includes(f.id)?'hooks':'transport';
  add({...f,id:'api:'+f.id,parent,type:'interface',description:f.operation,components:f.id==='confirm'?['client','mail','clock']:['client','gateway','mail']});
  const paths=[...new Set(f.symbols.map(([p])=>p))];
  for(const path of paths){const mid=`module:${f.id}:${path}`;add({id:mid,parent:'api:'+f.id,name:path.split('/').pop(),path,type:'module',description:`${f.name}流程中的程式模組。`,components:[path===clock?'clock':'client']});
   for(const [p,name]of f.symbols.filter(([p])=>p===path)){const sid=symbol(p,name),s=map.symbols?.[sid];add({id:`fn:${f.id}:${sid}`,parent:mid,name:s?.title??name,type:'function',description:s?.description??'原始碼尚未納入本次快照。',symbolId:sid,signature:name,components:[p===clock?'clock':'client']});}
  }
 }
 const serviceApis={'service:mail':['send','receive','handoff'],'service:clock':['confirm'],'service:gateway':['send']};
 let scope='root',selected=null,flow=null,snapshot={items:[]},workFocus=null,cam={x:20,y:20,k:1},request=0;
 const cameras=new Map();
 const saved=()=>{const p=new URLSearchParams(location.hash.slice(1));return{scope:p.get('scope'),selected:p.get('selected'),flow:p.get('flow')};};
 function store(){const q=new URLSearchParams({scope});if(selected)q.set('selected',selected);if(flow)q.set('flow',flow);history.replaceState(null,'','#'+q);}
 function navigate(id,select=null){if(!nodes.has(id))return;cameras.set(scope,{...cam});scope=id;selected=select;cam=cameras.get(scope)??{x:20,y:20,k:1};store();render();}
 function children(){return [...nodes.values()].filter(n=>n.parent===scope);}
 function focusFlow(id){flow=id;workFocus=null;const n=nodes.get('api:'+id);navigate(n.id);}
 function select(id){selected=id;store();render();}
 function zoom(factor,cx=500,cy=325){const k=Math.max(.45,Math.min(2.8,cam.k*factor));cam.x=cx-(cx-cam.x)*k/cam.k;cam.y=cy-(cy-cam.y)*k/cam.k;cam.k=k;drawCamera();}
 function fit(){cam={x:20,y:20,k:1};drawCamera();}
 controls.append(btn('清除定位',()=>{workFocus=null;onClear();render();}),btn('−',()=>zoom(.8)),btn('＋',()=>zoom(1.25)),btn('適合畫面',fit),toggle);
 viewport.addEventListener('wheel',e=>{e.preventDefault();const r=viewport.getBoundingClientRect();zoom(e.deltaY<0?1.12:.89,(e.clientX-r.left)*1000/r.width,(e.clientY-r.top)*650/r.height);},{passive:false});
 const pointers=new Map();let lastPinch=null;
 viewport.addEventListener('pointerdown',e=>{if(e.target.closest('[data-node]'))return;viewport.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});});
 viewport.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const old=pointers.get(e.pointerId),r=viewport.getBoundingClientRect();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2){const[a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y);if(lastPinch)zoom(distance/lastPinch,((a.x+b.x)/2-r.left)*1000/r.width,((a.y+b.y)/2-r.top)*650/r.height);lastPinch=distance;}else{cam.x+=(e.clientX-old.x)*1000/r.width;cam.y+=(e.clientY-old.y)*650/r.height;drawCamera();}});
 for(const type of ['pointerup','pointercancel'])viewport.addEventListener(type,e=>{pointers.delete(e.pointerId);lastPinch=null;});
 minimap.addEventListener('click',e=>{const r=minimap.getBoundingClientRect();cam.x=500-(e.clientX-r.left)*1000/r.width*cam.k;cam.y=325-(e.clientY-r.top)*650/r.height*cam.k;drawCamera();});
 minimap.addEventListener('keydown',e=>{if(e.key==='Enter')fit();});
 viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;const delta={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]}[e.key];if(delta){e.preventDefault();cam.x+=delta[0];cam.y+=delta[1];drawCamera();}else if(e.key==='+')zoom(1.25);else if(e.key==='-')zoom(.8);});
 search.addEventListener('input',()=>{results.replaceChildren();const q=search.value.trim().toLowerCase();results.hidden=!q;if(!q)return;const hits=[...nodes.values()].filter(n=>[n.name,n.signature,n.path,n.operation].some(v=>v?.toLowerCase().includes(q))).slice(0,12);for(const n of hits)results.append(btn(`${n.type} · ${n.name}${n.signature?' · '+n.signature:''}`,()=>{navigate(n.parent??'root',n.id);search.value='';results.hidden=true;}));if(!hits.length)results.append(el('p','找不到對應項目。'));});
 function drawCamera(){layer.setAttribute('transform',`translate(${cam.x} ${cam.y}) scale(${cam.k})`);viewport.classList.toggle('zoom-detail',cam.k>=1.15);viewport.classList.toggle('zoom-compact',cam.k<.7);const rect=minimap.querySelector('.view-window');if(rect){rect.setAttribute('x',-cam.x/cam.k);rect.setAttribute('y',-cam.y/cam.k);rect.setAttribute('width',1000/cam.k);rect.setAttribute('height',650/cam.k);} }
 function related(n){return snapshot.items.filter(i=>n.symbolId&&i.symbols?.length?i.symbols.includes(n.symbolId):i.components?.some(c=>n.components?.includes(c)));}
 function render(){
  const contract=nodes.get(scope).type==='interface'?nodes.get(scope):interfaces.find(f=>f.id===flow);protocolStrip.replaceChildren();protocolStrip.hidden=!contract;if(contract){protocolStrip.append(el('strong',contract.protocol),el('span',contract.method+' '+contract.path+' · '+contract.operation));protocolStrip.append(btn('查看契約',()=>inspect(nodes.get('api:'+contract.id.replace('api:','')))));}
  crumbs.replaceChildren();let chain=[],n=nodes.get(scope);while(n){chain.unshift(n);n=nodes.get(n.parent);}for(const n of chain)crumbs.append(btn(n.name,()=>navigate(n.id)));
  flows.replaceChildren(el('span','沿流程探索：','muted'));for(const f of interfaces){const b=btn(f.name,()=>focusFlow(f.id));if(flow===f.id)b.classList.add('active');flows.append(b);}flows.append(btn('系統全貌',()=>{flow=null;navigate('root');}));
  const items=children();layer.replaceChildren();minimap.replaceChildren();list.replaceChildren();const positions=new Map(items.map((n,i)=>[n.id,{x:40+(i%3)*310,y:120+Math.floor(i/3)*180}]));
  const drawEdge=(a,b,label,fn)=>{const g=svg('g',{class:'explorer-edge',tabindex:0,role:'button','aria-label':label});g.append(svg('line',{x1:a.x+125,y1:a.y+55,x2:b.x+125,y2:b.y+55}),svg('line',{x1:a.x+125,y1:a.y+55,x2:b.x+125,y2:b.y+55,class:'edge-hit'}));const t=svg('text',{x:(a.x+b.x)/2+125,y:(a.y+b.y)/2+40,'text-anchor':'middle'});t.textContent=label;g.append(t);g.addEventListener('click',fn);g.addEventListener('keydown',e=>{if(e.key==='Enter')fn();});layer.append(g);};
  for(const e of edges)if(positions.has(e.from)&&positions.has(e.to))drawEdge(positions.get(e.from),positions.get(e.to),e.label,()=>inspectEdge(e));
  if(nodes.get(scope).type==='module'){
   const verifiedCalls=[['createMailClient.sendItem','validateItem'],['createMailClient.sendItem','createMailClient.callTool'],['createMailClient.callTool','createMailClient.rpc'],['syncInbox','createMailClient.fetchEvents'],['syncInbox','createMailClient.readMessage'],['modeSend','queueItem'],['modeSend','flushOutbox'],['createLifecycle.ingest','createLifecycle.applyMessage'],['createLifecycle.applyMessage','createLifecycle.onChoice']];
   for(const [from,to]of verifiedCalls){const a=items.find(i=>i.signature===from),b=items.find(i=>i.signature===to);if(a&&b)drawEdge(positions.get(a.id),positions.get(b.id),'本地呼叫 · 原始碼核對',()=>inspect(nodes.get(a.id)));}
  }
  for(const n of items){const p=positions.get(n.id),count=related(n).length,hasChildren=[...nodes.values()].some(v=>v.parent===n.id);const g=svg('g',{class:`explorer-node ${selected===n.id?'selected':''} ${workFocus&&!(n.symbolId&&workFocus.symbols?.length?workFocus.symbols.includes(n.symbolId):workFocus.components?.some(c=>n.components?.includes(c)))?'faded':''}`,tabindex:0,role:'button','aria-label':n.name,'data-node':n.id});
   g.append(svg('rect',{x:p.x,y:p.y,width:260,height:120,rx:12}));
   for(const [text,y,cls]of [[({system:'系統',service:'服務',interface:'介面',module:'模組',function:'函式'})[n.type],22,'node-kind'],[n.name,48,'node-title'],[n.operation??n.signature??n.technical??n.deployment??'',72,'node-sub'],[`${hasChildren?'進入內部 →':'查看詳情'}${count?' · '+count+' 則相關回報':''}`,98,'node-detail']]){const t=svg('text',{x:p.x+14,y:p.y+y,class:cls});t.textContent=String(text).length>32?String(text).slice(0,31)+'…':text;g.append(t);}
   g.addEventListener('click',()=>select(n.id));g.addEventListener('dblclick',()=>hasChildren?navigate(n.id):select(n.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(n.id);}});layer.append(g);minimap.append(svg('rect',{x:p.x,y:p.y,width:260,height:120,rx:10,class:'mini-node'}));list.append(btn(`${n.name} · ${n.type}`,()=>select(n.id)));
  }
  minimap.append(svg('rect',{class:'view-window',fill:'none',stroke:'#45bca0','stroke-width':8}));drawCamera();inspect(nodes.get(selected)??nodes.get(scope));
  if(selected)viewport.querySelector(`[data-node="${CSS.escape(selected)}"]`)?.focus({preventScroll:true});
 }
 function addField(label,text){inspector.append(el('h3',label),el('p',text??'尚未核對'));}
 function inspectEdge(e){selected=null;request++;inspector.replaceChildren(el('span','通訊關係 · 人工核對','tag'),el('h2',e.label));addField('方向',`${nodes.get(e.from).name} → ${nodes.get(e.to).name}`);addField('說明',e.description??'設計關係，非即時流量。');if(e.interfaceId)inspector.append(btn('展開通訊協議與 API →',()=>navigate('api:'+e.interfaceId)));}
 function inspect(n){const token=++request;inspector.replaceChildren(el('span',`${n.type} · ${n.id}`,'tag'),el('h2',n.name),el('p',n.description??'此部件負責對應的系統功能。'));const children=[...nodes.values()].filter(v=>v.parent===n.id);if(children.length)inspector.append(btn(`進入內部 · ${children.length} 個部件 →`,()=>navigate(n.id)));
  if(n.type==='interface'){for(const[label,value]of [['通訊協議',n.protocol],['呼叫方向',`${n.from} → ${n.to}`],['Method / Path',`${n.method} ${n.path}`],['操作',n.operation],['驗證',n.auth],['輸入',n.input],['輸出',n.output],['錯誤與邊界',n.errors]])addField(label,value);inspector.append(el('p','示例只列契約欄位，不包含正式憑證。','muted'));}
  if(serviceApis[n.id])for(const id of serviceApis[n.id])inspector.append(btn(`查看 ${interfaces.find(f=>f.id===id).name} 介面`,()=>navigate('api:'+id)));
  if(!children.length&&n.type==='service'&&!serviceApis[n.id])addField('可查證深度','目前提供 overview；尚未納入本批程式碼快照，不推測內部函式。');
  if(n.path)addField('來源模組',n.path);
  if(n.symbolId){addField('函式',n.signature);const pre=el('pre','正在取得原始碼…','code-snapshot');inspector.append(pre);api('/api/code/'+encodeURIComponent(n.symbolId)).then(s=>{if(token!==request)return;pre.replaceChildren();s.code.split('\n').forEach((line,i)=>{const row=el('span',undefined,'code-line');row.append(el('span',String(s.startLine+i),'line-number'),el('code',line));pre.append(row);});addField('參數',s.params.join(', ')||'無參數');addField('輸出與呼叫','請依真實程式碼與流程契約核對；本視圖不推測動態呼叫。');addField('版本',`${s.snapshot.revision}${s.snapshot.dirty?' · 未提交工作目錄':''}\nSHA-256 ${s.fileHash}`);const a=el('a','在 GitHub 查看來源');a.href=`https://github.com/${map.repo}/blob/${s.snapshot.dirty?(map.ref??'master'):s.snapshot.revision}/${s.path}#L${s.startLine}-L${s.endLine}`;a.target='_blank';a.rel='noopener noreferrer';if(s.snapshot.dirty)addField('來源提醒','未提交快照可能與 GitHub 分支內容不同；下方連結僅作參考。');inspector.append(a);}).catch(()=>{if(token===request)pre.textContent='快照無法取得，請重試；不以舊程式碼替代。';});}
  addField('相關工作',related(n).length?'以下為回報與證據，非即時監控。':'尚無對應工作回報。');for(const i of related(n).slice(0,5))inspector.append(btn(`${i.subject} · Mail #${i.id}`,()=>onItem(i)));
  const meta=map.codeSnapshot;if(meta)inspector.append(el('p',`快照 ${meta.snapshotHash.slice(0,12)} · ${meta.dirty?'工作目錄未提交':'版本 '+meta.revision.slice(0,12)} · 部署狀態需另行核對`,'muted small'));
 }
 const initial=saved();if(interfaces.some(f=>f.id===initial.flow))flow=initial.flow;if(nodes.has(initial.scope))scope=initial.scope;if(nodes.has(initial.selected))selected=initial.selected;render();
 window.addEventListener('hashchange',()=>{const p=saved();if(nodes.has(p.scope)){scope=p.scope;selected=nodes.has(p.selected)?p.selected:null;flow=p.flow;cam=cameras.get(scope)??{x:20,y:20,k:1};render();}});
 return {update(data,item){snapshot=data;workFocus=item;render();},showWork(item){workFocus=item;flow=null;navigate('root');},get scope(){return scope;}};
}
