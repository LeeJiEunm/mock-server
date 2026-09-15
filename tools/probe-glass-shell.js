#!/usr/bin/env node
'use strict';

/**
 * probe-glass-shell.js —— 玻璃壳层（顶栏 / 栏头 / 搜索筛选区 / 吸顶条 / 折叠窄轨）视觉验收
 *
 * 为什么单独写一个：verify-ui.js 只能断结构（元素在不在、谁压谁），答不了
 * 「极光到底有没有从壳里透出来」。这个需求本身是「观感」类的，必须真看像素。
 *
 * 零依赖：Node 22 自带 WebSocket / fetch，不需要 puppeteer。
 *
 * 用法：
 *   node tools/probe-glass-shell.js                                # 默认 http://127.0.0.1:18080/
 *   node tools/probe-glass-shell.js http://127.0.0.1:18099/ /tmp/shots-glass
 *
 * 输出：
 *   <out>/glass-<主题>.png              整页（筛选面板已展开）
 *   <out>/glass-<主题>-scrolled.png     左栏滚到底（看吸顶条压在卡片上的样子）
 *   <out>/glass-<主题>-collapsed.png    右栏折叠（看 32px 窄轨）
 *   控制台打印五个壳的 computed backgroundColor + backdropFilter（数值证据）
 *
 * 注意：左栏要真的能滚出吸顶效果，config.json 得先把 apis 复制成几十个
 * （只有 4 个示例接口时列表根本不溢出，滚动探针等于没跑）。
 *
 * 退出码：0 = 全部截图完成；非 0 = 有步骤失败。
 */

