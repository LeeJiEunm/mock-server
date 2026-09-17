#!/usr/bin/env node
'use strict';

// verify-mock-limits.js — pin three behaviours that used to be either broken
// or unbounded on the mock side (not the admin side):
//
//   1. proxy inheritance — an api whose own proxy.url is empty must reach its
//      group's upstream. proxyPass used to read api.proxy.url directly, so the
//      request died with 502 "代理地址不合法：" even though handleMock had
//      already decided (via effectiveProxyUrl) that proxying was on.
//   2. delay cap — delayMs / delayMaxMs are clamped to MAX_DELAY_MS (default
//      30s). A config carrying "wait an hour" used to hold the connection for
//      an hour; the clamp lives in normalizeResponse so the number the console
//      shows is the number the server actually waits.
//   3. held-request cap — at most MAX_HELD_REQUESTS requests may hold a socket
//      at once (delay + the timeout fault). Beyond that the mock answers 503
//      with the reason instead of queueing, because fd exhaustion takes the
//      admin UI down with it.
//   4. log body cap — the copy kept in the request log is clamped to
//      LOG_BODY_LIMIT (default 100KB) while the body handed back to the caller
//      stays complete. Multi-byte characters must survive the byte-level cut.
//   5. method matching — same path can hold separate GET/POST/ALL entries.
//
// Usage:  node tools/verify-mock-limits.js
// Exit 0 when every assertion passes, 1 otherwise. Zero dependencies, no
// browser. Boots throwaway instances in a temp sandbox: the repository
// config.json is never read or written.
//
// The sandbox shrinks every knob (400ms delay cap, 1.2s fault hold, 2 held
// requests) so the suite stays under a few seconds. The *default* values are
// asserted separately by booting one instance with no overrides at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { tempDir, seedServer } = require('./lib/sandbox');
const SERVER_SRC = path.join(ROOT, 'server.js');

/* server.js resolves its config as path.join(__dirname, 'config.json'), so the
 * copy we run MUST live next to the config we write. Booting the repository
 * copy would read (and, on this script's behalf, never write) the real
 * config.json. Guarded statically here and re-checked at runtime below.
 * seedServer() also brings lib/ along — server.js requires it since the split. */
const SANDBOX_MARK = 'verify-mock-limits-sandbox';
const SANDBOX_API_COUNT = 12;
const SANDBOX = seedServer(tempDir('mock-limits-verify-'), { publicMinimal: true });
const SANDBOX_SERVER = path.join(SANDBOX, 'server.js');
if (path.dirname(SANDBOX_SERVER) !== SANDBOX) {
  throw new Error('harness bug: the server we spawn must live inside the sandbox');
}

// Sandbox knobs (kept small purely so this suite runs in seconds).
const MAX_DELAY = 400;          // MOCK_MAX_DELAY_MS
const FAULT_HOLD = 1200;        // MOCK_FAULT_TIMEOUT_MS
const MAX_HELD = 2;             // MOCK_MAX_HELD_REQUESTS
const OVER_DELAY = 3600000;     // "an hour" — must come out capped
const DEFAULT_MAX_DELAY = 30000;  // the documented default, asserted in part D
const DEFAULT_MAX_HELD = 50;      // the documented default, asserted in part D
const CLIENT_TIMEOUT_MS = 10000;  // ceiling on the client side, see request()

/* Log body cap (part E). Deliberately multi-byte: a naive byte-level cut would
 * leave a replacement character at the end, and that must NOT happen.
 *
 * The sandbox limit is 2002 on purpose: BIG_TEXT repeats a 23-byte unit, and
 * 2002 % 23 === 1, so the cut lands INSIDE the 3-byte 「测」. A round number
 * like 2000 (2000 % 23 === 22, i.e. inside plain ASCII) would sit exactly on a
 * character boundary and the "no broken character" assertion would pass even
 * with the naive implementation. Part E re-proves this at runtime. */
const SANDBOX_LOG_LIMIT = 2002;             // MOCK_LOG_BODY_LIMIT
const DEFAULT_LOG_LIMIT = 100 * 1024;       // the documented default, asserted in part D
const BIG_UNIT = '测试字符串🎯abc-';          // 23 bytes: 5×3 + 4 + 4
const BIG_TEXT = BIG_UNIT.repeat(9000);     // ≈ 207KB, well past both caps
const BIG_BYTES = Buffer.byteLength(BIG_TEXT, 'utf8');

