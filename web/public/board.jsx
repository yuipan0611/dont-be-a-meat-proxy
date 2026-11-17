import React, {memo, useCallback, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, SelectionMode, useNodesInitialized} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './board.css';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const duration = () => reducedMotion() ? 0 : 280;
const PageIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/></svg>;
const ArrowIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>;

const PageCard = memo(function PageCard({data, selected}) {
 const n = data.original;
 const kind = n.type==='source-reference' ? '設定來源' : n.type==='code' ? '原始碼頁面' : n.symbolId ? '函式頁面' : n.path ? '模組頁面' : n.type === 'context' ? '系統頁面' : '服務頁面';
 return <article className={`rf-page-card${selected ? ' is-selected' : ''}${data.active ? ' is-active' : ''}`} data-node={n.id}>
  <div className="rf-card-heading"><PageIcon/><span>{n.stepIndex !== undefined ? `流程步驟 ${n.stepIndex+1}` : kind}</span><span className="rf-card-page-corner"><ArrowIcon/></span></div>
  <h3>{n.title ?? n.name}</h3>
  <p>{n.subtitle ?? n.description ?? n.path ?? '打開白板查看這個零件的內部。'}</p>
  <button type="button" className="rf-open-page nodrag nopan" aria-label={n.actionLabel ? `${n.actionLabel}：${n.name}` : `打開 ${n.name} 的白板`} onClick={event => {event.stopPropagation();data.open(n);}}><span>{n.actionLabel ?? (n.type==='code' ? '閱讀原始碼' : '打開白板')}</span><ArrowIcon/></button>
  <Handle type="target" id="left" position={Position.Left}/><Handle type="source" id="right" position={Position.Right}/>
  <Handle type="target" id="top" position={Position.Top}/><Handle type="source" id="bottom" position={Position.Bottom}/>
 </article>;
});
const GroupFrame = memo(function GroupFrame({data}) {return <div className="rf-group-frame"><span>{data.label}</span></div>;});
const nodeTypes = {page:PageCard, boundary:GroupFrame};
const empty = {pageId:'initial',nodes:[],edges:[],bounds:[]};

function adaptNodes(model, previous, memory, callbacks) {
 const prev = new Map(previous.map(n => [n.id,n]));
 const frames = (model.bounds ?? []).map((b,i) => ({
  id:`__boundary:${b.id ?? i}`,type:'boundary',position:{x:b.x,y:b.y},data:{label:b.label},
  width:b.w,height:b.h,style:{width:b.w,height:b.h},selectable:false,draggable:false,connectable:false,focusable:false,zIndex:-10,
 }));
 const nodes = (model.nodes ?? []).map((n,i) => {
  const old = prev.get(n.id), position = memory.positions.get(n.id) ?? old?.position ?? {x:n.x ?? (i%3)*330,y:n.y ?? Math.floor(i/3)*210};
  const width = Math.max(260,n.w ?? 280),height = Math.max(180,n.h ?? 180);
  return {id:n.id,type:'page',position,data:{original:n,open:callbacks.onNodeOpen,active:n.stepIndex!==undefined&&n.stepIndex===model.activeStep},
   width,height,style:{width,height},selected:Boolean(n.selected ?? old?.selected),connectable:false,ariaLabel:n.name,
   className:n.workMatched===false?'rf-work-dim':undefined,
  };
 });
 return [...frames,...nodes];
}
function adaptEdges(model) {
 const lookup = new Map((model.nodes ?? []).map(n => [n.id,n]));
 return (model.edges ?? []).filter(e=>lookup.has(e.from)&&lookup.has(e.to)).map((e,i) => {
  const a=lookup.get(e.from),b=lookup.get(e.to), vertical=Math.abs((a.y??0)-(b.y??0))>Math.abs((a.x??0)-(b.x??0));
  const active=Boolean(model.playing&&(e.id===`sequence-${model.activeStep}`||i===model.activeStep));
  return {id:e.id??`edge:${i}`,source:e.from,target:e.to,sourceHandle:vertical?'bottom':'right',targetHandle:vertical?'top':'left',type:'smoothstep',
   data:{original:e},label:e.label,animated:active&&!reducedMotion(),className:active?'rf-flow-active':'',
   markerEnd:{type:MarkerType.ArrowClosed,color:active?'#136a4d':'#779384',width:17,height:17},
   style:{stroke:active?'#136a4d':'#779384',strokeWidth:active?2.5:1.4},
   labelStyle:{fill:'#385b49',fontSize:12},labelBgStyle:{fill:'#fafbf7',fillOpacity:.95},labelBgPadding:[7,4],labelBgBorderRadius:4,
   interactionWidth:24,focusable:true,selectable:true,ariaLabel:`${a.name} → ${b.name}：${e.label??e.protocol??'串接'}`,
  };
 });
}


