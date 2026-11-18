import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build,extractFunctions} from '../scripts/build-architecture.mjs';
import {extractGo,extractCompose,extractTables,sourceRoots} from '../scripts/scan-architecture.mjs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {root} from '../scripts/build-architecture.mjs';
test('AST extracts exact nested function ranges; comments/strings do not create symbols',()=>{
 const code='// function fake() {}\nexport function parent(a){\n function nested(x={a:1}) { return x; }\n return nested(a);\n}';
 const symbols=extractFunctions(code,'allowed.mjs');assert.equal(Object.keys(symbols).length,2);const n=symbols['allowed.mjs#parent.nested'];assert.equal(n.startLine,3);assert.equal(n.endLine,3);assert.equal(n.code,'function nested(x={a:1}) { return x; }');assert.deepEqual(n.params,['x={a:1}']);assert.throws(()=>extractFunctions('bad syntax','file.mjs'));
});
test('AST includes named arrows and methods with exact bodies and stable nested IDs',()=>{
 const source='export const arrow = (x) => x + 1;\nexport function factory(){ return { async read(key){ return key; } }; }\nclass Box { getValue(){ return 1; } }';
 const symbols=extractFunctions(source,'sample.mjs');
 assert.equal(symbols['sample.mjs#arrow'].code,'(x) => x + 1');
 assert.equal(symbols['sample.mjs#factory.read'].startLine,2);
 assert.equal(symbols['sample.mjs#Box.getValue'].code,'(){ return 1; }');
});
test('Go declaration scanner ignores fake functions and braces in strings and comments',()=>{
 const source='package main\n// func fake() {}\nfunc (v *validator) ServeHTTP(x string) {\n text := `} func nope() {`\n /* } */\n if true { println(text) }\n}\n';
 const symbols=extractGo(source,'server.go');assert.deepEqual(Object.keys(symbols),['server.go#validator.ServeHTTP']);
 assert.equal(symbols['server.go#validator.ServeHTTP'].startLine,3);assert.equal(symbols['server.go#validator.ServeHTTP'].endLine,7);
 assert.match(symbols['server.go#validator.ServeHTTP'].extraction,/not AST/);
});
test('deployment scanner retains Compose overlay evidence without merging or expanding secrets',()=>{
 const text='services:\n  mail-a:\n    image: upstream@sha256:123\n    ports: !reset []\n    environment:\n      PRIVATE_FILE: /run/private/token\n  worker:\n    command: [node, main.mjs]\nnetworks:\n  internal:\n';
 const containers=extractCompose(text,'deploy/example.yaml');assert.equal(containers.length,2);assert.equal(containers[0].line,2);assert.equal(containers[0].properties.find(p=>p.name==='ports').value,'!reset []');assert(!JSON.stringify(containers).includes('PRIVATE_FILE'));
});
test('SQL scanner records table columns, human comments and source locations',()=>{
 const tables=extractTables("-- fixture\ncreate table public.example (\n id bigint primary key,\n group_id text references public.groups(id)\n);\ncomment on table public.example is '範例用途';",'migration.sql');
 assert.equal(tables[0].name,'example');assert.equal(tables[0].line,2);assert.equal(tables[0].description,'範例用途');assert.deepEqual(tables[0].columns.map(c=>c.name),['id','group_id']);
});
test('whole-repository snapshot has valid source ranges and no dangling architecture references',async()=>{
 const map=await build(),atlas=map.atlas;
 assert.deepEqual(atlas.coverage.roots,sourceRoots);for(const sourceRoot of sourceRoots)assert(atlas.coverage.byRoot[sourceRoot]>0,sourceRoot);
 assert(Object.keys(map.symbols).length>300);assert(atlas.services.length>=12);assert(atlas.tables.some(t=>t.name==='devices'));assert(atlas.tables.some(t=>t.name==='decisions'));
 const files=new Map();
 for(const[id,s]of Object.entries(map.symbols)){
  assert.equal(id,s.id);assert.match(s.fileHash,/^[a-f0-9]{64}$/);assert(s.endLine>=s.startLine);assert.doesNotMatch(s.path,/(?:^|\/)(?:private|\.local|\.hub-local|test|tests|spikes)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem|token|password|secret)$/);
  if(!files.has(s.path))files.set(s.path,(await readFile(resolve(root,s.path),'utf8')).split('\n'));
  const range=files.get(s.path).slice(s.startLine-1,s.endLine).join('\n');assert(range.includes(s.code),id);
 }
 for(const required of ['client/mail-client.mjs#createMailClient.sendItem','client/hub-hook.mjs#modeSend','ops/lifecycle/lifecycle.mjs#createLifecycle.onChoice','ops/token_applier.py#PsqlDb.export','server/validator/validator.go#validator.ServeHTTP','bot/src/store-pg.mjs#createPgStore'])assert(map.symbols[required],required);
 const serviceIds=new Set(atlas.services.map(s=>s.id));
 for(const module of atlas.modules){assert(serviceIds.has(module.serviceId),module.path);for(const id of module.symbolIds)assert(map.symbols[id],id);}
 for(const edge of atlas.connections){assert(serviceIds.has(edge.from));assert(serviceIds.has(edge.to));}
 for(const item of [...atlas.services,...atlas.connections,...atlas.modules,...atlas.tables,...atlas.messages]){
  assert(item.sources?.length);for(const source of item.sources){const text=await readFile(resolve(root,source.path),'utf8');assert(source.line>0&&source.line<=text.split('\n').length,JSON.stringify(source));}
 }
 assert(atlas.messages.some(m=>m.name==='handoff'));assert(atlas.messages.some(m=>m.name==='auto.executed'));
 assert(atlas.imports.some(i=>i.from==='web/src/data.mjs'&&i.to==='client/mail-client.mjs'));
 assert(atlas.coverage.warnings.some(w=>w.includes('不宣稱 Go AST')));
 assert.match(map.codeSnapshot.snapshotHash,/^[a-f0-9]{64}$/);
});
