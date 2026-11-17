import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(resolve(web,'.generated/ui'),{recursive:true});
const result=await build({metafile:true,entryPoints:[resolve(web,'public/board.jsx')],outdir:resolve(web,'.generated/ui'),entryNames:'board',bundle:true,minify:true,format:'esm',target:['es2022'],legalComments:'inline',define:{'process.env.NODE_ENV':'"production"'},logLevel:'info'});
const packageNames=[...new Set(Object.keys(result.metafile.inputs).map(path=>path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort();
const licenses=await Promise.all(packageNames.map(async name=>{
 const dir=resolve(web,'node_modules',name),pkg=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'));
 let content;for(const path of ['LICENSE','LICENSE.txt','LICENSE.md']){try{content=await readFile(resolve(dir,path),'utf8');break;}catch{}}
 if(!content&&name==='react-compiler-runtime')content=await readFile(resolve(web,'node_modules/react/LICENSE'),'utf8');
 if(!content)throw Error(`License not found: ${name}`);
 return `${name} ${pkg.version}\n${content}`;
}));
await writeFile(resolve(web,'.generated/ui/THIRD_PARTY_LICENSES.txt'),licenses.join('\n\n--------------------\n\n'));
