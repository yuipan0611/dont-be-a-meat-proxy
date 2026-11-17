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
export function createExplorer({map,api,onItem,onClear = () => {}}) {
 const atlas = map.atlas;
 if (!atlas?.services?.length) throw Error('架構模型尚未建置，請執行 npm run build。');
 const services = new Map(atlas.services.map(s => [s.id,s]));
 const modules = new Map(atlas.modules.map(m => [m.id,m]));
 const panel = $('#architecture'); panel.replaceChildren(); panel.className = 'workbench';
 let level = 0, serviceId = 'client', moduleId = '', selected = null, activeFlow = flows[0], step = -1, playing = false, timer = null, request = 0;
 let snapshot = {items:[]}, workFocus = null, camera = {x:0,y:0,k:1};
 const mobile = matchMedia('(max-width: 760px)');
 const rail = el('aside',undefined,'level-rail'); rail.setAttribute('aria-label','架構層級');
 rail.append(el('div','探索層級','rail-label'));
 const stage = el('div',undefined,'explorer-stage');
 const toolbar = el('div',undefined,'explorer-toolbar'), heading = el('div'), title = el('h2'), subtitle = el('p',undefined,'muted'); heading.append(title,subtitle);
 const searchWrap = el('label',undefined,'architecture-search'),search = el('input'); search.type='search'; search.placeholder='搜尋零件、檔案、函式'; search.setAttribute('aria-label','搜尋架構'); searchWrap.append(icon('search'),search);
 toolbar.append(heading,searchWrap);
 const results = el('div',undefined,'search-results'); results.hidden=true;
 const breadcrumbs = el('nav',undefined,'crumbs'); breadcrumbs.setAttribute('aria-label','探索路徑');
 const selector = el('div',undefined,'scope-selector');
 const player = el('section',undefined,'flow-player'); player.setAttribute('aria-label','流程教學');
 const body = el('div',undefined,'explorer-body'), surface = el('div',undefined,'canvas-surface');
 const canvasHead = el('div',undefined,'canvas-caption'),canvasTitle = el('strong'),canvasNote = el('span','靜態架構 · 非即時流量'); canvasHead.append(canvasTitle,canvasNote);
 const viewport = svg('svg', {viewBox:'0 0 1000 610',class:'architecture-canvas','aria-label':'互動架構圖',tabindex:0});
 const defs=svg('defs'),marker=svg('marker',{id:'atlas-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#64877c'}));defs.append(marker);const layer=svg('g');viewport.append(defs,layer);
 const controls = el('div',undefined,'canvas-controls'),zoomLabel=el('span','100%');
 controls.append(button('−',()=>zoom(.8)),zoomLabel,button('＋',()=>zoom(1.25)),button('重設視野',()=>{camera={x:0,y:0,k:1};drawCamera();}));
 const legend = el('div',undefined,'canvas-legend'); legend.append(el('span','點零件看用途 · 雙擊進入下一層'),el('span','實線：來源核對的串接　虛線：使用關係'));
 const catalog = el('div',undefined,'catalog'),codeReader=el('section',undefined,'source-reader');codeReader.hidden=true;
 const inspector = el('aside',undefined,'architecture-inspector'); inspector.id='architecture-inspector'; inspector.setAttribute('aria-label','零件詳細說明');
 surface.append(canvasHead,codeReader,viewport,controls,legend,catalog); body.append(surface,inspector); stage.append(toolbar,results,breadcrumbs,selector,player,body);
 const provenance = el('div',undefined,'atlas-provenance'); panel.append(rail,stage,provenance);
 function setURL(){const p=new URLSearchParams({level:String(level),service:serviceId});if(moduleId)p.set('module',moduleId);if(selected?.id)p.set('selected',selected.id);p.set('flow',activeFlow.id);history.replaceState(null,'','#'+p);}
 function restore(){const p=new URLSearchParams(location.hash.slice(1));const l=Number(p.get('level'));if(Number.isInteger(l)&&l>=0&&l<=4)level=l;if(services.has(p.get('service')))serviceId=p.get('service');if(modules.has(p.get('module')))moduleId=p.get('module');activeFlow=flows.find(f=>f.id===p.get('flow'))??flows[0];const id=p.get('selected');selected=services.get(id)??modules.get(id)??contextNodes.find(n=>n.id===id)??(map.symbols[id]?{...map.symbols[id],type:'function',symbolId:id}:null);}
 function stop(){playing=false;clearTimeout(timer);timer=null;}
 function navigate(l,s=serviceId,m=moduleId){stop();level=l;serviceId=services.has(s)?s:serviceId;moduleId=modules.has(m)?m:'';selected=null;step=-1;camera={x:0,y:0,k:1};setURL();render();}
 function select(n){selected=n;setURL();draw();inspect(n);if(mobile.matches)(n.symbolId&&level===4?codeReader:inspector).scrollIntoView({behavior:'smooth',block:'start'});}
 function serviceModules(id=serviceId){return atlas.modules.filter(m=>m.serviceId===id);}
 function activeModule(){return modules.get(moduleId)??serviceModules().find(m=>m.symbolIds.length)??serviceModules()[0];}
 function field(label,value,cls){const section=el('section',undefined,cls??'detail-field');section.append(el('h3',label),el('p',value??'此欄位未提供；請核對來源。'));inspector.append(section);}
 function sourceLink(source){const line=source.line??source.startLine??1,label=`${source.path}:${line}`;const m=atlas.modules.find(m=>m.path===source.path),id=m?.symbolIds.find(id=>map.symbols[id].startLine===line)??m?.symbolIds.find(id=>map.symbols[id].startLine<=line&&map.symbols[id].endLine>=line);if(id){const b=button(label+' · 本機快照',()=>{navigate(4,m.serviceId,m.id);select({...map.symbols[id],symbolId:id,type:'function'});},'source-link local-source');return b;}const a=el('a',label+' · GitHub 參考','source-link');a.href=`https://github.com/${map.repo}/blob/${map.ref??'master'}/${source.path}#L${line}`;a.target='_blank';a.rel='noopener noreferrer';a.title='外部連結指向 GitHub 分支，可能與本機快照不同或尚未包含此檔。';return a;}

 function evidence(n){const sources=n.sources??(n.path?[{path:n.path,line:n.startLine??1}]:[]);if(sources.length){const box=el('section',undefined,'detail-field');box.append(el('h3','從哪裡查證'),el('p','行號對應本機快照；GitHub 參考連結的版本可能不同。','source-caveat'));sources.slice(0,5).forEach(s=>box.append(sourceLink(s)));inspector.append(box);}}
 function openInside(n){if(n.type==='context'){if(n.id==='vps')navigate(1);else if(['mac','windows'].includes(n.id))navigate(3,'client');else if(n.id==='discord')navigate(3,'bot');else if(n.id==='github')navigate(3,'bot');else navigate(1);}else if(n.symbolId||n.type==='function'){level=4;selected=n;setURL();render();}else if(n.path&&n.symbolIds){navigate(4,n.serviceId,n.id);}else if(services.has(n.id)){navigate(3,n.id);} }
 function inspect(n){const token=++request;inspector.replaceChildren();if(mobile.matches)inspector.append(button('回到架構圖',()=>surface.scrollIntoView({behavior:'smooth',block:'start'}),'back-to-diagram'));if(!n){codeReader.hidden=true;viewport.removeAttribute('hidden');controls.hidden=false;const s=services.get(serviceId);inspector.append(el('div','閱讀這張圖','detail-type'),el('h2',levels[level][1]),el('p',levels[level][2]+'。點一個零件，這裡會解釋它的用途與串接。','detail-lead'));
   const guide=['先從你和兩台電腦開始，再點 VPS 進入服務。','VPS 是放服務的遠端電腦；入口、處理與儲存由不同零件分工。','編號箭頭是教學步驟先後；真正的呼叫方向請看下方串接目錄。Windows 會主動讀取 Mail。','一個模組通常是一個來源檔。選擇服務，再看各模組的責任。','函式是完成一件小工作的程式。選取函式，讀取真實來源行號。'][level];field('怎麼開始',guide);
   if(level===0){field('一條真實的路徑','Mac → Caddy → validator → Agent Mail；Windows 再主動讀取。');inspector.append(button('播放交接給我看',()=>{level=2;startFlow();},'primary-action'));}
   else if(level===1){field('服務與容器的差別','Caddy 與 token applier 是主機上的服務；其他零件依 Compose 分組執行。資料庫與 Mail 各自保存不同資料。');inspector.append(button('查看全部串接',()=>navigate(2),'primary-action'));}
   else if(level>=3&&s){field('目前服務',s.description);evidence(s);}
   field('來源版本',`${map.codeSnapshot.revision.slice(0,12)}${map.codeSnapshot.dirty?' · 建置時有未提交變更':''}。來源快照不代表已部署。`);return;
  }
  const isFn=!!n.symbolId||n.type==='function';codeReader.hidden=!isFn||level!==4;viewport.toggleAttribute('hidden',isFn&&level===4);controls.hidden=isFn&&level===4;inspector.append(el('div',isFn?'函式 · 唯讀快照':n.type==='step-transition'?'教學步驟先後':n.type==='connection'?'有方向的串接':n.type==='context'?'系統中的角色':n.path?'來源模組':'系統零件','detail-type'),el('h2',n.title??n.name??n.label),el('p',n.description??n.input,'detail-lead'));
  if(n.type==='step-transition'){field('教學順序',`${n.fromName} → ${n.toName}`);field('實際呼叫方向',n.from==='mail'&&n.to==='client'?'Windows → Caddy → validator → Mail，發出收件查詢；Mail 回傳原文。':'此箭頭表示先後步驟；各服務真正發出的呼叫請查下方串接目錄。');}if(n.type==='connection'){field('誰送給誰',`${n.fromName??services.get(n.from)?.name??n.from} → ${n.toName??services.get(n.to)?.name??n.to}`);field('通訊方式',n.protocol);}
  {field('為什麼需要它',n.why??'將這項責任放在明確邊界內，讓其他零件能使用它的結果。');const io=el('div',undefined,'io-pair');for(const [label,value]of[['輸入',n.input],['輸出',n.output]]){const item=el('div');item.append(el('h3',label),el('p',value??'依來源契約'));io.append(item);}inspector.append(io);field('如果它出錯',n.errors??'結果無法確認，需核對來源與錯誤回報；不當成完成。','detail-field failure-field');}
  if(n.type==='context'||n.symbolIds||services.has(n.id))inspector.append(button(n.symbolIds?'進入函式與原始碼':n.id==='vps'?'打開 VPS 看服務':'進入內部看程式',()=>openInside(n),'primary-action'));
  const connected=atlas.connections.filter(e=>e.from===n.id||e.to===n.id);if(connected.length){const box=el('section',undefined,'detail-field');box.append(el('h3','跟誰相連'));connected.forEach(e=>box.append(button(`${services.get(e.from)?.name??e.from} → ${services.get(e.to)?.name??e.to}`,()=>{select({...e,type:'connection'});} ,'connection-link')));inspector.append(box);}
  evidence(n);const deployments=(atlas.containers??[]).filter(c=>n.modules?.includes(c.path));if(deployments.length){const d=el('section',undefined,'detail-field');d.append(el('h3','對應的 Compose 容器設定'));for(const c of deployments){d.append(el('p',c.name));d.append(sourceLink({path:c.path,line:c.line}));}d.append(el('p','這是設定檔的服務名稱；override 尚未合併，也不是已部署清單。','source-caveat'));inspector.append(d);}
  if(isFn){const id=n.symbolId??n.id,meta=map.symbols[id];field('函式簽名',`${meta?.name??n.name}(${meta?.params?.join(', ')??''})`);const pre=el('pre','正在讀取受保護的原始碼…','code-snapshot');if(level===4){codeReader.replaceChildren(el('div',undefined,'source-reader-heading'),pre);const head=codeReader.firstChild;head.append(el('span',meta?.language??'source','source-language'),el('h3',meta?.title??meta?.name??n.name),el('p',`${meta?.path??''} · L${meta?.startLine??''}–${meta?.endLine??''}`));}else inspector.append(pre);api('/api/code/'+encodeURIComponent(id)).then(s=>{if(token!==request)return;pre.replaceChildren();s.code.split('\n').forEach((line,i)=>{const row=el('span',undefined,'code-line');row.append(el('span',String(s.startLine+i),'line-number'),el('code',line));pre.append(row);});field('快照完整性',`檔案 SHA-256 ${s.fileHash}`);}).catch(()=>{if(token===request){pre.textContent='無法讀取快照。請確認登入後重試。';pre.append(button('重試讀取',()=>inspect(n)));}});}
  const ids=n.serviceId?[n.serviceId]:[n.id];const related=snapshot.items.filter(i=>i.components?.some(id=>ids.includes(id==='guide'?'web':id==='discord'?'bot':id)));if(related.length){const box=el('section',undefined,'detail-field');box.append(el('h3','相關工作回報'));related.slice(0,4).forEach(i=>box.append(button(i.subject,()=>onItem(i),'connection-link')));inspector.append(box);}
 }
 const contextNodes=[
 {id:'person',name:'你與專案成員',subtitle:'決定工作，確認動作',description:'你設定方向、查看結果，並確認需要批准的動作。',why:'系統協助交換上下文，決定權仍在成員手上。',input:'任務、交接與確認請求',output:'工作目標、同意或拒絕',errors:'未確認的動作不能被當成已批准。',icon:'person',type:'context'},
 {id:'mac',name:'Mac 工作站',subtitle:'AI + 本機 hooks',description:'在 Mac 上工作，透過本機 hook 寄出交接與接收訊息。',why:'把 AI session 的上下文接入跨電腦協作。',input:'你的任務、Mail 訊息',output:'交接、控制事件、本機 staging',errors:'網路失敗時交接留在 outbox，保存結果需核對。',sources:[{path:'client/hub-hook.mjs',line:1}],icon:'computer',type:'context'},
 {id:'vps',name:'Hub 協作主機',subtitle:'VPS · 點開看每個服務',description:'一台遠端電腦，讓兩台工作站不必同時開機也能交換交接。',why:'工作站關閉時，訊息仍有共同保存的地方。',input:'HTTPS 訊息、Discord 指令',output:'訊息回執、查詢結果、通知',errors:'主機不可用時無法取得新資料；本機待送項目保留。',sources:[{path:'deploy/compose.yaml',line:1}],icon:'server',type:'context'},
 {id:'windows',name:'Windows 工作站',subtitle:'AI + 本機 hooks',description:'主動讀取 Mail 裡的新訊息，讓下一段工作接得上。',why:'另一台電腦也能取得共同的原始交接。',input:'Mail 事件與交接原文',output:'本機上下文、回覆、確認選擇',errors:'輪詢失敗保留游標；沒有新資料不代表任務完成。',sources:[{path:'client/mail-client.mjs',line:1}],icon:'computer',type:'context'},
 {id:'discord',name:'Discord',subtitle:'通知、手機查詢與登入',description:'你可以從 Discord 看通知、查進度，也用 Discord 身分登入這個工作台。',why:'讓人類從熟悉的入口查看協作結果。',input:'Bot 訊息、指令、OAuth 身分請求',output:'通知、查詢指令、登入身分',errors:'通知與登入不可用；不會因此改變 Mail 保存結果。',sources:[{path:'bot/src/discord.mjs',line:1},{path:'web/src/server.mjs',line:1}],icon:'message',type:'context'},
 {id:'github',name:'GitHub',subtitle:'正式任務與程式碼',description:'GitHub Issues 記錄正式任務，程式碼連結提供可查證的來源。',why:'任務編號、工作回報與程式提交需要可追溯的關係。',input:'建立／更新 Issue、唯讀程式連結',output:'Issue 編號、狀態與來源檔',errors:'GitHub 失敗不能回報已建立任務；原交接仍可保留。',sources:[{path:'bot/src/github.mjs',line:1}],icon:'code',type:'context'},
 ];
 function positions(items,cols=3,startY=90,width=1000){const gap=22,pad=32,cw=(width-pad*2-gap*(cols-1))/cols;return items.map((n,i)=>({...n,x:pad+(i%cols)*(cw+gap),y:startY+Math.floor(i/cols)*150,w:cw,h:116}));}
 function view(){const compact=mobile.matches,width=compact?400:1000;let nodes=[],edges=[],bounds=[],height=620;
  if(level===0){nodes=contextNodes.map(n=>({...n}));const coords=compact?[[32,55],[32,220],[32,385],[32,550],[32,715],[32,880]]:[[28,60],[28,270],[370,195],[370,435],[720,60],[720,435]];nodes.forEach((n,i)=>Object.assign(n,{x:coords[i][0],y:coords[i][1],w:compact?336:250,h:126}));edges=[['person','mac','發出任務'],['person','discord','手機查詢'],['mac','vps','HTTPS · 交接'],['windows','vps','HTTPS · 主動收件'],['vps','discord','通知 / OAuth'],['vps','github','HTTPS · Issues']].map(([from,to,label])=>({from,to,label,id:from+'-'+to,type:'context-edge'}));bounds=[{x:compact?16:350,y:compact?355:170,w:compact?368:290,h:compact?175:180,label:'遠端 · 共同協作中心'}];height=compact?1040:620;
  } else if(level===1){const groups=[['安全入口',['gateway','validator','bank-proxy']],['協作與連接',['mail','clock','bot','bridge','web','token-applier']],['記憶與資料',['memory','postgres']],['主機維運',['ops']]];let y=70;for(const [label,ids]of groups){const ns=ids.map(id=>services.get(id)).filter(Boolean);const cols=compact?1:3;const laid=positions(ns,cols,y+35,width);nodes.push(...laid);const rows=Math.ceil(ns.length/cols);bounds.push({x:16,y,w:width-32,h:rows*150+25,label});y+=rows*150+56;}height=y+10;
    const available=new Set(nodes.map(n=>n.id));edges=atlas.connections.filter(e=>available.has(e.from)&&available.has(e.to)&&['gateway','validator','mail','memory','bridge'].includes(e.from)).slice(0,8);
  } else if(level===2){const seen=new Map();const steps=activeFlow.steps;for(const [i,[sid,name,desc,protocol]]of steps.entries()){const id='step-'+i;const s=services.get(sid)??{};seen.set(i,id);nodes.push({...s,id,serviceId:sid,name,subtitle:protocol,description:desc,stepIndex:i});}nodes=positions(nodes,compact?1:3,70,width);height=Math.ceil(nodes.length/(compact?1:3))*150+110;edges=nodes.slice(0,-1).map((n,i)=>({id:'sequence-'+i,from:n.id,to:nodes[i+1].id,label:`${i+1} → ${i+2}`,description:steps[i+1][2],protocol:steps[i+1][3],input:steps[i][2],output:steps[i+1][2],sources:services.get(steps[i+1][0])?.sources??[],type:'sequence'}));
  } else if(level===3){const ms=serviceModules();nodes=positions(ms.slice(0,12),compact?1:3,60,width);height=Math.ceil(nodes.length/(compact?1:3))*150+95;const modulePaths=new Map(nodes.map(n=>[n.path,n.id]));const used=new Set();for(const im of atlas.imports??[]){const from=modulePaths.get(im.from??im.path),to=modulePaths.get(im.to??im.resolved);if(from&&to&&!used.has(from+to)){edges.push({id:from+'-'+to,from,to,label:'import',description:'靜態模組匯入；不代表執行時呼叫順序。',protocol:'本地 JavaScript import',input:im.specifier??to,output:'匯出介面',sources:[{path:im.from??im.path,line:im.line??1}]});used.add(from+to);}}}
  else {const m=activeModule();if(m){const syms=m.symbolIds.map(id=>map.symbols[id]).filter(Boolean);nodes=positions(syms.slice(0,12).map(s=>({...s,symbolId:s.id,type:'function',title:s.title??s.name,name:s.name,description:s.description??'從原始碼擷取的函式。'})),compact?1:3,60,width);height=Math.ceil(nodes.length/(compact?1:3))*150+95;}}
  if(workFocus){const focused=new Set(workFocus.components??[]);nodes=nodes.map(n=>({...n,workMatched:focused.has(n.serviceId??n.id)||focused.has(n.id==='web'?'guide':n.id==='bot'?'discord':n.id)}));}
  return {nodes,edges,bounds,width,height:Math.max(height,300)};
 }
 function drawCamera(){layer.setAttribute('transform',`translate(${camera.x} ${camera.y}) scale(${camera.k})`);zoomLabel.textContent=Math.round(camera.k*100)+'%';}
 function zoom(f){camera.k=Math.min(2.5,Math.max(.55,camera.k*f));drawCamera();}
 function compactArc(a,b,x1,y1,x2,y2){if(!mobile.matches||Math.abs(a.y-b.y)<180)return null;const side=a.y<b.y?14:386;return `M${x1} ${y1} L${x1} ${y1+(a.y<b.y?12:-12)} L${side} ${y1+(a.y<b.y?12:-12)} L${side} ${y2+(a.y<b.y?-12:12)} L${x2} ${y2+(a.y<b.y?-12:12)} L${x2} ${y2}`;}
 function draw(){const v=view();viewport.dataset.viewLevel=String(level);viewport.setAttribute('viewBox',`0 0 ${v.width} ${v.height}`);layer.replaceChildren();const lookup=new Map(v.nodes.map(n=>[n.id,n]));
  for(const b of v.bounds){const g=svg('g',{class:'diagram-boundary'});g.append(svg('rect',{x:b.x,y:b.y,width:b.w,height:b.h,rx:16}));const t=svg('text',{x:b.x+16,y:b.y+23});t.textContent=b.label;g.append(t);layer.append(g);}
  for(const e of v.edges){const a=lookup.get(e.from),b=lookup.get(e.to);if(!a||!b)continue;const down=b.y>a.y+80,up=a.y>b.y+80;let x1=a.x+a.w/2,y1=a.y+a.h/2,x2=b.x+b.w/2,y2=b.y+b.h/2;if(down){y1=a.y+a.h;y2=b.y;}else if(up){y1=a.y;y2=b.y+b.h;}else if(b.x>a.x){x1=a.x+a.w;x2=b.x;}else{x1=a.x;x2=b.x+b.w;}
    const d=compactArc(a,b,x1,y1,x2,y2)??(down||up?`M${x1} ${y1} C${x1} ${(y1+y2)/2},${x2} ${(y1+y2)/2},${x2} ${y2}`:`M${x1} ${y1} C${(x1+x2)/2} ${y1},${(x1+x2)/2} ${y2},${x2} ${y2}`);
    const g=svg('g',{class:`diagram-edge ${e.type==='context-edge'?'context-edge':''} ${playing&&e.id==='sequence-'+step?'flowing':''}`,tabindex:0,role:'button','aria-label':`${a.name} → ${b.name}：${e.label}`,'data-edge':e.id});
    g.append(svg('path',{d,class:'edge-hit'}),svg('path',{d,class:'edge-path','marker-end':'url(#atlas-arrow)'}));
    const tx=(x1+x2)/2,ty=(y1+y2)/2-9;const text=svg('text',{x:tx,y:ty,'text-anchor':'middle'});text.textContent=e.label?.length>22?e.label.slice(0,22)+'…':e.label;g.append(text);
    if(playing&&e.id==='sequence-'+step&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const dot=svg('circle',{r:6,class:'flow-dot'}),motion=svg('animateMotion',{dur:'1.8s',repeatCount:'indefinite',path:d});dot.append(motion);g.append(dot);}
    const choose=()=>{stop();renderPlayer();inspect({...e,type:e.type==='sequence'?'step-transition':'connection',from:a.serviceId??e.from,to:b.serviceId??e.to,fromName:a.name,toName:b.name,why:e.type==='context-edge'?'把使用者、電腦與共同服務的使用關係標出來。':undefined,input:e.input??e.label,output:e.output??'由接收端處理並回傳結果。',description:e.description??`${a.name} 透過這條關係與 ${b.name} 合作。${e.label}`,protocol:e.protocol??(e.label.includes('HTTPS')?'HTTPS':'使用關係；細部協議請看 L2'),sources:e.sources??b.sources??a.sources??[]});if(mobile.matches)inspector.scrollIntoView({behavior:'smooth',block:'start'});};g.addEventListener('click',choose);g.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();choose();}});layer.append(g);
  }
  for(const n of v.nodes){const fo=svg('foreignObject',{x:n.x,y:n.y,width:n.w,height:n.h+3});const card=button('',()=>{if(n.stepIndex!==undefined){stop();step=n.stepIndex;renderPlayer();}select(n);},`diagram-card ${selected?.id===n.id?'selected':''} ${n.stepIndex===step?'current-step':''} ${workFocus&&!n.workMatched?'work-dim':''}`);card.dataset.node=n.id;card.setAttribute('aria-label',n.name);card.addEventListener('dblclick',()=>openInside(n));const top=el('span',undefined,'diagram-card-top');top.append(icon(n.icon??serviceIcon(n.serviceId??n.id)),el('span',n.stepIndex!==undefined?`步驟 ${n.stepIndex+1}`:n.type==='function'?'FUNCTION':n.path?'SOURCE MODULE':n.id==='vps'?'VPS':n.type==='context'?'CONTEXT':'SERVICE'));if(!n.symbolId){const enter=el('span',undefined,'card-enter');enter.append(icon('arrow'));top.append(enter);}card.append(top,el('strong',n.name),el('span',n.subtitle??n.description,'diagram-description'));fo.append(card);layer.append(fo);}
  drawCamera();renderCatalog(v);
 }
 function renderCatalog(v){catalog.replaceChildren();if(level===0){const directory=el('details',undefined,'context-directory');directory.open=mobile.matches;directory.append(el('summary',`合作關係 · ${v.edges.length} 條方向`));for(const e of v.edges){const a=v.nodes.find(n=>n.id===e.from),b=v.nodes.find(n=>n.id===e.to);const row=button('',()=>select({...e,type:'connection',fromName:a.name,toName:b.name,name:e.label,description:`${a.name} 與 ${b.name} 的合作關係。`,protocol:e.label.includes('HTTPS')?'HTTPS':'使用關係；細部契約見 L2',input:a.output,output:b.input,sources:b.sources??a.sources??[]}), 'connection-row');row.append(el('strong',`${a.name} → ${b.name}`),el('span',e.label));directory.append(row);}catalog.append(directory);}if(level===2){catalog.append(el('h3','所有服務的串接'),el('p','不只這條示範流程。選一條連線，查看實際方向與資料。','muted'));const list=el('div',undefined,'connection-catalog');for(const e of atlas.connections){const b=button('',()=>select({...e,type:'connection'}),'connection-row');b.append(el('strong',`${services.get(e.from)?.name??e.from} → ${services.get(e.to)?.name??e.to}`),el('span',e.protocol),el('span',e.label));list.append(b);}catalog.append(list);const messageDirectory=el('details',undefined,'message-directory');messageDirectory.append(el('summary',`訊息種類 · ${atlas.messages.length} 種（展開查看）`));for(const message of atlas.messages){const b=button('',()=>select({...message,type:'message'}),'module-row');b.append(el('strong',message.title),el('span',message.name));messageDirectory.append(b);}catalog.append(messageDirectory);}
  if(level===3){const ms=serviceModules();catalog.append(el('h3',`全部來源模組 · ${ms.length}`));const list=el('div',undefined,'module-catalog');for(const m of ms){const b=button('',()=>select(m),'module-row');b.append(icon('folder'),el('span',m.path),el('span',`${m.symbolIds.length} 個函式`));list.append(b);}catalog.append(list);}
  if(level===4){const m=activeModule();if(m){const syms=m.symbolIds.map(id=>map.symbols[id]).filter(Boolean);const directory=el('details',undefined,'function-directory'),items=el('div',undefined,'function-catalog');directory.append(el('summary',`函式索引 · ${syms.length} 個函式（展開查看）`));for(const s of syms){const b=button('',()=>select({...s,type:'function',symbolId:s.id}),'module-row');b.append(icon('code'),el('span',s.title===s.name?s.name:`${s.title} · ${s.name}`),el('span',`L${s.startLine}–${s.endLine}`));items.append(b);}directory.append(items);catalog.append(directory);}}
  if(level===1){const tables=atlas.tables??[];const d=el('details',undefined,'table-directory');d.append(el('summary',`資料表目錄 · ${tables.length} 張表（由 migration 擷取）`));for(const t of tables){const r=el('div',undefined,'table-row');r.append(button(t.name,()=>select({...t,type:'table'}),'table-select'),sourceLink({path:t.path,line:t.line}));d.append(r);}catalog.append(d);}
  if(!v.nodes.length){catalog.append(el('p',level===4&&activeModule()?'這份檔案是設定或資料結構，沒有可擷取的具名函式。可選另一個來源模組，或沿來源連結查看設定。':'此服務使用外部映像；本庫提供部署設定，內部函式請查上游來源。','empty'));const s=services.get(serviceId);if(s?.sources)for(const source of s.sources)catalog.append(sourceLink(source));}
 }
 function renderPlayer(){player.replaceChildren();const bar=el('div',undefined,'player-bar'),play=button(playing?'暫停':'播放流程',()=>{if(playing){stop();renderPlayer();draw();}else startFlow();},'play-button');play.prepend(icon('play'));const pick=el('select');pick.setAttribute('aria-label','選擇教學流程');for(const f of flows){const o=el('option',f.name);o.value=f.id;pick.append(o);}pick.value=activeFlow.id;pick.addEventListener('change',()=>{stop();activeFlow=flows.find(f=>f.id===pick.value);step=-1;selected=null;level=2;camera={x:0,y:0,k:1};setURL();render();});const text=el('span','教學動畫 · 不會發送訊息','player-mode');bar.append(play,pick,text);if(level===2){const previous=button('上一步',()=>{stop();step=Math.max(0,step-1);renderPlayer();draw();inspectFlowStep();},'step-navigation');previous.disabled=step<=0;const next=button('下一步',()=>{stop();step=Math.min(activeFlow.steps.length-1,step+1);renderPlayer();draw();inspectFlowStep();},'step-navigation');next.disabled=step>=activeFlow.steps.length-1;bar.append(previous,next);}player.append(bar);
  if(level===2||playing||step>=0){const sequence=el('div',undefined,'player-sequence');activeFlow.steps.forEach((s,i)=>{const b=button('',()=>{stop();step=i;renderPlayer();draw();inspectFlowStep();},'step-chip'+(step===i?' active':''));b.append(el('span',String(i+1)),el('span',s[1]));b.setAttribute('aria-current',step===i?'step':'false');sequence.append(b);});const caption=el('div',undefined,'player-caption');caption.setAttribute('aria-live','polite');caption.append(el('strong',step>=0?activeFlow.steps[step][1]:'跟著箭頭看一次資料旅程'),el('span',step>=0?activeFlow.steps[step][2]:activeFlow.description));player.append(sequence,caption);}
 }
 function inspectFlowStep(){const s=activeFlow.steps[step];if(!s)return;const service=services.get(s[0]);inspect({...service,name:s[1],description:s[2],input:s[3],id:s[0]});}
 function tick(){if(!playing)return;step++;if(step>=activeFlow.steps.length){stop();step=activeFlow.steps.length-1;renderPlayer();draw();return;}renderPlayer();draw();inspectFlowStep();timer=setTimeout(tick,2400);}
 function startFlow(){stop();level=2;selected=null;if(step>=activeFlow.steps.length-1||step<0)step=-1;playing=true;setURL();render();tick();}
 function renderScope(){selector.replaceChildren();if(level<3){selector.hidden=true;return;}selector.hidden=false;const label=el('label','探索服務 '),pick=el('select');pick.setAttribute('aria-label','選擇服務');for(const s of services.values()){const o=el('option',s.name);o.value=s.id;pick.append(o);}pick.value=serviceId;pick.addEventListener('change',()=>navigate(level,pick.value));label.append(pick);selector.append(label);if(level===4){const ml=el('label','來源模組 '),mp=el('select');mp.setAttribute('aria-label','選擇來源模組');for(const m of serviceModules()){const o=el('option',m.path);o.value=m.id;mp.append(o);}mp.value=activeModule()?.id??'';mp.addEventListener('change',()=>navigate(4,serviceId,mp.value));ml.append(mp);selector.append(ml);}}
 function render(){if(level===4&&!selected){const m=activeModule();const id=m?.symbolIds.find(id=>/#[^.]*modeSend$|#createMailClient.sendItem$/.test(id))??m?.symbolIds[0];if(id)selected={...map.symbols[id],symbolId:id,type:'function',serviceId:m.serviceId};setURL();}rail.replaceChildren(el('div','探索層級','rail-label'));levels.forEach((l,i)=>{const b=button('',()=>navigate(i),'level-button'+(level===i?' active':''));b.setAttribute('aria-current',level===i?'page':'false');b.dataset.level=i;const label=el('div');label.append(el('span',`L${i}`,'level-number'),el('strong',l[0]),el('small',l[1]));b.append(icon(l[3]),label);rail.append(b);});rail.append(el('p','從全貌到程式碼，每一步都能回到來源。','rail-note'));
  title.textContent=levels[level][0];subtitle.textContent=levels[level][1]+' '+levels[level][2];canvasTitle.textContent=level===0?'同一份上下文，接起不同電腦':level===1?'Hub VPS · 依責任分區':level===2?activeFlow.name:level===3?`${services.get(serviceId).name} · 來源模組`:`${activeModule()?.path??services.get(serviceId).name} · 函式`;
  breadcrumbs.replaceChildren(button('系統全貌',()=>navigate(0),'crumb'));if(level>0)breadcrumbs.append(el('span','/'),button('VPS 服務',()=>navigate(1),'crumb'));if(level>=2)breadcrumbs.append(el('span','/'),button(level===2?'串接與協議':services.get(serviceId).name,()=>navigate(level===2?2:3),'crumb'));if(level===4&&activeModule())breadcrumbs.append(el('span','/'),el('span',activeModule().name));
  renderScope();renderPlayer();legend.replaceChildren(el('span','點零件看用途 · 雙擊進入下一層'),el('span',level===2?'編號箭頭：教學步驟順序；真正呼叫方向見下方目錄。':mobile.matches?'方向與協議請看零件詳情或下方串接清單。':'實線：來源核對的串接　虛線：使用關係'));canvasNote.textContent=level===2?'教學步驟順序 · 非即時推送':'靜態架構 · 非即時流量';draw();inspect(selected);const c=atlas.coverage;provenance.textContent=`由 repo 建置 · ${atlas.inventory.length} 個檔案已盤點 · ${atlas.modules.length} 個模組 · ${Object.keys(map.symbols).length} 個函式 · 快照 ${map.codeSnapshot.snapshotHash.slice(0,10)}。關係由來源核對，動態行為仍需實測。`;
 }
 search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase();results.replaceChildren();results.hidden=!q;if(!q)return;const candidates=[...atlas.services.map(n=>({...n,resultType:'服務'})),...atlas.modules.map(n=>({...n,resultType:'模組'})),...Object.values(map.symbols).map(n=>({...n,resultType:'函式',symbolId:n.id}))];const hits=candidates.filter(n=>[n.name,n.path,n.description,n.title].some(s=>s?.toLowerCase().includes(q))).slice(0,18);for(const n of hits){results.append(button(`${n.resultType} · ${n.path??n.name}${n.symbolId?' · '+n.name:''}`,()=>{search.value='';results.hidden=true;if(n.symbolId){const m=atlas.modules.find(m=>m.symbolIds.includes(n.id));navigate(4,m?.serviceId??serviceId,m?.id??'');select({...n,type:'function'});}else if(n.path){navigate(3,n.serviceId);select(n);}else{navigate(1);select(n);}} ,'search-result'));}if(!hits.length)results.append(el('p','找不到符合的零件，請試試 Mail、bot 或函式名稱。'));});
 viewport.addEventListener('wheel',e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();zoom(e.deltaY<0?1.1:.9);},{passive:false});
 let pointer=null;viewport.addEventListener('pointerdown',e=>{if(e.target.closest('button')||e.target.closest('[data-edge]'))return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY};viewport.setPointerCapture(e.pointerId);});viewport.addEventListener('pointermove',e=>{if(!pointer||e.pointerId!==pointer.id)return;const r=viewport.getBoundingClientRect(),v=view();camera.x+=(e.clientX-pointer.x)*v.width/r.width;camera.y+=(e.clientY-pointer.y)*v.height/r.height;pointer={id:e.pointerId,x:e.clientX,y:e.clientY};drawCamera();});for(const event of ['pointerup','pointercancel'])viewport.addEventListener(event,()=>pointer=null);
 viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;const offset={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]}[e.key];if(offset){e.preventDefault();camera.x+=offset[0];camera.y+=offset[1];drawCamera();}else if(e.key==='+')zoom(1.2);else if(e.key==='-')zoom(.8);});
 mobile.addEventListener('change',()=>{camera={x:0,y:0,k:1};draw();});window.addEventListener('hashchange',()=>{stop();restore();render();});restore();render();
 return {update(data,item){snapshot=data;workFocus=item;if(!playing){draw();if(!panel.querySelector('.code-snapshot'))inspect(selected);}},showWork(item){workFocus=item;onClear();navigate(1);},get scope(){return `L${level}`;},destroy(){stop();}};
}
