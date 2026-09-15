#!/usr/bin/env node
'use strict';

/**
 * verify-dropdown.js —— 头像下拉「浮层定位 + 文案跟随语言」的真浏览器自检
 *
 * 覆盖两个反复出问题、且只在真浏览器里才看得见的点：
 *
 *   1) 下拉定位（用户反馈「跑到页面底部 / 飘在内容中间」）
 *      顶栏 .topbar 带 backdrop-filter(blur)，会为后代创建包含块；窄屏下顶栏还会换行。
 *      所以下拉不能靠「相对 .user-menu 的 absolute」，必须像 GitHub 那样：
 *      打开时把菜单挂到 <body>、用 position:fixed + 视口坐标。
 *      这里按宽度扫一遍，断言：菜单挂在 body 上、computed position 为 fixed、
 *      在最上层未被遮挡、完整落在视口内、贴着头像，且顶栏不横向溢出。
 *
 *   2) 文案不跟随语言（用户反馈「中文时有个 Deploy admin 显示」）
 *      #userMenuRole（部署管理员 / 普通用户）是 JS 写进 DOM 的，没有 data-i18n，
 *      applyI18n() 覆盖不到。若切语言时不重渲染顶栏用户条，它就会停在旧语言。
 *      这里断言 zh → en → zh 来回切时，角色标签与下拉项都跟着变。
 *
 * 零依赖：Node 22 自带 WebSocket（CDP），不需要 puppeteer。
 *
 * 前置：
 *   MOCK_ADMIN_USER=admin MOCK_ADMIN_PASS=admin123 PORT=18080 node server.js
 *
 * 用法：
 *   node tools/verify-dropdown.js http://127.0.0.1:18080/ admin admin123
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
let PORT = 0; // 动态选空闲端口：避免连到上一轮残留 Chrome 里的旧页面

const WIDTHS = [420, 480, 630, 700, 780, 900, 1280];
const HEIGHT = 900;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const page = (await res.json()).find((t) => t.type === 'page');
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

/** 读写顶栏用户条文案 + 下拉定位特征（先把语言钉成 zh-CN，保证可复现） */
const READ_I18N = `
const $ = (s) => document.querySelector(s);
const txt = (s) => { const n = $(s); return n ? n.textContent.trim() : null; };
return {
  lang: window.I18N ? window.I18N.getLang() : null,
  role: txt('#userMenuRole'),
  mgmt: txt('#btnUserMgmt'),
  logout: txt('#btnLogout'),
  contactTitle: (($('#btnContact') || {}).title || ''),
  name: txt('#userMenuName'),
};
`;

/** 点顶栏 🌐 切语言（#btnLang 是"切换到另一种语言"的开关），等一帧后回报文案 */
const clickLang = () => `
const btn = document.querySelector('#btnLang');
if (!btn) return { error: 'no #btnLang' };
btn.click();
await new Promise((r) => setTimeout(r, 250));
const $ = (s) => document.querySelector(s);
const txt = (s) => { const n = $(s); return n ? n.textContent.trim() : null; };
return {
  lang: window.I18N ? window.I18N.getLang() : null,
  role: txt('#userMenuRole'),
  mgmt: txt('#btnUserMgmt'),
  logout: txt('#btnLogout'),
};
`;

