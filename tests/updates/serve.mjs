import { build } from 'esbuild';
import svelte from 'esbuild-svelte';
import config from '../../svelte.config.mjs';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)), out=resolve(here,'../../dist/updates-harness');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(here,'entry.mjs')],outfile:resolve(out,'bundle.js'),bundle:true,format:'esm',platform:'browser',target:'safari16',plugins:[svelte(config)]});
await copyFile(resolve(here,'index.html'),resolve(out,'index.html'));
await copyFile(resolve(here,'../../styles.css'),resolve(out,'production.css'));
if(!process.argv.includes('--build-only')) createServer(async(req,res)=>{
  const path=req.url.split('?')[0];
  if(path==='/results' && req.method==='POST') {
    let body=''; for await(const chunk of req) { body+=chunk; if(body.length>65536){res.writeHead(413);res.end();return;} }
    try { const data=JSON.parse(body); const orientation=data.viewport[0]>data.viewport[1]?'landscape':'portrait'; const appearance=data.dark?'dark':'light'; await writeFile(resolve(out,`result-${orientation}-${appearance}.json`),JSON.stringify(data,null,2)); res.writeHead(204);res.end(); }
    catch {res.writeHead(400);res.end();} return;
  }
  const name=({'/':'index.html','/bundle.js':'bundle.js','/production.css':'production.css'})[path];
  if(!name){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store'); res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(resolve(out,name)));
}).listen(4177,'127.0.0.1',()=>console.log('Update harness http://127.0.0.1:4177/'));
