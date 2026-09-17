#!/usr/bin/env node
'use strict';
/* 截图脚本：对运行中的 MockDeck 控制台抓 deepnight / night / day 三主题，
 * 用于对照参考稿确认视觉改造已落地。
 * 零依赖；起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js。
 *
 * 用法：node tools/shot-console.js http://127.0.0.1:18080/ /tmp/shots
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');

const TARGET = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/?t=' + Date.now();
const OUT = process.argv[3] || '/tmp/shots';
const W = 1440, H = 900;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await cdp.launchChrome({
    width: W, height: H, profilePrefix: 'shot-', args: ['--hide-scrollbars'],
  });
  const page = await cdp.connect(chrome.port);
  try {
    await page.viewport(W, H);
    await page.goto(TARGET, { waitMs: 2600 });   // 等数据 / 日志渲染

    for (const th of ['deepnight', 'night', 'light']) {
      /* 强制主题：先清 localStorage（防止 JS 初始化覆盖），再设 data-theme */
      await page.evalExpr(`localStorage.removeItem('theme');document.documentElement.setAttribute('data-theme','${th}')`);
      await cdp.sleep(400);
      // 展开筛选面板（点击漏斗按钮）
      await page.evalExpr(`document.getElementById('btnToggleFilter')?.click()`);
      await cdp.sleep(500);
      const file = path.join(OUT, 'theme-' + th + '.png');
      await page.shot(file, { fromSurface: true, captureBeyondViewport: false });
      console.log('saved', file);
    }
  } finally {
    await page.close();
    await chrome.close();
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