/** 打开下拉，回报浮层的定位特征（是否挂 body / fixed / 在最上层 / 几何） */
const READ_MENU_GEOM = `
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; };
const avatar = $('#btnUserMenu');
// 轮询等登录态渲染完成（/auth 往返 + renderUserBar）。固定 sleep 偶尔不够，
// 会把「还没渲染完」误判成「头像未显示」，产生假 FAIL。
for (let i = 0; i < 60; i++) {
  if (avatar && !avatar.hidden) break;
  await wait(100);
}
if (!avatar || avatar.hidden) return { fatal: '头像未显示（可能未登录）' };
if (!$('#userDropdown').hidden) { /* 已开，先关掉再测 */ avatar.click(); await wait(200); }
avatar.click();
await wait(300);
const dd = $('#userDropdown');
if (!dd || dd.hidden) return { fatal: '点击头像后下拉未展开' };
const cs = getComputedStyle(dd);
const a = rect(avatar);
const m = rect(dd);
const vw = window.innerWidth, vh = window.innerHeight;
const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
const topEl = document.elementFromPoint(cx, cy);
const gapBelow = m.y - a.bottom;
const gapAbove = a.y - m.bottom;
return {
  vw: vw, vh: vh,
  scrollW: document.documentElement.scrollWidth,
  overflowX: document.documentElement.scrollWidth > vw + 1,
  position: cs.position,
  parentIsBody: dd.parentElement === document.body,
  onTop: !!(topEl && dd.contains(topEl)),
  zIndex: cs.zIndex,
  avatar: a, menu: m,
  avatarInside: a.x >= -0.5 && a.right <= vw + 0.5 && a.y >= -0.5 && a.bottom <= vh + 0.5,
  menuInside: m.x >= -0.5 && m.right <= vw + 0.5 && m.y >= -0.5 && m.bottom <= vh + 0.5,
  gap: Math.max(gapBelow, gapAbove),
  nearAvatar: (gapBelow > 0 && gapBelow < 16) || (gapAbove > 0 && gapAbove < 16),
  overlapX: Math.min(a.right, m.right) - Math.max(a.x, m.x) > 0,
};
`;

/** 关闭下拉后，DOM 是否已归位到头像容器（保证重渲染不丢节点） */
const READ_AFTER_CLOSE = `
const $ = (s) => document.querySelector(s);
const dd = $('#userDropdown');
const avatar = $('#btnUserMenu');
if (dd && !dd.hidden) avatar.click();
await new Promise((r) => setTimeout(r, 200));
return { parentIsWrap: dd.parentElement === $('#userMenu') };
`;

