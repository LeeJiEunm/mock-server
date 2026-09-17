#!/usr/bin/env node
'use strict';

// verify-server-basics.js — pin the server's own HTTP contract and the
// config-file lifecycle (both changed on 2026-09-16, #8 / #13 / #14 / #15 / #16):
//
//   A. HTTP surface
//      - a path matching no api answers **404** (it used to answer 500, which
//        makes the caller think the mock itself broke — and public/help.html
//        already documented 404)
//      - a path that does match still answers normally
//      - static assets carry an ETag and revalidate: same ETag → 304 with an
//        empty body, changed file → new ETag → 200 with the new bytes. The
//        console must stay "edit and reload" fresh, so this must NOT turn into
//        "cache for an hour".
//      - directory-traversal shapes never leak a file outside public/
//   B. Config lifecycle (config.json is runtime data, config.example.json ships)
//      - missing config.json → seeded from config.example.json
//      - both missing → built-in minimal config
//      - config.json is a directory (the docker single-file-bind trap) →
//        a readable message + exit 1, not a stack trace
//      - config.json is broken JSON → readable message + exit 1
//   C. Tools share the same rule: add-user.js runs on a fresh clone and seeds
//      the config instead of dying with "找不到配置文件"
//   D. Source invariants that HTTP cannot observe (traversal guard shape, no
//      resurrection of the dead configMtime variable)
//
// Usage:  node tools/verify-server-basics.js
// Exit 0 when every assertion passes, 1 otherwise. Zero dependencies, no browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { tempDir, seedServer } = require('./lib/sandbox');
const SERVER_SRC = path.join(ROOT, 'server.js');
const EXAMPLE_SRC = path.join(ROOT, 'config.example.json');

if (!fs.existsSync(EXAMPLE_SRC)) {
  console.error('缺少 config.example.json —— 它是「clone 即跑」依赖的示例配置，不能删。');
  process.exit(1);
}

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

/* ------------------------------------------------------------- temp sandbox */

