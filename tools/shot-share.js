#!/usr/bin/env node
'use strict';
/* 截图脚本：抓「只读分享视图」整页长图（用于 README / 手册）。
 * 起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js。
 *
 * 用法：node tools/shot-share.js [输出文件]
 * 注意：URL 里的分享令牌是占位值（公开版不入库真实令牌），跑之前先换成自己的。 */
const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');

const TARGET = 'http://127.0.0.1:18080/?share=REPLACE_WITH_YOUR_SHARE_TOKEN';
const OUT = process.argv[2] || path.join(__dirname, '_share_light.png');
const W = 1440, H = 2200;

(async () => {
  const chrome = await cdp.launchChrome({
    width: W, height: H, profilePrefix: 'shot-',
    args: ['--hide-scrollbars', '--force-color-profile=srgb'],
  });
  const page = await cdp.connect(chrome.port);
  try {
    await page.viewport(W, H, { deviceScaleFactor: 2 });
    await page.goto(TARGET, { waitMs: 3000 });
    await page.evalExpr('window.scrollTo(0, 680);');
    await cdp.sleep(400);
    await page.shot(OUT, { captureBeyondViewport: false });
    console.log('saved', OUT, fs.statSync(OUT).size, 'bytes');
  } finally {
    await page.close();
    await chrome.close();
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
