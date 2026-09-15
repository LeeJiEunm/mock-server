#!/usr/bin/env node
'use strict';
// 验证两种部署模式下的分享链接行为：
//  Point 1 (免密部署 + 只读隔离端口)：只读端口永远只读，剥离 ?share= 也只读，登录/写被拒。
//  Point 2 (账密部署)：失效分享链接 → 登录界面（而非全屏「链接已失效」页）。
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 900;

// 只读端口的分享链接从文件读取（不在终端回显令牌）
let RO_SHARE_URL = '';
try { RO_SHARE_URL = (require('/tmp/share.json').item || {}).url || ''; } catch (e) {}
const RO_BASE = 'http://127.0.0.1:18199/';            // 只读端口，无令牌
const CRED_BASE = 'http://127.0.0.1:18184/';          // 账密部署主端口
const CRED_INVALID = CRED_BASE + '?share=REPLACE_WITH_INVALID_TOKEN'; // 失效令牌

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
  .then((r) => (r && r.result ? r.result.value : undefined));

async function probe(url, waitMs) {
  await send('Page.navigate', { url: url });
  await sleep(waitMs || 3000);
  return evalExp(`(function(){
    var invalid = document.querySelector('.share-invalid');
    var lb = document.getElementById('loginLayer');
    return {
      bodyReadonly: document.body.classList.contains('readonly'),
      loginLayerHidden: lb ? lb.hidden : null,
      invalidBlockExists: !!invalid,
      invalidBlockVisible: invalid ? (getComputedStyle(invalid).display !== 'none' && getComputedStyle(invalid).visibility !== 'hidden') : false,
      ruleCardCount: document.querySelectorAll('.rule').length,
      workspaceLayout: !!document.querySelector('#workspace .layout')
    };
  })()`);
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

  const out = {};
  if (RO_SHARE_URL) {
    out.P1_READONLY_SHARE = await probe(RO_SHARE_URL, 3500); // 只读端口 + 有效令牌
  }
  out.P1_READONLY_NO_TOKEN = await probe(RO_BASE, 3500);    // 只读端口，无令牌（剥离 ?share=）
  out.P2_CRED_INVALID = await probe(CRED_INVALID, 3500);    // 账密 + 失效令牌
  out.P2_CRED_NONE = await probe(CRED_BASE, 3500);          // 账密 + 无令牌（对照）

  console.log(JSON.stringify(out, null, 2));
  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
