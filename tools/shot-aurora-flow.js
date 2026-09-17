#!/usr/bin/env node
'use strict';
// 抓取渐变主题极光在 45s 周期里不同相位的几帧，证明它在「流动扫动」而非静止中心点。
// 用法：node tools/shot-aurora-flow.js [PUBLIC_DIR] [OUT_DIR]
// 起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js（这里自带一个静态文件小服务）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const OUT = path.resolve(process.argv[3] || '/tmp/aurora-flow');

async function main() {
  cdp.findChrome();      // 找不到会抛出带候选路径的错误
  fs.mkdirSync(OUT, { recursive: true });

  const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
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
      width: 1440, height: 900, profilePrefix: 'aurora-flow-',
      args: ['--disable-background-timer-throttling'],
    });
    page = await cdp.connect(chrome.port);
    await page.viewport(1440, 900);
    await page.goto('http://127.0.0.1:' + srvPort + '/', { waitMs: 1500 });
    await page.evalExpr(`document.documentElement.setAttribute('data-aurora','on'); true;`);

    for (const sec of [0, 5, 10, 15, 20, 25, 30, 35]) {
      await page.evalExpr(`(function(){
        var s = document.getElementById('__auroraPhase');
        if (!s) { s = document.createElement('style'); s.id = '__auroraPhase'; document.head.appendChild(s); }
        s.textContent = '.aurora-bg{animation-delay:-${sec}s!important;} .atmosphere::before{animation-delay:-${sec}s!important;}';
        return true;
      })()`);
      await cdp.sleep(500);
      await page.shot(path.join(OUT, 'phase-' + sec + 's.png'), { captureBeyondViewport: false });
      console.log('captured', sec + 's');
    }
  } finally {
    if (page) await page.close();
    if (chrome) await chrome.close();
    server.close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
