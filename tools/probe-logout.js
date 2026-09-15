#!/usr/bin/env node
'use strict';

/**
 * probe-logout.js —— 复现「退出后未回到登录页」(Issue 2)
 * 真浏览器：登录 admin → 点头像 → 点退出 → 读登录层真实状态。
 * 零依赖：Node 22 自带 WebSocket(CDP)。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
let PORT = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
function findChrome() {
  const hit = CHROME_CANDIDATES.find((f) => fs.existsSync(f));
  if (!hit) { console.error('找不到 Chrome'); process.exitCode = 2; throw new Error('no chrome'); }
  return hit;
}

let chrome = null, ws = null, msgId = 0;
function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (d.error) reject(new Error(method + ': ' + JSON.stringify(d.error)));
      else resolve(d.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function ev(src) {
  const out = await send('Runtime.evaluate', {
    expression: '(async () => {' + src + '})()',
    awaitPromise: true, returnByValue: true,
  });
  if (out.exceptionDetails) return { thrown: out.exceptionDetails.text, value: null };
  return { value: out.result ? out.result.value : null, thrown: null };
}

async function main() {
  const chromePath = findChrome();
  PORT = await getFreePort();
  chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* not ready */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口没起来');

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(1500);

  const u = JSON.stringify(USER), p = JSON.stringify(PASS);
  await ev(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const userEl = document.querySelector('#loginUsername');
    const pwEl = document.querySelector('#loginPassword');
    const f = document.querySelector('#loginForm');
    if (!userEl || !pwEl || !f) return { fatal: '登录表单缺失' };
    userEl.value = ${u};
    pwEl.value = ${p};
    f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; i < 60; i++) {
      const a = document.querySelector('#btnUserMenu');
      if (a && !a.hidden) return { loggedIn: true };
      await wait(100);
    }
    return { loggedIn: false };
  `);

  const before = await ev(`
    const $ = (s) => document.querySelector(s);
    return {
      loggedIn: window.state ? window.state.auth.loggedIn : null,
      isDeployAdmin: window.state ? window.state.auth.isDeployAdmin : null,
      avatarHidden: $('#btnUserMenu').hidden,
      loginHidden: $('#loginLayer').hidden,
    };
  `);
  console.log('登录后:', JSON.stringify(before.value));

  const clicked = await ev(`
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const $ = (s) => document.querySelector(s);
    const out = {};

    // ---- Issue 3: 头像是项目 M logo ----
    const avatarSvg = $('#btnUserMenu .user-avatar__icon');
    out.avatarIsM = !!(avatarSvg && /M9 22V10l7 7 7-7v12/.test(avatarSvg.innerHTML) && /#100f0e/.test(avatarSvg.innerHTML));

    // ---- Issue 1: 隐藏的用户管理项须真正 display:none ----
    const mgmt = $('#btnUserMgmt');
    mgmt.hidden = true;
    out.issue1 = getComputedStyle(mgmt).display;   // 期望 'none'（修复前为 'flex'）
    mgmt.hidden = false;

    // ---- Issue 2: 退出后回到登录层 ----
    const layer = $('#loginLayer');
    window.__hist = [];
    const mo = new MutationObserver((muts) => {
      for (const m of muts) if (m.attributeName === 'hidden') window.__hist.push({ hidden: layer.hidden });
    });
    mo.observe(layer, { attributes: true, attributeFilter: ['hidden'] });
    try { window.logout(); } catch (e) { out.logoutThrew = e.message; }
    await wait(500);
    out.loginHidden = layer.hidden;
    out.loginDisplay = getComputedStyle(layer).display;
    const r = layer.getBoundingClientRect();
    out.loginRect = { w: r.width, h: r.height };
    out.vw = window.innerWidth; out.vh = window.innerHeight;
    out.avatarHidden = $('#btnUserMenu').hidden;
    const topEl = document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
    out.centerHitLogin = !!(topEl && layer.contains(topEl));
    return out;
  `);
  console.log('综合诊断:', JSON.stringify(clicked.value, null, 2));

  const v = clicked.value;
  const ok2 = !v.logoutThrew && v.loginHidden === false && v.loginDisplay === 'flex'
    && v.loginRect.w >= v.vw - 2 && v.loginRect.h >= v.vh - 2 && v.centerHitLogin;
  const ok1 = v.issue1 === 'none';
  const ok3 = v.avatarIsM === true;
  console.log('\\n[Issue1] 普通用户看不到用户管理(display:none):', ok1 ? 'PASS' : 'FAIL (' + v.issue1 + ')');
  console.log('[Issue2] 退出回到登录层且全屏覆盖:', ok2 ? 'PASS' : 'FAIL');
  console.log('[Issue3] 头像是项目 M logo:', ok3 ? 'PASS' : 'FAIL');
  process.exitCode = (ok1 && ok2 && ok3) ? 0 : 1;
}

main()
  .catch((e) => { console.error('探针异常:', e.message); process.exitCode = 3; })
  .finally(() => { if (chrome) chrome.kill('SIGKILL'); });
