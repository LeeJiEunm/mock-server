#!/usr/bin/env node
'use strict';

/**
 * shot-modals.js —— 把六个弹窗在「三套主题」下逐个截成图，用来做视觉评审
 *
 * 为什么单独写一个：verify-ui.js 只管断言（元素在不在、点不点得动），
 * 它答不了「好不好看」。改版弹窗样式时得真看到像素，所以这里补一个纯截图工具。
 *
 * 零依赖：Node 22 自带 WebSocket，不需要 puppeteer。
 *
 * 用法：
 *   node tools/shot-modals.js                                        # 默认 http://127.0.0.1:18080/
 *   node tools/shot-modals.js http://127.0.0.1:18080/ /tmp/shots     # 指定地址与输出目录
 *
 * 输出：<out>/<主题>-<场景>.png        整页（看弹窗和背景的关系）
 *       <out>/crop-<主题>-<场景>.png   弹窗卡片特写（看细节）
 *
 * 退出码：0 = 全部截图完成；非 0 = 有场景失败（打印在 stderr）。
 */

/* 本机默认 node 是 v14（跑服务足够），但它没有全局 fetch / WebSocket，
 * 会报一句莫名其妙的 "fetch is not defined"。这里提前拦住并给出可执行的替代命令。 */
if (typeof fetch === 'undefined' || typeof WebSocket === 'undefined') {
  console.error('需要 Node 18+（自带 fetch / WebSocket），当前是 ' + process.version + '。用：');
  console.error('  node ' +
    __filename.replace(/^.*\/mock-server\//, ''));
  process.exit(2);
}

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/';
const OUT = process.argv[3] || path.join(process.cwd(), 'shots');
const THEMES = ['light', 'night', 'deepnight'];

/* ------------------------------ 场景定义 ------------------------------
 * 每个场景：id = 弹窗 layer 的 id；open = 在页面里触发展开的脚本。
 * 一律走「真实的打开入口」，这样截到的是真数据、真状态，
 * 而不是我手糊一段假 HTML 冒充。 */
const SCENES = [
  { id: 'confirmModal', name: '1-confirm-delete', open: `document.querySelector('#btnDeleteApi').click()` },
  { id: 'promptLayer', name: '2-prompt-input', open: `document.querySelector('#btnAddGroup').click()` },
  { id: 'changelogModal', name: '3-changelog', open: `document.querySelector('#btnApiChangelog').click()` },
  { id: 'hostModal', name: '4-host', open: `document.querySelector('#btnHost').click()` },
  { id: 'contactModal', name: '5-contact', open: `document.querySelector('#btnContact').click()` },
  {
    id: 'userMgmtModal',
    name: '6-user-mgmt',
    // 用户管理弹窗藏在登录后的头像下拉里；截图机上没登录，直接展开弹窗本身
    open: `(() => { const m = document.querySelector('#userMgmtModal'); m.hidden = false; })()`,
  },
];

/* ------------------------------ CDP 小客户端 ------------------------------ */

let chrome = null;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function findChrome() {
  const hit = CHROME_CANDIDATES.find((f) => fs.existsSync(f));
  if (!hit) {
    console.error('找不到 Chrome / Chromium，请手动改 CHROME_CANDIDATES');
    process.exit(2);
  }
  return hit;
}

async function attach(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* Chrome 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

async function evaluate(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text);
  return out.result ? out.result.value : null;
}

async function shoot(file, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = { ...clip, scale: 2 };
  const res = await send('Page.captureScreenshot', params);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-shot-'));
  const port = await getFreePort();
  chrome = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await attach(port);
  ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('目标：' + BASE);
  console.log('输出：' + OUT);

  let failed = 0;
  for (const theme of THEMES) {
    await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(2200);

    for (const scene of SCENES) {
      try {
        // 每次先把所有弹窗收干净、切到目标主题，再打开当前这一个
        const rect = await evaluate(`(async () => {
          document.querySelectorAll('.modal-layer').forEach((n) => { n.hidden = true; });
          document.documentElement.setAttribute('data-theme', '${theme}');
          window.__shotNativeConfirm = window.confirm;
          window.confirm = () => false;   // 截图为只读操作，绝不能真删掉数据
          ${scene.open};
          await new Promise((r) => setTimeout(r, 260));
          /* 入场动画 modal-in 带 scale(0.985)：不等它跑完就量，460px 会量成 453px、
           * 640px 会量成 630px（日志里真出现过），裁图也会跟着偏。 */
          await Promise.all(Array.from(document.querySelectorAll('.modal-card'))
            .flatMap((el) => el.getAnimations().map((a) => a.finished.catch(() => {}))));
          const layer = document.querySelector('#${scene.id}');
          if (!layer || layer.hidden) throw new Error('#${scene.id} 没打开');
          const card = layer.querySelector('.modal-card');
          const r = card.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`);

        await shoot(path.join(OUT, theme + '-' + scene.name + '.png'));
        const pad = 28;
        await shoot(path.join(OUT, 'crop-' + theme + '-' + scene.name + '.png'), {
          x: Math.max(0, rect.x - pad),
          y: Math.max(0, rect.y - pad),
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        });
        console.log('  ok   ' + theme + ' / ' + scene.name + '  ' +
          Math.round(rect.width) + '×' + Math.round(rect.height));
      } catch (e) {
        failed++;
        console.error('  FAIL ' + theme + ' / ' + scene.name + ': ' + e.message);
      }
    }
  }

  if (chrome) chrome.kill();
  await sleep(200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  if (chrome) chrome.kill();
  process.exit(2);
});