function makeSandbox(prefix) {
  /* seedServer 会把 server.js + lib/ 一起复制过去 —— server.js require('./lib/*')，
   * 只复制 server.js 的沙盘根本起不来（这是拆模块时踩过的坑，已收敛到 sandbox.js 一处）。 */
  const dir = seedServer(tempDir(prefix), {});
  fs.mkdirSync(path.join(dir, 'public', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>sandbox</title>', 'utf8');
  /* 用 .js 而不是 .txt：只有 STATIC_EXTENSION 里的后缀（或 /styles/、/scripts/ 前缀）
   * 才会走静态文件分支，别的后缀会被当成挡板路径 → 404，那样测的就不是静态服务了。 */
  fs.writeFileSync(path.join(dir, 'public', 'scripts', 'asset.js'), 'var asset = "v1";', 'utf8');
  return dir;
}

/* server.js resolves its config as path.join(__dirname, 'config.json'); the copy
 * we spawn must therefore live in the sandbox, next to the config we control —
 * spawning the repository copy would read the real config.json. */
function assertSandboxed(dir) {
  if (path.dirname(path.join(dir, 'server.js')) !== dir) {
    throw new Error('harness bug: the spawned server must live inside the sandbox');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(port, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  /* `raw` 用于发送超大/非 JSON 的原始 body（o.body 会被 JSON.stringify） */
  const payload = o.raw !== undefined
    ? Buffer.from(String(o.raw), 'utf8')
    : (o.body !== undefined ? Buffer.from(JSON.stringify(o.body), 'utf8') : null);
  if (payload) headers['Content-Length'] = payload.length;
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method || 'GET', path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buf: buf, text: buf.toString('utf8') });
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('client timeout')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), text: '', error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(dir, port, extraEnv) {
  assertSandboxed(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      READONLY_PORT: '',
      MOCK_ADMIN_USER: '',
      MOCK_ADMIN_PASS: '',
      MOCK_SEED: '',
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const res = await request(port, '/_admin/health');
    if (res.status === 200 || res.status === 401) return { child: child, log: () => out };
  }
  throw new Error('沙盘服务没起来，日志：\n' + out);
}

function stop(srv) {
  try { srv.child.kill('SIGKILL'); } catch (e) {}
}

/** Run server.js to completion, expecting it to exit on its own (fatal config). */
function runToExit(dir, extraEnv) {
  assertSandboxed(dir);
  return spawnSync(process.execPath, ['server.js'], {
    cwd: dir,
    env: Object.assign({}, process.env, { PORT: '0', MOCK_SEED: '' }, extraEnv || {}),
    timeout: 15000,
    encoding: 'utf8',
  });
}

/* ------------------------------------------------------------------- part A */

async function partHttp(dir, port) {
  note('A. HTTP 表面（未匹配 404 / 静态 ETag / 穿越）—— 端口 ' + port);

  const unmatched = await request(port, '/nope/nothing');
  expect(
    '路径没匹配到任何接口 → 404（不是 500）',
    unmatched.status === 404,
    unmatched.status + ' ' + unmatched.text.slice(0, 80)
  );
  expect(
    '404 的正文仍然说明清楚是哪个路径没配 mock',
    unmatched.text.indexOf('/nope/nothing') >= 0,
    unmatched.text.slice(0, 120)
  );

  const matched = await request(port, '/demo/sample', { method: 'POST' });
  expect(
    '配了的接口照常返回（示例接口未被 404 改动波及）',
    matched.status === 200,
    matched.status + ' ' + matched.text.slice(0, 80)
  );

  // --- 未匹配也要能进日志，且记的是 404 ---
  const logs = await request(port, '/_admin/logs?limit=20');
  let rows = [];
  try { rows = JSON.parse(logs.text).items || []; } catch (e) { rows = []; }
  const unmatchedRow = rows.filter((row) => row.kind === 'unmatched')[0];
  expect(
    '未匹配请求进了请求日志，且日志里的 status 也是 404',
    !!unmatchedRow && unmatchedRow.status === 404,
    unmatchedRow ? JSON.stringify({ kind: unmatchedRow.kind, status: unmatchedRow.status }) : '日志里没有 unmatched 条目'
  );

  // --- ETag / 304 ---
  const ASSET = '/scripts/asset.js';
  const ASSET_V1 = 'var asset = "v1";';
  const first = await request(port, ASSET);
  const etag = first.headers.etag;
  expect('静态资源返回 200 且带 ETag', first.status === 200 && !!etag, first.status + ' etag=' + etag);
  expect(
    '静态资源声明为「可缓存但必须回源校验」（no-cache），而不是禁止缓存',
    String(first.headers['cache-control'] || '').indexOf('no-cache') >= 0,
    first.headers['cache-control']
  );
  expect('静态资源正文完整', first.text === ASSET_V1, JSON.stringify(first.text.slice(0, 40)));
  if (!etag) throw new Error('没拿到 ETag，后面的 304 断言没法做');

  const revalidated = await request(port, ASSET, { headers: { 'If-None-Match': etag } });
  expect(
    '带同一个 ETag 再请求 → 304，且响应体为空（省掉重复传输）',
    revalidated.status === 304 && revalidated.buf.length === 0,
    revalidated.status + ' body=' + revalidated.buf.length + 'B'
  );

  // --- 内容一变，ETag 必须跟着变（否则「改完刷新还是旧的」） ---
  const ASSET_V2 = 'var asset = "v2-changed";';
  await sleep(10);
  fs.writeFileSync(path.join(dir, 'public', 'scripts', 'asset.js'), ASSET_V2, 'utf8');
  const changed = await request(port, ASSET);
  expect(
    '文件改了 → ETag 变化 → 返回 200 与新内容（不会拿 304 糊弄）',
    changed.status === 200 && changed.text === ASSET_V2 && changed.headers.etag !== etag,
    changed.status + ' etag=' + changed.headers.etag + '（旧 ' + etag + '）'
  );

  const stale = await request(port, ASSET, { headers: { 'If-None-Match': etag } });
  expect(
    '拿旧 ETag 请求改过的文件 → 仍返回 200 新内容（不会错误命中 304）',
    stale.status === 200 && stale.text === ASSET_V2,
    stale.status + ' ' + stale.text.slice(0, 40)
  );

  const root = await request(port, '/');
  expect('根路径仍然返回 index.html', root.status === 200 && root.text.indexOf('sandbox') >= 0, root.status);

  const missing = await request(port, '/no-such-file.css');
  expect('不存在的静态文件 → 404', missing.status === 404, missing.status);

  // --- 目录穿越：URL 解析会先折叠 `..`，这里断言「无论哪种写法都不泄漏」 ---
  const variants = [
    '/../public-evil/secret.txt',
    '/styles/../../public-evil/secret.txt',
    '/%2e%2e/public-evil/secret.txt',
    '/..%2fpublic-evil/secret.txt',
    '/....//public-evil/secret.txt',
  ];
  let leaked = null;
  const statuses = [];
  for (const variant of variants) {
    const res = await request(port, variant);
    statuses.push(variant + '→' + res.status);
    if (res.text.indexOf('SENTINEL-OUTSIDE-PUBLIC') >= 0) leaked = variant;
  }
  expect(
    '5 种目录穿越写法都拿不到 public/ 之外的文件',
    !leaked,
    leaked ? '泄漏于 ' + leaked : statuses.join(' | ')
  );

  /* --- 超大请求体：以前是「黑洞」（既不回响应也不进日志），现在是 413 + 一条日志 --- */
  const huge = 'A'.repeat(9 * 1024 * 1024);      // > MAX_BODY (8MB)
  const tooBig = await request(port, '/demo/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    raw: huge,
  });
  expect(
    '请求体超 8MB 打挡板路径 → 413（不是静默消失）',
    tooBig.status === 413,
    tooBig.status + ' ' + tooBig.text.slice(0, 80)
  );
  const tooBigAdmin = await request(port, '/_admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    raw: huge,
  });
  expect(
    '请求体超 8MB 打管理接口 → 413 且是 JSON 错误（前端能读懂）',
    tooBigAdmin.status === 413 && tooBigAdmin.text.indexOf('"ok":false') >= 0,
    tooBigAdmin.status + ' ' + tooBigAdmin.text.slice(0, 80)
  );
  const afterLogs = await request(port, '/_admin/logs?limit=10');
  let afterRows = [];
  try { afterRows = JSON.parse(afterLogs.text).items || []; } catch (e) { afterRows = []; }
  expect(
    '两次超限请求都进了日志（status=413），不再是「请求凭空消失」',
    afterRows.filter((row) => row.status === 413).length >= 2,
    '413 条目数=' + afterRows.filter((row) => row.status === 413).length
  );
  const stillAlive = await request(port, '/_admin/health');
  expect('超限请求之后服务仍然健康（连接没被搞坏）', stillAlive.status === 200, String(stillAlive.status));
}

