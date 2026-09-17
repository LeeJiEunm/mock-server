#!/usr/bin/env node
'use strict';

/**
 * screenshot-themes.js —— 截取 6 种主题效果
 * 零依赖；起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js
 *
 * 用法：node tools/screenshot-themes.js [URL] [OUTPUT_DIR]
 */

const fs = require('fs');
const path = require('path');
const cdp = require('./lib/cdp');

const BASE = (process.argv[2] || 'http://localhost:18095/').replace(/\/+$/, '') + '/';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'docs', 'theme-screenshots');
const W = 1280, H = 800;

const THEMES = [
  { pref: 'deepnight',       label: '01-deepnight-aurora' },
  { pref: 'day',             label: '02-day-aurora' },
  { pref: 'night',           label: '03-night-aurora' },
  { pref: 'deepnight-flat',  label: '04-deepnight-flat' },
  { pref: 'day-flat',        label: '05-day-flat' },
  { pref: 'night-flat',      label: '06-night-flat' },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = await cdp.launchChrome({ width: W, height: H, profilePrefix: 'shot-themes-' });
  const page = await cdp.connect(chrome.port);
  try {
    await page.viewport(W, H);
    await page.goto(BASE, { waitMs: 2500 });

    /* 逐主题：点顶栏主题按钮，直到 localStorage 里的偏好变成目标值再截图 */
    for (const t of THEMES) {
      let reached = false;
      for (let click = 0; click < 8; click++) {
        const now = await page.evalExpr(`localStorage.getItem('mockServer.theme') || 'deepnight'`);
        if (now === t.pref) { reached = true; break; }
        await page.evalExpr(`(() => { const b = document.getElementById('btnTheme'); if (b) b.click(); return !!b; })()`);
        await cdp.sleep(400);
      }
      if (!reached) console.log('WARN ' + t.label + '：点了 8 次主题按钮仍未切到 ' + t.pref + '，截图可能不是目标主题');

      await cdp.sleep(600);
      const outPath = path.join(OUT_DIR, t.label + '.png');
      await page.shot(outPath, { captureBeyondViewport: false });
      console.log('OK ' + t.label + ' (' + t.pref + ')');
    }

    console.log('\nDone -> ' + OUT_DIR);
  } finally {
    await page.close();
    await chrome.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
