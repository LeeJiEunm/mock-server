#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://127.0.0.1:18080';
const BAD = BASE + '/?share=REPLACE_WITH_INVALID_TOKEN';
const NONE = BASE + '/';
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

const evalExp = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true })
  .then((r) => (r && r.result && r.result.value !== undefined ? r.result.value
    : (r && r.result && r.result.value)));

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

  // ---------- Case 1: BAD token (?share=shr-notexist) ----------
  await send('Page.navigate', { url: BAD });
  await sleep(3000);

  const bad = await evalExp(`(function(){
    var invalid = document.querySelector('.share-invalid');
    var banner = document.getElementById('readonlyBanner');
    var rules = document.querySelectorAll('.rule').length;
    return {
      authShareInvalid: !!(window.state && state.auth && state.auth.shareInvalid),
      authReadonly: !!(window.state && state.auth && state.auth.readonly),
      bodyReadonly: document.body.classList.contains('readonly'),
      invalidBlockExists: !!invalid,
      invalidBlockVisible: invalid ? (getComputedStyle(invalid).display !== 'none' && getComputedStyle(invalid).visibility !== 'hidden') : false,
      invalidTitle: invalid ? (document.querySelector('.share-invalid__title')||{}).textContent : '',
      invalidDesc: invalid ? (document.querySelector('.share-invalid__desc')||{}).textContent : '',
      bannerHidden: banner ? banner.hidden : null,
      ruleCardCount: rules,
      workspaceHasLayout: !!document.querySelector('#workspace .layout')
    };
  })()`);
  console.log('CASE_BAD_TOKEN:', JSON.stringify(bad, null, 2));

  // ---------- Case 2: NO token (normal admin access) ----------
  await send('Page.navigate', { url: NONE });
  await sleep(3000);

  const none = await evalExp(`(function(){
    var invalid = document.querySelector('.share-invalid');
    return {
      authReadonly: !!(window.state && state.auth && state.auth.readonly),
      authShareInvalid: !!(window.state && state.auth && state.auth.shareInvalid),
      bodyReadonly: document.body.classList.contains('readonly'),
      invalidBlockExists: !!invalid,
      ruleCardCount: document.querySelectorAll('.rule').length,
      topbarExists: !!document.querySelector('.topbar'),
      workspaceHasLayout: !!document.querySelector('#workspace .layout')
    };
  })()`);
  console.log('CASE_NO_TOKEN:', JSON.stringify(none, null, 2));

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