/* ------------------------------------------------------------------- part B */

async function partConfigLifecycle() {
  note('B. 配置生命周期（首次生成 / 异常兜底）');

  // B1 — 只有 example → 自动复制
  const b1 = makeSandbox('mock-basics-seed-');
  fs.copyFileSync(EXAMPLE_SRC, path.join(b1, 'config.example.json'));
  const port1 = await freePort();
  const srv1 = await boot(b1, port1);
  try {
    const seeded = fs.existsSync(path.join(b1, 'config.json'));
    expect('缺 config.json、有 config.example.json → 自动生成 config.json', seeded);
    expect(
      '启动日志说明了它是从示例复制来的',
      srv1.log().indexOf('config.example.json') >= 0,
      srv1.log().split('\n').filter((l) => l.indexOf('[config]') >= 0).join(' / ')
    );
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(b1, 'config.json'), 'utf8')); } catch (e) { cfg = null; }
    expect(
      '生成出来的配置与示例一致（示例接口都在，不是空壳）',
      !!cfg && Array.isArray(cfg.apis) && cfg.apis.length === 3,
      cfg ? 'apis=' + cfg.apis.length : '解析失败'
    );
  } finally {
    stop(srv1);
  }

  // B2 — 两个都没有 → 内置最小配置，服务照常起来
  const b2 = makeSandbox('mock-basics-builtin-');
  const port2 = await freePort();
  const srv2 = await boot(b2, port2);
  try {
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(path.join(b2, 'config.json'), 'utf8')); } catch (e) { cfg = null; }
    expect(
      'config.json 与 config.example.json 都没有 → 写一份内置最小配置并照常启动',
      !!cfg && Array.isArray(cfg.apis) && cfg.apis.length === 0,
      cfg ? JSON.stringify(cfg).slice(0, 100) : '文件没生成'
    );
    const health = await request(port2, '/_admin/health');
    expect('最小配置下服务仍然可用', health.status === 200, String(health.status));
  } finally {
    stop(srv2);
  }

  // B3 — config.json 是目录（docker 单文件绑定的经典坑）
  const b3 = makeSandbox('mock-basics-dir-');
  fs.copyFileSync(EXAMPLE_SRC, path.join(b3, 'config.example.json'));
  fs.mkdirSync(path.join(b3, 'config.json'));
  const r3 = runToExit(b3);
  const err3 = String(r3.stderr || '') + String(r3.stdout || '');
  expect(
    'config.json 是目录 → 非零退出（不是带着坏配置硬跑）',
    r3.status === 1,
    'exit=' + r3.status
  );
  expect(
    '并给出可照做的提示（含 cp config.example.json config.json）',
    err3.indexOf('是个目录') >= 0 && err3.indexOf('cp config.example.json config.json') >= 0,
    err3.split('\n').slice(0, 3).join(' / ')
  );

  // B4 — config.json 内容坏了
  const b4 = makeSandbox('mock-basics-broken-');
  fs.copyFileSync(EXAMPLE_SRC, path.join(b4, 'config.example.json'));
  fs.writeFileSync(path.join(b4, 'config.json'), '{ "apis": [ ', 'utf8');
  const r4 = runToExit(b4);
  const err4 = String(r4.stderr || '') + String(r4.stdout || '');
  expect('config.json 是坏 JSON → 非零退出', r4.status === 1, 'exit=' + r4.status);
  expect(
    '报错是人话：点明文件路径 + 可改用 config.example.json',
    err4.indexOf('不是合法 JSON') >= 0 && err4.indexOf('config.example.json') >= 0,
    err4.split('\n').slice(0, 3).join(' / ')
  );
}

