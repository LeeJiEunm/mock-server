#!/usr/bin/env node
'use strict';

/**
 * tools/lib/cdp.js —— 无头 Chrome 的公共客户端（零依赖，Node ≥ 22 自带 WebSocket）
 *
 * 为什么要有它：
 *   tools/ 下原本有 30 多个脚本各自复制一套「起 Chrome → 连调试端口 → send/ev → 收尾」
 *   的样板（每个 40~80 行，合计两千多行）。复制粘贴的代价不是行数，而是：
 *   每个坑都只修在其中一份里，其余的脚本继续带着老毛病跑 —— 例如
 *     · 固定调试端口：上一轮 Chrome 没杀干净时，新脚本会连到**旧页面**上，
 *       断言结果随残留进程飘（所以这里一律用 getFreePort() 现取空闲端口）；
 *     · 不清理 HTTP_PROXY：本机有代理时，Chrome 的调试请求可能被代理拦掉，
 *       表现为「连不上 127.0.0.1」（所以 launchChrome 默认把代理变量清空）；
 *     · 拿不到「页面里的 JS 报错」：只做 eval 的脚本看不到异常，
 *       前端一崩就只剩「元素找不到」，排查方向完全错。
 *
 * 谁该用它：tools/ 下新增的脚本，以及 README 里列出、需要长期维护的那批
 *   （verify-*.js / shot-*.js / screenshot-themes.js / fps-probe.js）。
 *   tools/probe-*.js、repro-*.js 等是历史上针对某次问题的**一次性排查脚本**，
 *   保留原样（它们依赖当时特定的服务端状态才能复现，重写反而没法验证）。
 *
 * 用法（最小示例）：
 *   const cdp = require('./lib/cdp');
 *   const chrome = await cdp.launchChrome({ width: 1440, height: 900 });
 *   const page = await cdp.connect(chrome.port, { captureErrors: true });
 *   await page.goto('http://127.0.0.1:18080/', { waitMs: 2200 });
 *   const got = await page.ev('return document.title;');
 *   console.log(got.value, page.errors());
 *   await page.shot('/tmp/console.png');
 *   await page.close();
 *   await chrome.close();          // 内置杀进程 + 删临时 profile
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/* 按优先级找浏览器；CHROME_BIN 优先，便于 CI 里指向 npx playwright 装的那份 */
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((file) => { try { return fs.existsSync(file); } catch (e) { return false; } });
  if (!hit) {
    throw new Error('找不到 Chrome / Chromium，可用 CHROME_BIN=/path/to/chrome 指定。已尝试：\n  ' + CHROME_CANDIDATES.join('\n  '));
  }
  return hit;
}

/** 现取一个空闲端口（不要写死端口：残留的 Chrome 会让新脚本连到旧页面） */
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

/** 等一个条件成立（轮询），超时抛错 */
async function retry(fn, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  const intervalMs = o.intervalMs || 200;
  const label = o.label || '条件';
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (e) { last = e && e.message ? e.message : String(e); }
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeoutMs + 'ms）：' + label + (last === null ? '' : '，最后结果：' + JSON.stringify(last)));
    await sleep(intervalMs);
  }
}

/**
 * 起一个无头 Chrome 并等调试端口就绪。
 * opts: { width, height, port, args, keepProfile, quiet }
 * 返回 { child, port, profile, close() }
 */
async function launchChrome(opts) {
  const o = opts || {};
  const port = o.port || await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), (o.profilePrefix || 'cdp-') + 'profile-'));

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
  ];
  if (o.width && o.height) args.push('--window-size=' + o.width + ',' + o.height);
  args.push('about:blank');
  if (o.args) args.push.apply(args, o.args);

  /* 清掉代理变量：本机开着 HTTP_PROXY 时，Chrome 对 127.0.0.1 的探测可能被代理接走，
   * 症状是「调试端口没起来」而实际是代理拦了。 */
  const env = Object.assign({}, process.env, {
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });

  const child = spawn(findChrome(), args, { stdio: 'ignore', env: env });
  child.on('error', () => { /* 交给下面的等待逻辑报错 */ });

  try {
    await retry(async () => {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      return res.ok;
    }, { timeoutMs: 20000, intervalMs: 250, label: 'Chrome 调试端口 ' + port });
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (e2) { /* ignore */ }
    throw e;
  }

  return {
    child: child,
    port: port,
    profile: profile,
    close: async () => {
      try { child.kill('SIGKILL'); } catch (e) { /* 已经退了 */ }
      if (!o.keepProfile) {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 删不掉就留着 */ }
      }
    },
  };
}

/**
 * 连到已就绪的 Chrome 页面目标。
 * opts: { captureErrors: true 时采集页面 JS 异常与 console.error }
 * 返回 session（见文件头的最小示例）。
 */
