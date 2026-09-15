#!/usr/bin/env node
'use strict';
/* probe-dup-copy.js —— 「复制接口」改造的观感证据（零依赖 CDP，抄 verify-ui.js 的骨架）
 *
 * 为什么单独做：本轮新增/改动的是**人眼要判断**的东西 —— 左侧「发现 N 条不会命中的接口」
 * 提示条长什么样、复制抽屉里预填了什么、路径撞车时按钮变成什么样。
 * 断言能证明行为，证明不了"看起来对不对"。
 *
 * 用法：
 *   node tools/probe-dup-copy.js http://127.0.0.1:18094/ /tmp/dup-shots
 * 产物：left-banner.png / drawer-prefill.png / drawer-conflict.png
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/';
const OUT = process.argv[3] || '/tmp/dup-shots';
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((f) => fs.existsSync(f));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null, chrome = null, msgId = 0;
const pending = new Map();
const CMD_TIMEOUT_MS = 30000;

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')); }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function attach(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

/* 截图：clip 只截目标元素，图与"看的那个东西"一一对应（整页图在长页面上等于没有证据）。
 * 元素不存在时直接抛错 —— 出一张空白图比不出图更糟。 */
async function shot(selector, file, pad) {
  const box = await send('Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    returnByValue: true,
  });
  const v = box.result && box.result.value;
  if (!v || v.w <= 0 || v.h <= 0) throw new Error('截图目标不可见：' + selector);
  const p = pad === undefined ? 10 : pad;
  const res = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, v.x - p), y: Math.max(0, v.y - p), width: v.w + p * 2, height: v.h + p * 2, scale: 2 },
  });
  const buf = Buffer.from(res.data, 'base64');
  const target = path.join(OUT, file);
  fs.writeFileSync(target, buf);
  console.log('  ' + file + '  ' + Math.round(buf.length / 1024) + ' KB  ← ' + selector
    + '  (' + Math.round(v.w) + '×' + Math.round(v.h) + ')');
}

async function evaluate(source) {
  const res = await send('Runtime.evaluate', {
    expression: '(async () => {' + source + '})()', awaitPromise: true, returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error('注入脚本出错：' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails.text));
  return res.result ? res.result.value : undefined;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await getFreePort();
  chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'dup-probe-')),
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  ws = new WebSocket(await attach(port));
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(2500);
  console.log('目标：' + BASE);

  // 只读护栏：探针绝不改目标实例的数据（与 verify-ui.js 同一条规矩）
  await evaluate(`
    const real = window.fetch;
    window.fetch = function (url, opt) {
      if (String((opt && opt.method) || 'GET').toUpperCase() === 'POST' && String(url).indexOf('/_admin/config') >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.apply(this, arguments);
    };`);

  console.log('① 左栏「不会命中」提示条');
  const info = await evaluate(`
    const b = document.querySelector('#shadowBanner');
    return { text: b ? b.querySelector('.shadow-banner__text').textContent.trim() : null,
             btn: !!document.querySelector('#btnDisableShadowed'),
             cards: document.querySelectorAll('#apiList .api-item__warn').length };`);
  console.log('   ' + JSON.stringify(info));
  await shot('#shadowBanner', 'left-banner.png');

  console.log('② 复制抽屉（预填态：路径已换成可用值、按钮仍是「保存接口」）');
  await evaluate(`document.querySelector('#btnDuplicateApi').click(); await new Promise(r=>setTimeout(r,500));`);
  const pre = await evaluate(`
    return { title: document.querySelector('#drawerTitle').textContent.trim(),
             name: document.querySelector('#apiName').value,
             path: document.querySelector('#apiPath').value,
             enabled: document.querySelector('#apiEnabled').checked,
             save: document.querySelector('#btnDrawerSave').textContent.trim(),
             warn: document.querySelector('#btnDrawerSave').classList.contains('is-warn') };`);
  console.log('   ' + JSON.stringify(pre, null, 0));
  await shot('#drawer', 'drawer-prefill.png', 0);

  console.log('③ 同抽屉里把路径改回原件那段（撞车态：按钮改「保存（不会命中）」+ 出提示）');
  const conf = await evaluate(`
    const seg = (document.querySelector('#apiList .api-item.is-active .api-item__path').textContent || '').trim().split('/').filter(Boolean).pop();
    const input = document.querySelector('#apiPath');
    input.value = seg;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r=>setTimeout(r,300));
    const h = document.querySelector('#pathConflict');
    return { setPath: input.value, save: document.querySelector('#btnDrawerSave').textContent.trim(),
             warn: document.querySelector('#btnDrawerSave').classList.contains('is-warn'),
             hint: h.textContent.trim(), hintShown: getComputedStyle(h).display !== 'none' };`);
  console.log('   ' + JSON.stringify(conf, null, 0));
  await shot('#drawer', 'drawer-conflict.png', 0);

  // 收尾：取消，确认没落盘
  const after = await evaluate(`
    document.querySelector('#btnDrawerCancel').click();
    await new Promise(r=>setTimeout(r,400));
    return { apis: document.querySelectorAll('#apiList .api-item').length };`);
  console.log('④ 取消后列表条数 = ' + after.apis + '（探针不应产生任何数据）');

  ws.close();
  chrome.kill();
  console.log('\n产物目录：' + OUT);
  process.exit(0);
})().catch((err) => {
  console.error('探针失败：' + err.message);
  if (ws) ws.close();
  if (chrome) chrome.kill();
  process.exit(2);
});
