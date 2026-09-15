#!/usr/bin/env node
'use strict';

/**
 * verify-login.js —— 控制台登录功能的「真浏览器」自检
 *
 * 为什么需要它：登录框出过三类只有真跑起来才会暴露的问题，
 *   1) 文案键漏配，界面上直接显示成 login.usernamePh 这种原始 key；
 *   2) 提交时只发了密码、没发用户名，多用户模式永远登不进去；
 *   3) 后台轮询（health / logs）每次 401 都会清空输入框并把焦点抢回用户名框，
 *      表现就是「输到一半跳到用户名」「用户名自己没了」。
 * 这三类都在这里固化成断言。
 *
 * 零依赖：Node 22 自带 WebSocket，不需要 puppeteer。
 *
 * 前置：服务端必须已开启登录保护（两种方式任选其一）
 *   MOCK_ADMIN_USER=admin MOCK_ADMIN_PASS=admin123 PORT=18080 node server.js
 *   node tools/add-user.js admin admin123 && PORT=18080 node server.js
 *
 * 用法：
 *   node tools/verify-login.js                                        # 默认 http://127.0.0.1:18080/
 *   node tools/verify-login.js http://127.0.0.1:18080/ admin admin123  # 指定地址与账号
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
let PORT = 0; // 运行时动态选空闲端口，避免连到上一轮残留的 Chrome

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

/** 在页面里跑一段脚本并取回值（返回 { value, thrown }） */
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

async function goto(url) {
  await send('Page.navigate', { url: url });
  await sleep(2000);
}

/* ------------------------------ 注入脚本 ------------------------------ */

const WAIT_MS = 12000; // 要跨过后台轮询周期（health 10s / logs 3s）

/** 读取登录层文案 + 初始焦点（中英文都跑一遍，专治漏配 key） */
const READ_LOGIN = `
const $ = (s) => document.querySelector(s);
const label = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim() : '(缺失)'; };
const hint = document.querySelector('.login-card__hint');
return {
  layerVisible: !document.querySelector('#loginLayer').hidden,
  labelUsername: label('label[for="loginUsername"]'),
  labelPassword: label('label[for="loginPassword"]'),
  phUsername: ($('#loginUsername') || {}).placeholder,
  phPassword: ($('#loginPassword') || {}).placeholder,
  submitText: label('#loginForm button[type="submit"]'),
  hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '(缺失)',
  focusOnLoad: document.activeElement ? document.activeElement.id : '',
};
`;

/** 真输入：敲用户名 → 聚焦密码 → 跨过轮询 → 看有没有被清空 / 抢焦点 */
const TYPE_AND_WAIT = `
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
$('#loginUsername').value = '${USER}';
$('#loginUsername').dispatchEvent(new Event('input', { bubbles: true }));
$('#loginPassword').focus();
$('#loginPassword').value = 'probe';
await wait(${WAIT_MS});
return {
  usernameAfterWait: $('#loginUsername').value,
  passwordAfterWait: $('#loginPassword').value,
  activeAfterWait: document.activeElement ? document.activeElement.id : '',
  layerStillVisible: !$('#loginLayer').hidden,
};
`;

/** 密码错 → 看提示与输入保留情况；密码对 → 看是否进入控制台 */
const LOGIN_WRONG_THEN_RIGHT = `
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

$('#loginPassword').value = 'definitely-wrong';
$('#loginForm').requestSubmit();
await wait(1500);
out.errorText = $('#loginError').textContent.trim();
out.layerVisibleAfterFail = !$('#loginLayer').hidden;
out.usernameAfterFail = $('#loginUsername').value;
out.passwordAfterFail = $('#loginPassword').value;
out.focusAfterFail = document.activeElement ? document.activeElement.id : '';

$('#loginUsername').value = '${USER}';
$('#loginPassword').value = '${PASS}';
$('#loginForm').requestSubmit();
await wait(1500);
out.layerVisibleAfterOk = !$('#loginLayer').hidden;
out.token = localStorage.getItem('mockServer.token') || '';

// 已登录：管理接口应 200
const health = await fetch('/_admin/health', {
  headers: { 'Authorization': 'Bearer ' + out.token },
});
out.healthStatus = health.status;

// 未登录：mock 接口必须照样能调（登录只保护控制台）
const mock = await fetch('/demo/echo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"id":"X1"}',
});
out.mockStatus = mock.status;
out.mockBody = (await mock.text()).slice(0, 120);

// 登录后跨过轮询周期，确认不会被莫名踢回登录层
await wait(${WAIT_MS});
out.layerVisibleAfterPolls = !$('#loginLayer').hidden;
return out;
`;

