#!/usr/bin/env node
'use strict';
/* 截图脚本：对运行中的 MockDeck 控制台抓 deepnight / night / day 三主题，
 * 用于对照参考稿确认视觉改造已落地。零依赖（Node 22 自带 WebSocket / fetch）。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/?t=' + Date.now();
const OUT = process.argv[3] || '/tmp/shots';
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
    } catch (e) { /* Chrome 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp,
    '--window-size=' + W + ',' + H, 'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await attach(port);
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: URL });
  await sleep(2600); // 等数据/日志渲染

  for (const th of ['deepnight', 'night', 'light']) {
    // 强制主题：先清 localStorage（防止 JS 初始化覆盖），再设 data-theme
    await send('Runtime.evaluate', { expression: `localStorage.removeItem('theme');document.documentElement.setAttribute('data-theme','${th}')`, returnByValue: true });
    await sleep(400);
    // 展开筛选面板（点击漏斗按钮）
    await send('Runtime.evaluate', { expression: `document.getElementById('btnToggleFilter')?.click()`, returnByValue: true });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const file = path.join(OUT, 'theme-' + th + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved', file);
  }

  try { await send('Browser.close'); } catch (e) {}
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
