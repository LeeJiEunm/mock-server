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

const cdp = require('./lib/cdp');

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
const EXPECT_LANG = process.argv[5] || 'zh-CN';   // 期望的「初次访问默认语言」
let PORT = 0; // 运行时动态选空闲端口，避免连到上一轮残留的 Chrome（端口复用会导致读到旧页面）

// 覆盖溢出区间（620~886）与安全区间，外加一个手机宽度
const WIDTHS = [420, 630, 700, 780, 900, 1280];
const HEIGHT = 900;

const sleep = cdp.sleep;

/* ------------------------------ CDP 客户端 ------------------------------ */
/* 起 Chrome / 连接 / 命令超时 / 页面报错采集统一在 tools/lib/cdp.js；
 * 这里只保留 send / ev / chrome / PORT 这些旧名字（转发给 page），
 * 免得动下面所有调用点。 */
let chrome = null;
let page = null;

function send(method, params) { return page.send(method, params); }

function ev(source) { return page.ev(source); }

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
  chrome = await cdp.launchChrome({
    width: WIDTHS[WIDTHS.length - 1], height: HEIGHT,
    profilePrefix: 'mock-layout-verify-',
  });
  PORT = chrome.port;
  page = await cdp.connect(PORT);

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
  if (page) await page.close();
  if (chrome) await chrome.close();     // 顺手杀掉 Chrome + 清掉临时 profile
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  if (page) await page.close();
  if (chrome) await chrome.close();
  process.exit(2);
});
