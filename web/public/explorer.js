import {mountBoard} from '/board.js';
import {createPageIndex,pageAncestors,searchPages,cardPageId} from '/pages.js';
// C4 context/container/component/code + a project-specific protocol level.
// Relationships are source-backed design facts, never live traffic telemetry.
const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const svg = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k,v); return n; };
const button = (text, fn, cls = 'secondary') => { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', fn); return b; };
const icons = {
 person: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3M8 21v-3m8 3v-3"/>',
 computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
 server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5m-5 11h5"/>',
 message: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V10a8 8 0 0 1 8-8h3a8 8 0 0 1 8 9Z"/><path d="M7 8h9M7 12h6"/>',
 code: '<path d="m8 5-7 7 7 7m8-14 7 7-7 7m-3-17-2 20"/>',
 lock: '<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
 data: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/>',
 folder: '<path d="M2 6V3h7l3 3h10v15H2Z"/>',
 play: '<path d="m8 4 12 8-12 8Z"/>',
 pause: '<path d="M8 4v16M16 4v16"/>',
 arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
 search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 7 7"/>',
};
function icon(name) { const n = svg('svg', { viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':1.5, 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true' }); n.innerHTML = icons[name] ?? icons.server; return n; }
const levels = [
 ['系統全貌','誰在使用？','人、電腦與外部服務','person'],
 ['VPS 服務','裡面有哪些零件？','入口、協作核心與資料','server'],
 ['串接與協議','訊息怎麼走？','方向、協議與輸入輸出','message'],
 ['程式模組','程式放在哪裡？','每個服務的來源檔案','folder'],
 ['函式與原始碼','這段程式做什麼？','真實行號與唯讀快照','code'],
];
const serviceIcon = id => ({client:'computer',gateway:'lock',validator:'lock',mail:'message',clock:'server',memory:'data',bridge:'message',bot:'message',web:'code',postgres:'data','bank-proxy':'lock','token-applier':'lock'})[id] ?? 'server';
const flows = [
 {id:'handoff',name:'Mac 交接給 Windows',description:'寄件端保存交接，收件端主動讀取；Mail 不會直接推送到 Windows。',steps:[
 ['client','Mac 準備交接','checkpoint 產生 handoff，先留在本機 outbox。','本機 JSON'],
 ['gateway','Caddy 接住連線','裝置透過 HTTPS 進入 /mcp/，入口轉送給驗證代理。','HTTPS · POST /mcp/'],
 ['validator','驗證身分與組別','驗證裝置、收件者與內容，轉送至該組 Mail。','MCP · JSON-RPC'],
 ['mail','Mail 保存原文','send_message 保存訊息；收到回執才顯示已保存。','tools/call · send_message'],
 ['client','Windows 主動收件','輪詢 fetch_inbox_events，再 resources/read 取回原文。','輪詢 · MCP'],
 ['client','下一段工作接續','寫入本機 staging，開工時讀取交接；不自動批准動作。','本機 staging → session'],
 ]},
 {id:'confirm',name:'動作確認與逾時',description:'選擇先成為控制事件，再由 HubClock 判定；通知不代表動作已執行。',steps:[
 ['client','工作站呈現請求','把 presented 控制事件送入 Mail。','control · presented'],
 ['mail','Mail 保存控制事件','保留請求與 session 的識別資料。','MCP · send_message'],
 ['clock','HubClock 追蹤時限','讀取事件，檢查 session 與有效期限。','MCP · fetch_inbox_events'],
 ['client','人類留下選擇','工作站送出 choice；請求與收件 session 必須相符。','control · choice'],
 ['clock','產生確認結果','核對後寫入 approved/rejected/expired 等結果。','control · result'],
 ['client','原工作站核對結果','工作站讀取結果後，才依既有規則接續。','MCP → 本機 session'],
 ]},
 {id:'memory',name:'交接變成可搜尋記憶',description:'原文仍保存在 Mail；Bridge 與記憶服務建立可回指的搜尋內容。',steps:[
 ['mail','Mail 保存交接','交接與決策保留原文。','handoff / decision'],
 ['bridge','Bridge 擷取新紀錄','讀取 topic 窗口，以識別與游標避免重複處理。','MCP · fetch_topic'],
 ['memory','Hindsight 建立記憶','Bridge 使用受控服務身分，把文件送到 Hindsight。','HTTP · retain'],
 ['postgres','Hindsight 保存記憶','Hindsight 使用自己的資料庫保存索引，並非直接寫 hub 表。','Hindsight → PostgreSQL'],
 ['memory','後續可以查回來源','工作站透過 Caddy 與 bank proxy 查詢指定組別的記憶。','HTTPS · MCP recall'],
 ]},
];
const contextNodes=[
 {id:'person',name:'你與專案成員',subtitle:'決定工作，確認動作',description:'你設定方向、查看結果，並確認需要批准的動作。',why:'系統協助交換上下文，決定權仍在成員手上。',input:'任務、交接與確認請求',output:'工作目標、同意或拒絕',errors:'未確認的動作不能被當成已批准。',icon:'person',type:'context'},
 {id:'mac',name:'Mac 工作站',subtitle:'AI + 本機 hooks',description:'在 Mac 上工作，透過本機 hook 寄出交接與接收訊息。',why:'把 AI session 的上下文接入跨電腦協作。',input:'你的任務、Mail 訊息',output:'交接、控制事件、本機 staging',errors:'網路失敗時交接留在 outbox，保存結果需核對。',sources:[{path:'client/hub-hook.mjs',line:1}],icon:'computer',type:'context'},
 {id:'vps',name:'Hub 協作主機',subtitle:'VPS · 點開看每個服務',description:'一台遠端電腦，讓兩台工作站不必同時開機也能交換交接。',why:'工作站關閉時，訊息仍有共同保存的地方。',input:'HTTPS 訊息、Discord 指令',output:'訊息回執、查詢結果、通知',errors:'主機不可用時無法取得新資料；本機待送項目保留。',sources:[{path:'deploy/compose.yaml',line:1}],icon:'server',type:'context'},
 {id:'windows',name:'Windows 工作站',subtitle:'AI + 本機 hooks',description:'主動讀取 Mail 裡的新訊息，讓下一段工作接得上。',why:'另一台電腦也能取得共同的原始交接。',input:'Mail 事件與交接原文',output:'本機上下文、回覆、確認選擇',errors:'輪詢失敗保留游標；沒有新資料不代表任務完成。',sources:[{path:'client/mail-client.mjs',line:1}],icon:'computer',type:'context'},
 {id:'discord',name:'Discord',subtitle:'通知、手機查詢與登入',description:'你可以從 Discord 看通知、查進度，也用 Discord 身分登入這個工作台。',why:'讓人類從熟悉的入口查看協作結果。',input:'Bot 訊息、指令、OAuth 身分請求',output:'通知、查詢指令、登入身分',errors:'通知與登入不可用；不會因此改變 Mail 保存結果。',sources:[{path:'bot/src/discord.mjs',line:1},{path:'web/src/server.mjs',line:1}],icon:'message',type:'context'},
 {id:'github',name:'GitHub',subtitle:'正式任務與程式碼',description:'GitHub Issues 記錄正式任務，程式碼連結提供可查證的來源。',why:'任務編號、工作回報與程式提交需要可追溯的關係。',input:'建立／更新 Issue、唯讀程式連結',output:'Issue 編號、狀態與來源檔',errors:'GitHub 失敗不能回報已建立任務；原交接仍可保留。',sources:[{path:'bot/src/github.mjs',line:1}],icon:'code',type:'context'},
 ];

export function createExplorer({map,api,onItem,onClear=()=>{}}){
 const atlas=map.atlas;
 if(!atlas?.services?.length)throw Error('架構模型尚未建置，請先執行 npm run build。');
 const pages=createPageIndex(map,contextNodes),services=new Map(atlas.services.map(s=>[s.id,s]));
 const modules=new Map(atlas.modules.map(m=>[m.id,m]));
 const panel=$('#architecture');panel.replaceChildren();panel.className='workbench board-workbench';
 document.body.classList.add('board-shell');
 const mobile=matchMedia('(max-width: 760px)'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let current='home',selected=null,linkedPageId=null,hoveredPageId=null,transitionAnimation=null,workFocus=null,snapshot={items:[]},request=0,playing=false,step=-1,timer=null,activeFlow=flows[0],sidebarOpen=!mobile.matches;
 const expanded=new Set(['home','vps']);
 const sidebar=el('aside',undefined,'page-sidebar');sidebar.setAttribute('aria-label','架構頁面目錄');
 const sideHead=el('div',undefined,'sidebar-head');sideHead.append(icon('folder'),el('strong','Hub 工作空間'));
 const sideClose=button('關閉目錄',()=>toggleSidebar(false),'sidebar-close');sideHead.append(sideClose);
 const searchWrap=el('label',undefined,'tree-search'),search=el('input');search.type='search';search.placeholder='搜尋頁面與原始碼';search.setAttribute('aria-label','搜尋頁面');searchWrap.append(icon('search'),search);
 const tree=el('div',undefined,'page-tree');tree.setAttribute('role','tree');tree.setAttribute('aria-label','系統架構頁面樹');
 const sideFoot=el('div',undefined,'sidebar-footer');sideFoot.append(el('span','唯讀架構 · 位置可自由整理'),el('span',`來源 ${map.codeSnapshot.revision.slice(0,8)}`));sidebar.append(sideHead,searchWrap,tree,sideFoot);
 const stage=el('div',undefined,'explorer-stage board-stage');
 const top=el('div',undefined,'board-topbar'),menu=button('目錄',()=>toggleSidebar(!sidebarOpen),'secondary menu-toggle');menu.prepend(icon('folder'));
 const breadcrumbs=el('nav',undefined,'board-breadcrumbs');breadcrumbs.setAttribute('aria-label','頁面路徑');
 const explain=button('零件說明',()=>toggleInspector(),'secondary detail-toggle');
 const commandButton=button('',()=>openCommand(),'command-trigger secondary');commandButton.setAttribute('aria-label','搜尋並跳到頁面');commandButton.append(icon('search'),el('span','搜尋頁面'),el('kbd','⌘K'));top.append(menu,breadcrumbs,commandButton,explain);
 const pageHead=el('div',undefined,'board-page-heading'),heading=el('div'),title=el('h1'),subtitle=el('p');heading.append(title,subtitle);
 const pageTools=el('div',undefined,'board-page-tools'),flowShortcut=button('流程教學',()=>go('flows'),'secondary'),fit=button('適合畫面',()=>board.fitView(),'secondary');pageTools.append(flowShortcut,fit);pageHead.append(heading,pageTools);
 const player=el('section',undefined,'flow-player board-flow-player');player.setAttribute('aria-label','流程教學');
 const body=el('div',undefined,'explorer-body board-body'),surface=el('div',undefined,'board-surface');
 const canvas=el('div',undefined,'infinite-board');canvas.id='infinite-board';canvas.setAttribute('aria-label','可平移縮放的無限白板');
 const source=el('section',undefined,'source-reader board-source');source.hidden=true;
 const hint=el('div',undefined,'board-hint');hint.append(el('span','拖曳空白平移 · 滾輪縮放 · Shift 拖曳框選'),el('span','雙擊卡片或「打開白板」進入下一頁'));
 const selectedCount=el('span','未選取零件','selection-count');hint.append(selectedCount);
 const catalog=el('details',undefined,'board-directory');catalog.append(el('summary','本頁零件與資料目錄'));const catalogBody=el('div');catalog.append(catalogBody);
 const inspector=el('aside',undefined,'architecture-inspector board-inspector');inspector.id='architecture-inspector';inspector.setAttribute('aria-label','零件詳細說明');
 const status=el('div',undefined,'board-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 surface.append(canvas,source,hint,catalog);body.append(surface,inspector);stage.append(top,pageHead,player,body,status);panel.append(sidebar,stage);
 const board=mountBoard(canvas,{
  onNodeSelect(n){if(n.stepIndex!==undefined){stop();step=n.stepIndex;renderPlayer();}selected=n;linkedPageId=pages.has(cardPageId(n))?cardPageId(n):null;if(linkedPageId){for(const p of pageAncestors(pages,linkedPageId))expanded.add(p.id);renderTree();}renderInspector(n);draw();if(mobile.matches)toggleInspector(true);},
  onNodeHover(n){hoveredPageId=n?cardPageId(n):null;syncTreeHighlight();},
  onNodeOpen(n){if(n.type==='source-reference'){selected=n;renderInspector(n);toggleInspector(true);return;}const id=cardPageId(n);if(pages.has(id))go(id);},
  onEdgeSelect(e){stop();renderPlayer();selected={...e,type:e.type==='sequence'?'step-transition':'connection'};renderInspector(selected);if(mobile.matches)toggleInspector(true);},
  onSelectionChange(items){const count=Array.isArray(items)?items.length:items?.nodes?.length??0;selectedCount.textContent=count?`已框選 ${count} 個零件`:'未選取零件';},
 });
 function toggleSidebar(open){sidebarOpen=open;panel.classList.toggle('sidebar-hidden',!open);menu.setAttribute('aria-expanded',String(open));sidebar.classList.toggle('mobile-open',open);}
 function toggleInspector(open){const yes=open??!panel.classList.contains('inspector-open');panel.classList.toggle('inspector-open',yes);explain.setAttribute('aria-expanded',String(yes));}
 function stop(){playing=false;clearTimeout(timer);timer=null;}
 function currentPage(){return pages.get(current);}
 function urlFor(id){return '#'+new URLSearchParams({page:id});}
 function go(id,{replace=false}={}){
  if(!pages.has(id))return;stop();current=id;selected=null;linkedPageId=null;hoveredPageId=null;step=-1;
  if(currentPage().flowId)activeFlow=flows.find(f=>f.id===currentPage().flowId)??flows[0];
  for(const p of pageAncestors(pages,id))expanded.add(p.id);
  history[replace?'replaceState':'pushState'](null,'',urlFor(id));
  if(mobile.matches){toggleSidebar(false);toggleInspector(false);}
  render();transitionAnimation?.cancel();if(!reduced.matches)transitionAnimation=surface.animate([{opacity:.4,transform:'scale(.975) translateY(6px)'},{opacity:1,transform:'scale(1) translateY(0)'}],{duration:280,easing:'cubic-bezier(.16,1,.3,1)'});
 }
 function restore(){const q=new URLSearchParams(location.hash.slice(1));let id=q.get('page');
  if(!pages.has(id)){const level=Number(q.get('level')),sid=q.get('service')??'client',mid=q.get('module'),symbol=q.get('selected');id=level===4&&map.symbols[symbol]?`code:${symbol}`:level===4&&modules.has(mid)?mid:level===3?`service:${sid}`:level===2?`flow:${q.get('flow')??'handoff'}`:level===1?'vps':'home';}
  go(pages.has(id)?id:'home',{replace:true});
 }
 function renderTree(){
  tree.replaceChildren();const query=search.value.trim();
  if(query){const hits=searchPages(pages,query);tree.removeAttribute('role');if(!hits.length)tree.append(el('p','找不到頁面，請試試 Mail、模組或函式名稱。','empty'));for(const p of hits){const b=button('',()=>{search.value='';go(p.id);},'tree-search-result');b.append(icon(p.kind==='function'?'code':'folder'),el('strong',p.name),el('small',pageAncestors(pages,p.id).slice(0,-1).map(x=>x.name).join(' / ')));tree.append(b);}return;}
  tree.setAttribute('role','tree');
  function row(id,depth,parent){const p=pages.get(id),item=el('div',undefined,'tree-item');item.setAttribute('role','treeitem');item.setAttribute('aria-level',String(depth+1));if(p.children.length)item.setAttribute('aria-expanded',String(expanded.has(id)));const line=el('div',undefined,'tree-row'+(id===current?' current':''));line.dataset.pageId=id;line.style.setProperty('--tree-depth',String(depth));
   if(p.children.length){const toggle=button('',()=>{expanded.has(id)?expanded.delete(id):expanded.add(id);renderTree();},'tree-expander');toggle.setAttribute('aria-label',`${expanded.has(id)?'收合':'展開'} ${p.name}`);toggle.setAttribute('aria-expanded',String(expanded.has(id)));toggle.append(icon('arrow'));line.append(toggle);}else line.append(el('span','','tree-spacer'));
   const b=button('',()=>go(id),'tree-page');b.append(icon(['function','code'].includes(p.kind)?'code':p.kind==='flows'||p.kind==='flow'?'message':p.kind==='service'?'server':'folder'),el('span',p.name));b.title=p.detail?.path??p.name;b.setAttribute('aria-label',`開啟頁面 ${p.name}`);if(id===current)b.setAttribute('aria-current','page');line.append(b);item.append(line);parent.append(item);
   if(p.children.length&&expanded.has(id)){const group=el('div',undefined,'tree-children');group.setAttribute('role','group');item.append(group);for(const child of p.children)row(child,depth+1,group);}
  }
  row('home',0,tree);syncTreeHighlight();queueMicrotask(()=>tree.querySelector('.tree-row.current')?.scrollIntoView({block:'nearest',behavior:reduced.matches?'instant':'smooth'}));
 }
 function positions(items,cols=3,startY=110){return items.map((n,i)=>({...n,x:60+(i%cols)*370,y:startY+Math.floor(i/cols)*205,w:290,h:150}));}
 function pageCard(id,overrides={}){const p=pages.get(id);return {...p.detail,id:p.id,name:p.name,description:p.description,pageId:p.id,serviceId:p.serviceId,symbolId:p.kind==='function'?p.symbolId:undefined,type:p.kind,...overrides};}
 function graph(){const p=currentPage();let nodes=[],edges=[],bounds=[];
  if(p.kind==='overview'){
   nodes=contextNodes.map(n=>({...n,pageId:cardPageId(n)}));const xy=[[40,40],[40,300],[430,200],[430,500],[820,40],[820,500]];nodes.forEach((n,i)=>Object.assign(n,{x:xy[i][0],y:xy[i][1],w:290,h:150}));
   edges=[['person','mac','發出任務'],['person','discord','手機查詢'],['mac','vps','HTTPS · 交接'],['windows','vps','HTTPS · 主動收件'],['vps','discord','通知 / OAuth'],['vps','github','HTTPS · Issues']].map(([from,to,label])=>({id:`${from}-${to}`,from,to,label,protocol:label.includes('HTTPS')?'HTTPS':'使用關係',type:'context-edge'}));bounds=[{id:'remote',x:400,y:160,w:350,h:250,label:'VPS · 共同協作中心'}];
  }else if(p.kind==='services'){
   const groups=[['安全入口',['gateway','validator','bank-proxy']],['協作核心',['mail','clock','bot','bridge','web','token-applier']],['記憶與資料',['memory','postgres']],['主機維運',['ops']]];let y=70;
   for(const [label,ids]of groups){const cards=ids.filter(id=>services.has(id)).map(id=>pageCard('service:'+id,{id}));nodes.push(...positions(cards,3,y+55));const h=Math.ceil(cards.length/3)*205+45;bounds.push({id:'group-'+label,x:30,y,w:1110,h,label});y+=h+50;}
   const visible=new Set(nodes.map(n=>n.id));edges=atlas.connections.filter(e=>visible.has(e.from)&&visible.has(e.to));
  }else if(p.kind==='service'){
   nodes=positions(p.children.map(id=>pageCard(id)));const byPath=new Map(nodes.map(n=>[modules.get(n.id)?.path,n.id]));edges=(atlas.imports??[]).filter(im=>byPath.has(im.from)&&byPath.has(im.to)).map((im,i)=>({id:'import-'+i,from:byPath.get(im.from),to:byPath.get(im.to),label:'import',protocol:'靜態模組依賴',description:'import 表示來源依賴，不代表實際呼叫順序。',sources:[{path:im.from,line:im.line}]}));
  }else if(p.kind==='module'){
   nodes=positions(p.children.map(id=>pageCard(id)));if(!nodes.length)nodes=positions([{...p.detail,id:'reference:'+p.id,type:'source-reference',name:'來源設定與用途',description:p.detail.description,subtitle:p.detail.path,actionLabel:'查看來源與說明'}],1,90);const byName=new Map(nodes.filter(n=>n.pageId).map(n=>[pages.get(n.pageId).detail.name,n.id]));edges=(atlas.calls??[]).filter(c=>c.path===p.detail.path&&byName.has(c.from)).flatMap((c,i)=>{const target=[...byName.keys()].find(name=>name===c.callee||name===c.from.split('.').slice(0,-1).concat(c.callee).join('.'));return target?[{id:'call-'+i,from:byName.get(c.from),to:byName.get(target),label:'靜態呼叫候選',protocol:'本地函式',sources:[{path:c.path,line:c.line}]}]:[];});
  }else if(p.kind==='function'){
   nodes=positions([pageCard(p.children[0],{subtitle:`${p.detail.path}:${p.detail.startLine}–${p.detail.endLine}`,description:'打開唯讀原碼頁，查看真實行號、參數與程式。',name:'閱讀 '+p.detail.name+' 原始碼',symbolId:undefined})],1,90);
  }else if(p.kind==='flows'){nodes=positions(p.children.map(id=>pageCard(id)),3,90);}
  else if(p.kind==='flow'){
   nodes=positions(activeFlow.steps.map(([sid,name,description,subtitle],i)=>({...services.get(sid),id:'step-'+i,name,description,subtitle,pageId:'service:'+sid,serviceId:sid,stepIndex:i})),3,90);
   edges=nodes.slice(0,-1).map((n,i)=>({id:'sequence-'+i,from:n.id,to:nodes[i+1].id,label:`步驟 ${i+1} → ${i+2}`,description:activeFlow.steps[i+1][2],protocol:activeFlow.steps[i+1][3],type:'sequence',fromName:n.name,toName:nodes[i+1].name,sources:services.get(activeFlow.steps[i+1][0])?.sources??[]}));
  }else if(p.kind==='context'){
   const ids=p.contextId==='person'?['service:client','context:discord','vps']:p.contextId==='discord'?['service:bot','service:web']:['service:bot','service:web'];nodes=positions(ids.map(id=>pageCard(id)),3,90);
  }
  const lookup=new Map(nodes.map(n=>[n.id,n]));edges=edges.map(e=>({...e,fromName:e.fromName??lookup.get(e.from)?.name,toName:e.toName??lookup.get(e.to)?.name}));
  if(workFocus){const focus=new Set(workFocus.components??[]);nodes=nodes.map(n=>({...n,workMatched:focus.has(n.serviceId??n.id)||focus.has(n.id==='web'?'guide':n.id==='bot'?'discord':n.id)}));}
  return {nodes,edges,bounds};
 }
 function draw(){const g=graph();board.render({pageId:current,...g,activeStep:step,playing,highlightedPageId:hoveredPageId??linkedPageId,highlightNodeIds:g.nodes.filter(n=>[hoveredPageId,linkedPageId].filter(Boolean).includes(cardPageId(n))).map(n=>n.id),selectedNodeId:selected?.id});renderCatalog(g);}
 function field(label,value){const section=el('section',undefined,'detail-field');section.append(el('h3',label),el('p',value??'請依來源核對，這裡不推測動態行為。'));inspector.append(section);}
 function sourceLink(s){const line=s.line??s.startLine??1,m=atlas.modules.find(m=>m.path===s.path),sid=m?.symbolIds.find(id=>map.symbols[id].startLine<=line&&map.symbols[id].endLine>=line);if(sid)return button(`${s.path}:${line} · 本機快照`,()=>go('code:'+sid),'source-link local-source');const a=el('a',`${s.path}:${line} · GitHub 參考`,'source-link');a.href=`https://github.com/${map.repo}/blob/${map.ref??'master'}/${s.path}#L${line}`;a.target='_blank';a.rel='noopener noreferrer';return a;}
 function renderInspector(n){inspector.replaceChildren();const close=button('關閉說明',()=>toggleInspector(false),'inspector-close');inspector.append(close);const p=currentPage(),item=n??p.detail??{name:p.name,description:p.description};
  inspector.append(el('span',n?.type==='connection'?'串接契約':p.kind==='code'?'原碼頁':'這個零件在做什麼','detail-type'),el('h2',item.title??item.name??item.label),el('p',item.description??'點卡片看白話用途，雙擊或打開白板深入。','detail-lead'));
  if(item.type==='connection'){field('誰送給誰',`${item.fromName??services.get(item.from)?.name??item.from} → ${item.toName??services.get(item.to)?.name??item.to}`);field('協議',item.protocol);}
  if(item.type==='step-transition'){field('教學步驟順序',`${item.fromName} → ${item.toName}`);field('真正呼叫方向','編號箭頭是流程先後；Windows 主動呼叫 Mail 收件，真正串接另列於目錄。');}
  field('為什麼需要它',item.why??(p.kind==='overview'?'讓你在一張白板看見跨電腦協作，再逐頁深入每個零件。':'把這項責任放在明確頁面，讓用途、來源與其他零件的邊界可以追溯。'));
  const io=el('div',undefined,'io-pair');for(const [label,text]of[['輸入',item.input],['輸出',item.output]]){const box=el('div');box.append(el('h3',label),el('p',text??(p.kind==='overview'?'任務、訊息與來源快照':'請核對來源中的參數、回傳與副作用。')));io.append(box);}inspector.append(io);
  field('如果出錯',item.errors??'無法取得結果時應停止核對，不能當作已保存、已批准或已部署。');
  const destination=n&&n.type!=='source-reference'?cardPageId(n):null;if(destination&&pages.has(destination)&&destination!==current)inspector.append(button('打開這個零件的白板',()=>go(destination),'primary-action'));
  const id=item.serviceId??(services.has(item.id)?item.id:p.serviceId),connected=atlas.connections.filter(e=>e.from===id||e.to===id);if(connected.length){const section=el('section',undefined,'detail-field');section.append(el('h3','跟誰相連'));for(const e of connected)section.append(button(`${services.get(e.from)?.name??e.from} → ${services.get(e.to)?.name??e.to}`,()=>{selected={...e,type:'connection'};renderInspector(selected);},'connection-link'));inspector.append(section);}
  const sources=item.sources??(item.path?[{path:item.path,line:item.startLine??1}]:[]);if(sources.length){const s=el('section',undefined,'detail-field');s.append(el('h3','來源與行號'),el('p','本機快照可直接讀；GitHub 參考版本可能不同。','source-caveat'));sources.slice(0,5).forEach(x=>s.append(sourceLink(x)));inspector.append(s);}
  if(item.params)field('函式參數',item.params.join(', ')||'無明列參數');
  const work=snapshot.items.filter(i=>i.components?.some(c=>[id,id==='web'?'guide':'',id==='bot'?'discord':''].includes(c)));if(work.length){const s=el('section',undefined,'detail-field');s.append(el('h3','相關工作回報'));work.slice(0,4).forEach(i=>s.append(button(i.subject,()=>onItem(i),'connection-link')));inspector.append(s);}
  field('版本與界線',`${map.codeSnapshot.revision.slice(0,12)}${map.codeSnapshot.dirty?' · 建置時有未提交變更':''}；來源快照不代表服務已部署。`);
 }
 function renderCode(){const p=currentPage(),token=++request;source.hidden=p.kind!=='code';canvas.hidden=p.kind==='code';hint.hidden=p.kind==='code';if(p.kind!=='code')return;const s=p.detail;source.replaceChildren();const head=el('div',undefined,'source-reader-heading');head.append(el('span',s.language??'source','source-language'),el('h2',s.title??s.name),el('p',`${s.path} · L${s.startLine}–${s.endLine}`),el('p','唯讀來源快照 · 可左右捲動 · 行號對應原檔','source-caveat'));const pre=el('pre','正在讀取受保護的原始碼…','code-snapshot');source.append(head,pre);
  api('/api/code/'+encodeURIComponent(p.symbolId)).then(value=>{if(token!==request||current!==p.id)return;pre.replaceChildren();value.code.split('\n').forEach((line,i)=>{const row=el('span',undefined,'code-line');row.append(el('span',String(value.startLine+i),'line-number'),el('code',line));pre.append(row);});head.append(el('p',`SHA-256 ${value.fileHash}`,'source-caveat'));}).catch(()=>{if(token===request){pre.textContent='讀取失敗，請確認登入後重試。';source.append(button('重試原碼',renderCode,'secondary'));}});
 }
 function renderCatalog(g){catalogBody.replaceChildren();catalog.hidden=currentPage().kind==='code';for(const n of g.nodes){const b=button('',()=>{if(n.type==='source-reference'){renderInspector(n);toggleInspector(true);}else go(cardPageId(n));},'module-row');b.append(icon(n.symbolId?'code':'folder'),el('span',n.name),el('span','打開白板'));catalogBody.append(b);}if(['services','flow'].includes(currentPage().kind)){const d=el('details');d.append(el('summary','所有服務的真正呼叫方向'));for(const e of atlas.connections){const b=button('',()=>{selected={...e,type:'connection'};renderInspector(selected);toggleInspector(true);},'connection-row');b.append(el('strong',`${services.get(e.from)?.name} → ${services.get(e.to)?.name}`),el('span',e.protocol));d.append(b);}catalogBody.append(d);}
  if(currentPage().kind==='services'){const d=el('details');d.append(el('summary',`資料表 · ${atlas.tables.length}`));for(const t of atlas.tables)d.append(button(t.name,()=>{renderInspector(t);toggleInspector(true);},'module-row'));catalogBody.append(d);}
  if(currentPage().kind==='flow'){const d=el('details');d.append(el('summary',`訊息種類 · ${atlas.messages.length}`));for(const m of atlas.messages)d.append(button(m.title,()=>{renderInspector(m);toggleInspector(true);},'module-row'));catalogBody.append(d);}
 }
 function renderPlayer(){player.replaceChildren();player.hidden=currentPage().kind!=='flow';if(player.hidden)return;
  const bar=el('div',undefined,'player-bar');const play=button(playing?'暫停':'播放流程',()=>{if(playing){stop();renderPlayer();draw();}else startFlow();},'play-button');play.prepend(icon(playing?'pause':'play'));const pick=el('select');pick.setAttribute('aria-label','選擇教學流程');for(const f of flows){const o=el('option',f.name);o.value=f.id;pick.append(o);}pick.value=activeFlow.id;pick.addEventListener('change',()=>go('flow:'+pick.value));
  const prev=button('上一步',()=>manualStep(Math.max(0,step-1)),'step-navigation'),next=button('下一步',()=>manualStep(Math.min(activeFlow.steps.length-1,step+1)),'step-navigation');prev.disabled=step<=0;next.disabled=step>=activeFlow.steps.length-1;bar.append(play,pick,prev,next);player.append(bar);
  const seq=el('div',undefined,'player-sequence');activeFlow.steps.forEach((s,i)=>{const b=button('',()=>manualStep(i),'step-chip'+(step===i?' active':''));b.append(el('span',String(i+1)),el('span',s[1]));seq.append(b);});const cap=el('div',undefined,'player-caption');cap.setAttribute('aria-live','polite');cap.append(el('strong',step>=0?activeFlow.steps[step][1]:'教學步驟先後 · 非即時流量'),el('span',step>=0?activeFlow.steps[step][2]:activeFlow.description));player.append(seq,cap);
 }
 function inspectStep(){const s=activeFlow.steps[step];if(s)renderInspector({...services.get(s[0]),name:s[1],description:s[2]});}
 function manualStep(i){stop();step=i;renderPlayer();draw();inspectStep();}
 function tick(){if(!playing)return;step++;if(step>=activeFlow.steps.length){stop();step--;renderPlayer();draw();return;}renderPlayer();draw();inspectStep();timer=setTimeout(tick,2400);}
 function startFlow(){stop();if(step<0||step>=activeFlow.steps.length-1)step=-1;playing=true;renderPlayer();tick();}
 function render(){const p=currentPage();title.textContent=p.name;subtitle.textContent=p.description??'每個零件都是一頁，打開它自己的白板。';breadcrumbs.replaceChildren();const chain=pageAncestors(pages,current);chain.forEach((p,i)=>{if(i)breadcrumbs.append(el('span','/'));const b=button(p.name,()=>go(p.id),'crumb');if(p.id===current)b.setAttribute('aria-current','page');breadcrumbs.append(b);});
  panel.dataset.page=current;renderTree();renderPlayer();renderCode();draw();renderInspector(selected);status.textContent=`${pages.size} 個頁面 · ${atlas.modules.length} 個模組 · ${Object.keys(map.symbols).length} 個函式　畫布位置只在本機暫存；架構與來源唯讀。`;
 }
 function syncTreeHighlight(){for(const row of tree.querySelectorAll('.tree-row')){row.classList.toggle('canvas-linked',row.dataset.pageId===linkedPageId);row.classList.toggle('canvas-hovered',row.dataset.pageId===hoveredPageId);}}
 function hoverTreePage(id){if(hoveredPageId===id)return;hoveredPageId=id;syncTreeHighlight();draw();}
 tree.addEventListener('pointerover',event=>{const row=event.target.closest('.tree-row');if(row)hoverTreePage(row.dataset.pageId);});
 tree.addEventListener('pointerleave',()=>hoverTreePage(null));
 tree.addEventListener('focusin',event=>{const row=event.target.closest('.tree-row');if(row)hoverTreePage(row.dataset.pageId);});
 const command=el('dialog',undefined,'command-palette');command.setAttribute('aria-label','搜尋並跳到架構頁面');
 const commandHead=el('div',undefined,'command-head'),commandInput=el('input');commandInput.type='search';commandInput.placeholder='搜尋零件、模組、函式…';commandInput.setAttribute('aria-label','命令面板搜尋');commandInput.setAttribute('role','combobox');commandInput.setAttribute('aria-expanded','true');commandInput.setAttribute('aria-controls','command-results');commandInput.setAttribute('aria-autocomplete','list');const commandClose=button('Esc',()=>command.close(),'command-close');commandClose.setAttribute('aria-label','關閉命令面板');commandHead.append(icon('search'),commandInput,commandClose);
 const commandResults=el('div',undefined,'command-results');commandResults.id='command-results';commandResults.setAttribute('role','listbox');commandResults.setAttribute('aria-label','符合的架構頁面');const commandFooter=el('div',undefined,'command-footer');commandFooter.append(el('span','↑ ↓ 選擇　↵ 打開頁面'),el('span','⌘K / Ctrl K'));command.append(commandHead,commandResults,commandFooter);document.body.append(command);
 let commandHits=[],commandIndex=0,returnFocus=null,commandNavigating=false;
 function renderCommand(){const q=commandInput.value.trim();commandHits=q?searchPages(pages,q,18):['home','vps','flows','service:client','service:validator','service:web'].map(id=>pages.get(id)).filter(Boolean);commandIndex=Math.max(0,Math.min(commandIndex,commandHits.length-1));commandResults.replaceChildren();
  if(!commandHits.length){commandResults.append(el('p','找不到符合的頁面，請試試 Mail、sendItem 或來源檔名。','command-empty'));commandInput.removeAttribute('aria-activedescendant');return;}
  const kinds={overview:'總覽',services:'主機',service:'服務',module:'模組',function:'函式',flows:'流程',flow:'教學',context:'系統'};
  commandHits.forEach((p,i)=>{const option=el('div',undefined,'command-option'+(i===commandIndex?' active':''));option.id='command-option-'+i;option.setAttribute('role','option');option.setAttribute('aria-selected',String(i===commandIndex));const face=icon(p.kind==='function'?'code':p.kind==='service'?'server':'folder'),copy=el('span',undefined,'command-option-copy');copy.append(el('strong',p.name),el('small',p.detail?.path??pageAncestors(pages,p.id).slice(0,-1).map(x=>x.name).join(' / ')));option.append(face,copy,el('span',kinds[p.kind]??'頁面','command-kind'));option.addEventListener('click',()=>chooseCommand(i));option.addEventListener('pointermove',()=>{if(commandIndex===i)return;commandIndex=i;highlightCommand();});commandResults.append(option);});highlightCommand();
 }
 function highlightCommand(){for(const [i,option]of [...commandResults.querySelectorAll('[role=option]')].entries()){option.classList.toggle('active',i===commandIndex);option.setAttribute('aria-selected',String(i===commandIndex));}commandInput.setAttribute('aria-activedescendant','command-option-'+commandIndex);commandResults.querySelector('.active')?.scrollIntoView({block:'nearest'});}
 function openCommand(){if(command.open){command.close();return;}commandNavigating=false;returnFocus=document.activeElement;commandInput.value='';commandIndex=0;renderCommand();command.showModal();commandInput.focus();}
 function chooseCommand(index){const p=commandHits[index];if(!p)return;commandNavigating=true;command.close();go(p.id);queueMicrotask(()=>title.focus({preventScroll:true}));}
 title.tabIndex=-1;
 commandInput.addEventListener('input',()=>{commandIndex=0;renderCommand();});commandInput.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();commandIndex=Math.max(0,Math.min(commandHits.length-1,commandIndex+(event.key==='ArrowDown'?1:-1)));highlightCommand();}else if(event.key==='Enter'){event.preventDefault();chooseCommand(commandIndex);}});
 command.addEventListener('click',event=>{if(event.target===command){const r=command.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)command.close();}});
 command.addEventListener('close',()=>{if(commandNavigating)title.focus({preventScroll:true});else if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
 function commandKey(event){if(!event.isComposing&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openCommand();}}
 window.addEventListener('keydown',commandKey);
 tree.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const line=event.target.closest('.tree-row');if(!line)return;event.preventDefault();const id=line.dataset.pageId,p=pages.get(id),visible=[...tree.querySelectorAll('.tree-row')].map(r=>r.dataset.pageId);let target=id;if(event.key==='ArrowRight'){if(p.children.length&&!expanded.has(id)){expanded.add(id);renderTree();}else target=p.children[0]??id;}else if(event.key==='ArrowLeft'){if(p.children.length&&expanded.has(id)){expanded.delete(id);renderTree();}else target=p.parent??id;}else if(event.key==='ArrowUp')target=visible[Math.max(0,visible.indexOf(id)-1)];else if(event.key==='ArrowDown')target=visible[Math.min(visible.length-1,visible.indexOf(id)+1)];else target=event.key==='Home'?visible[0]:visible.at(-1);queueMicrotask(()=>[...tree.querySelectorAll('.tree-row')].find(r=>r.dataset.pageId===target)?.querySelector('.tree-page')?.focus());});
 search.addEventListener('input',renderTree);
 window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('page');if(pages.has(id)&&id!==current)go(id,{replace:true});});
 mobile.addEventListener('change',()=>{toggleSidebar(!mobile.matches);toggleInspector(!mobile.matches);});
 toggleSidebar(sidebarOpen);toggleInspector(!mobile.matches);restore();
 return {update(data,item){snapshot=data;workFocus=item;if(!playing){draw();renderInspector(selected);}},showWork(item){workFocus=item;onClear();go('vps');},get scope(){return current;},destroy(){stop();request++;transitionAnimation?.cancel();window.removeEventListener('keydown',commandKey);command.remove();board.destroy();}};
}
