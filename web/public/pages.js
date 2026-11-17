// Nested pages are application state. React Flow owns canvas interaction, not hierarchy.
export function createPageIndex(map, contexts = []) {
 const pages=new Map();
 const add=p=>{if(pages.has(p.id))throw Error(`duplicate architecture page: ${p.id}`);pages.set(p.id,{...p,children:[]});};
 add({id:'home',name:'協作系統白板',kind:'overview',parent:null,level:0,description:map.description});
 add({id:'vps',name:'Hub VPS',kind:'services',parent:'home',level:1,description:'打開遠端主機，看每個服務如何分工。'});
 for(const s of map.atlas.services)add({id:`service:${s.id}`,name:s.name,kind:'service',parent:s.id==='client'?'home':'vps',serviceId:s.id,level:3,detail:s,description:s.description});
 for(const m of map.atlas.modules){add({id:m.id,name:m.name,kind:'module',parent:`service:${m.serviceId}`,serviceId:m.serviceId,moduleId:m.id,level:4,detail:m,description:m.description});
  for(const symbolId of m.symbolIds){const s=map.symbols[symbolId];if(!s)throw Error(`missing page symbol ${symbolId}`);const id=`fn:${symbolId}`;add({id,name:s.title??s.name,kind:'function',parent:m.id,serviceId:m.serviceId,moduleId:m.id,symbolId,level:4,detail:s,description:s.description});add({id:`code:${symbolId}`,name:'原始碼',kind:'code',parent:id,serviceId:m.serviceId,moduleId:m.id,symbolId,level:4,detail:s,description:`${s.path}:${s.startLine}–${s.endLine}`});}
 }
 for(const c of contexts.filter(c=>['person','discord','github'].includes(c.id)))add({id:`context:${c.id}`,name:c.name,kind:'context',parent:'home',contextId:c.id,level:0,detail:c,description:c.description});
 add({id:'flows',name:'流程教學',kind:'flows',parent:'home',level:2,description:'看交接、動作確認與記憶索引的先後順序。'});
 for(const [id,name]of [['handoff','Mac 交接給 Windows'],['confirm','動作確認與逾時'],['memory','交接變成可搜尋記憶']])add({id:`flow:${id}`,name,kind:'flow',parent:'flows',flowId:id,level:2,description:'編號箭頭表示教學步驟，不代表即時流量。'});
 for(const p of pages.values()){if(p.parent){const parent=pages.get(p.parent);if(!parent)throw Error(`missing architecture parent ${p.parent}`);parent.children.push(p.id);}}
 return pages;
}
export function pageAncestors(pages,id){const chain=[],seen=new Set();let page=pages.get(id);while(page){if(seen.has(page.id))throw Error('cyclic architecture page tree');seen.add(page.id);chain.unshift(page);page=pages.get(page.parent);}return chain;}
export function searchPages(pages,query,limit=60){const q=query.trim().toLowerCase();if(!q)return [];return [...pages.values()].filter(p=>p.kind!=='code'&&[p.name,p.description,p.detail?.path,p.detail?.name].some(s=>s?.toLowerCase().includes(q))).slice(0,limit);}
export function cardPageId(node){if(node.pageId)return node.pageId;if(node.symbolId)return `fn:${node.symbolId}`;if(node.symbolIds)return node.id;if(node.id==='vps')return 'vps';if(['mac','windows'].includes(node.id))return 'service:client';if(['person','discord','github'].includes(node.id))return `context:${node.id}`;return `service:${node.serviceId??node.id}`;}
