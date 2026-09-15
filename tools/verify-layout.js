#!/usr/bin/env node
'use strict';

/**
 * verify-layout.js —— 控制台「顶栏 + 头像下拉 + 登录页语言」的真浏览器自检
 *
 * 为什么需要它（都是真跑起来才暴露的问题）：
 *   1) 窗口窄于 ~890px 时顶栏操作区横向溢出，最右侧的头像被挤出视口，
 *      锚在头像上的「用户管理 / 退出」下拉跟着跑出视口 —— 用户看到的现象就是
 *      「下拉跑到页面底部 / 飘在内容中间」。这里按宽度扫一遍，断言：
 *      不产生横向溢出、头像与下拉都完整落在视口内、下拉贴着头像。
 *   2) 登录页原本固定中文，没有语言入口，也没有部署期默认语言。
 *      这里断言：登录卡片有语言切换、默认语言与 /auth 下发的 defaultLang 一致、
 *      点击后文案真的切换。
 *
 * 零依赖：Node 22 自带 WebSocket（CDP），不需要 puppeteer。
 *
 * 前置：
 *   MOCK_ADMIN_PASS=admin123 PORT=18080 node server.js
 *   （若要一并验证部署默认语言：MOCK_DEFAULT_LANG=en MOCK_ADMIN_PASS=admin123 PORT=18081 node server.js）
 *
 * 用法：
 *   node tools/verify-layout.js http://127.0.0.1:18080/ admin admin123
 *   node tools/verify-layout.js http://127.0.0.1:18081/ admin admin123 en   # 指定期望的默认语言
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

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
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
const EXPECT_LANG = process.argv[5] || 'zh-CN';   // 期望的「初次访问默认语言」
let PORT = 0; // 运行时动态选空闲端口，避免连到上一轮残留的 Chrome（端口复用会导致读到旧页面）

/** 选一个当前未被占用的本地端口，规避「上一个 verify 进程的 Chrome 没被杀干净、占着固定端口」的坑 */
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

// 覆盖溢出区间（620~886）与安全区间，外加一个手机宽度
const WIDTHS = [420, 630, 700, 780, 900, 1280];
const HEIGHT = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const hit = CHROME_CANDIDATES.find((file) => fs.existsSync(file));
  if (!hit) {
    console.error('找不到 Chrome，跳过浏览器自检。');
    process.exit(2);
  }
  return hit;
}

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
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  });
}

