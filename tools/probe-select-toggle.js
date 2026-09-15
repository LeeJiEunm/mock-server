#!/usr/bin/env node
'use strict';

/**
 * probe-select-toggle.js —— 「选择」开关迁到「全部接口」行 + 全选勾选框的观感证据（零依赖 CDP）
 *
 * 本轮改的全是观感与宽度账，自检只能证明「结构对」，证明不了「好不好看、放不放得下」，
 * 所以必须出图。每条主题出两张同区域、同裁剪的对照图：
 *   平时态 = 面板工具条（已无「选择」）＋「全部接口」行（☑ 图标 + ⇅ + ☰）
 *   模式中 = 同一区域（最左全选勾选框 + ✕ 高亮 + ⇅，☰ 让位隐藏）＋ 批量条
 * 同裁剪是为了**能直接叠着比**，而不是各截各的。
 *
 * 用法：
 *   node tools/probe-select-toggle.js http://127.0.0.1:18097/ [OUTPUT_DIR]
 *
 * 输出（OUTPUT_DIR 默认 docs/select-toggle/）：
 *   pane-<主题>-idle.png      平时态：面板顶 → 第一个组头
 *   pane-<主题>-mode.png      模式中：同区域（已勾 2 条，故有批量条 + 半选态）
 *   full-<主题>.png           模式中整页
 *   pane-light-mode-en.png    英文模式中（宽度最紧的一档）
 *
 * 注意：只点不写，写配置的请求在页面里被拦掉（同 verify-ui 的 READONLY_GUARD），
 * 磁盘上的 config.json 一个字节都不动。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BASE = (process.argv[2] || 'http://127.0.0.1:18097/').replace(/\/+$/, '') + '/';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'docs', 'select-toggle');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const THEMES = ['deepnight', 'light', 'night'];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let chrome = null;
let msgId = 0;

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

async function attach(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来（原样重跑一次通常就好）');
}

/** 只读护栏：把写配置的 POST 拦在页面里返回假成功 */
const READONLY_GUARD = `
(() => {
  const real = window.fetch;
  window.fetch = function (url, opt) {
    const method = String((opt && opt.method) || 'GET').toUpperCase();
    if (method === 'POST' && String(url).indexOf('/_admin/config') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, message: '(探针拦截，未落盘)' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real.apply(this, arguments);
  };
})();
`;

/** 量一遍当前状态。返回值里的 clip 就是这一轮截图要用的裁剪框。 */
const MEASURE = `
const o = {};
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));
const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
const round = (n) => +n.toFixed(1);

const pane = q('#paneLeft') || q('.pane');
const paneR = R(pane);
if (!paneR) { o.fatal = '找不到左栏容器'; return o; }

o.selectMode = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on'));
o.btnInPaneActs = !!q('.pane__acts #btnSelect');
o.btnInTotalGroup = !!q('#totalGroup #btnSelect');
o.actsIds = qa('.pane__acts button').map((b) => b.id || String(b.className));

const tg = q('#totalGroup');
const tgR = R(tg);
o.totalKids = tg ? Array.from(tg.children).map((n) => {
  const r = n.getBoundingClientRect();
  const cls = String(n.className).replace(/\\s+/g, '.').slice(0, 30);
  return cls + '  ' + round(r.width) + 'px @' + round(r.left - paneR.x);
}) : [];

const nameEl = q('#totalGroup .group__name');
const countEl = q('#apiTotal');
o.nameClipped = nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null;
o.countClipped = countEl ? countEl.scrollWidth > countEl.clientWidth + 1 : null;

const last = tg ? tg.lastElementChild : null;
o.slack = (tgR && last) ? round(tgR.right - last.getBoundingClientRect().right) : null;
o.rowHScroll = tg ? Math.max(0, tg.scrollWidth - tg.clientWidth) : null;

o.menuBtn = !!q('#totalGroup [data-total-menu]');
o.toggleAllBtn = !!q('#btnToggleAllGroups');
o.totalCheck = !!q('#totalGroup [data-total-check]');
o.totalCheckState = (() => {
  const b = q('#totalGroup [data-total-check] input');
  if (!b) return null;
  return b.indeterminate ? 'indeterminate' : (b.checked ? 'checked' : 'unchecked');
})();

const btn = q('#btnSelect');
const btnR = R(btn);
o.btn = btnR ? { w: round(btnR.w), h: round(btnR.h), left: round(btnR.x - paneR.x) } : null;
o.btnIcons = btn ? qa('#totalGroup #btnSelect svg').map((s) =>
  s.getAttribute('data-icon') + ':' + (getComputedStyle(s).display === 'none' ? '隐' : '显')) : [];
o.btnBorder = btn ? getComputedStyle(btn).borderTopWidth : null;

o.batchBar = !!q('#batchBar');
o.batchBarRows = qa('#batchBar .batchbar__row').length;
o.selected = qa('#apiList .api-item.is-selected').length;
o.halfGroupChecks = qa('#apiList [data-group-check] input').filter((b) => b.indeterminate).length;

/* 全局 ☰ 与 分组 ☰ 的横坐标差：0 = 上下叠成一列。
 * 两处 ☰ 的右侧留白都是 12px，只要 ☰ 一直占着各自行的最右一格就会对齐；
 * 往 ☰ 右边塞任何按钮都会把整列推歪（塞一个 28px 按钮 + 6px gap = 34px）。 */
o.menuAlign = (() => {
  const a = q('#totalGroup [data-total-menu]');
  const b = q('#apiList [data-group-menu]');
  if (!a || !b) return null;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return { dLeft: Math.round(rb.left - ra.left), dRight: Math.round(rb.right - ra.right),
    totRight: Math.round(ra.right), grpRight: Math.round(rb.right) };
})();

// 裁剪框：面板顶 →（第一个组头底 +10），宽度取整个左栏列
// 平时态与模式中同框，才能叠着比
const head = q('.pane__head');
const g1 = q('#apiList .group');
const gh = g1 ? g1.querySelector('.group__head') : null;
const ghR = R(gh);
const top = head ? R(head).y : paneR.y;
const bottom = ghR ? ghR.bottom + 10 : (tgR ? tgR.bottom + 10 : top + 300);
o.clip = {
  x: Math.max(0, Math.floor(paneR.x)),
  y: Math.max(0, Math.floor(top)),
  width: Math.ceil(paneR.w),
  height: Math.min(700, Math.ceil(bottom - top)),
};
o.clipH = o.clip.height;
o.paneW = round(paneR.w);
o.firstGroupHeadBottom = ghR ? round(ghR.bottom) : null;
return o;
`;

