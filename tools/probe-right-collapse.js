#!/usr/bin/env node
'use strict';

/**
 * probe-right-collapse.js —— 侧栏折叠后的几何探针（2026-09-13）
 *
 * 用户报：「右边栏收缩，有点叠在一起了」——折叠后的展开按钮与中栏「+ 新增规则」疑似重叠。
 * 本探针把折叠前后的关键矩形都量一遍，判断到底谁压谁、有没有真重叠、按钮是否被父级裁掉。
 *
 * 用法：node tools/probe-right-collapse.js http://127.0.0.1:18084/ /tmp/collapse-shots
 * 零依赖，复用 verify-ui.js 的 CDP 手法。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const BASE = (process.argv[2] || 'http://127.0.0.1:18084/').replace(/\/+$/, '') + '/';
const SHOT_DIR = process.argv[3] || '/tmp/collapse-shots';
let PORT = 0, chrome = null, ws = null, msgId = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function findChrome() {
  const hit = CHROME_CANDIDATES.find((f) => fs.existsSync(f));
  if (!hit) { console.error('找不到 Chrome'); process.exit(2); }
  return hit;
}
function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (data.error) reject(new Error(method + ': ' + JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}
const READONLY_GUARD = `
(() => {
  const real = window.fetch;
  window.fetch = function (url, opt) {
    const method = String((opt && opt.method) || 'GET').toUpperCase();
    if (method === 'POST' && String(url).indexOf('/_admin/config') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real.apply(this, arguments);
  };
})();`;

async function evaluate(source) {
  const out = await send('Runtime.evaluate', {
    expression: '(async () => {' + READONLY_GUARD + source + '})()',
    awaitPromise: true, returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(out.exceptionDetails.text || out.exceptionDetails));
  return out.result ? out.result.value : null;
}

async function shot(name, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = Object.assign({ scale: 2 }, clip);
  const res = await send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(res.data, 'base64'));
}

const PROBE = `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
  return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
const css = (el, p) => (el ? getComputedStyle(el)[p] : null);
const out = { viewport: { w: window.innerWidth, h: window.innerHeight } };

/* 没选中接口时 #btnAddRule 不在 DOM 里，先点一个（探针只读，点击不会写配置） */
if (!document.querySelector('#btnAddRule')) {
  const first = document.querySelector('.api-item');
  if (first) { first.click(); await wait(700); }
}

const snap = (label) => {
  const toggle = document.getElementById('btnToggleRight');
  const addRule = document.getElementById('btnAddRule');
  const paneR = document.getElementById('paneRight');
  const mid = document.querySelector('.pane--mid');
  const wsHead = document.querySelector('.ws-head');
  const layout = document.querySelector('.layout');
  const t = rect(toggle), a = rect(addRule), pr = rect(paneR), m = rect(mid), w = rect(wsHead);
  return {
    label: label,
    layoutClass: layout ? layout.className : null,
    gridCols: css(layout, 'gridTemplateColumns'),
    paneRight: pr ? { left: pr.left, right: pr.right, w: pr.w, overflow: css(paneR, 'overflow'), bg: css(paneR, 'backgroundColor') } : null,
    toggle: t ? { left: t.left, right: t.right, w: t.w, h: t.h, bg: css(toggle, 'backgroundColor'), radius: css(toggle, 'borderRadius'), visible: !!(toggle.offsetWidth && toggle.offsetHeight) } : null,
    addRule: a,
    paneMid: m ? { left: m.left, right: m.right, w: m.w, overflow: css(mid, 'overflow') } : null,
    wsHead: w ? { left: w.left, right: w.right, w: w.w, overflow: css(wsHead, 'overflow') } : null,
    gapToggleVsAddRule: (t && a) ? (t.left - a.right) : null,
    toggleOverflowsPane: (t && pr) ? (t.right - pr.right) : null,
    wsHeadOverflowsMid: (w && m) ? (w.right - m.right) : null,
  };
};

out.before = snap('折叠前');

document.getElementById('btnToggleRight').click();
await wait(600);

out.after = snap('折叠后');

/* 折叠按钮是否被父级轨道裁剪 */
(() => {
  const t = document.getElementById('btnToggleRight');
  const pr = document.getElementById('paneRight');
  if (!t || !pr) { out.clip = null; return; }
  const tb = t.getBoundingClientRect(), pb = pr.getBoundingClientRect();
  out.clip = {
    paneRightW: Math.round(pb.width),
    toggleW: Math.round(tb.width),
    toggleLeftInset: Math.round(tb.left - pb.left),
    toggleRightInset: Math.round(pb.right - tb.right),
    clipped: tb.left < pb.left - 0.5 || tb.right > pb.right + 0.5,
  };
})();

/* 右上角那一横排逐点命中：看见的到底是哪个元素 */
out.stackAtTopRight = (() => {
  const pr = document.getElementById('paneRight');
  if (!pr) return null;
  const b = pr.getBoundingClientRect();
  const y = Math.round(b.top) + 26;
  const list = [];
  for (let x = Math.round(b.left) - 80; x <= Math.round(b.right); x += 10) {
    const el = document.elementFromPoint(x, y);
    list.push({ x: x, el: el ? (el.id || String(el.className).slice(0, 44)) : null });
  }
  return list;
})();

return out;
`;

async function main() {
  PORT = await getFreePort();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rc-'));
  chrome = spawn(findChrome(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  const wsUrl = await attach();
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(2400);

  const out = await evaluate(PROBE);
  console.log(JSON.stringify(out, null, 2));

  await shot('collapse-after.png');
  if (out.after && out.after.paneRight) {
    const x = Math.max(0, out.after.paneRight.left - 320);
    await shot('collapse-crop.png', { x: x, y: 0, width: Math.min(1600 - x, 340), height: 220 });
  }
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('探针失败：' + err.message);
  if (ws) ws.close();
  if (chrome) chrome.kill();
  process.exit(2);
});