let checks = 0;
let failures = 0;

function expect(label, ok, detail) {
  checks++;
  if (ok) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + (detail ? '\n         → got ' + detail : ''));
}

function note(label) {
  console.log('\n' + label);
}

/* ------------------------------------------------------------ toy upstream */

/** Stands in for the real service: echoes what it was asked for, so the test
 *  can tell WHICH upstream was hit and with which path. */
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // A large upstream body: proxyPass used to buffer it whole and hand the
      // whole thing to addLog, so the log ring grew with the upstream payload.
      if ((req.url || '').indexOf('big-proxy') >= 0) {
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=UTF-8' });
        res.end(BIG_TEXT);
        return;
      }
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ upstream: true, path: req.url, method: req.method, body: data }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* --------------------------------------------------------------- sandbox io */

function writeConfig(upstreamPort) {
  const echo = (body) => ({
    mode: 'static',
    status: 200,
    delayMs: 0,
    delayMaxMs: 0,
    fault: 'none',
    contentType: 'application/json;charset=UTF-8',
    body: body,
    script: '',
  });
  const cfg = {
    server: {},
    logSize: 200,
    meta: { projectName: SANDBOX_MARK },
    groups: [{ id: 'g1', name: 'group with upstream', proxyUrl: 'http://127.0.0.1:' + upstreamPort + '/up' }],
    apis: [
      // 1 — proxy on, own URL empty: must inherit the group's upstream
      {
        id: 'a1', name: 'inherit', module: 'demo', path: 'inherit', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: true, url: '' }, rules: [], defaultResponse: echo('{"via":"rules"}'),
      },
      // 2 — own URL set: must win over the group's
      {
        id: 'a2', name: 'own', module: 'demo', path: 'own', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: true, url: 'http://127.0.0.1:' + upstreamPort }, rules: [], defaultResponse: echo('{"via":"rules"}'),
      },
      // 3 — delay of an hour: must be clamped
      {
        id: 'a3', name: 'delay', module: 'demo', path: 'delay', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: false, url: '' }, rules: [],
        defaultResponse: Object.assign(echo('{"slow":true}'), { delayMs: OVER_DELAY, delayMaxMs: OVER_DELAY * 2 }),
      },
      // 4 — timeout fault: holds a socket for FAULT_HOLD, then cuts it
      {
        id: 'a4', name: 'hold', module: 'demo', path: 'hold', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: false, url: '' }, rules: [],
        defaultResponse: Object.assign(echo('{"held":true}'), { fault: 'timeout' }),
      },
      // 5 — plain mock, used as a control
      {
        id: 'a5', name: 'fast', module: 'demo', path: 'fast', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: false, url: '' }, rules: [], defaultResponse: echo('{"fast":true}'),
      },
      // 6 — proxy on but no URL anywhere: must fall through to the rules, not proxy
      {
        id: 'a6', name: 'no-upstream', module: 'demo', path: 'no-upstream', enabled: true, groupId: '', vars: {},
        proxy: { enable: true, url: '' }, rules: [], defaultResponse: echo('{"via":"rules","why":"no-upstream"}'),
      },
      // 7 — proxy on with a garbage URL: the 502 message must name the URL it tried
      {
        id: 'a7', name: 'bad-url', module: 'demo', path: 'bad-url', enabled: true, groupId: '', vars: {},
        proxy: { enable: true, url: 'not-a-url' }, rules: [], defaultResponse: echo('{"via":"rules"}'),
      },
      // 8 — static response far larger than the log body cap
      {
        id: 'a8', name: 'big-static', module: 'demo', path: 'big-static', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: false, url: '' }, rules: [],
        defaultResponse: Object.assign(echo(BIG_TEXT), { contentType: 'text/plain;charset=UTF-8' }),
      },
      // 9 — proxy whose upstream answers with a far larger body than the cap
      {
        id: 'a9', name: 'big-proxy', module: 'demo', path: 'big-proxy', enabled: true, groupId: 'g1', vars: {},
        proxy: { enable: true, url: '' }, rules: [], defaultResponse: echo('{"via":"rules"}'),
      },
      // 10-12 — same path but different method: GET/POST hit their own, DELETE falls through to ALL
      {
        id: 'a10', name: 'method-get', module: 'demo', path: 'method', method: 'GET', enabled: true, groupId: '', vars: {},
        proxy: { enable: false, url: '' }, rules: [], defaultResponse: echo('{"via":"get"}'),
      },
      {
        id: 'a11', name: 'method-post', module: 'demo', path: 'method', method: 'POST', enabled: true, groupId: '', vars: {},
        proxy: { enable: false, url: '' }, rules: [], defaultResponse: echo('{"via":"post"}'),
      },
      {
        id: 'a12', name: 'method-all', module: 'demo', path: 'method', method: 'ALL', enabled: true, groupId: '', vars: {},
        proxy: { enable: false, url: '' }, rules: [], defaultResponse: echo('{"via":"all"}'),
      },
    ],
  };
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function request(port, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  let body = null;
  if (o.body !== undefined) {
    body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method || 'GET', path: pathname, headers },
      (res) => {
        /* 必须先收齐 Buffer 再整体解码：逐块 `data += chunk` 会在块边界
         * 切开多字节字符（本用例的 body 满是中文和 emoji），解出来的字节数
         * 会比真实响应长 —— 那是量法的错，不是被测对象的错。 */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, body: data, bytes: Buffer.byteLength(data, 'utf8'), json, ms: Date.now() - started });
        });
      }
    );
    /* Client-side ceiling: if the delay cap is ever removed again, the /demo/delay
     * assertion must FAIL in seconds instead of hanging this suite for an hour. */
    req.setTimeout(CLIENT_TIMEOUT_MS, () => req.destroy(new Error('client timeout after ' + CLIENT_TIMEOUT_MS + 'ms')));
    req.on('error', (e) => resolve({ status: 0, body: '', bytes: 0, json: null, error: e.code || e.message, ms: Date.now() - started }));
    if (body !== null) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot one throwaway instance; resolve once the main port answers at all. */
