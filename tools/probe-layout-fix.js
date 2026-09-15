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
  throw new Error('Chrome debug port not ready');
}

(async () => {
  const port = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
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

  // Check 1: layout height
  const layout = await send('Runtime.evaluate', {
    expression: `(function(){
      var tb = document.querySelector('.topbar');
      var banner = document.getElementById('readonlyBanner');
      var ly = document.querySelector('.layout');
      return {
        viewportH: window.innerHeight,
        topbarH: tb ? tb.offsetHeight : 0,
        bannerH: banner && !banner.hidden ? banner.offsetHeight : 0,
        layoutH: ly ? ly.clientHeight : 0,
        layoutCSSH: ly ? getComputedStyle(ly).height : '',
        totalH: (tb?tb.offsetHeight:0) + (banner&&!banner.hidden?banner.offsetHeight:0) + (ly?ly.clientHeight:0),
        headerTop: tb ? tb.getBoundingClientRect().top : null,
        headerVisible: tb ? tb.getBoundingClientRect().top >= -10 : false
      };
    })()`,
    returnByValue: true,
  });
  console.log('LAYOUT:', JSON.stringify(layout.result.value, null, 2));

  // Check 2: count alignment
  const margins = await send('Runtime.evaluate', {
    expression: `(function(){
      var ungrouped = document.querySelector('.group[data-group-id="__ungrouped__"] .group__count');
      var counts = document.querySelectorAll('.group__count');
      var normal = null;
      for (var i = 0; i < counts.length; i++) {
        if (!counts[i].closest('[data-group-id="__ungrouped__"]')) { normal = counts[i]; break; }
      }
      return {
        ungroupedMarginR: ungrouped ? getComputedStyle(ungrouped).marginRight : 'NOT_FOUND',
        normalMarginR: normal ? getComputedStyle(normal).marginRight : 'NONE',
        ungroupedRight: ungrouped ? ungrouped.getBoundingClientRect().right : 0,
        normalRight: normal ? normal.getBoundingClientRect().right : 0
      };
    })()`,
    returnByValue: true,
  });
  console.log('MARGINS:', JSON.stringify(margins.result.value, null, 2));

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