function ViewportReady({bridge, pageId}) {
 const initialized=useNodesInitialized();
 useLayoutEffect(()=>{
  bridge.nodesReady=initialized;
  if(!initialized)return;
  let frame=requestAnimationFrame(()=>bridge.prepareViewport?.());
  return ()=>cancelAnimationFrame(frame);
 },[initialized,pageId,bridge]);
 return null;
}

function Board({model, bridge}) {
 const [nodes,setNodes] = useState([]),[edges,setEdges] = useState([]),[selectionMode,setSelectionMode]=useState(false);
 const current = useRef({pageId:null,model}),container=useRef(null);
 const instance = useRef(null);
 const positionRef = useRef(nodes);positionRef.current=nodes;
 const ready = useCallback(api => {instance.current=api;bridge.instance=api;bridge.prepareViewport?.();},[bridge]);
 const saveCurrent = useCallback(() => {
  const pageId=current.current.pageId;if(!pageId)return;
  const memory=bridge.memoryFor(pageId);if(instance.current&&bridge.pendingPage!==pageId)memory.viewport=instance.current.getViewport();
  for(const n of positionRef.current)if(n.type==='page')memory.positions.set(n.id,n.position);
 },[bridge]);
 useLayoutEffect(() => {
  const changed=current.current.pageId!==model.pageId;
  if(changed){saveCurrent();bridge.pendingPage=model.pageId;}
  const memory=bridge.memoryFor(model.pageId);
  setNodes(previous=>adaptNodes(model,changed?[]:previous,memory,bridge.callbacks));setEdges(adaptEdges(model));
  current.current={pageId:model.pageId,model};
  bridge.prepareViewport = () => {
   const box=container.current?.getBoundingClientRect();
   if(!instance.current||!bridge.nodesReady||!model.nodes?.length||!box?.width||!box?.height||bridge.pendingPage!==model.pageId)return;
   bridge.pendingPage=null;
   if(memory.viewport)instance.current.setViewport(memory.viewport,{duration:duration()});
   else if(window.innerWidth<761){const n=model.nodes[0];instance.current.setViewport({x:20-(n.x??0)*.9,y:76-(n.y??0)*.9,zoom:.9},{duration:duration()});}
   else instance.current.fitView({nodes:model.nodes.slice(0,6).map(n=>({id:n.id})),padding:'8%',minZoom:.72,maxZoom:1,duration:duration()});
  };
  let frame=requestAnimationFrame(()=>bridge.prepareViewport?.());
  return ()=>cancelAnimationFrame(frame);
 },[model,bridge,saveCurrent]);
 useLayoutEffect(()=>{const observer=new ResizeObserver(()=>bridge.prepareViewport?.());if(container.current)observer.observe(container.current);return ()=>observer.disconnect();},[bridge]);
 const onNodesChange=useCallback(changes=>setNodes(old=>{
  const next=changes.applyTo(old);const memory=bridge.memoryFor(current.current.pageId);
  for(const n of next)if(n.type==='page')memory.positions.set(n.id,n.position);
  return next;
 }),[bridge]);
 const onEdgesChange=useCallback(changes=>setEdges(old=>changes.applyTo(old)),[]);
 const onSelectionChange=useCallback(({nodes:ns,edges:es})=>bridge.callbacks.onSelectionChange?.({nodes:ns.filter(n=>n.type==='page').map(n=>n.data.original),edges:es.map(e=>e.data.original)}),[bridge]);
 const onMoveEnd=useCallback((event,viewport)=>{bridge.memoryFor(current.current.pageId).viewport=viewport;bridge.callbacks.onViewportChange?.(viewport);},[bridge]);
 return <div ref={container} className="rf-board-root" data-board-page={model.pageId}>
  <ReactFlow id="architecture-whiteboard" nodes={nodes} edges={edges} nodeTypes={nodeTypes}
   onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onInit={ready}
   onNodeClick={(event,node)=>node.type==='page'&&bridge.callbacks.onNodeSelect?.(node.data.original)}
   onNodeDoubleClick={(event,node)=>node.type==='page'&&bridge.callbacks.onNodeOpen?.(node.data.original)}
   onEdgeClick={(event,edge)=>bridge.callbacks.onEdgeSelect?.(edge.data.original)}
   onSelectionChange={onSelectionChange} onMoveEnd={onMoveEnd}
   minZoom={.12} maxZoom={2.5} nodeDragThreshold={5} selectionKeyCode="Shift" selectionMode={SelectionMode.Partial}
   panOnDrag={selectionMode?[1,2]:true} selectionOnDrag={selectionMode} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
   panOnScroll={false} deleteKeyCode={null} nodesConnectable={false} edgesReconnectable={false}
   onlyRenderVisibleElements preventScrolling elevateEdgesOnSelect className="architecture-react-flow"
   aria-label="無限架構白板；拖曳空白平移、滾輪縮放、Shift 拖曳框選"
   ariaLabelConfig={{'controls.zoomIn.ariaLabel':'放大白板','controls.zoomOut.ariaLabel':'縮小白板','controls.fitView.ariaLabel':'適合白板','minimap.ariaLabel':'架構小地圖','node.a11yDescription.default':'按 Enter 選取，雙擊或使用卡片按鈕打開白板。'}}>
   <ViewportReady bridge={bridge} pageId={model.pageId}/>
   <Background gap={24} size={1} color="#dce4d9"/>
   <Controls position="bottom-left" showInteractive={false}/>
   <MiniMap position="bottom-right" pannable zoomable nodeStrokeWidth={2} nodeColor={node=>node.type==='boundary'?'#edf3e9':node.selected?'#a3c6ac':'#fff'} nodeStrokeColor={node=>node.selected?'#136a4d':'#8aa991'} maskColor="rgba(243,245,241,.72)"/>
   <div className="rf-board-mode nodrag nopan"><button type="button" aria-pressed={!selectionMode} onClick={()=>setSelectionMode(false)}>平移</button><button type="button" aria-pressed={selectionMode} onClick={()=>setSelectionMode(true)}>框選</button><span>Shift + 拖曳也可框選</span></div>
  </ReactFlow>
 </div>;
}

export function mountBoard(element, callbacks={}) {
 const root=createRoot(element),memories=new Map();
 const bridge={instance:null,prepareViewport:null,nodesReady:false,pendingPage:null,callbacks:{onNodeOpen:()=>{},...callbacks},memoryFor(id){if(!memories.has(id))memories.set(id,{positions:new Map(),viewport:null});return memories.get(id);}};
 let model=empty,destroyed=false;
 return {
  render(next){if(destroyed)return;model={...empty,...next};root.render(<Board model={model} bridge={bridge}/>);},
  fitView(){return bridge.instance?.fitView({padding:'10%',minZoom:.3,maxZoom:1.2,duration:duration()});},
  zoomIn(){return bridge.instance?.zoomIn({duration:duration()});},
  zoomOut(){return bridge.instance?.zoomOut({duration:duration()});},
  getViewport(){return bridge.instance?.getViewport()??{x:0,y:0,zoom:1};},
  destroy(){destroyed=true;root.unmount();memories.clear();},
 };
}
