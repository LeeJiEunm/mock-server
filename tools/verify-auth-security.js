#!/usr/bin/env node
'use strict';

// verify-auth-security.js — assert the read-only share boundary on the SERVER
// side, plus the config read/write contract around sensitive fields.
//
// Why this file exists: READONLY_PORT used to enforce "a valid share link is
// required" in the frontend only. The page rendered a lock, but an anonymous
// curl could still read GET /_admin/config (password hashes + every share
// token) and GET /_admin/share off that port — while the main port answered 401
// to the very same request. These assertions pin the server-side gate so the
// hole cannot come back.
//
// Also pinned here:
//   * GET  /_admin/config strips users + shareTokens
//   * POST /_admin/config carries them back from server memory, so a UI save
//     (the frontend submits the whole config) can never wipe accounts or
//     share tokens it never received
//   * mocks (/demo/...) are untouched by any admin-side change
//
// Usage:  node tools/verify-auth-security.js
// Exit 0 when every assertion passes, 1 otherwise. Zero dependencies, no
// browser. Boots throwaway instances in a temp sandbox: the repository
// config.json is never read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { tempDir, seedServer } = require('./lib/sandbox');
const SERVER_SRC = path.join(ROOT, 'server.js');
const { hashPassword } = require('./lib/password');

const USERNAME = 'alice';
const PASSWORD = 'alice123';
const LEGACY_USER = 'legacy-alice';
const LEGACY_PASSWORD = 'legacy-pass';
const SHARE = 'shr-verify-only-not-a-real-token';
const REVOKED = 'shr-verify-revoked-token';
const sha256Hex = (pw) => 'sha256:' + crypto.createHash('sha256').update(String(pw)).digest('hex');

/* server.js resolves its config as path.join(__dirname, 'config.json'), so the
 * copy we run MUST live next to the config we write. Running the repository
 * copy would make the sandbox read — and this script WRITE — the real
 * config.json. Guarded statically here and re-checked at runtime below.
 * seedServer() also brings lib/ along — server.js requires it since the split. */
const SANDBOX_MARK = 'verify-auth-security-sandbox';
const SANDBOX_API_COUNT = 1;
const SANDBOX = seedServer(tempDir('mock-auth-verify-'), { publicMinimal: true });
const SANDBOX_SERVER = path.join(SANDBOX, 'server.js');
if (path.dirname(SANDBOX_SERVER) !== SANDBOX) {
  throw new Error('harness bug: the server we spawn must live inside the sandbox');
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

function sandboxConfig(withUsers) {
  const cfg = {
    server: {},
    logSize: 200,
    meta: { projectName: SANDBOX_MARK, rev: 0 },
    groups: [{ id: 'g1', name: 'demo group', proxyUrl: '' }],
    shareTokens: [{ token: SHARE, label: 'probe', createdBy: 'admin', createdAt: 1700000000000 }],
    apis: [
      {
        id: 'a1',
        name: 'hello',
        module: 'demo',
        path: 'hello',
        enabled: true,
        groupId: 'g1',
        vars: {},
        proxy: { enable: false, url: '' },
        rules: [],
        defaultResponse: {
          mode: 'static',
          status: 200,
          contentType: 'application/json;charset=UTF-8',
          body: '{"ok":true}',
        },
      },
    ],
  };
  if (withUsers) {
    cfg.users = [
      { username: USERNAME, passwordHash: hashPassword(PASSWORD) },
      { username: LEGACY_USER, passwordHash: sha256Hex(LEGACY_PASSWORD) },
    ];
  }
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
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  let body = null;
  if (o.body !== undefined) {
    body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method || 'GET', path: pathname, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, body: data, json });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: '', json: null, error: e.code }));
    if (body !== null) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same as request(), but resolves on the response head and hangs up — needed
 *  for the SSE log stream, which never ends on its own. */
function headRequest(port, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers }, (res) => {
      resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' });
      req.destroy();
    });
    req.on('error', (e) => resolve({ status: 0, contentType: '', error: e.code }));
    req.end();
  });
}