async function connect(port, opts) {
  const o = opts || {};

  const wsUrl = await retry(async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/json/list');
    if (!res.ok) return null;
    const list = await res.json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return page ? page.webSocketDebuggerUrl : null;
  }, { timeoutMs: 20000, intervalMs: 250, label: 'Chrome 页面目标' });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  let msgId = 0;
  const pending = new Map();
  const errors = [];
  const listeners = [];

  /* 单条 CDP 命令的超时。**必须挂**：Chrome 中途崩溃 / 断开时，不挂超时的话
   * 这个 Promise 会永久 pending，事件循环变空 → Node 静默退出 0，
   * 输出只剩开头一行，看起来像「全绿通过」，其实一项都没跑（2026-09-15 实际踩到过）。
   * 挂上超时后定时器让事件循环保持活跃，必定报出明确错误，不再伪装成功。 */
  const CMD_TIMEOUT_MS = o.commandTimeoutMs || 30000;

  ws.addEventListener('message', (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(entry.method + ': ' + JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    listeners.forEach((fn) => fn(msg));
  });

  function send(method, params) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const entry = { resolve: resolve, reject: reject, method: method, timer: null };
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(method + ' 超时 ' + CMD_TIMEOUT_MS + 'ms（Chrome 可能已崩溃 / 断开）'));
      }, CMD_TIMEOUT_MS);
      pending.set(id, entry);
      try {
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(e);
      }
    });
  }

  /* 采集页面侧错误：不打这些事件，前端一崩只会表现为「元素找不到」，
   * 排查方向会完全跑偏（本次拆前端脚本就是靠它确认了「一个错都没有」）。 */
  if (o.captureErrors !== false) {
    listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        errors.push({ kind: 'exception', text: d && d.text, detail: d && d.exception && d.exception.description });
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        const text = (msg.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
        errors.push({ kind: 'console.error', text: text });
      } else if (msg.method === 'Log.entryAdded' && msg.params && msg.params.entry && msg.params.entry.level === 'error') {
        errors.push({ kind: 'log.error', text: msg.params.entry.text, url: msg.params.entry.url });
      }
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable').catch(() => { /* 个别目标不支持，不影响其它能力 */ });

  const session = {
    wsUrl: wsUrl,

    send: send,

    /** 在页面里执行一段「函数体」源码，自动包成 async IIFE；不抛异常，返回 {value, thrown} */
    ev: async (source) => {
      const out = await send('Runtime.evaluate', {
        expression: '(async () => {' + source + '})()',
        awaitPromise: true,
        returnByValue: true,
      });
      return {
        value: out && out.result ? out.result.value : null,
        thrown: out && out.exceptionDetails ? out.exceptionDetails.text : null,
      };
    },

    /** 需要「出错就抛」时用它 */
    evaluate: async (source) => {
      const r = await session.ev(source);
      if (r.thrown) throw new Error(r.thrown);
      return r.value;
    },

    /**
     * 按「表达式」求值 —— 与 ev() 的区别很关键：
     *   ev('return document.title;')      函数体语义（里面要自己 return）
     *   evalExpr('document.title')        表达式语义（值本身就是结果）
     * 混用会静默拿到 undefined：把表达式塞进函数体里，末尾那个值是不会被返回的。
     */
    evalExpr: async (expression) => {
      const out = await send('Runtime.evaluate', {
        expression: expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (out && out.exceptionDetails) throw new Error('页面脚本报错：' + JSON.stringify(out.exceptionDetails));
      return out ? out.result.value : undefined;
    },

    goto: async (url, o2) => {
      const wait = (o2 && o2.waitMs) !== undefined ? o2.waitMs : 1500;
      await send('Page.navigate', { url: url });
      if (wait) await sleep(wait);
      return true;
    },

    /** 轮询页面里的表达式，直到为真；超时抛错 */
    waitFor: async (expr, o2) => retry(async () => {
      const r = await session.ev('return (' + expr + ');');
      return r.value;
    }, Object.assign({ label: expr }, o2)),

    viewport: async (width, height, o2) => send('Emulation.setDeviceMetricsOverride', {
      width: width,
      height: height,
      deviceScaleFactor: (o2 && o2.deviceScaleFactor) || 1,
      mobile: !!(o2 && o2.mobile),
    }),

    /** 截当前页面，返回 base64 字符串 */
    screenshot: async (o2) => {
      const out = await send('Page.captureScreenshot', Object.assign({ format: 'png' }, o2 || {}));
      return out.data;
    },

    /** 截图落盘（自动建目录） */
    shot: async (file, o2) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = await session.screenshot(o2);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },

    /** 采集到的页面错误列表（captureErrors 为真时） */
    errors: () => errors.slice(),

    clearErrors: () => { errors.length = 0; },

    /**
     * 订阅原始 CDP 事件（收到的是解析后的消息对象）。
     * 用它是为了替代脚本里 `ws.addEventListener('message', …)` 的老写法 ——
     * 有些自检要在「某一段窗口期」内自己收集控制台错误 / 异常，
     * 直接删掉那段逻辑会改变断言语义，所以这里保留一个原样透出的入口。
     * 返回取消订阅的函数。
     */
    on: (fn) => {
      listeners.push(fn);
      return () => {
        const at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },

    waitForLoad: async (timeoutMs) => retry(async () => {
      const r = await session.ev('return document.readyState === "complete";');
      return r.value;
    }, { timeoutMs: timeoutMs || 15000, label: '页面加载完成' }),

    close: async () => {
      try { ws.close(); } catch (e) { /* ignore */ }
    },
  };

  return session;
}

module.exports = {
  CHROME_CANDIDATES: CHROME_CANDIDATES,
  findChrome: findChrome,
  getFreePort: getFreePort,
  sleep: sleep,
  retry: retry,
  launchChrome: launchChrome,
  connect: connect,
};
