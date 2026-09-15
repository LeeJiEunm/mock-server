#!/usr/bin/env node
'use strict';
/**
 * shot-aurora.js —— 截一张渐变（aurora-on）主题整页，确认极光背景渲染正常、内容未被遮挡。
 * 零依赖（Node 22 内置 fetch + WebSocket + http）。
 * 用法：node tools/shot-aurora.js [PUBLIC_DIR] [OUT_PNG]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const OUT = process.argv[3] || path.join(__dirname, '..', 'docs', 'aurora-check.png');

const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'].find(f=>fs.existsSync(f));
let ws=null, msgId=0;
function send(method,params){ const id=++msgId; return new Promise((res,rej)=>{ const h=e=>{ const d=JSON.parse(e.data); if(d.id!==id) return; ws.removeEventListener('message',h); d.error?rej(new Error(method+': '+JSON.stringify(d.error))):res(d.result); }; ws.addEventListener('message',h); ws.send(JSON.stringify({id,method,params:params||{}})); }); }
async function attach(port){ for(let i=0;i<80;i++){ try{ const r=await fetch('http://127.0.0.1:'+port+'/json/list'); const pg=(await r.json()).find(t=>t.type==='page'); if(pg&&pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; }catch(e){} await sleep(250);} throw new Error('chrome not ready'); }

async function main(){
  if(!CHROME){ console.error('Chrome not found'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const server = http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/') p='/index.html'; const fp=path.join(ROOT,p); if(!fp.startsWith(ROOT)){res.writeHead(403);return res.end();} fs.readFile(fp,(e,buf)=>{ if(e){res.writeHead(404);return res.end('nf');} res.writeHead(200,{'Content-Type':TYPES[path.extname(fp)]||'application/octet-stream'}); res.end(buf); }); });
  const srvPort = await getFreePort(); const cdpPort = await getFreePort();
  await new Promise(r=>server.listen(srvPort,'127.0.0.1',r));
  const url=`http://127.0.0.1:${srvPort}/`;
  const proc=spawn(CHROME,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--remote-debugging-port='+cdpPort, url],{stdio:'ignore',detached:true});
  try{
    const wsUrl=await attach(cdpPort); ws=new WebSocket(wsUrl);
    await new Promise((res,rej)=>{ const t=setTimeout(()=>res(),5000); ws.addEventListener('open',()=>{clearTimeout(t);res();},{once:true}); ws.addEventListener('error',e=>{clearTimeout(t);rej(e);},{once:true}); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await send('Runtime.evaluate',{expression:`document.documentElement.setAttribute('data-aurora','on'); true;`,returnByValue:true});
    await sleep(1500);
    // 报告关键层的可见性，确认 aurora-bg 渲染且内容在它之上
    const diag = await send('Runtime.evaluate',{ expression:`(function(){ function cs(el,sel){ var n=el.querySelector(sel); if(!n) return null; var s=getComputedStyle(n); return {w:s.width,h:s.height,zi:s.zIndex,disp:s.display,vis:s.visibility}; } return JSON.stringify({ auroraBg: cs(document,'.aurora-bg'), topbar: cs(document,'.topbar'), layout: cs(document,'.layout') }); })()`, returnByValue:true });
    const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(shot&&shot.data){ fs.writeFileSync(OUT,Buffer.from(shot.data,'base64')); console.log('OK -> '+OUT); }
    else console.log('FAIL screenshot');
    console.log('DIAG '+ (diag.result&&diag.result.value));
  }catch(e){ console.error('ERR',e.message); } finally { try{ws&&ws.close();}catch(e){} try{process.kill(-proc.pid);}catch(e){} server.close(); process.exit(0); }
}
main();
