#!/usr/bin/env node
'use strict';
/**
 * probe-share-banner.js —— 只读分享视图的「横幅真的看得见吗」端到端探针
 *
 * 为什么要单独有它：
 *   1) verify-ui.js 里那条「只读横幅可见」的判据只有 `!banner.hidden`，
 *      **不检测遮挡** —— 横幅被氛围层（.aurora-bg / .atmosphere::before）整块盖住时照样 PASS。
 *      2026-09-15 用户报的「三个渐变主题下横幅消失、纯色正常」正是这样漏掉的。
 *   2) 免密部署必须配 READONLY_PORT 才能创建分享令牌；否则 verify-ui 拿不到 token
 *      会让 A11 三条断言静默 FAIL（detail 为空 `{}`），看起来像产品坏了。
 *
 * 判据（对每个主题各测一遍）：
 *   - body.readonly 生效、编辑入口隐藏、只读 chip 可见
 *   - 横幅未 hidden，且**其矩形区域的实际像素 ≈ 横幅背景色**（不是氛围层颜色）→ 真的没被盖住
 *
 * 用法：node tools/probe-share-banner.js [BASE] [OUT_DIR]
 *   默认 BASE=http://127.0.0.1:18099/（注意：目标实例需带 READONLY_PORT 才能建令牌）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const BASE = (process.argv[2] || 'http://127.0.0.1:18099/').replace(/\/+$/, '') + '/';
const OUT = path.resolve(process.argv[3] || '/tmp/share-banner');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].find((f) => fs.existsSync(f));

let ws = null, msgId = 0;
function send(method, params) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(method + ' 超时(15s)')), 15000);
    const h = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', h);
      d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function attach(port) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const pg = (await r.json()).find((t) => t.type === 'page'); if (pg && pg.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; } catch (e) {}
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

/* ---- 极简 PNG 解码（8bit RGB/RGBA 非隔行，Chrome 截图即此格式） ---- */
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported png');
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++], line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255; }
      cur[x] = v;
    }
  }
  return { w, h, at(x, y) { const i = y * stride + x * ch; return [out[i], out[i + 1], out[i + 2]]; } };
}
const parseRgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(String(s)); return m ? m[1].split(',').slice(0, 3).map((x) => parseFloat(x)) : null; };
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

async function main() {
  if (!CHROME) { console.error('Chrome not found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  /* 1) 建分享令牌（免密部署需 READONLY_PORT，否则 403） */
  let token = null, mkMsg = '';
  try {
    const r = await fetch(BASE + '_admin/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    mkMsg = j.message || ('http ' + r.status);
    token = j && j.item && j.item.token;
  } catch (e) { mkMsg = 'fetch 失败: ' + e.message; }
  if (!token) {
    console.error('✗ 拿不到分享令牌（无法测只读视图）：' + mkMsg);
    console.error('  提示：免密部署需带 READONLY_PORT 启动，如 PORT=18099 READONLY_PORT=18098 node server.js');
    process.exit(2);
  }
  console.log('分享令牌：' + token.slice(0, 12) + '…  (' + mkMsg + ')');

  const cdpPort = await getFreePort();
  const url = BASE + '?share=' + encodeURIComponent(token);
  const proc = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--remote-debugging-port=' + cdpPort, url], { stdio: 'ignore', detached: true });
  const report = { url: url.replace(token, token.slice(0, 8) + '…'), themes: {} };
  let failed = 0;
  try {
    const wsUrl = await attach(cdpPort); ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { const to = setTimeout(res, 5000); ws.addEventListener('open', () => { clearTimeout(to); res(); }, { once: true }); ws.addEventListener('error', (e) => { clearTimeout(to); rej(e); }, { once: true }); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(3000);   // 等 boot() 跑完（含 /_admin/auth）

    const dom = (await send('Runtime.evaluate', {
      expression: `(function(){
        var b = document.getElementById('readonlyBanner');
        var chip = document.getElementById('readonlyChip');
        var add = document.getElementById('btnAddApi');
        var r = b ? b.getBoundingClientRect() : null;
        return {
          readonly: document.body.classList.contains('readonly'),
          bannerHidden: b ? b.hidden : null,
          bannerDisplay: b ? getComputedStyle(b).display : null,
          bannerBg: b ? getComputedStyle(b).backgroundColor : null,
          bannerRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          chipVisible: chip ? !chip.hidden : null,
          addHidden: add ? getComputedStyle(add).display === 'none' : null
        };
      })()`, returnByValue: true,
    })).result.value;
    report.dom = dom;

    for (const mode of ['on', 'off']) {
      await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-aurora','${mode}'); true;`, returnByValue: true });
      await sleep(500);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(data, 'base64');
      fs.writeFileSync(path.join(OUT, 'share-banner-' + mode + '.png'), buf);
      const img = decodePNG(buf);
      const r = dom.bannerRect;
      const want = parseRgb(dom.bannerBg);
      // 在横幅矩形内取 3 个横向采样点，避免单点偶然
      const pts = [0.25, 0.5, 0.75].map((f) => img.at(Math.round(r.x + r.w * f), Math.round(r.y + r.h / 2)));
      const covered = pts.filter((p) => !want || dist(p, want) > 12).length;
      const ok = dom.readonly && !dom.bannerHidden && covered === 0;
      if (!ok) failed++;
      report.themes[mode] = { samples: pts, bannerBg: dom.bannerBg, outsideCount: covered, ok: ok };
      console.log(`[渐变 ${mode}] 采样像素 ${pts.map((p) => 'rgb(' + p.join(',') + ')').join(' | ')} / 横幅底色 ${dom.bannerBg} → 脱靶 ${covered} 点 → ${ok ? 'PASS 看得见' : 'FAIL 被盖住'}`);
    }
    const envOk = dom.readonly && dom.chipVisible && dom.addHidden === true;
    if (!envOk) failed++;
    console.log(`[只读环境] body.readonly=${dom.readonly} chip可见=${dom.chipVisible} 编辑入口隐藏=${dom.addHidden} → ${envOk ? 'PASS' : 'FAIL'}`);
    console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
  } catch (e) {
    console.error('ERR ' + e.message); failed++;
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    try { await fetch(BASE + '_admin/share?token=' + encodeURIComponent(token), { method: 'DELETE' }); } catch (e) {}
    try { ws && ws.close(); } catch (e) {}
    try { process.kill(-proc.pid); } catch (e) {}
    process.exit(failed === 0 ? 0 : 1);
  }
}
main();
