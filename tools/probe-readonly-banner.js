#!/usr/bin/env node
'use strict';
// 复现/验证「只读分享横幅 & 离线提示 在渐变主题下被极光层盖住」。
// 做法：自带静态服务器 + headless Chrome，强制显示 #readonlyBanner / #offlineNotice，
// 分别在 data-aurora=on / off 两态截图 + 采样横幅区域中心像素 + 报告层叠清单。
// 用法：node tools/probe-readonly-banner.js [PUBLIC_DIR] [OUT_DIR]
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const OUT = path.resolve(process.argv[3] || '/tmp/readonly-banner');
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
    const h = (e) => { const d = JSON.parse(e.data); if (d.id !== id) return; ws.removeEventListener('message', h); d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result); };
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

/* ---- 极简 PNG 解码：只支持 8bit RGBA/RGB 非隔行（Chrome 截图就是这种） ---- */
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported png colorType=' + colorType + ' depth=' + bitDepth);
  const ch = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      cur[x] = v;
    }
  }
  return { w, h, ch, data: out, at(x, y) { const i = y * stride + x * ch; return [out[i], out[i + 1], out[i + 2]]; } };
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(OUT, name + '.png'), buf);
  return decodePNG(buf);
}

async function main() {
  if (!CHROME) { console.error('Chrome not found'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p); if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => { if (err) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf); });
  });
  const srvPort = await getFreePort(), cdpPort = await getFreePort();
  await new Promise((r) => server.listen(srvPort, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--remote-debugging-port=' + cdpPort, `http://127.0.0.1:${srvPort}/`], { stdio: 'ignore', detached: true });
  const report = {};
  try {
    const wsUrl = await attach(cdpPort); ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { const to = setTimeout(() => res(), 5000); ws.addEventListener('open', () => { clearTimeout(to); res(); }, { once: true }); ws.addEventListener('error', (e) => { clearTimeout(to); rej(e); }, { once: true }); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);

    // 强制显示两条横幅（只读 + 离线），并固定极光动画相位便于逐像素对比
    const setup = await send('Runtime.evaluate', {
      expression: `(function(){
        var rb = document.getElementById('readonlyBanner'); if (rb) rb.hidden = false;
        var on = document.getElementById('offlineNotice'); if (on) on.hidden = false;
        var st = document.getElementById('__probePhase'); if(!st){ st=document.createElement('style'); st.id='__probePhase'; document.head.appendChild(st); }
        st.textContent = '.aurora-bg{animation-delay:0s!important;animation-play-state:paused!important} .atmosphere::before{animation-delay:0s!important;animation-play-state:paused!important}';
        var r = rb.getBoundingClientRect();
        return { bannerRect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
                 bannerDisplay: getComputedStyle(rb).display };
      })()`,
      returnByValue: true,
    });
    report.setup = setup.result.value;

    const bannerColor = async () => (await send('Runtime.evaluate', {
      expression: `(function(){
        var rb=document.getElementById('readonlyBanner'); var cs=getComputedStyle(rb);
        return { background: cs.backgroundColor, color: cs.color, display: cs.display, hidden: rb.hidden };
      })()`, returnByValue: true,
    })).result.value;
    report.bannerCss = await bannerColor();

    for (const mode of ['on', 'off']) {
      await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-aurora','${mode}'); true;`, returnByValue: true });
      await sleep(400);
      const img = await shot('banner-' + mode);
      const r = report.setup.bannerRect;
      const sample = img.at(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
      const bgSample = img.at(20, img.h - 20);
      report[mode] = { bannerPixel: sample, pagePixel: bgSample };
      console.log(`[${mode}] banner 区域中心像素 rgb(${sample.join(',')}) / 页面角落 rgb(${bgSample.join(',')})`);
    }

    // 待修复的"漏网"元素清单：body 顶层里没有 z-index 的静态块
    const stacked = await send('Runtime.evaluate', {
      expression: `(function(){
        return [...document.body.children].filter(function(n){ return n.nodeType===1; }).map(function(n){
          var cs = getComputedStyle(n);
          return { sel: n.id ? ('#'+n.id) : ('.'+String(n.className).split(' ').filter(Boolean)[0]),
                   pos: cs.position, z: cs.zIndex, isFixedBg: n.classList.contains('aurora-bg') };
        });
      })()`, returnByValue: true,
    });
    report.bodyChildren = stacked.result.value;
  } catch (e) { console.error('ERR', e.message); }
  finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\nBODY 顶层元素层叠：');
    (report.bodyChildren || []).forEach((c) => console.log('  ', JSON.stringify(c)));
    try { ws && ws.close(); } catch (e) {}
    try { process.kill(-proc.pid); } catch (e) {}
    server.close(); process.exit(0);
  }
}
main();
