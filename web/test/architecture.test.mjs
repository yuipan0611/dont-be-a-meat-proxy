import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build,extractFunctions} from '../scripts/build-architecture.mjs';
test('AST extracts exact nested function ranges; comments/strings do not create symbols',()=>{
 const code='// function fake() {}\nexport function parent(a){\n function nested(x={a:1}) { return x; }\n return nested(a);\n}';
 const symbols=extractFunctions(code,'allowed.mjs');assert.equal(Object.keys(symbols).length,2);const n=symbols['allowed.mjs#parent.nested'];assert.equal(n.startLine,3);assert.equal(n.endLine,3);assert.equal(n.code,'function nested(x={a:1}) { return x; }');assert.deepEqual(n.params,['x={a:1}']);assert.throws(()=>extractFunctions('bad syntax','file.mjs'));
});
test('core snapshot references real source, contains stable hashes and excludes unrelated files',async()=>{const map=await build();assert.equal(Object.keys(map.symbols).length,17);for(const[id,s]of Object.entries(map.symbols)){assert.equal(id,s.id);assert.match(s.fileHash,/^[a-f0-9]{64}$/);assert(s.endLine>=s.startLine);assert(s.code.includes('function'));assert(!s.path.includes('private'));}assert.match(map.codeSnapshot.snapshotHash,/^[a-f0-9]{64}$/);});
