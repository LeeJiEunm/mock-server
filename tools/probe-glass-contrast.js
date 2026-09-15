#!/usr/bin/env node
'use strict';

/**
 * probe-glass-contrast.js —— 壳层「完全穿透」后的可读性实测（真像素，不看源码）
 *
 * 为什么必须单独有这么一个工具：
 *   verify-ui.js 里的对比度断言是拿 **token 两两相减**算的
 *   （--color-faint vs --color-surface-3），它压根不知道"文字底下实际铺的是什么"。
 *   一旦把壳层改成 transparent，文字就直接压在极光上 —— 极光是径向渐变、
 *   还带 26s 漂移，对比度**随时间和位置变化**，静态 token 算不出来。
 *   所以这里用真 Chrome 截图 + 逐像素解码，量「文字核心色 vs 实际背景色」。
 *
 * 零依赖：Node 22 自带 WebSocket / fetch / zlib（PNG 解码自己写，见 decodePNG）。
 *
 * 用法：
 *   node tools/probe-glass-contrast.js                            # 默认 http://127.0.0.1:18080/
 *   node tools/probe-glass-contrast.js http://127.0.0.1:18099/ /tmp/shots-contrast
 *
 * 输出：
 *   <out>/contrast-<主题>.png           整页（筛选面板展开）
 *   <out>/contrast-<主题>-scrolled.png  左栏滚到底（吸顶条压在滚动内容上的样子）
 *   控制台：
 *     ① 每个壳的「自身底色 vs 紧邻正文底色」→ 判断穿透是否达成（两者应几乎相等）
 *     ② 每处压在壳上的文字 → 实测对比度，列出 < 4.5:1 的
 *
 * 退出码：0 = 采集完成（不代表全部达标，达标情况看打印的 LOW 行）；非 0 = 脚本自身出错。
 */

if (typeof fetch === 'undefined' || typeof WebSocket === 'undefined') {
  console.error('需要 Node 18+，用托管 Node 22 跑：');
  console.error('  node tools/probe-glass-contrast.js');
  process.exit(2);
}

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const zlib = require('zlib');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/?t=' + Date.now();
const OUT = process.argv[3] || '/tmp/shots-contrast';
const W = 1440, H = 900;
const THEMES = ['deepnight', 'night', 'light'];

/* ---------- 页面里要量的文字（都坐在壳上）+ 壳自身取色用的空档 ---------- */

// 文字目标：[标签, 选择器]。选择器取"文字所在的那个元素"，measure 时取它的 rect 后内缩 1px。
const TEXT_TARGETS = [
  ['页头·统计标签', '.stat__label'],
  ['页头·统计值', '#statApis'],
  ['页头·连通状态', '#healthText'],
  ['页头·次要按钮', '#btnReload'],
  ['右栏头·栏标题', '#paneRight .pane__title'],
  ['右栏头·计数徽标', '#logCount'],
  ['右栏头·清空按钮', '#btnClearLogs'],
  ['搜索区·行标签', '.filter-panel__label'],
  ['搜索区·筛选芯片', '.filter-chip span'],
  ['吸顶条·标题', '.total-group .group__name'],
];

// 壳自身取色：[标签, 壳选择器, x 起点比例, x 终点比例]（取底部中间段的空档，避开文字与控件）
const SHELL_PATCHES = [
  ['页头', '.topbar', 0.40, 0.47],
  ['左栏头', '#paneLeft .pane__head', 0.45, 0.70],
  ['右栏头', '#paneRight .pane__head', 0.30, 0.45],
  ['搜索筛选区', '.filter-panel', 0.62, 0.92],
  ['左栏吸顶条', '.total-group', 0.35, 0.60],
];

// 正文参照：右栏正文（.pane__body 向来透明）——壳底色应当与它一致
const BODY_REF = ['右栏正文(参照)', '#paneRight .pane__body', 0.55, 0.90];