/** Boot one throwaway instance; resolve once the main port answers at all. */
async function boot(mainPort, roPort) {
  const child = spawn(process.execPath, [SANDBOX_SERVER], {
    cwd: SANDBOX,
    env: Object.assign({}, process.env, {
      PORT: String(mainPort),
      READONLY_PORT: String(roPort),
      // Keep both modes deterministic regardless of the caller's shell.
      MOCK_ADMIN_USER: '',
      MOCK_ADMIN_PASS: '',
      MOCK_DEFAULT_LANG: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

/** Runtime hard guard, called before anything that writes.
 *  Refuse to touch an instance whose served config is not our sandbox: an
 *  earlier version of this script booted the repository server.js, which read —
 *  and then overwrote — the real config.json. */
async function assertSandboxIdentity(port, token) {
  const r = await request(port, '/_admin/config', { token });
  const mark = r.json && r.json.meta ? r.json.meta.projectName : undefined;
  const count = r.json && Array.isArray(r.json.apis) ? r.json.apis.length : -1;
  if (r.status !== 200 || mark !== SANDBOX_MARK || count !== SANDBOX_API_COUNT) {
    console.error('\n✗ REFUSING TO RUN — the instance under test is not the sandbox.');
    console.error('  expected meta.projectName="' + SANDBOX_MARK + '" and ' + SANDBOX_API_COUNT + ' api(s),');
    console.error('  got projectName=' + JSON.stringify(mark) + ', apis=' + count + ', HTTP ' + r.status);
    console.error('  Nothing was written. This guard exists because server.js locates its config as');
    console.error('  path.join(__dirname, "config.json"): booting the repository copy would target the real config.json.');
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (e) {}
    process.exit(1);
  }
}

const noUsersNoTokens = (json) => !!json && !('users' in json) && !('shareTokens' in json);

/* ---------------------------------------------------------------- 账密模式 */
async function runAuthedMode() {
  const mainPort = await freePort();
  const roPort = await freePort();
  sandboxConfig(true);
  const srv = await boot(mainPort, roPort);
  try {
    note('A. 账密模式（config.json 有 users）— 主端口 ' + mainPort + ' / 只读端口 ' + roPort);

    expect('主端口 匿名 GET /_admin/config → 401', (await request(mainPort, '/_admin/config')).status === 401);

    const auth = await request(roPort, '/_admin/auth');
    expect(
      '只读端口 匿名 GET /_admin/auth → 200 且 shareRequired=true（前端靠它渲染提示页）',
      auth.status === 200 && !!auth.json && auth.json.shareRequired === true,
      JSON.stringify(auth)
    );

    for (const p of ['/_admin/config', '/_admin/share', '/_admin/logs', '/_admin/changelog', '/_admin/stats', '/_admin/health']) {
      const r = await request(roPort, p);
      expect('只读端口 匿名 GET ' + p + ' → 403', r.status === 403, 'HTTP ' + r.status + ' ' + r.body.slice(0, 80));
    }
    expect(
      '只读端口 匿名 POST /_admin/config → 403',
      (await request(roPort, '/_admin/config', { method: 'POST', body: {} })).status === 403
    );
    expect(
      '只读端口 匿名 POST /_admin/login → 403（该端口禁登录）',
      (await request(roPort, '/_admin/login', { method: 'POST', body: {} })).status === 403
    );

    const roCfg = await request(roPort, '/_admin/config', { token: SHARE });
    expect('只读端口 带有效分享令牌 GET /_admin/config → 200', roCfg.status === 200, 'HTTP ' + roCfg.status);
    expect('只读端口 带有效令牌的配置不含 users / shareTokens', noUsersNoTokens(roCfg.json), JSON.stringify(roCfg.json).slice(0, 120));
    expect(
      '只读端口 带有效令牌仍能看全规则视图（apis 完整）',
      !!(roCfg.json && Array.isArray(roCfg.json.apis) && roCfg.json.apis.length === 1)
    );
    expect(
      '只读端口 带有效令牌 GET /_admin/share → 403（只读身份不能枚举令牌）',
      (await request(roPort, '/_admin/share', { token: SHARE })).status === 403
    );

    /* SSE 日志流只能把令牌放 ?token=（EventSource 不能自定义请求头），
     * 是这道网关最容易误伤的一条：「带令牌要能连上、不带要拒绝」两头都得钉住。 */
    const sse = await headRequest(roPort, '/_admin/logs/stream?token=' + encodeURIComponent(SHARE));
    expect(
      '只读端口 SSE 日志流（令牌走 ?token=）→ 200 且是事件流',
      sse.status === 200 && sse.contentType.indexOf('event-stream') >= 0,
      JSON.stringify(sse)
    );
    const sseAnon = await headRequest(roPort, '/_admin/logs/stream');
    expect('只读端口 SSE 匿名 → 403', sseAnon.status === 403, JSON.stringify(sseAnon));

    const shareCfg = await request(mainPort, '/_admin/config', { token: SHARE });
    expect('主端口 持分享令牌 GET /_admin/config → 200 且不含 users / shareTokens', shareCfg.status === 200 && noUsersNoTokens(shareCfg.json), JSON.stringify(shareCfg).slice(0, 120));
    expect(
      '主端口 持分享令牌 GET /_admin/share → 403',
      (await request(mainPort, '/_admin/share', { token: SHARE })).status === 403
    );
    expect(
      '主端口 持分享令牌 POST /_admin/config → 403（只读身份不能写）',
      (await request(mainPort, '/_admin/config', { method: 'POST', body: {}, token: SHARE })).status === 403
    );

    const login = await request(mainPort, '/_admin/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
    expect('主端口 POST /_admin/login（正确账号）→ 200', login.status === 200 && !!login.json && login.json.ok === true, JSON.stringify(login.json));
    const token = (login.json && login.json.token) || '';

    const legacyLogin = await request(mainPort, '/_admin/login', { method: 'POST', body: { username: LEGACY_USER, password: LEGACY_PASSWORD } });
    expect(
      '主端口 老 sha256 用户仍可登录（迁移兼容）',
      legacyLogin.status === 200 && !!legacyLogin.json && legacyLogin.json.ok === true,
      JSON.stringify(legacyLogin.json)
    );

    // 从这里开始有写操作（POST /_admin/config）：先确认对面是我们的沙盘，不是仓库实例
    await assertSandboxIdentity(mainPort, token);

    const adminCfg = await request(mainPort, '/_admin/config', { token });
    expect('主端口 登录后 GET /_admin/config → 200 且不含 users / shareTokens', adminCfg.status === 200 && noUsersNoTokens(adminCfg.json), JSON.stringify(adminCfg).slice(0, 120));
    expect(
      '主端口 GET /_admin/config 带 meta.rev（乐观锁基线 0）',
      !!adminCfg.json && Number(adminCfg.json.meta && adminCfg.json.meta.rev) === 0,
      JSON.stringify(adminCfg.json && adminCfg.json.meta).slice(0, 120)
    );
    const adminShare = await request(mainPort, '/_admin/share', { token });
    expect(
      '主端口 登录后 GET /_admin/share → 200 且能看到 1 条令牌（正常控制台不受影响）',
      adminShare.status === 200 && !!adminShare.json && adminShare.json.items.length === 1,
      JSON.stringify(adminShare).slice(0, 120)
    );
    expect(
      '主端口 登录后 GET /_admin/users → 403（config 里的普通账号不是部署管理员）',
      (await request(mainPort, '/_admin/users', { token })).status === 403
    );

    const save = await request(mainPort, '/_admin/config', { method: 'POST', token, body: adminCfg.json });
    expect('主端口 POST /_admin/config（整份提交脱敏后的视图）→ 200', save.status === 200 && !!save.json && save.json.ok === true, JSON.stringify(save).slice(0, 120));
    expect('POST /_admin/config 返回递增后的版本号 rev=1', !!save.json && Number(save.json.rev) === 1, JSON.stringify(save.json).slice(0, 120));

    const refreshCfg = await request(mainPort, '/_admin/config', { token });
    expect(
      '保存后 GET /_admin/config 的 meta.rev 已递增到 1',
      !!refreshCfg.json && Number(refreshCfg.json.meta && refreshCfg.json.meta.rev) === 1,
      JSON.stringify(refreshCfg.json && refreshCfg.json.meta).slice(0, 120)
    );
    const staleSave = await request(mainPort, '/_admin/config', { method: 'POST', token, body: adminCfg.json });
    expect(
      '拿旧版本整份保存 → 409 conflict（防止后保存覆盖先保存）',
      staleSave.status === 409 && !!staleSave.json && staleSave.json.conflict === true && staleSave.json.currentRev === 1,
      JSON.stringify(staleSave).slice(0, 120)
    );
    const latestSave = await request(mainPort, '/_admin/config', { method: 'POST', token, body: refreshCfg.json });
    expect('拿最新版本重新保存 → 200', latestSave.status === 200 && !!latestSave.json && latestSave.json.ok === true, JSON.stringify(latestSave).slice(0, 120));

    const afterShare = await request(mainPort, '/_admin/share', { token });
    expect(
      '保存后分享令牌没被冲掉（仍 1 条）',
      !!afterShare.json && afterShare.json.items.length === 1,
      JSON.stringify(afterShare).slice(0, 120)
    );
    const relogin = await request(mainPort, '/_admin/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
    expect(
      '保存后账号还能登录（users 被服务端 carry 回来了，没被清空）',
      relogin.status === 200 && !!relogin.json && relogin.json.ok === true,
      JSON.stringify(relogin.json)
    );

    const mock = await request(mainPort, '/demo/hello');
    expect(
      '挡板接口不受影响：GET /demo/hello → 200 且返回兜底响应',
      mock.status === 200 && mock.body.indexOf('"ok":true') >= 0,
      'HTTP ' + mock.status + ' ' + mock.body.slice(0, 80)
    );
  } finally {
    await stop(srv);
  }
}

/* ---------------------------------------------------------------- 免密模式 */
async function runOpenMode() {
  const mainPort = await freePort();
  const roPort = await freePort();
  sandboxConfig(false);
  const srv = await boot(mainPort, roPort);
  try {
    note('B. 免密模式（无 users / 无 MOCK_ADMIN_PASS）— 主端口 ' + mainPort + ' / 只读端口 ' + roPort);

    // 本模式最后有一条 POST /_admin/share（会落盘）：同样先确认是沙盘
    await assertSandboxIdentity(mainPort, '');

    expect('主端口 匿名 GET /_admin/config → 200（免密开放，回归）', (await request(mainPort, '/_admin/config')).status === 200);
    expect('主端口 匿名 GET /_admin/share → 200（不能误伤免密控制台）', (await request(mainPort, '/_admin/share')).status === 200);

    const auth = await request(roPort, '/_admin/auth');
    expect(
      '只读端口 匿名 GET /_admin/auth → 200、shareRequired=true、readonlyPort 指向只读端口',
      auth.status === 200 && !!auth.json && auth.json.shareRequired === true && auth.json.readonlyPort === roPort,
      JSON.stringify(auth.json)
    );
    expect('只读端口 匿名 GET /_admin/config → 403', (await request(roPort, '/_admin/config')).status === 403);

    const roCfg = await request(roPort, '/_admin/config', { token: SHARE });
    expect(
      '只读端口 带有效分享令牌 GET /_admin/config → 200（?share= 与 Bearer 两种带法都放行）',
      roCfg.status === 200 && !!roCfg.json && Array.isArray(roCfg.json.apis),
      'HTTP ' + roCfg.status
    );
    const roCfgViaQuery = await request(roPort, '/_admin/config?share=' + encodeURIComponent(SHARE));
    expect('只读端口 用 URL ?share= 带令牌 GET /_admin/config → 200', roCfgViaQuery.status === 200, 'HTTP ' + roCfgViaQuery.status);
    expect(
      '只读端口 带失效令牌 GET /_admin/config → 403',
      (await request(roPort, '/_admin/config', { token: REVOKED })).status === 403
    );

    expect(
      '主端口 持分享令牌 GET /_admin/share → 403（只读身份不能枚举令牌）',
      (await request(mainPort, '/_admin/share', { token: SHARE })).status === 403
    );
    expect(
      '主端口 匿名 POST /_admin/share → 200（免密 + 已配只读端口仍允许生成分享）',
      (await request(mainPort, '/_admin/share', { method: 'POST', body: {} })).status === 200
    );
  } finally {
    await stop(srv);
  }
}

(async () => {
  try {
    await runAuthedMode();
    await runOpenMode();
  } catch (err) {
    console.error('\n✗ harness error: ' + (err && err.message));
    failures++;
  } finally {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (e) {}
  }
  if (failures) {
    console.error('\n✗ ' + failures + ' of ' + checks + ' assertions failed');
    process.exit(1);
  }
  console.log('\n✓ All ' + checks + ' read-only-share / config-sanitising assertions passed.');
  process.exit(0);
})();
