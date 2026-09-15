#!/usr/bin/env node
'use strict';

/**
 * probe-batch-mode.js —— 批量选择模式 / 复制接口改造的观感证据（零依赖 CDP）
 *
 * 自检只能证明「结构对、逻辑对」，证明不了「好不好看」。本轮改的全是**观感 + 交互热区**，
 * 所以必须出图：三套主题各出「批量模式整页 + 左栏特写 + 不会命中警示特写」。
 *
 * 用法：
 *   node tools/probe-batch-mode.js http://127.0.0.1:18099/ [OUTPUT_DIR]
 *
 * 输出（OUTPUT_DIR 默认 docs/batch-mode/）：
 *   batch-<主题>.png            整页，处于批量模式、已勾选若干条、两行批量条可见
 *   crop-<主题>-left.png        左栏特写：组头三态勾选框 + 两行批量条 + 计数
 *   crop-<主题>-warn.png        含「不会命中」警示的卡片特写（复制接口后必然出现）
 *
 * 注意：脚本会点「复制接口」，写配置的请求在页面里被拦掉（同 verify-ui 的 READONLY_GUARD），
 * 内存状态照常变、界面照常重渲染，磁盘上的 config.json 一个字节都不动。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BASE = (process.argv[2] || 'http://127.0.0.1:18099/').replace(/\/+$/, '') + '/';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'docs', 'batch-mode');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/* 三套主题（与 verify-ui 断言的 data-theme 取值一致）。btnTheme 是循环切换，逐个点到位。 */
const THEMES = ['deepnight', 'light', 'night'];
const THEME_LABEL = { deepnight: 'deepnight', light: 'light', night: 'night' };

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

/** 只读护栏：把写配置的 POST 拦在页面里返回假成功（与 verify-ui 同一套做法） */
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

/** 进批量模式 + 勾几条 + 复制一条接口（逼出「不会命中」警示），返回几个关键坐标 */
const SETUP = `
const out = {};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));

if (!q('#apiList')) { out.fatal = '没有 #apiList'; return out; }

// 进批量模式（进模式即全展开，组头才会长出三态勾选框）
if (q('#btnSelect')) { q('#btnSelect').click(); await tick(360); }
out.selectOn = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on'));

// 勾 3 条「不是当前接口」的卡，让两行批量条有内容、且勾选态不是当前接口态
const idle = qa('#apiList .api-item').filter((n) => !n.classList.contains('is-active'));
for (let i = 0; i < 3 && i < idle.length; i++) { idle[i].click(); await tick(180); }
out.selected = qa('#apiList .api-item.is-selected').length;

// 再把「样例接口」那个组勾成半选，展示三态 indeterminate（取卡片最多的组）
const groups = qa('#apiList .group');
const gBig = groups.slice().sort((a, b) =>
  b.querySelectorAll('.api-item').length - a.querySelectorAll('.api-item').length)[0];
if (gBig) {
  const cards = Array.from(gBig.querySelectorAll('.api-item'));
  const unselected = cards.filter((c) => !c.classList.contains('is-selected'));
  if (unselected.length) { unselected[0].click(); await tick(220); }
}
out.halfState = qa('#apiList [data-group-check] input').filter((b) => b.indeterminate).length;

// 复制一条接口 → 副本保持原路径 → 必须冒出「不会命中」警示
if (q('#btnDuplicateApi')) { q('#btnDuplicateApi').click(); await tick(1200); }

// 左栏滚到顶，保证批量条与第一个分组都在视口里
const sc = q('#apiList .api-scroll');
if (sc) sc.scrollTop = 0;
await tick(260);

// 收集裁剪用的坐标（视口坐标，Page.captureScreenshot 的 clip 用同一坐标系）
const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.max(0, Math.floor(r.left) - 8), y: Math.max(0, Math.floor(r.top) - 8),
    width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 }; };

out.warnCount = qa('#apiList .api-item__warn').length;
const warnCard = qa('#apiList .api-item').find((c) => c.querySelector('.api-item__warn'));
out.clipWarn = rectOf(warnCard);

const paneLeft = q('#paneLeft') || q('.pane');
out.clipLeft = rectOf(paneLeft);
out.clipBar = rectOf(q('#batchBar'));
out.batchBarRows = qa('#batchBar .batchbar__row').length;
out.hasHScroll = sc ? (sc.scrollWidth > sc.clientWidth + 1) : null;
return out;
`;

