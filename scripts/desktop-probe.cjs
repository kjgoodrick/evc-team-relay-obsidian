// Companion to managed_stack.py --serve-seconds 900. In Obsidian, connect the
// Team share and create Desktop.md containing the exact test line below.
// Usage: node scripts/desktop-probe.cjs /path/printed/by/harness/fixture.json
// Reads only the disposable loopback fixture. It checks the desktop edit and
// sends a reply to verify in Obsidian. No production vaults or credentials.
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const req = createRequire(require('node:path').resolve(__dirname, '../package.json'));
const Y=req('yjs'), sync=req('y-protocols/sync'), enc=req('lib0/encoding'), dec=req('lib0/decoding');
const f=JSON.parse(readFileSync(process.argv[2], 'utf8'));
if(new URL(f.base).hostname!=='127.0.0.1') throw Error('Loopback only');
async function api(route, token, body) {
 const r=await fetch(f.base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok)throw Error('API '+r.status); return r.json();
}
(async()=>{
 const root=await api('/v1/tokens/relay',f.ownerToken,{share_id:f.share,doc_id:f.share,mode:'write'});
 const manifest=await api('/v1/managed/index/'+f.share,root.token);
 const record=manifest.records['Desktop.md']; if(!record)throw Error('Desktop note missing from inventory');
 const grant=await api('/v1/tokens/relay',f.ownerToken,{share_id:f.share,doc_id:record.id,mode:'write'});
 const doc=new Y.Doc(); const ws=new WebSocket(grant.relay_url+'/'+record.id+'?token='+encodeURIComponent(grant.token)); ws.binaryType='arraybuffer';
 const timer=setTimeout(()=>{console.error('Timed out with text:',doc.getText('contents').toString());ws.close();process.exitCode=1;},12000);
 let sent=false;
 ws.onopen=()=>{const e=enc.createEncoder();enc.writeVarUint(e,0);sync.writeSyncStep1(e,doc);ws.send(enc.toUint8Array(e));};
 doc.on('update',(update,origin)=>{if(origin===ws)return;const e=enc.createEncoder();enc.writeVarUint(e,0);sync.writeUpdate(e,update);ws.send(enc.toUint8Array(e));});
 ws.onmessage=event=>{
  const d=dec.createDecoder(new Uint8Array(event.data)); if(dec.readVarUint(d)!==0)return;
  const e=enc.createEncoder();enc.writeVarUint(e,0);sync.readSyncMessage(d,e,doc,ws);if(enc.length(e)>1)ws.send(enc.toUint8Array(e));
  if(!sent && doc.getText('contents').toString()==='Desktop preview live collaboration check.\n') {
   sent=true; console.log('PASS: fresh peer received the exact Obsidian editor text');
   doc.getText('contents').insert(doc.getText('contents').length,'Peer reached the desktop.\n');
   setTimeout(()=>{clearTimeout(timer);ws.close();doc.destroy();},500);
  }
 };
 ws.onerror=()=>{console.error('WebSocket failure');};
})().catch(e=>{console.error(e.message);process.exitCode=1;});