if (typeof fetch === 'undefined' || typeof WebSocket === 'undefined') {
  console.error('需要 Node 18+（自带 fetch / WebSocket），当前是 ' + process.version + '。用：');
  console.error('  node ' +
    __filename.replace(/^.*\/mock-server\//, ''));
  process.exit(2);
}

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/?t=' + Date.now();
const OUT = process.argv[3] || '/tmp/shots-glass';
const W = 1440, H = 900;
const THEMES = ['deepnight', 'night', 'light'];

function pickChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  throw new Error('找不到 Chrome，试过：' + CHROME_CANDIDATES.join(' / '));
}
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
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面里报错：' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shoot(file, clip) {
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
  // clip + scale 出特写：吸顶条上沿那 16px 有没有漏内容，整页图看不出来
  if (clip) params.clip = Object.assign({ scale: 2 }, clip);
  const shot = await send('Page.captureScreenshot', params);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('saved', file);
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

/* 五个「壳」+ 一个反面样本（容器类，本来就该透）：量的是同一件事 —— 背景有没有 alpha。
 * 注意 :hover / 伪元素要用 getComputedStyle(el, '::before') 单独取。 */
const MEASURE = `(() => {
  const one = (sel, pseudo) => {
    const el = document.querySelector(sel);
    if (!el) return { sel: sel, missing: true };
    const cs = getComputedStyle(el, pseudo || undefined);
    return {
      sel: sel + (pseudo || ''),
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage.indexOf('none') === 0 ? 'none' : 'has-gradient',
      blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
    };
  };
  const shells = [
    one('.topbar'),
    one('#paneLeft .pane__head'),
    one('#paneRight .pane__head'),
    one('.search-filter-area'),
    one('.total-group'),
    one('.total-group', '::before'),
  ];
  const containers = [one('.pane__body'), one('.workspace')];
  const alpha = (v) => {
    const s = String(v).trim();
    /* 半透明可能以三种形态出现在计算值里：
     *   rgba(20, 23, 28, 0.78)        —— 直接写的 rgba
     *   color(srgb 0.06 0.06 0.08 / 0.78) —— color-mix() 的结果（Chrome 走这一支）
     *   rgb(20, 23, 28) / color(srgb ...) —— 不带 alpha = 不透明
     * 只认第一种会得出「transparentShells=0」的假结论，这里三种都解。 */
    /* ⚠️ 本段在模板字面量里，所有反斜杠都要写双份（写成 \\s 才是 \s）。
     * 写单个会被当成未知转义直接吞掉，页面里报
     * "Invalid regular expression: /^color(s*srgbs+.../" 这种看不懂的错。 */
    let m = s.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) {
      const parts = m[1].split(',').map((x) => x.trim());
      return parts.length < 4 ? 1 : Number(parts[3]);
    }
    m = s.match(/^color\\(\\s*srgb\\s+[^/]+?(\\/\\s*([\\d.]+)\\s*)?\\)$/);
    if (m) return m[2] === undefined ? 1 : Number(m[2]);
    return null;
  };
  return {
    shells: shells,
    transparentShells: shells.filter((s) => !s.missing && alpha(s.bg) !== null && alpha(s.bg) < 1).length,
    opaqueShells: shells.filter((s) => !s.missing && alpha(s.bg) === 1).map((s) => s.sel),
    containers: containers,
    theme: document.documentElement.getAttribute('data-theme'),
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = pickChrome();
  const port = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-'));
  const child = spawn(chrome, [
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
  await send('Page.navigate', { url: BASE });
  await sleep(2600);   // 等数据 / 日志渲染，也等入场动画跑完

  for (const th of THEMES) {
    await evaluate(`document.documentElement.setAttribute('data-theme','${th}')`);
    await sleep(400);
    // 展开筛选面板（搜索工具条 + 状态/分组芯片都要入镜）
    await evaluate(`document.getElementById('btnToggleFilter')?.click()`);
    await sleep(400);
    await shoot(path.join(OUT, 'glass-' + th + '.png'));

    // 量壳层：打印数值证据，避免"看着像改了"其实是别的原因
    const m = await evaluate(MEASURE);
    console.log('[measure ' + th + '] transparentShells=' + m.transparentShells +
      ' opaqueLeft=' + JSON.stringify(m.opaqueShells));
    m.shells.forEach((s) => console.log('  ' + s.sel + ' → ' + (s.missing ? 'MISSING' : s.bg + ' | blur=' + s.blur)));
    m.containers.forEach((s) => console.log('  (container) ' + s.sel + ' → ' + (s.missing ? 'MISSING' : s.bg)));

    // 左栏滚到底：看吸顶条压住卡片时的观感（这是唯一真压在滚动内容上的壳）
    const scrolled = await evaluate(`(() => {
      const body = document.querySelector('#paneLeft .pane__body');
      if (!body) return 0;
      body.scrollTop = body.scrollHeight;
      return Math.round(body.scrollTop);
    })()`);
    await sleep(500);
    console.log('[scroll ' + th + '] paneLeft scrollTop=' + scrolled);
    await shoot(path.join(OUT, 'glass-' + th + '-scrolled.png'));
    // 特写：左栏顶部（栏头 + 吸顶条 + 吸顶条上沿那条补丁）—— 判「漏不漏内容」只看这里
    await shoot(path.join(OUT, 'crop-' + th + '-sticky.png'), { x: 0, y: 30, width: 380, height: 230 });
    // 特写：顶栏左段（页头玻璃）+ 右栏日志统计条，一眼看穿透效果
    await shoot(path.join(OUT, 'crop-' + th + '-topbar.png'), { x: 0, y: 0, width: 700, height: 90 });

    // 右栏折叠：32px 窄轨也是"壳"，没跟着走玻璃就会多一条割裂竖条
    await evaluate(`document.querySelector('#paneLeft .pane__body').scrollTop = 0`);
    await evaluate(`document.getElementById('btnToggleRight')?.click()`);
    await sleep(500);
    await shoot(path.join(OUT, 'glass-' + th + '-collapsed.png'));
    await evaluate(`document.getElementById('btnToggleRight')?.click()`);
    await sleep(300);

    // 收起筛选面板，避免影响下一个主题的初始状态
    await evaluate(`document.getElementById('btnToggleFilter')?.click()`);
    await sleep(200);
  }

  try { await send('Browser.close'); } catch (e) { /* 忽略 */ }
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
