#!/usr/bin/env node
'use strict';
// 抓取渐变主题极光在 45s 周期里不同相位的几帧，证明它在「流动扫动」而非静止中心点。
// 用法：node tools/shot-aurora-flow.js [PUBLIC_DIR] [OUT_DIR]
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const OUT = path.resolve(process.argv[3] || '/tmp/aurora-flow');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].find((f) => fs.existsSync(f));

let ws = null, msgId = 0;
function send(method, params) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    const h = (e) => { const d = JSON.parse(e.data); if (d.id !== id) return; ws.removeEventListener('message', h); d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result); };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function attach(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const pg = (await r.json()).find((t) => t.type === 'page'); if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; } catch (e) {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

async function main() {
  if (!CHROME) { console.error('Chrome not found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p); if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => { if (err) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf); });
  });
  const srvPort = await getFreePort(), cdpPort = await getFreePort();
  await new Promise((r) => server.listen(srvPort, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--remote-debugging-port=' + cdpPort, `http://127.0.0.1:${srvPort}/`], { stdio: 'ignore', detached: true });
  try {
    const wsUrl = await attach(cdpPort); ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { const to = setTimeout(() => res(), 5000); ws.addEventListener('open', () => { clearTimeout(to); res(); }, { once: true }); ws.addEventListener('error', (e) => { clearTimeout(to); rej(e); }, { once: true }); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-aurora','on'); true;`, returnByValue: true });
    const phases = [0, 5, 10, 15, 20, 25, 30, 35];
    for (const sec of phases) {
      await send('Runtime.evaluate', { expression: `(function(){
        var s=document.getElementById('__auroraPhase'); if(!s){s=document.createElement('style'); s.id='__auroraPhase'; document.head.appendChild(s);}
        s.textContent='.aurora-bg{animation-delay:-${sec}s!important;} .atmosphere::before{animation-delay:-${sec}s!important;}';
        return true;
      })()`, returnByValue: true });
      await sleep(500);
      const { data } = await send('Page.captureScreenshot', { params: { format: 'png' } });
      fs.writeFileSync(path.join(OUT, `phase-${sec}s.png`), Buffer.from(data, 'base64'));
      console.log('captured', sec + 's');
    }
  } catch (e) { console.error('ERR', e.message); }
  finally { try { ws && ws.close(); } catch (e) {} try { process.kill(-proc.pid); } catch (e) {} server.close(); process.exit(0); }
}
main();