/** 循环 #btnTheme 直到 data-theme === 目标；返回实际落点
 * ⚠️ Runtime.evaluate 的返回值是 `{result:{type,value}}`，取值必须走 `res.result.value`。
 * 写成 `res.value` 不报错、只是恒得 undefined —— 表现是「主题根本切不动、三张图全是同一个主题」，
 * 而且因为每轮都照样点 8 次按钮，看起来还挺忙，很容易被骗过去。 */
async function readTheme() {
  const res = await send('Runtime.evaluate', {
    expression: "document.documentElement.getAttribute('data-theme') || document.body.getAttribute('data-theme') || 'unknown'",
    returnByValue: true,
  });
  return res && res.result ? res.result.value : undefined;
}

async function goTheme(target) {
  for (let i = 0; i < 8; i++) {
    const now = await readTheme();
    if (now === target) return now;
    await send('Runtime.evaluate', {
      expression: "(() => { const b = document.getElementById('btnTheme'); if (b) b.click(); return !!b; })()",
      returnByValue: true,
    });
    await sleep(420);
  }
  return await readTheme();
}

async function shot(file, clip) {
  const params = { format: 'png', captureBeyondViewport: false };
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 };
  const res = await send('Page.captureScreenshot', params);
  if (!res || !res.data) throw new Error('截图返回空：' + file);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  return fs.statSync(file).size;
}

(async () => {
  const chromePath = CHROME_CANDIDATES.find((f) => fs.existsSync(f));
  if (!chromePath) { console.error('找不到 Chrome'); process.exit(2); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'md-batch-shot-'));
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(2800);

    const setup = await send('Runtime.evaluate', {
      expression: '(async () => {' + READONLY_GUARD + SETUP + '})()',
      awaitPromise: true,
      returnByValue: true,
    });
    if (setup.exceptionDetails) {
      const d = setup.exceptionDetails;
      throw new Error('装配脚本抛异常：' + (d.exception ? d.exception.description : d.text));
    }
    const s = setup.result.value || {};
    console.log('装配结果：' + JSON.stringify(s));
    if (s.fatal) throw new Error(s.fatal);
    if (!s.clipLeft) throw new Error('量不到左栏坐标，截图会全错，先修选择器');

    const hashes = {};
    for (const theme of THEMES) {
      const landed = await goTheme(theme);
      if (landed !== theme) throw new Error('主题没切到 ' + theme + '（实际 ' + landed + '），出的图会贴错标签');
      await sleep(650);   // 主题切换 + 入场动画都跑完再截

      const label = THEME_LABEL[theme] || theme;
      const p1 = path.join(OUT_DIR, 'batch-' + label + '.png');
      const p2 = path.join(OUT_DIR, 'crop-' + label + '-left.png');
      const p3 = path.join(OUT_DIR, 'crop-' + label + '-warn.png');
      const n1 = await shot(p1, null);
      const n2 = await shot(p2, s.clipLeft);
      const n3 = s.clipWarn ? await shot(p3, s.clipWarn) : 0;
      hashes[label] = require('crypto').createHash('sha256').update(fs.readFileSync(p1)).digest('hex').slice(0, 12);
      console.log('  OK ' + label + '  data-theme=' + landed
        + '  整页=' + n1 + 'B  左栏=' + n2 + 'B  警示=' + n3 + 'B  整页指纹=' + hashes[label]);
    }
    const uniq = new Set(Object.values(hashes)).size;
    console.log('三张整页图指纹去重后 = ' + uniq + '（必须 = 3；< 3 说明主题切换没生效，图是重复的）');
    if (uniq < 3) throw new Error('三套主题整页图有重复，截图不算数');
    console.log('\nDone -> ' + OUT_DIR);
  } catch (e) {
    console.error('截图失败：' + e.message);
    process.exitCode = 1;
  } finally {
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    if (chrome) try { chrome.kill(); } catch (e) { /* ignore */ }
  }
})();
