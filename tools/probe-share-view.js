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

  // 1) 只读下规则卡「查看」按钮是否可见（非 display:none）
  const pre = await send('Runtime.evaluate', {
    expression: `(function(){
      const viewBtns = [...document.querySelectorAll('.rule__actions [data-action="view"]')];
      return {
        readonly: document.body.classList.contains('readonly'),
        viewBtnCount: viewBtns.length,
        viewBtnVisible: viewBtns.map(function(b){ return getComputedStyle(b).display !== 'none'; }),
        editOnlyHidden: [...document.querySelectorAll('.rule__actions [data-edit-only]')].every(function(b){ return getComputedStyle(b).display === 'none'; })
      };
    })()`,
    returnByValue: true,
  });
  console.log('PRE-CLICK:', JSON.stringify(pre.result));

  // 2) 点击第一条规则的「查看」按钮，打开只读抽屉
  const clicked = await send('Runtime.evaluate', {
    expression: `(function(){
      const b = document.querySelector('.rule__actions [data-action="view"]');
      if (!b) return { clicked: false };
      b.click();
      return { clicked: true };
    })()`,
    returnByValue: true,
  });
  await sleep(500);

  // 3) 抽屉内容 + 保存按钮是否隐藏
  const drawer = await send('Runtime.evaluate', {
    expression: `(function(){
      const d = document.getElementById('drawer');
      const open = d && d.classList.contains('is-open');
      const title = (document.getElementById('drawerTitle')||{}).textContent;
      const body = document.getElementById('drawerBody');
      const save = document.getElementById('btnDrawerSave');
      return {
        drawerOpen: open,
        title: title,
        saveHidden: save ? (save.hidden || getComputedStyle(save).display === 'none') : null,
        bodyText: body ? body.innerText.replace(/\\s+/g,' ').slice(0, 400) : '(none)',
        hasChangelogBtn: !!document.getElementById('btnRuleChangelog')
      };
    })()`,
    returnByValue: true,
  });
  console.log('AFTER-CLICK:', JSON.stringify(drawer.result, null, 2));

  // 4) 关闭抽屉，测试兜底行「查看」
  await send('Runtime.evaluate', { expression: 'var bd=document.getElementById("backdrop"); if(bd) bd.click();', returnByValue: true });
  await sleep(400);
  const fb = await send('Runtime.evaluate', {
    expression: `(function(){
      const b = document.getElementById('btnViewDefault');
      if (!b) return { hasBtn: false };
      b.click();
      return { hasBtn: true, visible: getComputedStyle(b).display !== 'none' };
    })()`,
    returnByValue: true,
  });
  await sleep(400);
  const fdrawer = await send('Runtime.evaluate', {
    expression: `(function(){
      const d = document.getElementById('drawer');
      const save = document.getElementById('btnDrawerSave');
      const body = document.getElementById('drawerBody');
      return {
        title: (document.getElementById('drawerTitle')||{}).textContent,
        saveHidden: save ? (save.hidden || getComputedStyle(save).display==='none') : null,
        drawerOpen: d ? d.classList.contains('is-open') : false,
        bodyText: body ? body.innerText.replace(/\\s+/g,' ').slice(0,220) : '(none)'
      };
    })()`,
    returnByValue: true,
  });
  console.log('FALLBACK:', JSON.stringify(fb.result), JSON.stringify(fdrawer.result));

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