/* ---------------------------- PNG 解码（只支持 8bit 非隔行） ---------------------------- */

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('隔行 PNG 不支持');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + bitDepth);
  const chans = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : -1;
  if (chans < 0) throw new Error('不支持的 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chans;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? cur[i - chans] : 0;
      const b = prev[i];
      const c = i >= chans ? prev[i - chans] : 0;
      let v = row[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { w, h, chans, data: out };
}

const lum = (r, g, b) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const rgbStr = (c) => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';

/** 在一段像素里找「主色（背景）」与「离主色最远的显著色（文字核心）」。 */
function analyse(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.w, Math.ceil(x1)); y1 = Math.min(img.h, Math.ceil(y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const buckets = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * img.chans;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const k = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      let e = buckets.get(k);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
  }
  const list = [...buckets.values()].map((e) => {
    const c = [e.r / e.n, e.g / e.n, e.b / e.n];
    return { n: e.n, c: c.map(Math.round), L: lum(c[0], c[1], c[2]) };
  });
  const total = (x1 - x0) * (y1 - y0);
  list.sort((a, b) => b.n - a.n);
  const bg = list[0];                                   // 主色 = 背景
  const minN = Math.max(3, Math.floor(total * 0.008));  // 至少 0.8% 像素才算「真文字」，滤掉杂点
  let fg = null, best = -1;
  for (const e of list) {
    if (e.n < minN) continue;
    const d = Math.abs(e.L - bg.L);
    if (d > best) { best = d; fg = e; }
  }
  if (!fg) return { bg: bg.c, fg: bg.c, cr: 1, coverage: bg.n / total };
  return {
    bg: bg.c,
    fg: fg.c,
    cr: ratio(bg.L, fg.L),
    coverage: fg.n / total,   // 文字像素占比：很小才说明量到的确实是文字
  };
}

/* --------------------------------- CDP 管线 --------------------------------- */

function pickChrome() {
  for (const c of CHROME_CANDIDATES) { if (fs.existsSync(c)) return c; }
  throw new Error('找不到 Chrome');
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
async function shotBuffer() {
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  return Buffer.from(s.data, 'base64');
}

/** 收集页面里所有目标的 rect（视口坐标），找不到的返回 null。 */
const GATHER = (targets, patches) => `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height, color: cs.color, size: cs.fontSize, weight: cs.fontWeight };
  };
  return {
    text: ${JSON.stringify(targets)}.map(([label, sel]) => [label, rect(sel)]),
    shell: ${JSON.stringify(patches)}.map(([label, sel, a, b]) => {
      const el = document.querySelector(sel);
      if (!el) return [label, null, a, b];
      const r = el.getBoundingClientRect();
      return [label, { x: r.x, y: r.y, w: r.width, h: r.height }, a, b];
    }),
  };
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = pickChrome();
  const port = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcontrast-'));
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp,
    '--window-size=' + W + ',' + H, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const p = (await r.json()).find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) wsUrl = p.webSocketDebuggerUrl;
    } catch (e) { /* 还没起 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口没起来');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(2600);

  const low = [];
  const shellRows = [];

  for (const th of THEMES) {
    await evaluate(`document.documentElement.setAttribute('data-theme','${th}')`);
    await sleep(400);
    await evaluate(`document.getElementById('btnToggleFilter')?.click()`);
    await sleep(450);

    const g = await evaluate(GATHER(TEXT_TARGETS, SHELL_PATCHES.concat([BODY_REF])));
    const png = await shotBuffer();
    fs.writeFileSync(path.join(OUT, 'contrast-' + th + '.png'), png);
    const img = decodePNG(png);

    console.log('\n===== 主题 ' + th + ' =====');
    console.log('-- 壳底色 vs 紧邻正文底色（相等 = 完全穿透）--');
    let bodyRef = null;
    for (const [label, r, a, b] of g.shell) {
      if (!r) { console.log('   ' + label + ' → 缺失'); continue; }
      const x0 = r.x + r.w * a, x1 = r.x + r.w * b;
      const y0 = r.y + r.h * 0.3, y1 = r.y + r.h * 0.7;
      const m = analyse(img, x0, y0, x1, y1);
      if (label.indexOf('参照') >= 0) { bodyRef = m; console.log('   ' + label + ' → ' + rgbStr(m.bg)); continue; }
      const d = bodyRef ? Math.abs(m.bg[0] - bodyRef.bg[0]) + Math.abs(m.bg[1] - bodyRef.bg[1]) + Math.abs(m.bg[2] - bodyRef.bg[2]) : null;
      shellRows.push({ theme: th, shell: label, bg: m.bg, d });
      console.log('   ' + label + ' → ' + rgbStr(m.bg) + (d === null ? '' : '   Δ(与正文)=' + d));
    }

    console.log('-- 文字实测对比度（背景取该元素 rect 内的主色）--');
    for (const [label, r] of g.text) {
      if (!r) { console.log('   ' + label + ' → 缺失'); continue; }
      if (r.w < 4 || r.h < 4) { console.log('   ' + label + ' → 尺寸过小 (' + Math.round(r.w) + 'x' + Math.round(r.h) + ')'); continue; }
      const m = analyse(img, r.x + 1, r.y + 1, r.x + r.w - 1, r.y + r.h - 1);
      const flag = m.cr < 4.5 ? '  ← 低于 4.5' : '';
      console.log('   ' + label.padEnd(16) + ' ' + m.cr.toFixed(2) + ':1   bg=' + rgbStr(m.bg) +
        ' fg=' + rgbStr(m.fg) + '  声明色=' + r.color + ' ' + r.size + '/' + r.weight + flag);
      if (m.cr < 4.5) low.push(th + ' · ' + label + ' = ' + m.cr.toFixed(2) + ':1');
    }

    // 滚动后：吸顶条底下真的压着内容，单独再量一次（这是唯一"透太多会糊"的位置）
    const scrolled = await evaluate(`(() => {
      const b = document.querySelector('#paneLeft .pane__body');
      if (!b) return 0;
      b.scrollTop = b.scrollHeight;
      return Math.round(b.scrollTop);
    })()`);
    await sleep(500);
    const g2 = await evaluate(GATHER([['吸顶条·标题(滚动中)', '.total-group .group__name']], [['左栏吸顶条', '.total-group', 0.35, 0.60]]));
    const png2 = await shotBuffer();
    fs.writeFileSync(path.join(OUT, 'contrast-' + th + '-scrolled.png'), png2);
    const img2 = decodePNG(png2);
    const srow = g2.shell[0];
    const sm = srow[1] ? analyse(img2, srow[1].x + srow[1].w * srow[2], srow[1].y + srow[1].h * 0.3,
      srow[1].x + srow[1].w * srow[3], srow[1].y + srow[1].h * 0.7) : null;
    const trow = g2.text[0];
    const tm = (trow[1] && trow[1].w > 4) ? analyse(img2, trow[1].x + 1, trow[1].y + 1, trow[1].x + trow[1].w - 1, trow[1].y + trow[1].h - 1) : null;
    console.log('-- 滚动中（scrollTop=' + scrolled + '，卡片正从吸顶条底下过）--');
    if (sm) console.log('   吸顶条底色 → ' + rgbStr(sm.bg));
    if (tm) {
      console.log('   ' + '吸顶条·标题'.padEnd(16) + ' ' + tm.cr.toFixed(2) + ':1   bg=' + rgbStr(tm.bg) + ' fg=' + rgbStr(tm.fg) +
        (tm.cr < 4.5 ? '  ← 低于 4.5' : ''));
      if (tm.cr < 4.5) low.push(th + ' · 吸顶条·标题(滚动中) = ' + tm.cr.toFixed(2) + ':1');
    }

    await evaluate(`document.querySelector('#paneLeft .pane__body').scrollTop = 0`);
    await evaluate(`document.getElementById('btnToggleFilter')?.click()`);
    await sleep(200);
  }

  console.log('\n===== 汇总 =====');
  console.log('低于 4.5:1 的项：' + (low.length ? '\n  - ' + low.join('\n  - ') : '无'));
  const worst = shellRows.filter((r) => r.d !== null).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  if (worst) console.log('壳底色与正文最大的通道差：' + worst.shell + ' @' + worst.theme + ' Δ=' + worst.d + '（0 = 完全一致）');
  console.log('截图：' + OUT);

  try { await send('Browser.close'); } catch (e) { /* 忽略 */ }
  child.kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