/** 切主题：循环点 #btnTheme 直到到位；返回值走 res.result.value（写成 res.value 会恒 undefined） */
async function readTheme() {
  const res = await send('Runtime.evaluate', {
    expression: "document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || 'unknown'",
    returnByValue: true,
  });
  return res && res.result ? res.result.value : undefined;
}

async function goTheme(target) {
  for (let i = 0; i < 8; i++) {
    if (await readTheme() === target) return target;
    await send('Runtime.evaluate', {
      expression: "(() => { const b = document.getElementById('btnTheme'); if (b) b.click(); return !!b; })()",
      returnByValue: true,
    });
    await sleep(420);
  }
  return await readTheme();
}

async function evalIn(expression, awaitPromise) {
  const res = await send('Runtime.evaluate', {
    expression, awaitPromise: !!awaitPromise, returnByValue: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面脚本抛异常：' + (d.exception ? d.exception.description : d.text));
  }
  return res.result ? res.result.value : undefined;
}

const measure = () => evalIn('(() => {' + MEASURE + '})()');
const ensureIdle = () => evalIn(`(async () => {
  const b = document.getElementById('btnSelect');
  if (b && b.classList.contains('is-on')) { b.click(); await new Promise(r => setTimeout(r, 460)); }
  return !!(b && !b.classList.contains('is-on'));
})()`, true);
const enterMode = () => evalIn(`(async () => {
  const b = document.getElementById('btnSelect');
  if (b && !b.classList.contains('is-on')) { b.click(); await new Promise(r => setTimeout(r, 460)); }
  return !!(b && b.classList.contains('is-on'));
})()`, true);
const pickTwo = () => evalIn(`(async () => {
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const cards = qa('#apiList .api-item').filter((c) => !c.classList.contains('is-active'));
  for (let i = 0; i < 2 && i < cards.length; i++) {
    cards[i].click();
    await new Promise(r => setTimeout(r, 220));
  }
  return qa('#apiList .api-item.is-selected').length;
})()`, true);
/* 语言切换：#btnLang 是「中文 ⇄ English」的循环切换（`I18N.setLang` 不是全局函数，
 * 挂在 window 上的是 I18N 对象）。所以只能点到位，不能直接喊 setLang ——
 * 上一轮探针里 `window.setLang(...)` 是个静默空操作，语言压根没切回去。 */
const readLang = () => evalIn("(window.I18N && I18N.getLang && I18N.getLang()) || document.documentElement.getAttribute('lang') || 'unknown'");

async function goLang(target) {
  for (let i = 0; i < 4; i++) {
    if (await readLang() === target) return target;
    await evalIn("(() => { const b = document.getElementById('btnLang'); if (b) b.click(); return !!b; })()");
    await sleep(500);
  }
  return await readLang();
}

async function shot(file, clip) {
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 };
  const res = await send('Page.captureScreenshot', params);
  if (!res || !res.data) throw new Error('截图返回空：' + file);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  return fs.statSync(file).size;
}

