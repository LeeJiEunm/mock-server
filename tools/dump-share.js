#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.argv[2] || 'http://127.0.0.1:18080/?share=REPLACE_WITH_YOUR_SHARE_TOKEN';
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
  const tmp = fs_mkdtemp(path.join(os.tmpdir(), 'dump-'));
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

  const out = await send('Runtime.evaluate', {
    expression: `(function(){
      const body = document.body;
      const ws = document.getElementById('workspace');
      const rules = [...document.querySelectorAll('.rule')].map(function(r){
        return {
          name: (r.querySelector('.rule__name')||{}).textContent,
          cond: (r.querySelector('.rule__cond')||{}).textContent,
          meta: (r.querySelector('.rule__meta')||{}).textContent.replace(/\\s+/g,' ').trim(),
          actionsVisible: [...r.querySelectorAll('.rule__actions .btn')].map(function(b){ return {t:b.textContent.trim(), hidden: getComputedStyle(b).display==='none'}; })
        };
      });
      const changelogBtn = document.getElementById('btnApiChangelog');
      const editOnly = [...document.querySelectorAll('[data-edit-only]')].map(function(e){ return getComputedStyle(e).display==='none' ? 'hidden' : 'shown'; });
      return {
        readonlyClass: body.classList.contains('readonly'),
        workspaceText: ws ? ws.innerText.replace(/\\s+/g,' ').slice(0, 900) : '(no workspace)',
        ruleCount: rules.length,
        rules: rules,
        changelogBtnExists: !!changelogBtn,
        changelogBtnHidden: changelogBtn ? (getComputedStyle(changelogBtn).display==='none') : null,
        editOnlySample: editOnly.slice(0,8)
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(out.result, null, 2));

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

function fs_mkdtemp(p){ const fs=require('fs'); return fs.mkdtempSync(p); }
