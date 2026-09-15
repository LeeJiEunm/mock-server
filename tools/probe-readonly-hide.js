#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:18080/?share=REPLACE_WITH_YOUR_SHARE_TOKEN';
const W = 1440, H = 900;

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let ws = null, msgId = 0;
function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const on = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', on);
      if (d.error) reject(new Error(method + ': ' + JSON.stringify(d.error)));
      else resolve(d.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function attach(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const p = (await r.json()).find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

(async () => {
  const port = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp,
    '--window-size=' + W + ',' + H, 'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await attach(port);
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: URL });
  await sleep(2800);

  const check = await send('Runtime.evaluate', {
    expression: `(function(){
      function hidden(sel){ var el=document.querySelector(sel); if(!el) return 'missing'; return getComputedStyle(el).display==='none' ? 'hidden' : 'visible'; }
      return {
        readonly: document.body.classList.contains('readonly'),
        btnReload: hidden('#btnReload'),
        btnTry: hidden('#btnTry'),
        btnTryReset: hidden('#btnTryReset'),
        totalMenu: hidden('[data-total-menu]'),
        groupMenu: hidden('[data-group-menu]')
      };
    })()`,
    returnByValue: true,
  });
  console.log('HIDE-CHECK:', JSON.stringify(check.result));

  // 尝试点击汉堡（即便隐藏，确认不会弹出 ctx-menu）；再判断 ctxMenu 是否可见
  const menu = await send('Runtime.evaluate', {
    expression: `(function(){
      var t=document.querySelector('[data-total-menu]'); if(t) t.click();
      var g=document.querySelector('[data-group-menu]'); if(g) g.click();
      var cm=document.getElementById('ctxMenu');
      return { ctxMenuOpen: cm ? (!cm.hidden) : null };
    })()`,
    returnByValue: true,
  });
  console.log('CTX-MENU:', JSON.stringify(menu.result));

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
