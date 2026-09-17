#!/usr/bin/env node
'use strict';
/**
 * shot-aurora.js —— 截一张渐变（aurora-on）主题整页，确认极光背景渲染正常、内容未被遮挡。
 * 零依赖（Node 22 内置 fetch + WebSocket + http）。
 * 起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js（这里自带一个静态文件小服务）。
 * 用法：node tools/shot-aurora.js [PUBLIC_DIR] [OUT_PNG]
 *
 * 判据是 DIAG 那一行 + 人眼看图，**不要拿这张图做跨版本的逐像素对比**：
 *   .aurora-bg 是 40s 的无限循环 CSS 动画，截图相位 = 「页面加载到截图之间流逝的时间」。
 *   不同脚本（哪怕只差 1.5s 的等待）截出来的背景色调必然不同，实测差异>8 的像素能占到 20%，
 *   而内容区（文字/卡片/间距）其实一模一样。
 *   要真做像素对比，先让两边都彻底失去动画再截：
 *     await page.evalExpr(`(function(){var s=document.createElement('style');
 *       s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;}';
 *       document.head.appendChild(s);return true;})()`);
 *   （用 animation-delay:0s + animation-play-state:paused 是不行的：paused 只冻结「冻结那一刻」
 *     的进度，相位仍随注入时刻漂移。）按此法复测，差异>8 的像素从 20.82% 落到 0.08%，
 *   与「同一脚本连跑两次」的基线 0.05% 同量级 —— 即差异全在动画相位，不在渲染。
 *
 * 另：本脚本只起静态文件服务、不起 server.js，所以前端探活打的 /_admin/* 必然 404。
 * 那是构造决定的预期现象，下面把它从报错里滤掉，免得看起来像脚本坏了。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const OUT = process.argv[3] || path.join(__dirname, '..', 'docs', 'aurora-check.png');

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function main() {
  cdp.findChrome();      // 找不到会抛出带候选路径的错误
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  const srvPort = await cdp.getFreePort();
  await new Promise((r) => server.listen(srvPort, '127.0.0.1', r));

  let chrome = null, page = null;
  try {
    chrome = await cdp.launchChrome({
      width: 1280, height: 800, profilePrefix: 'aurora-',
      args: ['--disable-background-timer-throttling'],
    });
    page = await cdp.connect(chrome.port);
    await page.viewport(1280, 800);
    await page.goto('http://127.0.0.1:' + srvPort + '/', { waitMs: 1500 });
    await page.evalExpr(`document.documentElement.setAttribute('data-aurora','on'); true;`);
    await cdp.sleep(1500);

    // 报告关键层的可见性，确认 aurora-bg 渲染且内容在它之上
    const diag = await page.evalExpr(`(function(){
      function cs(sel){ var n = document.querySelector(sel); if (!n) return null; var s = getComputedStyle(n); return { w: s.width, h: s.height, zi: s.zIndex, disp: s.display, vis: s.visibility }; }
      return { auroraBg: cs('.aurora-bg'), topbar: cs('.topbar'), layout: cs('.layout') };
    })()`);

    await page.shot(OUT, { captureBeyondViewport: false });
    console.log('OK -> ' + OUT);
    console.log('DIAG ' + JSON.stringify(diag));

    // 静态服务下 /_admin/* 全 404 属预期（没有后端），只报其余错误
    const errs = page.errors().filter((e) => !(e.url && /\/_admin\//.test(e.url)));
    if (errs.length) console.log('其余JS错误 ' + errs.length + ' 条：' + JSON.stringify(errs));
  } finally {
    if (page) await page.close();
    if (chrome) await chrome.close();
    server.close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
