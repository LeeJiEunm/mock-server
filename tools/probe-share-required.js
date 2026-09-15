const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const net = require('net');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function freePort(){return new Promise(r=>{const s=net.createServer();s.unref();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function get(url){return new Promise((res,rej)=>{const req=http.get(url,{headers:{'Host':'127.0.0.1'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});req.on('error',rej);});}

async function main(){
  const port = await freePort();
  const tmp = '/tmp/cdp-sr-' + process.pid; fs.rmSync(tmp,{recursive:true,force:true});
  const child = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+port,'--user-data-dir='+tmp,'about:blank'], {stdio:'ignore'});
  let ws;
  for (let i=0;i<50;i++){ try{ const v=JSON.parse(await get('http://127.0.0.1:'+port+'/json/version')); ws=new WebSocket(v.webSocketDebuggerUrl); break; }catch(e){} await sleep(300); }
  if(!ws){ console.log('CHROME_FAIL'); child.kill('SIGKILL'); process.exit(1); }
  let _id=0; const nextId=()=>++_id;
  const cdpPending={}, pagePending={};
  function route(o){
    if(!o.id) return;
    if(o.result && typeof o.result.message==='string'){
      const inner=JSON.parse(o.result.message);
      if(pagePending[o.id]){ if(inner.error) pagePending[o.id].rej(inner.error); else pagePending[o.id].res(inner.result); delete pagePending[o.id]; }
    } else if(cdpPending[o.id]){ cdpPending[o.id](o.result); delete cdpPending[o.id]; }
  }
  ws.addEventListener('message', m=>{ try{ route(JSON.parse(m.data)); }catch(e){} });
  await new Promise(r=>ws.addEventListener('open', r));
  const cdpSend=(method,params)=>new Promise(res=>{const id=nextId();cdpPending[id]=res;ws.send(JSON.stringify({id,method,params:params||{}}));});
  const {targetId}=await cdpSend('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdpSend('Target.attachToTarget',{targetId,flatten:true});
  const pageSend=(method,params)=>new Promise((res,rej)=>{const id=nextId();pagePending[id]={res,rej};ws.send(JSON.stringify({id,method:'Target.sendMessageToTarget',params:{sessionId,message:JSON.stringify({id,method,params:params||{}})}}));});
  async function navigate(url){ await pageSend('Page.enable'); await pageSend('Page.navigate',{url}); await sleep(2500); }
  const probeFn = function(){return new Promise(function(res){var t=setInterval(function(){var ws=document.querySelector('#workspace');var wsHtml=ws?ws.innerHTML:'';var hasLock=wsHtml.indexOf('share-invalid')>=0;var hasRules=document.querySelectorAll('.rule-card,.api-item').length;res({hasLock:hasLock,ruleCount:hasRules,bodyReadonly:document.body.classList.contains('readonly')});clearInterval(t);},100);setTimeout(function(){clearInterval(t);var ws=document.querySelector('#workspace');var wsHtml=ws?ws.innerHTML:'';res({hasLock:wsHtml.indexOf('share-invalid')>=0,ruleCount:document.querySelectorAll('.rule-card,.api-item').length,bodyReadonly:document.body.classList.contains('readonly')});},6000);});};
  async function evalProbe(){ const r=await pageSend('Runtime.evaluate',{expression:'('+probeFn.toString()+')()',returnByValue:true,awaitPromise:true}); return r.result.value; }
  const out={};
  await navigate('http://127.0.0.1:18299/');
  out['18299_noShare']=await evalProbe();
  await navigate('http://127.0.0.1:18299/?share=REPLACE_WITH_YOUR_SHARE_TOKEN');
  out['18299_validShare']=await evalProbe();
  console.log(JSON.stringify(out,null,2));
  child.kill('SIGKILL'); process.exit(0);
}
main().catch(e=>{console.error('ERR',e);process.exit(1);});
