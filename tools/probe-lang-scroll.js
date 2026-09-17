#!/usr/bin/env node
'use strict';

/**
 * probe-lang-scroll.js —— 一次性探针（2026-09-13）
 *
 * 复现用户报的 4 个问题，用真浏览器拿证据，而不是靠猜：
 *   0) 自证「页面跑的是哪一版前端」—— 直接 fetch 静态文件看有没有新字符串
 *      （用户报的 3 个问题都可能是「看到的是旧部署」，先排掉这个可能）
 *   1) GitHub 按钮：meta.repoUrl 有没有、点击有没有真打开
 *   2) 粘贴弹窗：说明区文案 / 可见输入框 / 弹窗宽度
 *   3) 语言切换序列：中文 → 切英文 → 新增规则 → 切回中文 → 新增规则
 *      （用户说切换后占位符不变、强刷才变）
 *   4) 左栏滚动：sticky「全部接口」条与内容的层叠关系
 *
 * 用法：node tools/probe-lang-scroll.js http://127.0.0.1:18099/ [/tmp/probe-shots]
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
const BASE = (process.argv[2] || 'http://127.0.0.1:18099/').replace(/\/+$/, '') + '/';
const SHOT_DIR = process.argv[3] || '/tmp/probe-shots';
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
const txt = (el) => (el ? (el.textContent || '').trim() : null);
const val = (sel, prop) => { const el = document.querySelector(sel); return el ? el[prop] : null; };
const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
  return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
const out = {};

/* ---------- 0) 自证：页面跑的是哪一版前端 ---------- */
/* 旧单文件前端已按功能拆成 public/scripts/ 下多个文件：
 *   function labelOf 在 state.js，data-i18n-value 相关逻辑在 drawer.js。 */
const i18nSrc = await (await fetch('/scripts/i18n.js')).text();
const stateSrc = await (await fetch('/scripts/state.js')).text();
const drawerSrc = await (await fetch('/scripts/drawer.js')).text();
const cssSrc = await (await fetch('/styles/components.css')).text();
out.build = {
  i18n_zh_example: i18nSrc.indexOf('例① curl') >= 0,          // 中文示例（本轮新增）
  i18n_en_example: i18nSrc.indexOf('e.g. 1 curl') >= 0,        // 英文示例（本轮新增）
  main_hasLabelOf: stateSrc.indexOf('function labelOf') >= 0,  // 切语言的 key 化修复
  main_hasI18nValue: drawerSrc.indexOf('data-i18n-value') >= 0,
  css_toastTop: /\\.toast-host\\s*\\{[^}]*top:/.test(cssSrc),      // 改这轮前后能一眼看出
};

/* ---------- 1) GitHub 按钮 ---------- */
const cfg = await (await fetch('/_admin/config')).json();
out.meta = cfg.meta || {};
const opened = [];
const realOpen = window.open;
window.open = (u) => { opened.push(String(u)); return null; };
const toastsBefore = document.querySelectorAll('.toast').length;
document.getElementById('btnGitHub').click();
await wait(200);
window.open = realOpen;
out.github = {
  opened: opened.slice(),
  toasts: document.querySelectorAll('.toast').length - toastsBefore,
  toastText: txt(document.querySelector('.toast')),
};

/* ---------- 2) 粘贴弹窗 ---------- */
I18N.setLang('zh-CN');
await wait(200);
const pasteBtn = document.querySelector('[data-kv-paste="tryQuery"]');
if (pasteBtn) {
  pasteBtn.click();
  await wait(450);
  const card = document.querySelector('#promptForm .modal-card') || document.querySelector('.modal-card');
  const body = document.querySelector('#promptForm .modal-card__body');
  const hint = document.querySelector('#promptForm .modal-card__hint');
  out.paste = {
    cardRect: rect(card),
    hintText: hint ? hint.textContent : null,
    hintLines: hint ? getComputedStyle(hint).whiteSpace : null,
    hintRect: rect(hint),
    visibleControls: Array.from(body.querySelectorAll('input, textarea')).filter((el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.offsetHeight > 0;
    }).map((el) => ({ tag: el.tagName.toLowerCase(), ph: el.getAttribute('placeholder'), rect: rect(el) })),
    placeholderLines: (() => { const ta = document.querySelector('#promptForm textarea'); return ta ? ta.placeholder.split('\\n').length : 0; })(),
  };
  document.getElementById('promptCancel').click();
  await wait(250);
}

