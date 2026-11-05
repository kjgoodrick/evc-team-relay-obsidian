import PluginUpdates from '../../src/components/PluginUpdates.svelte';
import { mountComponent } from '../../src/svelteMount';
import { PluginUpdater } from '../../src/updates/PluginUpdater';
import { UpdateFiles } from '../../src/updates/UpdateFiles';
import { RELEASES_URL,RUNTIME_FILES,assetUrl,sha256 } from '../../src/updates/releases';
window.activeDocument=document;
const enc=s=>new TextEncoder().encode(s).buffer, dec=b=>new TextDecoder().decode(b), dir='.obsidian/plugins/team-relay-sync';
const errors=[], results=[];let updater,component,storage,original,running=false,saving=Promise.resolve();
addEventListener('error',e=>{errors.push(e.message);record();});addEventListener('unhandledrejection',e=>{errors.push(String(e.reason));record();});
function record(){document.querySelector('#results').textContent=[...results,...errors.map(e=>'ERROR '+e)].join('\n');const data={viewport:[innerWidth,innerHeight],dark:matchMedia('(prefers-color-scheme:dark)').matches,results:[...results],errors:[...errors],userAgent:navigator.userAgent};localStorage.setItem('relay-updater-results',JSON.stringify(data));saving=saving.then(()=>fetch('/results',{method:'POST',body:JSON.stringify(data)})).catch(()=>{});}
function assert(test,label){if(!test)throw Error(label);results.push('PASS '+label);record();}
async function reset(scenario=document.querySelector('#scenario').value){
 updater?.dispose();component?.destroy();let failed=false;
 const old={'main.js':'old executable fixture','styles.css':'.old{}','manifest.json':JSON.stringify({id:'team-relay-sync',version:'0.2.5'})};
 storage={files:new Map(Object.entries(old).map(([f,v])=>[`${dir}/${f}`,enc(v)])),dirs:new Set(),async exists(p){return this.files.has(p)||this.dirs.has(p)},async mkdir(p){this.dirs.add(p)},async readBinary(p){if(!this.files.has(p))throw Error('Missing fixture file');return this.files.get(p).slice(0)},async writeBinary(p,b){this.files.set(p,b.slice(0))},async rename(p,d){if(scenario==='disk'&&!failed&&d===`${dir}/styles.css`){failed=true;throw Error('Synthetic disk failure')}if(!this.files.has(p))throw Error('Missing rename source');this.files.set(d,this.files.get(p));this.files.delete(p)}};
 storage.files.set(`${dir}/data.json`,enc('saved settings'));storage.files.set('Draft.md',enc('unsynced local edits'));original={...old};
 const bundle={'main.js':enc('new executable fixture'),'styles.css':enc('.new{}'),'manifest.json':enc(JSON.stringify({id:'team-relay-sync',name:'Team Relay Sync',version:'0.2.6',minAppVersion:'1.8.7',isDesktopOnly:false}))};
 const sums=enc((await Promise.all(RUNTIME_FILES.map(async f=>`${await sha256(bundle[f])}  ${f}`))).join('\n'));const assets={...bundle,SHA256SUMS:sums};
 const release={tag_name:'0.2.6',draft:false,prerelease:true,published_at:'2026-11-04T00:00:00Z',assets:Object.entries(assets).map(([name,b])=>({name,state:'uploaded',size:b.byteLength,browser_download_url:assetUrl('0.2.6',name)}))};
 if(scenario==='hash')assets['main.js']=enc('x'.repeat(bundle['main.js'].byteLength));
 const request=async url=>{if(scenario==='offline')throw Error('Synthetic offline connection');if(url===RELEASES_URL)return{status:200,arrayBuffer:enc(JSON.stringify([release]))};const name=Object.keys(assets).find(f=>assetUrl('0.2.6',f)===url);if(!name)throw Error('Unexpected request');return{status:200,arrayBuffer:assets[name]};};
 updater=new PluginUpdater(new UpdateFiles(storage,dir),'0.2.5',request,()=>true,true,()=>{});await updater.initialize();component=mountComponent(PluginUpdates,{target:document.querySelector('#app'),props:{updater}});
}
const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
async function waitIdle(){for(let i=0;i<100&&updater.snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));await frame();if(updater.snapshot().busy)throw Error('Updater stuck');}
async function run(){if(running)return;running=true;results.length=0;errors.length=0;document.querySelector('#run').disabled=true;try{
 await reset('success');document.querySelector('#app button').click();await waitIdle();assert(updater.snapshot().release?.version==='0.2.6','published preview discovered');
 const install=[...document.querySelectorAll('#app button')].find(b=>b.textContent.includes('Update to'));assert(!!install,'Update button available');install.click();await waitIdle();assert(updater.snapshot().installedVersion==='0.2.6','verified update installed');assert(dec(storage.files.get(`${dir}/data.json`))==='saved settings'&&dec(storage.files.get('Draft.md'))==='unsynced local edits','settings and local edits preserved');assert(document.querySelector('#app').textContent.includes('restart Obsidian'),'restart is explicit; no live reload');
 assert((await new UpdateFiles(storage,dir).recover()).installedVersion==='0.2.6','installation survives reopen');
 for(const scenario of ['hash','disk']){await reset(scenario);await updater.check();await updater.install();assert(!!updater.snapshot().error,`${scenario} failure reported`);assert(RUNTIME_FILES.every(f=>dec(storage.files.get(`${dir}/${f}`))===original[f]),`${scenario} leaves previous files intact`);}
 await reset('offline');await updater.check();assert(!!updater.snapshot().error,'offline error leaves updater usable');await reset('success');await updater.setAutomatic(false);const next=new PluginUpdater(new UpdateFiles(storage,dir),'0.2.5',async()=>{throw Error('must not request')},()=>true,true);await next.initialize();assert(!next.snapshot().automatic,'automatic-check preference persists');next.dispose();await reset('success');await updater.check();await frame();assert(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow');assert(errors.length===0,'no runtime errors');results.push(`Completed ${innerWidth}×${innerHeight}`);record();
 }catch(e){errors.push(String(e));record();}finally{running=false;document.querySelector('#run').disabled=false;}}
document.querySelector('#run').onclick=run;document.querySelector('#reset').onclick=()=>{if(!running)void reset()};document.querySelector('#scenario').onchange=()=>{if(!running)void reset()};await reset();record();