async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const page = (await res.json()).find((target) => target.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* Chrome 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

async function ev(source) {
  const out = await send('Runtime.evaluate', {
    expression: '(async () => {' + source + '})()',
    awaitPromise: true,
    returnByValue: true,
  });
  return {
    value: out.result ? out.result.value : null,
    thrown: out.exceptionDetails ? out.exceptionDetails.text : null,
  };
}

/* ------------------------------ 注入脚本 ------------------------------ */

/** 登录页：语言切换是否存在、当前选中哪个、各文案是什么 */
const READ_LOGIN_LANG = `
const box = document.querySelector('#loginLang');
const on = box ? box.querySelector('.login-lang.is-on') : null;
return {
  hasSwitch: !!box,
  buttons: box ? box.querySelectorAll('.login-lang').length : 0,
  active: on ? on.getAttribute('data-lang') : '',
  labelUsername: (document.querySelector('label[for="loginUsername"]') || {}).textContent,
  labelPassword: (document.querySelector('label[for="loginPassword"]') || {}).textContent,
  submit: (document.querySelector('#loginForm button[type="submit"]') || {}).textContent,
  layerVisible: !document.querySelector('#loginLayer').hidden,
  defaultLang: (await (await fetch('/_admin/auth')).json()).defaultLang || '',
};
`;

/** 点一次登录卡片上的语言按钮，回报切换后的文案 */
function CLICK_LANG(lang) {
  return `
const btn = document.querySelector('#loginLang .login-lang[data-lang="${lang}"]');
if (btn) btn.click();
await new Promise((r) => setTimeout(r, 200));
const on = document.querySelector('#loginLang .login-lang.is-on');
return {
  active: on ? on.getAttribute('data-lang') : '',
  labelUsername: (document.querySelector('label[for="loginUsername"]') || {}).textContent,
  labelPassword: (document.querySelector('label[for="loginPassword"]') || {}).textContent,
  submit: (document.querySelector('#loginForm button[type="submit"]') || {}).textContent,
};
`;
}

/** 顶栏 + 头像下拉的几何（在指定宽度下） */
const READ_TOPBAR = `
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; };
const avatar = $('#btnUserMenu');
if (!avatar || avatar.hidden) return { fatal: '头像未显示（可能未登录）' };
avatar.click();
await wait(350);
const dd = $('#userDropdown');
if (!dd || dd.hidden) return { fatal: '点击头像后下拉未展开' };
const a = rect(avatar);
const m = rect(dd);
const vw = window.innerWidth, vh = window.innerHeight;
const gapBelow = m.y - a.bottom;      // 大于 0 表示在头像下方
const gapAbove = a.y - m.bottom;      // 大于 0 表示在头像上方
return {
  vw: vw,
  scrollW: document.documentElement.scrollWidth,
  overflowX: document.documentElement.scrollWidth > vw + 1,
  avatar: a,
  menu: m,
  avatarInside: a.x >= -0.5 && a.right <= vw + 0.5 && a.y >= -0.5 && a.bottom <= vh + 0.5,
  menuInside: m.x >= -0.5 && m.right <= vw + 0.5 && m.y >= -0.5 && m.bottom <= vh + 0.5,
  gap: Math.max(gapBelow, gapAbove),
  nearAvatar: (gapBelow > 0 && gapBelow < 16) || (gapAbove > 0 && gapAbove < 16),
  overlapX: Math.min(a.right, m.right) - Math.max(a.x, m.x) > 0,
};
`;

/* ------------------------------ 断言 ------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-layout-verify-'));
  PORT = await getFreePort();
  chrome = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=' + WIDTHS[WIDTHS.length - 1] + ',' + HEIGHT,
    'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await attach();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  // 统一成浅色主题：三个主题里只有浅色的顶栏底色浅，最容易看出「头像是否可见」
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTHS[0], height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  console.log('目标：' + BASE + '   账号：' + USER + ' / (***)   期望默认语言：' + EXPECT_LANG);

  /* --- 1. 登录页语言（干净 profile：无 token、无语言记忆） --- */
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(2200);
  const first = await ev(READ_LOGIN_LANG);
  if (first.thrown) {
    check('登录页语言脚本执行', false, first.thrown);
  } else {
    const r = first.value;
    check('登录层弹出（未登录）', r.layerVisible === true, 'layerVisible=' + r.layerVisible);
    check('登录卡片有语言切换', r.hasSwitch === true && r.buttons === 2, 'buttons=' + r.buttons);
    if (r.defaultLang) {
      check('服务端下发 defaultLang=' + r.defaultLang, true, 'defaultLang=' + r.defaultLang);
    }
    check('初次访问默认语言=' + EXPECT_LANG, r.active === EXPECT_LANG, '实际选中=' + r.active);
    const expectEn = EXPECT_LANG === 'en';
    check('默认语言下用户名标签正确',
      expectEn ? r.labelUsername === 'Username' : r.labelUsername === '用户名', r.labelUsername);
    check('默认语言下按钮文案正确',
      expectEn ? r.submit === 'Log in' : r.submit === '登录', r.submit);

    // 切到另一种语言，确认真的换了
    const other = expectEn ? 'zh-CN' : 'en';
    const flip = await ev(CLICK_LANG(other));
    if (flip.thrown) {
      check('切换语言脚本执行', false, flip.thrown);
    } else {
      const f = flip.value;
      check('点「' + (other === 'en' ? 'English' : '中文') + '」后选中态切换', f.active === other, 'active=' + f.active);
      check('切换后用户名标签跟随',
        other === 'en' ? f.labelUsername === 'Username' : f.labelUsername === '用户名', f.labelUsername);
      check('切换后按钮文案跟随',
        other === 'en' ? f.submit === 'Log in' : f.submit === '登录', f.submit);
    }
    // 复原成期望的默认语言，别影响后面的布局断言
    await ev(CLICK_LANG(EXPECT_LANG));
  }

  /* --- 2. 多宽度：顶栏不溢出 + 头像与下拉都在视口内 --- */
  await ev(`
    const r = await fetch('/_admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '${USER}', password: '${PASS}' }),
    });
    const j = await r.json();
    if (j.token) localStorage.setItem('mockServer.token', j.token);
    return { ok: !!j.token };
  `);

  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(1600);
    const p = await ev(READ_TOPBAR);
    if (p.thrown) { check(w + 'px 几何脚本执行', false, p.thrown); continue; }
    const v = p.value;
    if (v.fatal) { check(w + 'px 头像/下拉可用', false, v.fatal); continue; }
    const tag = w + 'px';
    check(tag + ' 顶栏无横向溢出', v.overflowX === false, 'scrollWidth=' + v.scrollW + ' vw=' + v.vw);
    check(tag + ' 头像完整在视口内', v.avatarInside === true,
      'avatar=' + Math.round(v.avatar.x) + '..' + Math.round(v.avatar.right) + ' vw=' + v.vw);
    check(tag + ' 下拉完整在视口内', v.menuInside === true,
      'menu=' + Math.round(v.menu.x) + '..' + Math.round(v.menu.right) + ' vw=' + v.vw);
    check(tag + ' 下拉贴着头像', v.nearAvatar === true && v.overlapX === true,
      '间距=' + Math.round(v.gap) + 'px 水平重叠=' + v.overlapX);
  }

  /* --- 输出 --- */
  console.log('\n================ 布局与语言自检结果 ================');
  results.forEach((item) => {
    console.log((item.ok ? 'PASS  ' : 'FAIL  ') + item.name + (item.detail ? '   → ' + item.detail : ''));
  });
  const failed = results.filter((item) => !item.ok).length;
  console.log('-------------------------------------------------');
  console.log('共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
}).finally(() => {
  try { if (chrome) chrome.kill(); } catch (e) { /* 忽略 */ }
});
