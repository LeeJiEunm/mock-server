#!/usr/bin/env node
'use strict';

/**
 * screenshot-themes.js —— 截取 6 种主题效果
 * 零依赖（Node 22 内置 fetch + WebSocket），复用 verify-ui 的 CDP 连接方式
 *
 * 用法：node tools/screenshot-themes.js [URL] [OUTPUT_DIR]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:18095/').replace(/\/+$/, '') + '/';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'docs', 'theme-screenshots');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const THEMES = [
  { pref: 'deepnight',       label: '01-deepnight-aurora' },
  { pref: 'day',             label: '02-day-aurora' },
  { pref: 'night',           label: '03-night-aurora' },
  { pref: 'deepnight-flat',  label: '04-deepnight-flat' },
  { pref: 'day-flat',        label: '05-day-flat' },
  { pref: 'night-flat',      label: '06-night-flat' },
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findChrome() {
  return CHROME_CANDIDATES.find(f => fs.existsSync(f)) || null;
}

// ---- CDP client (same pattern as verify-ui) ----
let ws = null;
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
      const page = (await res.json()).find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome debug port not ready');
}

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error('Chrome not found'); process.exit(1); }

  const port = await getFreePort();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Launch Chrome
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=1280,800`,
    BASE,
  ], { stdio: 'ignore', detached: true });

  // Connect
  const wsUrl = await attach(port);
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(res, 5000); });

  await send('Page.enable');

  // Set viewport
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });

  // For each theme: cycle to it, wait, screenshot
  for (let i = 0; i < THEMES.length; i++) {
    const t = THEMES[i];
    
    // Click theme button until we reach target
    for (let click = 0; click < 8; click++) {
      const r = await send('Runtime.evaluate', {
        expression: `localStorage.getItem('mockServer.theme') || 'deepnight'`,
        returnByValue: true,
      });
      if (r && r.value === t.pref) break;
      
      await send('Runtime.evaluate', {
        expression: `(() => { const b = document.getElementById('btnTheme'); if(b) b.click(); return !!b; })()`,
        returnByValue: true,
      });
      await sleep(400);
    }
    
    await sleep(600);

    // Screenshot
    const result = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    });
    
    if (result && result.data) {
      const outPath = path.join(OUT_DIR, t.label + '.png');
      fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
      console.log(`OK ${t.label} (${t.pref})`);
    } else {
      console.log(`FAIL ${t.label}`);
    }
  }

  ws.close();
  // Kill our Chrome instance
  try { process.kill(-proc.pid); } catch(e) {}
  console.log(`\nDone -> ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