/* ---------- 3) 语言切换序列（用户报的复现步骤） ---------- */
const snap = () => ({
  lang: I18N.getLang(),
  ruleName: val('#ruleName', 'value'),
  ruleNamePh: val('#ruleName', 'placeholder'),
  drawerTitle: txt(document.getElementById('drawerTitle')),
  saveBtn: txt(document.getElementById('btnDrawerSave')),
  opOpts: Array.from(document.querySelectorAll('.cond-row select[data-cond="op"] option')).map((e) => e.textContent).join('/'),
  sourceOpts: Array.from(document.querySelectorAll('.cond-row select[data-cond="source"] option')).map((e) => e.textContent).join('/'),
  pathPh: val('.cond-row input[data-cond="path"]', 'placeholder'),
  addCondBtn: txt(document.getElementById('btnAddCond')),
});
const openAdd = async () => { document.getElementById('btnAddRule').click(); await wait(420); return snap(); };
const close = async () => { document.getElementById('btnDrawerCancel').click(); await wait(280); };
I18N.setLang('zh-CN');
await wait(250);
out.seq = {};
out.seq['① 中文·新增规则'] = await openAdd();
await close();
document.getElementById('btnLang').click();            // 真实点击右上角语言按钮
await wait(500);
out.seq['② 切英文后·新增规则'] = await openAdd();
await close();
document.getElementById('btnLang').click();            // 切回中文
await wait(500);
out.seq['③ 切回中文后·新增规则'] = await openAdd();
await close();
/* 抽屉开着切语言（另一种使用路径） */
document.getElementById('btnAddRule').click(); await wait(400);
I18N.setLang('en'); await wait(400);
out.seq['④ 抽屉开着切英文'] = snap();
document.getElementById('btnDrawerCancel').click(); await wait(250);

/* ---------- 4) 左栏滚动 ---------- */
const pane = document.querySelector('.pane__body');
pane.scrollTop = 600;
await wait(450);
const tg = document.querySelector('.total-group');
const fp = document.querySelector('.filter-panel');
const firstItem = document.querySelector('.api-item');
const paneRect = rect(pane);
out.scroll = {
  paneRect,
  paneScrollTop: Math.round(pane.scrollTop),
  panePaddingTop: getComputedStyle(pane).paddingTop,
  paneOverflowY: getComputedStyle(pane).overflowY,
  totalGroup: rect(tg),
  totalGroupPosition: tg ? getComputedStyle(tg).position : null,
  totalGroupTopProp: tg ? getComputedStyle(tg).top : null,
  totalGroupBg: tg ? getComputedStyle(tg).backgroundColor : null,
  totalGroupZ: tg ? getComputedStyle(tg).zIndex : null,
  totalGroupMargin: tg ? getComputedStyle(tg).margin : null,
  filterPanel: fp ? { rect: rect(fp), position: getComputedStyle(fp).position } : null,
  firstApiItem: rect(firstItem),
  /* 「全部接口」条顶部那条 8px 缝隙里漏出来的是什么元素 —— 这就是截图里"透出内容"的位置 */
  elementAtBarTopGap: (() => {
    if (!tg) return null;
    const b = tg.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(b.left) + 30, Math.round(b.top) - 4);
    return el ? (el.className || el.tagName) : null;
  })(),
  /* 谁盖在 sticky 条上 */
  elementAtBarCenter: (() => {
    if (!tg) return null;
    const b = tg.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(b.left) + 30, Math.round(b.top + b.height / 2));
    return el ? (el.className || el.tagName) : null;
  })(),
};
out.leftPaneClip = paneRect;
return out;
`;

async function main() {
  PORT = await getFreePort();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-ls-'));
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
  // 截图：左栏滚动状态（整页 + 左栏特写）
  await shot('scroll-pane.png');
  if (out.leftPaneClip) {
    await shot('scroll-pane-crop.png', {
      x: out.leftPaneClip.left, y: Math.max(0, out.leftPaneClip.top - 40),
      width: out.leftPaneClip.w, height: 420,
    });
  }
  // 截图：粘贴弹窗（中文）
  await evaluate(`
    I18N.setLang('zh-CN'); await new Promise((r)=>setTimeout(r,200));
    const b = document.querySelector('[data-kv-paste="tryQuery"]'); if (b) b.click();
    await new Promise((r)=>setTimeout(r,500)); return 1;`);
  await shot('paste-zh-2.png');
  // 截图：提示条位置（切一下语言就会弹 toast，2.6s 内截图）
  await evaluate(`
    document.getElementById('promptCancel').click();
    await new Promise((r)=>setTimeout(r,200));
    document.getElementById('btnLang').click();
    await new Promise((r)=>setTimeout(r,250)); return 1;`);
  await shot('toast-top.png');
  // 截图：英文语言下的规则抽屉（标题也应跟着变）
  await evaluate(`
    I18N.setLang('en'); await new Promise((r)=>setTimeout(r,300));
    document.getElementById('btnAddRule').click();
    await new Promise((r)=>setTimeout(r,500)); return 1;`);
  await shot('drawer-en-2.png');
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
