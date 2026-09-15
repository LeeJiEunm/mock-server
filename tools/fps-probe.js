#!/usr/bin/env node
'use strict';
/**
 * fps-probe.js —— 测量页面动画期间的主线程流畅度（客观证据，不靠肉眼）
 *
 * 原理：
 *  - 在页面里跑 requestAnimationFrame 循环 DURATION 毫秒，记录每帧间隔（delta）。
 *  - 同时用 PerformanceObserver 统计 >50ms 的 long task（主线程被卡的直接证据）。
 *  - 背景 background-position 动画会强制主线程每帧重绘 → rAF 间隔飙升、long task 增多；
 *    改成 transform 动画后走合成器线程 → rAF 间隔回到 ~16ms、long task 归零。
 *
 * 用法：node tools/fps-probe.js [PUBLIC_DIR] [DURATION_MS]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const DURATION = parseInt(process.argv[3] || '3000', 10);
const MODE = process.argv[4] || 'on'; // 'on' = 渐变(aurora)，'off' = 纯色

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
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
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', h);
      d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function attach(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const pg = (await r.json()).find((t) => t.type === 'page');
      if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

async function main() {
  if (!CHROME) { console.error('Chrome not found'); process.exit(1); }

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  const srvPort = await getFreePort();
  const cdpPort = await getFreePort();
  await new Promise((r) => server.listen(srvPort, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srvPort}/`;

  const proc = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=' + cdpPort,
    url,
  ], { stdio: 'ignore', detached: true });

  try {
    const wsUrl = await attach(cdpPort);
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => res(), 5000);
      ws.addEventListener('open', () => { clearTimeout(to); res(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(to); rej(e); }, { once: true });
    });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // 确保处于指定模式（on=渐变 / off=纯色），且动画已启动
    await send('Runtime.evaluate', {
      expression: `document.documentElement.setAttribute('data-aurora','${MODE}'); true;`,
      returnByValue: true,
    });

    // 可选：注入额外 CSS（用于隔离某层的影响），见 argv[5]
    const EXTRA_CSS = process.argv[5] || '';
    if (EXTRA_CSS) {
      await send('Runtime.evaluate', {
        expression: `(function(){ var s=document.createElement('style'); s.textContent=${JSON.stringify(EXTRA_CSS)}; document.head.appendChild(s); return true; })()`,
        returnByValue: true,
      });
      await sleep(300);
    }
    await sleep(1500);

    const expr = `(function(){
      return new Promise(function(resolve){
        var deltas=[]; var last=null; var frames=0; var longtasks=[];
        if('PerformanceObserver' in window){
          try{ var po=new PerformanceObserver(function(list){ var es=list.getEntries(); for(var i=0;i<es.length;i++){ if(es[i].duration>50) longtasks.push(Math.round(es[i].duration)); } }); po.observe({entryTypes:['longtask']}); }catch(e){}
        }
        var start=performance.now();
        function loop(t){ frames++; if(last!==null) deltas.push(t-last); last=t; if(performance.now()-start < ${DURATION}){ requestAnimationFrame(loop); } else {
          var s=deltas.slice().sort(function(a,b){return a-b;});
          var avg=deltas.reduce(function(x,y){return x+y;},0)/(deltas.length||1);
          var p95=s[Math.floor(s.length*0.95)]||s[s.length-1];
          resolve(JSON.stringify({
            frames:frames,
            avgMs:Math.round(avg*10)/10,
            minMs:Math.round((s[0]||0)*10)/10,
            p95Ms:Math.round((p95||0)*10)/10,
            maxMs:Math.round((s[s.length-1]||0)*10)/10,
            fps:Math.round(1000/avg*10)/10,
            longtasks:longtasks.length,
            longtaskMaxMs:longtasks.length?Math.max.apply(null,longtasks):0
          }));
        } }
        requestAnimationFrame(loop);
      });
    })()`;

    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    console.log(r.result.value);
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { process.kill(-proc.pid); } catch (e) {}
    server.close();
    process.exit(0);
  }
}

main();