const fingerprint = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);

(async () => {
  const chromePath = CHROME_CANDIDATES.find((f) => fs.existsSync(f));
  if (!chromePath) { console.error('找不到 Chrome'); process.exit(2); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'md-select-shot-'));
  chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const url = await attach(port);
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(2800);
    await evalIn(READONLY_GUARD);

    const fullHashes = {};

    for (const theme of THEMES) {
      const landed = await goTheme(theme);
      if (landed !== theme) throw new Error('主题没切到 ' + theme + '（实际 ' + landed + '），继续跑会贴错标签');
      await sleep(560);

      await ensureIdle();
      await sleep(420);
      const idle = await measure();
      if (idle.fatal) throw new Error(idle.fatal);
      const pIdle = path.join(OUT_DIR, 'pane-' + theme + '-idle.png');
      const nIdle = await shot(pIdle, idle.clip);

      await enterMode();
      await sleep(420);
      const picked = await pickTwo();
      await sleep(420);
      const mode = await measure();
      const pMode = path.join(OUT_DIR, 'pane-' + theme + '-mode.png');
      const pFull = path.join(OUT_DIR, 'full-' + theme + '.png');
      const nMode = await shot(pMode, mode.clip);
      const nFull = await shot(pFull, null);
      fullHashes[theme] = fingerprint(pFull);

      const fmt = (m) => '开关[' + (m.btn ? m.btn.w + '×' + m.btn.h + ' @' + m.btn.left : '—') + ']'
        + ' 边框=' + m.btnBorder + ' 图标=' + m.btnIcons.join(',')
        + ' | 全选=' + (m.totalCheck ? m.totalCheckState : '无')
        + ' ☰=' + (m.menuBtn ? '在' : '隐') + ' ⇅=' + (m.toggleAllBtn ? '在' : '隐')
        + ' | 半选组=' + m.halfGroupChecks + ' 已选=' + m.selected + ' 批量条=' + (m.batchBar ? m.batchBarRows + '行' : '无')
        + ' | 空余=' + m.slack + 'px 行溢出=' + m.rowHScroll + ' 名被裁=' + m.nameClipped + ' 计数被裁=' + m.countClipped
        + ' | ☰对齐差=' + (m.menuAlign ? m.menuAlign.dRight + 'px(全局右缘' + m.menuAlign.totRight + ' vs 分组右缘' + m.menuAlign.grpRight + ')' : 'n/a(之一不存在)')
        + ' | 面板工具条=[' + m.actsIds.join(',') + ']'
        + ' 开关在工具条=' + m.btnInPaneActs + ' 在全部接口行=' + m.btnInTotalGroup;

      console.log('[' + theme + '] 平时态  ' + fmt(idle) + '  裁剪=' + idle.clip.width + '×' + idle.clip.height + ' 图=' + nIdle + 'B');
      console.log('[' + theme + '] 模式中  ' + fmt(mode) + '  裁剪=' + mode.clip.width + '×' + mode.clip.height
        + ' 图=' + nMode + 'B（勾了 ' + picked + ' 条）  整页=' + nFull + 'B 指纹=' + fullHashes[theme]);
      console.log('[' + theme + '] 模式中行内元素：' + mode.totalKids.join('  |  '));

      // 只对 light 额外出一档英文（宽度最紧的一档）
      if (theme === 'light') {
        const landedEn = await goLang('en');
        if (landedEn !== 'en') throw new Error('语言没切到 en（实际 ' + landedEn + '），贴错标签的图不算数');
        await sleep(560);
        const en = await measure();
        const pEn = path.join(OUT_DIR, 'pane-light-mode-en.png');
        const nEn = await shot(pEn, en.clip);
        console.log('[light] 模式中·英文  ' + fmt(en) + '  图=' + nEn + 'B');
        const back = await goLang('zh-CN');
        if (back !== 'zh-CN') throw new Error('语言没切回 zh-CN（实际 ' + back + '），后面几张会串语言');
        await sleep(400);
      }
      await ensureIdle();
      await sleep(320);
    }

    const uniq = new Set(Object.values(fullHashes)).size;
    console.log('\n三张整页图指纹去重后 = ' + uniq + '（必须 = 3；< 3 说明主题没切成功，图是重复的）');
    if (uniq < 3) throw new Error('三套主题整页图有重复，截图不算数');
    console.log('Done -> ' + OUT_DIR);
  } catch (e) {
    console.error('截图失败：' + e.message);
    process.exitCode = 1;
  } finally {
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    if (chrome) try { chrome.kill(); } catch (e) { /* ignore */ }
  }
})();