async function boot(mainPort, extraEnv) {
  const env = Object.assign({}, process.env, {
    PORT: String(mainPort),
    READONLY_PORT: '',
    MOCK_ADMIN_USER: '',
    MOCK_ADMIN_PASS: '',
    MOCK_DEFAULT_LANG: '',
    MOCK_SEED: '',
    MOCK_FAULT_TIMEOUT_MS: '',
    MOCK_MAX_DELAY_MS: '',
    MOCK_MAX_HELD_REQUESTS: '',
    MOCK_LOG_BODY_LIMIT: '',
  }, extraEnv || {});
  const child = spawn(process.execPath, [SANDBOX_SERVER], { cwd: SANDBOX, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 120; i++) {
    const r = await request(mainPort, '/_admin/health');
    if (r.status !== 0) return { child, log: () => log };
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('server never came up. log:\n' + log);
}

async function stop(srv) {
  try {
    srv.child.kill('SIGKILL');
  } catch (e) {}
  await sleep(120);
}

/** Runtime hard guard: refuse to assert against an instance that is not ours.
 *  An earlier harness in this repo booted the repository server.js by mistake
 *  and its POST /_admin/config assertion overwrote the real config.json. */
async function assertSandboxIdentity(port) {
  const r = await request(port, '/_admin/config');
  const mark = r.json && r.json.meta ? r.json.meta.projectName : undefined;
  const count = r.json && Array.isArray(r.json.apis) ? r.json.apis.length : -1;
  if (r.status !== 200 || mark !== SANDBOX_MARK || count !== SANDBOX_API_COUNT) {
    console.error('\n✗ REFUSING TO RUN — the instance under test is not the sandbox.');
    console.error('  expected meta.projectName="' + SANDBOX_MARK + '" and ' + SANDBOX_API_COUNT + ' api(s),');
    console.error('  got projectName=' + JSON.stringify(mark) + ', apis=' + count + ', HTTP ' + r.status);
    console.error('  Nothing was written. server.js locates its config as path.join(__dirname, "config.json").');
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (e) {}
    process.exit(1);
  }
  return r.json;
}

const apiFrom = (cfg, id) => (cfg.apis || []).find((a) => a.id === id) || {};

/* ------------------------------------------------- A. proxy inheritance (#1) */
async function partProxy(port) {
  note('A. 代理上游继承 — 接口 URL 留空时走分组默认上游');

  const inherit = await request(port, '/demo/inherit', { method: 'POST', body: { n: 1 } });
  expect(
    'POST /demo/inherit（自身 URL 留空、分组有上游）→ 200 且真的打到了分组上游',
    inherit.status === 200 && !!inherit.json && inherit.json.upstream === true,
    inherit.status + ' ' + inherit.body
  );
  expect(
    '回源路径 = 分组上游的 basePath + 接口路径（/up/inherit）',
    !!inherit.json && inherit.json.path === '/up/inherit',
    inherit.json ? inherit.json.path : inherit.body
  );
  expect(
    '请求体与请求方法原样透传',
    !!inherit.json && inherit.json.method === 'POST' && inherit.json.body === '{"n":1}',
    inherit.json ? inherit.json.method + ' ' + inherit.json.body : inherit.body
  );

  const own = await request(port, '/demo/own', { method: 'POST', body: {} });
  expect(
    'POST /demo/own（自己填了 URL）→ 用接口自己的地址，不继承分组',
    own.status === 200 && !!own.json && own.json.path === '/own',
    own.status + ' ' + own.body
  );

  const none = await request(port, '/demo/no-upstream', { method: 'POST', body: {} });
  expect(
    'POST /demo/no-upstream（接口与分组都没填）→ 不代理，走规则兜底响应',
    none.status === 200 && !!none.json && none.json.via === 'rules',
    none.status + ' ' + none.body
  );

  const bad = await request(port, '/demo/bad-url', { method: 'POST', body: {} });
  expect(
    'POST /demo/bad-url → 502，且报错里写明实际尝试的地址',
    bad.status === 502 && bad.body.indexOf('not-a-url') >= 0,
    bad.status + ' ' + bad.body
  );
}

/* -------------------------------------------------------- B. delay cap (#7) */
async function partDelay(port) {
  note('B. 延迟上限 — 配置里写 1 小时，配置层与真实等待都被夹住');

  const cfg = await request(port, '/_admin/config');
  const slow = apiFrom(cfg.json || {}, 'a3').defaultResponse || {};
  expect(
    '读回配置：delayMs 3600000 → ' + MAX_DELAY + '（夹在配置层，界面显示 = 实际等待）',
    slow.delayMs === MAX_DELAY,
    JSON.stringify(slow.delayMs)
  );
  expect(
    '读回配置：delayMaxMs 7200000 → ' + MAX_DELAY + '（区间两个端点都夹）',
    slow.delayMaxMs === MAX_DELAY,
    JSON.stringify(slow.delayMaxMs)
  );

  const before = Date.now();
  const r = await request(port, '/demo/delay');
  const waited = Date.now() - before;
  expect(
    'GET /demo/delay → 200，且真实等待 ≈ ' + MAX_DELAY + 'ms（不是 1 小时）',
    r.status === 200 && waited >= MAX_DELAY - 40 && waited < MAX_DELAY * 4,
    r.status + '，实测 ' + waited + 'ms'
  );

  const fast = await request(port, '/demo/fast');
  expect('GET /demo/fast（无延迟）→ 200，未被上面的延迟波及', fast.status === 200 && !!fast.json && fast.json.fast === true, fast.status + ' ' + fast.body);
}

/* ----------------------------------------------- C. held-request cap (补 3) */
async function partHeld(port) {
  note('C. 挂起并发上限 — 同时挂住的连接数到顶后直接 503，不排队');

  // Two requests meant to sit on the timeout fault for FAULT_HOLD ms.
  const held1 = request(port, '/demo/hold');
  const held2 = request(port, '/demo/hold');
  await sleep(250);   // let both enter the hold

  const third = await request(port, '/demo/hold');
  expect(
    '第 ' + (MAX_HELD + 1) + ' 个挂起请求 → 503（到顶后不排队）',
    third.status === 503,
    third.status + ' ' + third.body
  );
  expect(
    '503 消息写明「已达上限」并给出上限值，联调方一眼知道原因',
    third.body.indexOf('上限') >= 0 && third.body.indexOf(String(MAX_HELD)) >= 0,
    third.body
  );

  const first = await held1;
  const second = await held2;
  expect(
    '前 ' + MAX_HELD + ' 个请求照常挂起，到点被断开（客户端拿到错误而不是 200）',
    first.status === 0 && second.status === 0,
    'status1=' + first.status + '/' + first.error + ' status2=' + second.status + '/' + second.error
  );

  await sleep(300);   // let the counter come back down

  const after = await request(port, '/demo/hold');
  expect(
    '挂起结束后计数归零：再来一个仍然照常挂起，而不是永久 503',
    after.status === 0,
    'status=' + after.status + ' ' + after.body
  );

  const logs = await request(port, '/_admin/logs?apiId=a4&limit=200');
  const items = (logs.json && logs.json.items) || [];
  const rejected = items.filter((row) => row.holdRejected === true);
  expect(
    '被拒绝的那次进了请求日志（holdRejected=true），排障时能看到，不是静默丢弃',
    rejected.length === 1 && rejected[0].status === 503,
    'holdRejected 条数=' + rejected.length
  );
  const heldRows = items.filter((row) => row.fault === 'timeout' && row.holdRejected !== true);
  expect(
    '真正挂起的那几次也各有日志（故障挂起必须可观测）',
    heldRows.length === 3,
    '挂起日志条数=' + heldRows.length
  );
}

/* -------------------------------------------------- E. log body cap (100KB) */
async function partLogBody(port) {
  note('E. 日志体量上限 — 日志里只留 ' + SANDBOX_LOG_LIMIT + 'B，回给调用方的 body 仍然完整');

  const bigStatic = await request(port, '/demo/big-static');
  expect(
    'GET /demo/big-static（约 ' + Math.round(BIG_BYTES / 1024) + 'KB）→ 调用方拿到的是**完整** body',
    bigStatic.status === 200 && bigStatic.bytes === BIG_BYTES,
    bigStatic.status + '，收到 ' + bigStatic.bytes + 'B（期望 ' + BIG_BYTES + 'B）'
  );

  const logs = await request(port, '/_admin/logs?apiId=a8&limit=10');
  const row = ((logs.json && logs.json.items) || [])[0] || {};
  expect(
    '日志里带 respBodyTruncated 标记（界面据此提示「你看到的是半份」）',
    !!row.respBodyTruncated,
    JSON.stringify(row.respBodyTruncated)
  );
  expect(
    '标记 kept = ' + SANDBOX_LOG_LIMIT + '（实际留在日志里的字节数）',
    !!row.respBodyTruncated && row.respBodyTruncated.kept === SANDBOX_LOG_LIMIT,
    JSON.stringify(row.respBodyTruncated)
  );
  expect(
    '标记 total = ' + BIG_BYTES + '（原始完整长度，不是截断后的长度）',
    !!row.respBodyTruncated && row.respBodyTruncated.total === BIG_BYTES,
    JSON.stringify(row.respBodyTruncated)
  );
  const loggedBytes = Buffer.byteLength(row.respBody || '', 'utf8');
  expect(
    '日志里那份 body 确实被夹短了（远小于原文）',
    loggedBytes > 0 && loggedBytes < BIG_BYTES / 10,
    loggedBytes + 'B vs 原文 ' + BIG_BYTES + 'B'
  );
  expect(
    '正文末尾带肉眼可见的截断说明（不靠 flag 也能看出来）',
    (row.respBody || '').indexOf('日志已截断') >= 0,
    (row.respBody || '').slice(-90)
  );
  /* 先自证这个用例真的踩在多字节字符上：朴素实现（直接 subarray + toString）
   * 在这个截断点会产出 U+FFFD。若这条挂了，说明上限选到了字符边界上，
   * 下面那条「没切坏字符」的断言就是在碰运气，得先改上限。 */
  const naiveCut = Buffer.from(BIG_TEXT, 'utf8').subarray(0, SANDBOX_LOG_LIMIT).toString('utf8');
  expect(
    '本用例的截断点确实落在多字节字符内部（否则下面那条断言是碰巧通过的）',
    naiveCut.indexOf('\uFFFD') >= 0,
    '朴素切法也没产生替换字符 → 上限 ' + SANDBOX_LOG_LIMIT + ' 选到了字符边界，本断言失去意义'
  );
  expect(
    '按字节切断不会切坏多字节字符（正文里没有 U+FFFD 替换字符）',
    (row.respBody || '').indexOf('\uFFFD') < 0,
    '正文里出现了替换字符'
  );

  const bigProxy = await request(port, '/demo/big-proxy');
  expect(
    'GET /demo/big-proxy（上游返回约 ' + Math.round(BIG_BYTES / 1024) + 'KB）→ 调用方同样拿到完整 body',
    bigProxy.status === 200 && bigProxy.bytes === BIG_BYTES,
    bigProxy.status + '，收到 ' + bigProxy.bytes + 'B（期望 ' + BIG_BYTES + 'B）'
  );
  const proxyLogs = await request(port, '/_admin/logs?apiId=a9&limit=10');
  const proxyRow = ((proxyLogs.json && proxyLogs.json.items) || [])[0] || {};
  expect(
    '代理透传的日志走同一处夹取：同样被截断，total 仍是上游原文长度',
    !!proxyRow.respBodyTruncated && proxyRow.respBodyTruncated.total === BIG_BYTES
      && proxyRow.respBodyTruncated.kept === SANDBOX_LOG_LIMIT,
    JSON.stringify(proxyRow.respBodyTruncated)
  );

  const small = await request(port, '/demo/fast');
  const fastLogs = await request(port, '/_admin/logs?apiId=a5&limit=10');
  const fastRow = ((fastLogs.json && fastLogs.json.items) || [])[0] || {};
  expect(
    '小响应（未超限）不带标记，日志里的 body 与返回给调用方的完全一致',
    small.status === 200 && !fastRow.respBodyTruncated && fastRow.respBody === small.body,
    JSON.stringify(fastRow.respBody)
  );

  const bigReq = await request(port, '/demo/fast', { method: 'POST', body: BIG_TEXT });
  expect('POST 一个超大请求体 → 请求本身照常处理（200）', bigReq.status === 200, bigReq.status + ' ' + bigReq.body);
  const reqLogs = await request(port, '/_admin/logs?apiId=a5&limit=10');
  const reqRow = ((reqLogs.json && reqLogs.json.items) || [])[0] || {};
  expect(
    '请求体走同一个上限：reqBodyTruncated.kept = ' + SANDBOX_LOG_LIMIT + '（收下 8MB 后不能让日志跟着涨）',
    !!reqRow.reqBodyTruncated && reqRow.reqBodyTruncated.kept === SANDBOX_LOG_LIMIT
      && reqRow.reqBodyTruncated.total === BIG_BYTES,
    JSON.stringify(reqRow.reqBodyTruncated)
  );
  expect(
    '同一次请求的响应体很小，不该被顺带标记',
    !reqRow.respBodyTruncated,
    JSON.stringify(reqRow.respBodyTruncated)
  );
}

/* ----------------------------------------------------- D. defaults, no env */
async function partDefaults() {
  note('D. 默认值（不传任何环境变量）— 与文档里写的数字一致');

  const port = await freePort();
  writeConfig(0);   // upstream 0 is never called in this part
  const srv = await boot(port, { MOCK_FAULT_TIMEOUT_MS: '2000' });
  try {
    await assertSandboxIdentity(port);

    const cfg = await request(port, '/_admin/config');
    const slow = apiFrom(cfg.json || {}, 'a3').defaultResponse || {};
    expect(
      'MOCK_MAX_DELAY_MS 未设时，延迟上限默认 ' + DEFAULT_MAX_DELAY + 'ms',
      slow.delayMs === DEFAULT_MAX_DELAY,
      JSON.stringify(slow.delayMs)
    );

    const seedBig = await request(port, '/demo/big-static');
    const seedLogs = await request(port, '/_admin/logs?apiId=a8&limit=10');
    const seedRow = ((seedLogs.json && seedLogs.json.items) || [])[0] || {};
    expect(
      'MOCK_LOG_BODY_LIMIT 未设时，日志体量上限默认 ' + DEFAULT_LOG_LIMIT + 'B（≈100KB）',
      seedBig.status === 200 && !!seedRow.respBodyTruncated
        && seedRow.respBodyTruncated.kept === DEFAULT_LOG_LIMIT
        && seedRow.respBodyTruncated.total === BIG_BYTES,
      JSON.stringify(seedRow.respBodyTruncated)
    );

    const flood = [];
    for (let i = 0; i < DEFAULT_MAX_HELD + 5; i++) flood.push(request(port, '/demo/hold'));
    const results = await Promise.all(flood);
    const rejectedAll = results.filter((r) => r.status === 503);
    const heldAll = results.filter((r) => r.status === 0);
    expect(
      'MOCK_MAX_HELD_REQUESTS 未设时默认 ' + DEFAULT_MAX_HELD + '：'
        + (DEFAULT_MAX_HELD + 5) + ' 个并发挂起里，挂住的 ≤ ' + DEFAULT_MAX_HELD + '，其余 503',
      rejectedAll.length >= 5 && heldAll.length >= 45 && heldAll.length <= DEFAULT_MAX_HELD,
      'held=' + heldAll.length + ' rejected=' + rejectedAll.length
    );
    expect(
      '503 消息里的上限值就是 ' + DEFAULT_MAX_HELD,
      rejectedAll.length > 0 && rejectedAll[0].body.indexOf(String(DEFAULT_MAX_HELD)) >= 0,
      rejectedAll.length ? rejectedAll[0].body : '（一个都没被拒）'
    );
  } finally {
    await stop(srv);
  }
}

async function partMethod(port) {
  note('F. 同路径按 HTTP 方法命中');
  const get = await request(port, '/demo/method', { method: 'GET' });
  expect('GET /demo/method → 命中 GET 接口', get.status === 200 && get.body.indexOf('"via":"get"') >= 0, 'HTTP ' + get.status + ' ' + get.body.slice(0, 80));
  const post = await request(port, '/demo/method', { method: 'POST' });
  expect('POST /demo/method → 命中 POST 接口', post.status === 200 && post.body.indexOf('"via":"post"') >= 0, 'HTTP ' + post.status + ' ' + post.body.slice(0, 80));
  const del = await request(port, '/demo/method', { method: 'DELETE' });
  expect('DELETE /demo/method → 回落到 ALL 接口', del.status === 200 && del.body.indexOf('"via":"all"') >= 0, 'HTTP ' + del.status + ' ' + del.body.slice(0, 80));
}

/* ------------------------------------------------------------------- runner */
async function main() {
  const upstream = await startUpstream();
  const upstreamPort = upstream.address().port;
  const port = await freePort();
  writeConfig(upstreamPort);
  const srv = await boot(port, {
    MOCK_MAX_DELAY_MS: String(MAX_DELAY),
    MOCK_FAULT_TIMEOUT_MS: String(FAULT_HOLD),
    MOCK_MAX_HELD_REQUESTS: String(MAX_HELD),
    MOCK_LOG_BODY_LIMIT: String(SANDBOX_LOG_LIMIT),
  });
  try {
    note('沙盘：端口 ' + port + ' / 上游 ' + upstreamPort
      + '（MOCK_MAX_DELAY_MS=' + MAX_DELAY + '，MOCK_FAULT_TIMEOUT_MS=' + FAULT_HOLD
      + '，MOCK_MAX_HELD_REQUESTS=' + MAX_HELD + '，MOCK_LOG_BODY_LIMIT=' + SANDBOX_LOG_LIMIT + '）');
    await assertSandboxIdentity(port);
    await partProxy(port);
    await partDelay(port);
    await partHeld(port);
    await partLogBody(port);
    await partMethod(port);
  } finally {
    await stop(srv);
  }
  await partDefaults();
  upstream.close();

  console.log('\n' + (failures === 0 ? '✓' : '✗') + ' ' + (checks - failures) + '/' + checks + ' 断言通过');
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch (e) {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n✗ harness crashed: ' + (err && err.stack ? err.stack : err));
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch (e) {}
  process.exit(1);
});