/* ------------------------------ 断言 ------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

function checkLoginText(prefix, r, expect) {
  check(prefix + ' 登录层弹出', r.layerVisible === true, 'layerVisible=' + r.layerVisible);
  check(prefix + ' 用户名标签=' + expect.username, r.labelUsername === expect.username, r.labelUsername);
  check(prefix + ' 密码标签=' + expect.password, r.labelPassword === expect.password, r.labelPassword);
  check(prefix + ' 用户名占位=' + expect.usernamePh, r.phUsername === expect.usernamePh, r.phUsername);
  check(prefix + ' 密码占位=' + expect.passwordPh, r.phPassword === expect.passwordPh, r.phPassword);
  check(prefix + ' 按钮文案=' + expect.submit, r.submitText === expect.submit, r.submitText);
  check(prefix + ' 初始焦点在用户名', r.focusOnLoad === 'loginUsername', r.focusOnLoad);
  check(prefix + ' 未出现原始 key', String(r.labelUsername).indexOf('login.') !== 0
    && String(r.phUsername).indexOf('login.') !== 0
    && String(r.phPassword).indexOf('login.') !== 0, r.labelUsername + ' / ' + r.phUsername);
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-login-verify-'));
  PORT = await getFreePort();
  chrome = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await attach();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  console.log('目标：' + BASE + '   账号：' + USER + ' / ' + (PASS ? '***' : '(空)'));

  /* --- 1. 中文文案 --- */
  await goto(BASE + '?t=' + Date.now());
  const cn = await ev(READ_LOGIN);
  if (cn.thrown) { check('中文文案脚本执行', false, cn.thrown); } else {
    checkLoginText('中文', cn.value, {
      username: '用户名', password: '密码',
      usernamePh: '管理员用户名', passwordPh: '管理员密码', submit: '登录',
    });
  }

  /* --- 2. 英文文案 --- */
  await ev("localStorage.setItem('mockServer.lang', 'en');");
  await goto(BASE + '?t=' + Date.now());
  const en = await ev(READ_LOGIN);
  if (en.thrown) { check('英文文案脚本执行', false, en.thrown); } else {
    checkLoginText('英文', en.value, {
      username: 'Username', password: 'Password',
      usernamePh: 'Username', passwordPh: 'Password', submit: 'Log in',
    });
  }

  /* --- 3. 输入不被清空、焦点不被抢 --- */
  await ev("localStorage.setItem('mockServer.lang', 'zh-CN');");
  await goto(BASE + '?t=' + Date.now());
  const typed = await ev(TYPE_AND_WAIT);
  if (typed.thrown) { check('输入保持脚本执行', false, typed.thrown); } else {
    const t = typed.value;
    check('轮询后用户名未被清空', t.usernameAfterWait === USER, '值=' + JSON.stringify(t.usernameAfterWait));
    check('轮询后密码未被清空', t.passwordAfterWait === 'probe', '值=' + JSON.stringify(t.passwordAfterWait));
    check('轮询后焦点仍在密码框', t.activeAfterWait === 'loginPassword', '焦点=' + t.activeAfterWait);
    check('轮询后登录层仍在', t.layerStillVisible === true, 'layerVisible=' + !t.layerStillVisible);
  }

  /* --- 4. 登录：先错后对 + 边界 --- */
  const res = await ev(LOGIN_WRONG_THEN_RIGHT);
  if (res.thrown) { check('登录流程脚本执行', false, res.thrown); } else {
    const r = res.value;
    check('密码错有中文提示', r.errorText === '用户名或密码错误', r.errorText);
    check('密码错后登录层不关', r.layerVisibleAfterFail === true, 'layerVisible=' + r.layerVisibleAfterFail);
    check('密码错后保留用户名', r.usernameAfterFail === USER, '值=' + JSON.stringify(r.usernameAfterFail));
    check('密码错后清空密码', r.passwordAfterFail === '', '值=' + JSON.stringify(r.passwordAfterFail));
    check('密码错后焦点回密码框', r.focusAfterFail === 'loginPassword', '焦点=' + r.focusAfterFail);
    check('正确账号密码可进入控制台', r.layerVisibleAfterOk === false, 'layerVisible=' + r.layerVisibleAfterOk);
    check('拿到 token', !!r.token, '长度=' + String(r.token).length);
    check('带 token 访问管理接口 200', r.healthStatus === 200, 'status=' + r.healthStatus);
    check('mock 接口免登录可调 200', r.mockStatus === 200, 'status=' + r.mockStatus + ' body=' + r.mockBody);
    check('登录后跨轮询周期不被踢回', r.layerVisibleAfterPolls === false, 'layerVisible=' + r.layerVisibleAfterPolls);
  }

  /* --- 输出 --- */
  console.log('\n================ 登录功能自检结果 ================');
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
