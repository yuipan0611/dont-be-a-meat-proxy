import {readFile} from 'node:fs/promises';
import {createApp} from './server.mjs';
const map=JSON.parse(await readFile(new URL('../.generated/architecture.json',import.meta.url),'utf8'));
const port=Number(process.env.DEMO_PORT??8080);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid DEMO_PORT');
const timestamp=new Date().toISOString();
const items=[{id:'65',subject:'修復 Windows 訊息接收',author:'Windows Claude',createdAt:timestamp,kind:'handoff',summary:'已找到確認提示與收件流程的接縫，正在補驗證。',stage:'in_progress',components:['client','gateway','mail'],paths:['client/hub-hook.mjs'],text:'這是展示資料，不代表正式部署狀態。\n下一步：在實體 Windows 重跑接收與確認。',unfinished:['實體 Windows 驗證'],links:[`https://github.com/${map.repo}/issues/1`],hasCommit:false,verification:'尚無測試結果'},
{id:'64',subject:'新增記憶代理',author:'Memory Agent',createdAt:timestamp,kind:'handoff',summary:'等待串接權限設定。',stage:'blocked',components:['memory'],paths:['ops/bank-proxy/'],text:'此處為示範交接原文。',unfinished:['核對 bank 權限'],links:[],hasCommit:false,verification:'AI 回報：本機單元測試通過；尚未核對 CI'}];
createApp({map,demo:true,origin:`http://127.0.0.1:${port}`,data:{async snapshot(){return {items,issues:[],sources:{mail:{ok:true,updatedAt:timestamp},github:{ok:true,updatedAt:timestamp}},fetchedAt:timestamp};}}}).listen(port,'127.0.0.1',()=>console.log(`DEMO ONLY http://127.0.0.1:${port}`));