/* ------------------------------ 断言 ------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-dropdown-verify-'));
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  console.log('目标：' + BASE + '   账号：' + USER + ' / (***)');

  /* --- 0. 登录并把语言钉成 zh-CN（干净 profile 无记忆，仍显式固定以保证可复现） --- */
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(2000);
  const login = await ev(`
    const r = await fetch('/_admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '${USER}', password: '${PASS}' }),
    });
    const j = await r.json();
    if (j.token) {
      localStorage.setItem('mockServer.token', j.token);
      localStorage.setItem('mockServer.lang', 'zh-CN');
    }
    return { ok: !!j.token, message: j.message || '' };
  `);
  if (login.thrown || !login.value || !login.value.ok) {
    check('登录成功', false, (login.thrown || (login.value && login.value.message) || '未拿到 token') + '');
    report();
    return;
  }
  check('登录成功', true, '已拿到 token');

  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(2200);

  /* --- 1. 语言来回切：角色标签与下拉项必须跟着变 --- */
  const zh = await ev(READ_I18N);
  if (zh.thrown) {
    check('读取用户条文案', false, zh.thrown);
  } else {
    const v = zh.value;
    check('初始语言=zh-CN', v.lang === 'zh-CN', 'lang=' + v.lang);
    check('zh 下角色标签为中文「部署管理员」', v.role === '部署管理员', '实际=' + JSON.stringify(v.role));
    check('zh 下下拉项为中文', v.mgmt === '用户管理' && v.logout === '退出',
      'mgmt=' + JSON.stringify(v.mgmt) + ' logout=' + JSON.stringify(v.logout));
    check('zh 下联系按钮提示为中文', v.contactTitle === '联系维护者', '实际=' + JSON.stringify(v.contactTitle));
  }

  const toEn = await ev(clickLang());
  if (toEn.thrown) {
    check('切到英文', false, toEn.thrown);
  } else {
    const v = toEn.value;
    check('切到 en 后角色标签为英文', v.role === 'Deploy admin', '实际=' + JSON.stringify(v.role));
    check('切到 en 后下拉项为英文', v.mgmt === 'Users' && v.logout === 'Sign out',
      'mgmt=' + JSON.stringify(v.mgmt) + ' logout=' + JSON.stringify(v.logout));
  }

  const backZh = await ev(clickLang());
  if (backZh.thrown) {
    check('切回中文', false, backZh.thrown);
  } else {
    const v = backZh.value;
    check('切回 zh 后角色标签恢复中文（回归点：曾经卡在 Deploy admin）',
      v.role === '部署管理员', '实际=' + JSON.stringify(v.role));
    check('切回 zh 后下拉项恢复中文', v.mgmt === '用户管理' && v.logout === '退出',
      'mgmt=' + JSON.stringify(v.mgmt) + ' logout=' + JSON.stringify(v.logout));
  }

  /* --- 2. 多宽度：浮层定位（挂 body / fixed / 最上层 / 视口内 / 贴头像） --- */
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(1700);
    const p = await ev(READ_MENU_GEOM);
    const tag = w + 'px';
    if (p.thrown) { check(tag + ' 几何脚本执行', false, p.thrown); continue; }
    const v = p.value;
    if (v.fatal) { check(tag + ' 头像/下拉可用', false, v.fatal); continue; }
    check(tag + ' 菜单挂在 body 上（脱离顶栏包含块）', v.parentIsBody === true, 'parentIsBody=' + v.parentIsBody);
    check(tag + ' 菜单 position:fixed', v.position === 'fixed', 'position=' + v.position);
    check(tag + ' 菜单在最上层未被遮挡', v.onTop === true, 'z=' + v.zIndex);
    check(tag + ' 顶栏无横向溢出', v.overflowX === false, 'scrollWidth=' + v.scrollW + ' vw=' + v.vw);
    check(tag + ' 头像完整在视口内', v.avatarInside === true,
      'avatar=' + Math.round(v.avatar.x) + '..' + Math.round(v.avatar.right) + ' vw=' + v.vw);
    check(tag + ' 下拉完整在视口内', v.menuInside === true,
      'menu=' + Math.round(v.menu.x) + '..' + Math.round(v.menu.right) + ' y=' + Math.round(v.menu.y) + '..' + Math.round(v.menu.bottom));
    check(tag + ' 下拉贴着头像', v.nearAvatar === true && v.overlapX === true,
      '间距=' + Math.round(v.gap) + 'px 水平重叠=' + v.overlapX);
  }

  /* --- 2b. 矮视口：菜单必须完整可见（曾经会被压出屏幕底部） --- */
  for (const w of [700, 1280]) {
    for (const hv of [300, 360, 420, 600]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: hv, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
      await sleep(1500);
      const p = await ev(READ_MENU_GEOM);
      const tag = w + 'x' + hv + '(矮)';
      if (p.thrown || (p.value && p.value.fatal)) {
        check(tag + ' 下拉可用', false, p.thrown || (p.value && p.value.fatal));
        continue;
      }
      const v = p.value;
      check(tag + ' 下拉完整在视口内', v.menuInside === true,
        'menu y=' + Math.round(v.menu.y) + '..' + Math.round(v.menu.bottom) + ' vh=' + v.vh);
      check(tag + ' 下拉贴着头像', v.nearAvatar === true && v.overlapX === true,
        '间距=' + Math.round(v.gap) + 'px');
    }
  }

  /* --- 3. 关闭后 DOM 归位 --- */
  const afterClose = await ev(READ_AFTER_CLOSE);
  if (afterClose.thrown) {
    check('关闭后 DOM 归位', false, afterClose.thrown);
  } else {
    check('关闭后下拉归位到头像容器（重渲染不丢节点）',
      afterClose.value.parentIsWrap === true, 'parentIsWrap=' + afterClose.value.parentIsWrap);
  }

  report();
}

function report() {
  console.log('\n================ 下拉浮层 + i18n 跟随自检结果 ================');
  results.forEach((item) => {
    console.log((item.ok ? 'PASS  ' : 'FAIL  ') + item.name + (item.detail ? '   → ' + item.detail : ''));
  });
  const failed = results.filter((item) => !item.ok).length;
  console.log('------------------------------------------------------------');
  console.log('共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  // 用 exitCode 而不是 process.exit()：后者会截断重定向到文件/管道的 stdout
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
}).finally(() => {
  try { if (chrome) chrome.kill(); } catch (e) { /* 忽略 */ }
});