/* ------------------------------------------------------------------- part C */

function partTools() {
  note('C. 工具脚本在「还没有 config.json」时也能用');

  const dir = makeSandbox('mock-basics-tools-');
  fs.rmSync(path.join(dir, 'public'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  const addUserSrc = path.join(ROOT, 'tools', 'add-user.js');
  const libSrc = path.join(ROOT, 'tools', 'lib', 'config.js');
  const pwSrc = path.join(ROOT, 'tools', 'lib', 'password.js');
  if (!fs.existsSync(addUserSrc) || !fs.existsSync(libSrc) || !fs.existsSync(pwSrc)) {
    // 退化/裁剪过的副本可能缺这些文件：报成失败，而不是让整个套件崩在半路
    expect('tools/add-user.js 与 tools/lib/{config,password}.js 存在（C 部分的前提）', false,
      addUserSrc + ' / ' + libSrc + ' / ' + pwSrc);
    return;
  }
  fs.copyFileSync(addUserSrc, path.join(dir, 'tools', 'add-user.js'));
  fs.mkdirSync(path.join(dir, 'tools', 'lib'), { recursive: true });
  fs.copyFileSync(libSrc, path.join(dir, 'tools', 'lib', 'config.js'));
  fs.copyFileSync(pwSrc, path.join(dir, 'tools', 'lib', 'password.js'));
  fs.copyFileSync(EXAMPLE_SRC, path.join(dir, 'config.example.json'));

  const res = spawnSync(process.execPath, ['tools/add-user.js', 'alice', 'alice123'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
  });
  const out = String(res.stdout || '') + String(res.stderr || '');
  expect(
    'add-user.js 在缺 config.json 时自己生成配置并加人（退出码 0）',
    res.status === 0,
    'exit=' + res.status + ' ' + out.replace(/\n/g, ' / ').slice(0, 160)
  );

  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch (e) { cfg = null; }
  expect(
    '生成的配置里既有示例接口、也有新加的用户',
    !!cfg && cfg.apis.length === 3 && Array.isArray(cfg.users)
      && cfg.users.some((u) => u.username === 'alice' && /^scrypt:/.test(u.passwordHash)),
    cfg ? 'apis=' + cfg.apis.length + ' users=' + JSON.stringify(cfg.users.map((u) => u.username)) : '解析失败'
  );
}

/* ------------------------------------------------------------------- part D */

function partSourceInvariants() {
  note('D. 源码不变量（HTTP 层观察不到的，只能静态钉住）');
  const src = fs.readFileSync(SERVER_SRC, 'utf8');

  expect(
    'PNG/静态目录穿越守卫用 path.resolve + PUBLIC_DIR + path.sep（不用裸 startsWith）',
    src.indexOf('filePath.startsWith(PUBLIC_DIR + path.sep)') >= 0,
    '守卫写法被改回了裸 startsWith(PUBLIC_DIR)？'
  );
  /* configMtime 只能出现在说明性注释里。以前它被 loadConfig / saveConfig 各赋值一次、
   * 全项目零读取 —— 死代码比不存在的代码更坏，因为它会让人以为「自写事件去重」已经做了。 */
  const mtimeLines = src.split('\n').filter((line) => line.indexOf('configMtime') >= 0);
  expect(
    'configMtime 这个死变量没有复活（最多只在说明性注释里出现一次）',
    mtimeLines.length <= 1 && (mtimeLines.length === 0 || /^\s*(\/\/|\/\*|\*)/.test(mtimeLines[0])),
    mtimeLines.length + ' 处：' + mtimeLines.join(' ¶ ').slice(0, 160)
  );
  expect(
    '未匹配分支返回 404（不是 500）',
    /kind: 'unmatched'[\s\S]{0,500}?sendText\(res, 404/.test(src),
    '未匹配分支的响应码被改回去了？'
  );
  expect(
    'server.js 没有 require 任何 tools/ 下的文件（它必须保持单文件可部署）',
    !/require\(['"][^'"]*tools\//.test(src),
    'server.js 开始依赖 tools/ 了，deploy.sh 不会上传它们'
  );
}

/* --------------------------------------------------------------------- run */

async function main() {
  const dir = makeSandbox('mock-basics-http-');
  fs.copyFileSync(EXAMPLE_SRC, path.join(dir, 'config.example.json'));
  // A sentinel file OUTSIDE public/ — any traversal success would show it up.
  fs.mkdirSync(path.join(dir, 'public-evil'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public-evil', 'secret.txt'), 'SENTINEL-OUTSIDE-PUBLIC', 'utf8');
  // The sandbox config must contain the /demo/hello api part A hits.
  const cfg = JSON.parse(fs.readFileSync(EXAMPLE_SRC, 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

  const port = await freePort();
  const srv = await boot(dir, port);
  try {
    await partHttp(dir, port);
  } catch (e) {
    failures++;
    console.log('  FAIL A 部分整体异常：' + (e && e.message));
  } finally {
    stop(srv);
  }

  /* 每一部分都各自兜住异常：某个部分挂掉时，剩下的部分照样给出结论，
   * 输出以 FAIL 呈现（而不是一句“自检脚本自身出错”把整轮结果吞掉）。 */
  const rest = [
    ['B', () => partConfigLifecycle()],
    ['C', () => partTools()],
    ['D', () => partSourceInvariants()],
  ];
  for (const [name, run] of rest) {
    try {
      await run();
    } catch (e) {
      failures++;
      console.log('  FAIL ' + name + ' 部分整体异常：' + (e && e.message));
    }
  }

  console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 条失败') + '（共 ' + checks + ' 条断言）');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('自检脚本自身出错：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
