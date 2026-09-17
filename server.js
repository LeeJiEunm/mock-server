#!/usr/bin/env node
'use strict';

/**
 * Mock Server —— 带界面的动态挡板服务
 *
 * 定位：一个"按请求内容动态返回"的挡板。同一个接口可以挂多条规则，
 *       规则命中即返回对应响应；不命中则由接口的兜底响应接管，或透传真实服务。
 *
 * 零依赖：只用 Node 内置模块（http / https / fs / path / crypto / url）。
 * 配置外置：config.json，界面改完点保存即写回该文件（不重启生效）。
 *
 * 目录约定：
 *   server.js           服务本体
 *   config.json         接口与规则配置（唯一数据源；**运行数据，不入库**）
 *   config.example.json 示例配置（入库）；首次启动若没有 config.json，自动复制一份
 *   public/             管理界面静态资源
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/* 逻辑分层（lib/）：server.js 只负责「持有状态 + HTTP 路由」，纯逻辑一律放 lib/。
 * 拆分的判据是「有没有读全局状态」——读 config / logs / sessions 的留下，只吃参数的搬走。
 * 这样一来每个 lib 模块都能被单独 require 做单测（见 tools/verify-core-logic.js）。 */
const { tokenizePath, collectValues, pick, compareOne, evalCondition, describeMatch, matchRules } = require('./lib/matching');
const { FAULT_TYPES, renderTemplate, renderResponse, malformedBody, setAllowScriptMode } = require('./lib/render');
const { normalizeMeta, configRevOf, normalizeMethod, apiMethodMatches, apiFingerprint, diffConfig, stampAuthors } = require('./lib/config-logic');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_FILE = path.join(ROOT, 'config.example.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_PREFIX = '/_admin';
const MAX_BODY = 8 * 1024 * 1024;

/* ==========================================================================
 * 浏览器控制台登录保护（可选）
 *   - 部署时指定管理员（最常用）：环境变量 MOCK_ADMIN_USER + MOCK_ADMIN_PASS。
 *       例：MOCK_ADMIN_USER=zhangsan MOCK_ADMIN_PASS=secret node server.js
 *       只给 MOCK_ADMIN_PASS 时，用户名默认 admin。
 *   - 多用户（团队）：在 config.json 配 users 数组，用 `node tools/add-user.js <用户名> <密码>` 增删改。
 *   - 两者都不设，则保持完全开放（不弹登录层）。
 *   - 优先级：环境变量先校验，未命中再查 config.json 的 users。
 *   - 只保护 /_admin/* 管理接口；/index.html 等静态页面不拦截，让前端能渲染。
 *   - mock 接口（如 /demo/...）完全不受影响。密码以 SHA-256 哈希存储（tools/gen-pass.js 生成）。
 *
 * 控制台默认语言（可选）
 *   - 环境变量 MOCK_DEFAULT_LANG=zh-CN|en，或 config.json 的 defaultLang。
 *       例：MOCK_DEFAULT_LANG=en MOCK_ADMIN_PASS=secret node server.js
 *   - 只影响「用户自己还没选过语言」的初次访问（登录页 + 控制台）；用户手动切过就听用户的。
 * ========================================================================== */
const ADMIN_USER = (process.env.MOCK_ADMIN_USER || 'admin').trim();
const ADMIN_PASSWORD = process.env.MOCK_ADMIN_PASS || '';

/* 部署期默认界面语言：环境变量 MOCK_DEFAULT_LANG > config.json 的 defaultLang。
 * 只作为「浏览器里还没有用户自己选过的语言」时的初始值，经 /auth 下发给前端；
 * 用户在界面上手动点过语言切换后，就以他选的那个为准。 */
const DEFAULT_LANG = normalizeLang(process.env.MOCK_DEFAULT_LANG);

function normalizeLang(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === 'en' || v === 'en-us' || v === 'en_us' || v === 'english') return 'en';
  if (v === 'zh' || v === 'zh-cn' || v === 'zh_cn' || v === 'cn' || v === 'chinese' || v === '中文') return 'zh-CN';
  return '';
}

/** 实际生效的默认语言：环境变量优先，其次 config.json；都没有则返回 ''（前端按中文） */
function resolvedDefaultLang() {
  return DEFAULT_LANG || normalizeLang(config && config.defaultLang) || '';
}

const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 2000; // 令牌数量上限：防登录接口被刷导致 sessions 无限增长
const sessions = new Map();

// 只读隔离端口（免密部署隔离用）：分享链接走独立端口，剥离 ?share= 也只能是只读，
// 永远无法暴露/变成可编辑的主端口。0 表示不启用（默认关闭，按需配置）。
let LISTEN_PORT = 0;
let RO_PORT = 0;

// 密码哈希：scrypt + 每用户随机 salt（替代原先无盐的裸 SHA-256，避免离线撞库）。
// passwordHash 新格式 "scrypt:<saltB64>:<derivedB64>"；为兼容老配置仍接受 "sha256:<hex>"（无盐，仅迁移期）。
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N=2^14，约 16MB/次；CLI 一次性生成与每请求登录校验均可接受
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { cost: SCRYPT_COST, blockSize: 8, parallelization: 1 });
  return 'scrypt:' + salt.toString('base64') + ':' + derived.toString('base64');
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const derived = crypto.scryptSync(String(pw), salt, expected.length, { cost: SCRYPT_COST, blockSize: 8, parallelization: 1 });
    return safeEqual(derived, expected);
  }
  if (stored.startsWith('sha256:')) { // 迁移期兼容：老配置里的无盐哈希，校验通过但建议改密码以转成 scrypt
    const hex = crypto.createHash('sha256').update(String(pw)).digest('hex');
    return safeEqual(Buffer.from(stored.slice(7)), Buffer.from(hex));
  }
  return false;
}
// 常量时间比较，避免口令字节级时序侧信道；长度不同直接判否（长度泄漏可接受）。
function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
// 登录失败限速：同一客户端 IP 在窗口内连续失败过多则拒绝，缓解撞库。
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // ip -> { count, first }
function checkLoginAllowed(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return true;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFails.delete(ip); return true; }
  return rec.count < LOGIN_MAX_FAILS;
}
function registerLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { rec.count = 0; rec.first = Date.now(); }
  rec.count += 1;
  loginFails.set(ip, rec);
}
function resetLoginFails(ip) { loginFails.delete(ip); }

// isDeployAdmin=true 表示这是「部署期环境变量管理员」(MOCK_ADMIN_USER/MOCK_ADMIN_PASS)，
// 拥有用户管理（增删改 config.json 的 users）权限；config.json 里的普通 users 账号为 false。
function issueToken(username, isDeployAdmin) {
  clearExpiredSessions();
  const token = crypto.randomUUID();
  sessions.set(token, { ts: Date.now(), username: username || '', isDeployAdmin: !!isDeployAdmin });
  // 兜底上限：超出则淘汰最旧的令牌，避免极端情况下 sessions 无限增长
  if (sessions.size > MAX_SESSIONS) {
    let overflow = sessions.size - MAX_SESSIONS;
    for (const [tk] of sessions.entries()) {
      if (overflow <= 0) break;
      sessions.delete(tk);
      overflow -= 1;
    }
  }
  return token;
}

// 当前会话是否为部署管理员（用于用户管理接口的权限判断）
function isDeployAdmin(req) {
  const entry = sessions.get(extractToken(req));
  return !!(entry && entry.isDeployAdmin);
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [token, entry] of sessions.entries()) {
    if (now - entry.ts > SESSION_TTL) sessions.delete(token);
  }
}

function extractToken(req) {
  const auth = (req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  /* EventSource 不能自定义请求头，日志 SSE 只能把令牌放查询串。
   * 只在这一条路由上接受，避免令牌扩散到其它请求的日志、书签与 Referer 里。 */
  if (req.url && req.url.indexOf('/logs/stream') >= 0) {
    const hit = /[?&]token=([^&]+)/.exec(req.url);
    if (hit) return decodeURIComponent(hit[1]);
  }
  return '';
}

/* --------------------------------------------------------------------------
 * 只读分享链接（A11）
 *   要把规则发给别人看时，不必把管理口令交出去：分享令牌只能读，写操作一律 403。
 *   令牌落在 config.shareTokens 里（重启不丢、可随时撤销），与登录会话完全独立。
 * ------------------------------------------------------------------------ */
function shareTokens() {
  if (!Array.isArray(config.shareTokens)) config.shareTokens = [];
  return config.shareTokens;
}

function findShareToken(token) {
  if (!token) return null;
  return shareTokens().find((row) => row && row.token === token) || null;
}

/** 本次请求是不是「只读分享」身份：分享令牌不在 sessions 里，两者互不干扰 */
function isShareRequest(req) {
  const token = extractToken(req);
  if (!token || sessions.has(token)) return false;
  return !!findShareToken(token);
}

/** 带了分享令牌但令牌已失效/被撤销（既非有效登录会话、也非有效分享令牌）。
 *  仅当请求携带一个「无效」Bearer 时才为真；普通无令牌访问、有效登录会话均不受影响——
 *  因此不会误伤正常的后台管理访问（不是按 IP/端口拦截）。 */
function shareTokenInvalid(req) {
  const token = extractToken(req);
  if (!token || sessions.has(token)) return false;
  return !findShareToken(token);
}

/** 只读隔离端口上从请求里取「有效分享令牌」，无效则返回空串。
 *  两个来源都要认：初次打开的页面 URL 带 ?share=，而前端之后发的 fetch 是 /_admin/auth、
 *  /_admin/config 这类相对路径（URL 里没有 ?share=），令牌放在 Authorization: Bearer 头里。 */
function roShareToken(req) {
  const hit = /[?&]share=([^&]+)/.exec(req.url || '');
  const fromUrl = hit ? decodeURIComponent(hit[1]) : '';
  const fromHeader = extractToken(req);
  const token = fromUrl || fromHeader;
  return token && findShareToken(token) ? token : '';
}

/** 只读隔离端口是否带了有效分享令牌（非只读端口恒为 true）。
 *  必须在服务端自己判：前端只是拿 /auth 的 shareRequired 渲染「需要有效分享链接」提示页，
 *  直接 curl 打 /_admin/config 仍能拿到全量配置。 */
function roShareOk(req) {
  if (!req.__ro) return true;
  return !!roShareToken(req);
}

/** 分享链接地址（沿用访问者当前使用的主机名，内网多网卡时各人拿到的地址互不影响） */
function shareUrl(req, token) {
  let host = req.headers.host || 'localhost';
  // 免密部署且配置了只读隔离端口：分享链接走独立端口，链接里不再出现可编辑的主端口，
  // 对方即便去掉 ?share= 也只是落到只读端口，无法编辑。
  if (!needAuth() && RO_PORT && RO_PORT !== LISTEN_PORT) {
    const idx = host.lastIndexOf(':');
    if (idx >= 0) host = host.slice(0, idx); // 去掉原端口
    host = host + ':' + RO_PORT;
  }
  return 'http://' + host + '/?share=' + encodeURIComponent(token);
}

// 是否启用登录保护：配置了 users 或设置了 MOCK_ADMIN_PASS 即启用
function needAuth() {
  return !!(ADMIN_PASSWORD || (config.users && config.users.length));
}

function isLoggedIn(req) {
  if (req.__ro) return true; // 只读隔离端口：视为已读登录，写操作由下方守卫拦截
  if (!needAuth()) return true;
  clearExpiredSessions();
  const token = extractToken(req);
  if (!token) return false;
  if (sessions.has(token)) return true;
  // 只读分享令牌也能过鉴权，但只能读（写操作在 handleAdmin 里另有一道 403）
  return !!findShareToken(token);
}

function currentUser(req) {
  const entry = sessions.get(extractToken(req));
  return entry ? entry.username : '';
}

function authJson(res, required) {
  sendJson(res, 401, { ok: false, required: required, message: '需要登录才能访问控制台' });
}

/* ==========================================================================
 * 一、配置读写
 * ========================================================================== */

/* 注意：这里曾经有个 configMtime 变量（loadConfig / saveConfig 各写一次，全项目零读取）。
 * 它的原意大概是「自己刚写的那次 fs.watch 事件可以跳过重载」，但那个去重从没实现过，
 * 于是只是个没人看的赋值。真要跳过自写事件，靠的是 fs.watch 回调 + 内容比较，不是 mtime，
 * 所以删掉，免得下一个人以为它在起作用。 */
let config = { server: {}, groups: [], apis: [] };

/** 没配置时用的最小骨架：保证任何环境下服务都能起来，而不是一个 ENOENT 栈把启动打断 */
function builtinConfig() {
  return {
    server: { host: '0.0.0.0', port: 18080, readonlyPort: 0 },
    logSize: 200,
    groups: [],
    apis: [],
    meta: {},
    users: [],
    changelog: [],
    shareTokens: [],
  };
}

/**
 * 启动前的配置兜底（#16：把「示例」和「运行数据」分开之后，靠这里继续保证 clone 即跑）：
 *   1. config.json 在 → 什么都不做（正常运行路径）
 *   2. 不在、但 config.example.json 在 → 复制一份，并说明来源
 *   3. 两个都没有 → 写一份内置最小配置
 * 另外把两种「文件在但用不了」的情况翻成人话：目录（Docker 单文件绑定的经典坑）
 * 和 JSON 解析失败。否则用户看到的只是一段 ENOENT / SyntaxError 栈。
 */
function ensureConfigFile() {
  let st = null;
  try { st = fs.statSync(CONFIG_FILE); } catch (e) { st = null; }

  if (st && st.isDirectory()) {
    console.error('[config] ' + CONFIG_FILE + ' 是个目录，不是文件。');
    console.error('[config] 常见原因：docker 把宿主机上不存在的文件按目录挂载了进来。');
    console.error('[config] 处理：删掉该目录，执行 cp config.example.json config.json 再启动。');
    throw new Error('config.json 是目录，无法作为配置文件读取');
  }
  if (st) return;

  if (fs.existsSync(CONFIG_EXAMPLE_FILE)) {
    fs.copyFileSync(CONFIG_EXAMPLE_FILE, CONFIG_FILE);
    console.log('[config] 未找到 config.json，已从 config.example.json 复制一份（示例数据，可直接在界面里改）');
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(builtinConfig(), null, 2) + '\n', 'utf8');
  console.log('[config] 未找到 config.json / config.example.json，已生成一份最小配置');
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new Error('config.json 不是合法 JSON（' + e.message + '）。文件：' + CONFIG_FILE
      + '；可先把该文件备份，再用 config.example.json 覆盖。');
  }
  config.meta = normalizeMeta(config.meta);
  config.groups = normalizeGroups(config.groups);
  config.apis = config.apis || [];
  config.apis.forEach(normalizeApi);
  // 脚本模式开关 + 接口路径索引/命中计数随配置重载同步
  setAllowScriptMode(config.scriptMode !== false);
  apiIndexDirty = true;
  pruneHitStats();
  return config;
}

/** 当前配置版本：每次 POST /_admin/config 成功 +1，用于多人同时保存的冲突检测 */
function configRev() {
  return configRevOf(config);
}

/** 分组：只用于左侧列表归类；接口通过 groupId 关联，找不到分组就落到「未分组」 */
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((group) => group && group.name)
    .map((group) => ({
      id: group.id || 'g' + crypto.randomUUID().slice(0, 8),
      name: String(group.name),
      /* 分组默认上游（A9）：同项目下多个接口往往指向同一台服务，
       * 填在分组上就不用在每个接口里重复填；接口自己填了则以接口为准。 */
      proxyUrl: String(group.proxyUrl || '').trim(),
    }));
}

/** 兜底补全字段，避免界面上出现 undefined */
function normalizeApi(api) {
  api.id = api.id || 'api-' + crypto.randomUUID().slice(0, 8);
  api.enabled = api.enabled !== false;
  api.method = normalizeMethod(api.method);
  api.rules = api.rules || [];
  api.rules.forEach((rule, index) => {
    rule.id = rule.id || 'r' + (index + 1);
    rule.enabled = rule.enabled !== false;
    rule.match = rule.match === 'any' ? 'any' : 'all';
    rule.conditions = rule.conditions || [];
    rule.response = normalizeResponse(rule.response);
  });
  api.vars = api.vars || {};
  api.proxy = api.proxy || { enable: false, url: '' };
  api.groupId = api.groupId || '';
  // 兜底响应也要补齐新字段（延迟区间 / 故障注入）
  if (api.defaultResponse) api.defaultResponse = normalizeResponse(api.defaultResponse);
  return api;
}

/* FAULT_TYPES（故障注入类型：none / timeout / malformed / abort）已随渲染逻辑搬到
 * lib/render.js —— 渲染时要按它校验，配置归一化也用同一份，从那里 import 即可，别再复制一份。 */

/** 挂起多久后放弃：故障挂起不能把 socket 永久占死，到点强制断开；可用环境变量缩短（自检用） */
const FAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.MOCK_FAULT_TIMEOUT_MS) || 30000);

/** 单个请求的延迟上限：延迟配成几小时会一直占着连接不放（叠加 timeout 故障更狠） */
const MAX_DELAY_MS = Math.max(0, Number(process.env.MOCK_MAX_DELAY_MS) || 30000);

/* 同时挂住的请求数上限：延迟与 timeout 故障都不吃 CPU，但占连接，并发一多就把 fd 打满，
 * 挡板和管理界面会一起不响应。到顶之后不排队，直接 503 并在消息里写明原因。 */
const MAX_HELD_REQUESTS = Math.max(1, Number(process.env.MOCK_MAX_HELD_REQUESTS) || 50);
let heldRequests = 0;

/* 请求日志里「留一份」的 body 上限（字节）。
 *
 * 日志是环形缓冲（默认 200 条）：代理一旦指向下载 / 大 JSON 接口，整份 body 抄进来
 * 会让内存随日志条数线性上涨，前端还要整份 prettyJson 渲染。
 * 这里截的只是「日志里留存的那一份」——回给调用方的响应体仍然是完整的。
 *
 * 请求体与响应体共用一个上限：请求体的 8MB 上限（MAX_BODY）只管「收不收」，
 * 收下之后同样会进日志，所以两边得一起夹。
 *
 * 默认 100KB：联调接口的返回基本都是几 KB 量级，100KB 足够看清结构；
 * 200 条 × 100KB ≈ 20MB 是日志内存的上界。要临时放宽用 MOCK_LOG_BODY_LIMIT。 */
const LOG_BODY_LIMIT = Math.max(0, Number(process.env.MOCK_LOG_BODY_LIMIT) || 100 * 1024);

function defaultResponse() {
  return {
    mode: 'static',
    status: 200,
    delayMs: 0,
    delayMaxMs: 0,          // > delayMs 时按区间随机，模拟真实抖动
    fault: 'none',
    contentType: 'application/json;charset=UTF-8',
    body: '{}',
    script: '',
  };
}

/** 延迟夹取：负数归零、超过上限截到上限。
 * 夹在「配置层」（normalizeResponse）而不是每次发请求时，是为了让界面里填的数和实际会等的
 * 时间是同一个数——否则用户填 1 小时、实际等 30 秒，界面却一直显示 1 小时，排查时像灵异事件。 */
function clampDelay(ms) {
  return Math.min(MAX_DELAY_MS, Math.max(0, Number(ms) || 0));
}

/** 补全响应字段：老配置里没有 delayMaxMs / fault，读进来必须补齐，否则界面上是 undefined */
function normalizeResponse(response) {
  const out = Object.assign(defaultResponse(), response || {});
  out.mode = out.mode === 'script' ? 'script' : 'static';
  out.status = Number(out.status) || 200;
  out.delayMs = clampDelay(out.delayMs);
  out.delayMaxMs = clampDelay(out.delayMaxMs);
  if (out.delayMaxMs < out.delayMs) out.delayMaxMs = out.delayMs;   // 区间填反了就当固定值
  if (FAULT_TYPES.indexOf(out.fault) < 0) out.fault = 'none';
  out.contentType = out.contentType || 'application/json;charset=UTF-8';
  out.body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body === undefined ? {} : out.body);
  out.script = typeof out.script === 'string' ? out.script : '';
  return out;
}

/**
 * 落盘配置：先写同目录临时文件，再 rename 顶替。
 * 直接覆盖写 config.json 时，进程被杀 / 断电会留下只写了一半的 JSON，
 * 下次启动 JSON.parse 直接失败，配置全丢。rename 在同一文件系统内是原子的，
 * 任何时刻 config.json 要么是完整的旧内容，要么是完整的新内容。
 */
// 写串行化：并发保存时让 tmp 文件 / rename 不再交错；并在入队时快照 config 引用，
// 避免「后到的请求已改写 config、先入队的保存任务却把旧值落盘」的竞态（last-write-wins 仍成立，但不再写花）。
let saveChain = Promise.resolve();
let savingNow = false;
function saveConfig(throwOnError) {
  const snapshot = config;
  savingNow = true;
  // 配置结构变化：下次 findApi 重建路径索引，并清掉已删除接口的命中计数
  apiIndexDirty = true;
  pruneHitStats();
  const run = () => {
    const tmpFile = CONFIG_FILE + '.tmp';
    const payload = JSON.stringify(snapshot, null, 2);
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);            // 先落盘再改名，避免 rename 成功但内容还在页缓存里
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, CONFIG_FILE);
  };
  const p = saveChain.then(run).catch((e) => {
    console.error('[config] 保存失败：', e && e.message ? e.message : e);
    if (throwOnError) throw e;
  }).finally(() => {
    savingNow = false;
  });
  saveChain = p.then(() => {}, () => {});
  return p;
}

/* ==========================================================================
 * 二、运行日志（内存环形，供界面实时查看）
 * ========================================================================== */

const logs = [];
let logSeq = 0;

/** 日志容量：config.logSize 可调，收敛到 [50, 5000]，避免填 0 或填出个 100 万把内存吃光 */
function logLimitOf(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 200;
  return Math.min(5000, Math.max(50, Math.floor(raw)));
}

function logLimit() {
  return logLimitOf(config.logSize);
}

/* --------------------------------------------------------------------------
 * 日志实时推送（SSE）
 *   原来是前端每 3 秒轮询一次：多人同时开面板时有最长 3 秒延迟，且绝大多数轮询没有新数据。
 *   改成「有新日志就推」：前端收到通知后拉一次快照，渲染逻辑仍然只有一份，
 *   不会出现「推送路径与轮询路径渲染不一致」这种典型分叉。
 * ------------------------------------------------------------------------ */
const logStreams = new Set();

function sseWrite(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (e) {
    return false;   // 连接已断，调用方负责把自己摘掉
  }
}

function broadcastLog(entry) {
  if (!logStreams.size) return;
  logStreams.forEach((res) => {
    if (!sseWrite(res, 'log', entry)) logStreams.delete(res);
  });
}

function broadcastLogClear() {
  logStreams.forEach((res) => {
    if (!sseWrite(res, 'clear', { ok: true })) logStreams.delete(res);
  });
}

/** 体积的可读写法（日志提示用）：1024 → 1KB，1.5MB 之类 */
function humanBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

/**
 * 把要进日志的 body 夹到 LOG_BODY_LIMIT 以内。
 *   返回 { text, truncated, total }；未超限时原样返回（不做任何拷贝）。
 *   截断只动「日志副本」，调用方回给客户端的那份不受影响。
 */
function clampBodyForLog(text) {
  if (typeof text !== 'string' || !text || LOG_BODY_LIMIT <= 0) {
    return { text: text, truncated: false, total: 0 };
  }
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= LOG_BODY_LIMIT) return { text: text, truncated: false, total: buf.length };
  // 按字节切可能把多字节字符切成两半，toString 会在末尾留 U+FFFD，去掉它保证日志仍是合法文本
  const kept = buf.subarray(0, LOG_BODY_LIMIT).toString('utf8').replace(/\uFFFD+$/, '');
  return {
    text: kept + '\n\n…（日志已截断，仅保留前 ' + humanBytes(LOG_BODY_LIMIT) + '；原文 ' + humanBytes(buf.length) + '，回给调用方的响应体是完整的）',
    truncated: true,
    total: buf.length,
  };
}

function addLog(entry) {
  entry.id = ++logSeq;
  if (!entry.ts) entry.ts = Date.now();          // 没传 ts 默认使用当前时间
  /* 日志副本限长（只影响这里留存的一份，不影响已经发出去的响应）：
   * 截断的同时记一个 truncated 标记，界面上要显式说明「你看到的是半份」，
   * 否则排查时会拿半份 body 当全份用。 */
  ['reqBody', 'respBody'].forEach((field) => {
    // 调用方已经给出精确标记（流式代理只用保留前 N 字节时），不要再按已截短的文本重新推断 total
    if (entry[field + 'Truncated']) return;
    const clamped = clampBodyForLog(entry[field]);
    if (!clamped.truncated) return;
    entry[field] = clamped.text;
    entry[field + 'Truncated'] = { kept: LOG_BODY_LIMIT, total: clamped.total };
  });
  logs.unshift(entry);
  const limit = logLimit();
  if (logs.length > limit) logs.length = limit;
  broadcastLog(entry);
}

/* --------------------------------------------------------------------------
 * 命中计数（内存累加器）
 *   和请求日志是两套独立数据：日志是环形缓冲会被轮转覆盖，计数只看累加，
 *   所以「规则命中多少次」不会因为日志滚动而失真。重启清零（刻意不落盘，
 *   否则每次请求都要写 config.json，与原子写的目标冲突）。
 * ------------------------------------------------------------------------ */
/* 接口路径索引：findApi 走它避免每次请求全量线性扫描（Codex 审查点⑨）。
 * config 结构变化后由 saveConfig / loadConfig 置脏，findApi 懒重建。 */
let apiPathIndex = new Map();
let apiIndexDirty = true;
function rebuildApiIndex() {
  const map = new Map();
  for (const api of (config.apis || [])) {
    if (!api.enabled) continue;
    const full = apiFullPath(api);
    if (full) {
      if (!map.has(full)) map.set(full, []);
      map.get(full).push(api);
    }
  }
  apiPathIndex = map;
  apiIndexDirty = false;
}

const hitStats = new Map();   // key = apiId + '|' + ruleId（兜底用空 ruleId）→ { count, last }

function recordHit(apiId, ruleId) {
  if (!apiId) return;
  const key = apiId + '|' + (ruleId || '');
  const item = hitStats.get(key) || { apiId: apiId, ruleId: ruleId || null, count: 0, last: 0 };
  item.count += 1;
  item.last = Date.now();
  hitStats.set(key, item);
}

function statsSnapshot() {
  const out = {};
  hitStats.forEach((item) => {
    if (!out[item.apiId]) out[item.apiId] = { total: 0, rules: {} };
    out[item.apiId].rules[item.ruleId || ''] = { count: item.count, last: item.last };
    out[item.apiId].total += item.count;
  });
  return out;
}

/** 接口/规则被删除后，清掉已失效的命中计数（Codex 审查点⑧：命中统计只增不减） */
function pruneHitStats() {
  if (hitStats.size === 0) return;
  if (!config.apis || config.apis.length === 0) { hitStats.clear(); return; }
  const alive = new Set(config.apis.map((a) => a.id));
  for (const key of hitStats.keys()) {
    const sep = key.indexOf('|');
    const apiId = sep >= 0 ? key.slice(0, sep) : key;
    if (!alive.has(apiId)) hitStats.delete(key);
  }
}

/* --------------------------------------------------------------------------
 * 变更流水
 *   目的：多人共用同一个面板时能回答「这条规则是谁在什么时候改的」。
 *   内存 + config.changelog 双写：内存保住本次运行，config 里留最近 200 条跨重启。
 * ------------------------------------------------------------------------ */
const changelog = [];
const CHANGELOG_LIMIT = 200;

function pushChangelog(entry) {
  const item = {
    id: ++logSeq,
    ts: Date.now(),
    by: entry.by || '',
    apiId: entry.apiId || '',
    apiName: entry.apiName || '',
    action: entry.action || '',
    detail: entry.detail || '',
  };
  changelog.unshift(item);
  if (changelog.length > CHANGELOG_LIMIT) changelog.length = CHANGELOG_LIMIT;
  if (!Array.isArray(config.changelog)) config.changelog = [];
  config.changelog.unshift(item);
  if (config.changelog.length > CHANGELOG_LIMIT) config.changelog.length = CHANGELOG_LIMIT;
  return item;
}

/** 变更流水的取用入口：倒序、可按接口过滤 */
function changelogList(apiId, limit) {
  const source = changelog.length ? changelog : (Array.isArray(config.changelog) ? config.changelog : []);
  const filtered = apiId ? source.filter((item) => item.apiId === apiId) : source;
  return filtered.slice(0, limit);
}

/* --- 历史日志种子（MOCK_SEED=1 启动时启用）
 *   用途：种入几天前的若干条请求记录，便于在日志面板里直接看到日期前缀效果。
 *   关闭方式：正常 `node server.js` 启动，不设 MOCK_SEED 即可，注入代码完全跳过。 */
function seedHistoricalLogs() {
  const day = 86400_000;
  const now = Date.now();
  // 用绝对时间构造，覆盖近 4 个不同日期，让「YYYY-MM-DD HH:MM:SS」前缀都能在面板里出现
  const fixtures = [
    { offsetMs: -3 * day + 8 * 3600_000 + 15 * 60_000,   method: 'POST', path: '/demo/sample',                status: 200, ms: 4,  body: '{"code":"500"}',                                       rule: '规则1：演示条件响应' },
    { offsetMs: -3 * day + 13 * 3600_000 + 42 * 60_000,  method: 'POST', path: '/demo/echo',                  status: 504, ms: 3001, body: '{"timeout":true}',                                    rule: null },
    { offsetMs: -2 * day + 1 * 3600_000 + 55 * 60_000,   method: 'POST', path: '/demo/echo',                  status: 200, ms: 1,   body: '{"hello":"world-09-09-01"}',                          rule: '默认：echo 原样返回' },
    { offsetMs: -2 * day + 11 * 3600_000 + 31 * 60_000,  method: 'POST', path: '/test/notfound',              status: 404, ms: 1,   body: '',                                                   rule: null },
    { offsetMs: -1 * day + 3 * 3600_000 + 13 * 60_000,   method: 'POST', path: '/demo/sample',                status: 200, ms: 6,   body: '{"code":"default"}',                                   rule: '默认：成功响应并回显 code' },
    { offsetMs: -1 * day + 14 * 3600_000 + 16 * 60_000,  method: 'POST', path: '/demo/echo',                  status: 200, ms: 2,   body: '{"check":"yesterday afternoon"}',                    rule: '默认：echo 原样返回' },
    { offsetMs: -6 * 3600_000 - 4 * 60_000,              method: 'POST', path: '/demo/sample',                status: 200, ms: 8,   body: '{"code":"404"}',                                       rule: '规则2：code=404 返回 404' },
    { offsetMs: -25 * 60_000,                            method: 'POST', path: '/demo/echo',                  status: 200, ms: 3,   body: '{"a":1,"b":2}',                                       rule: '默认：echo 原样返回' }
  ];
  // 按时间从老到新依次 unshift，最后写入的最新会在最上面，符合 addLog 的常规行为
  fixtures.sort((a, b) => a.offsetMs - b.offsetMs);
  for (const f of fixtures) {
    addLog({
      method: f.method,
      path: f.path,
      status: f.status,
      ms: f.ms,
      body: f.body,
      rule: f.rule,
      ts: now + f.offsetMs
    });
  }
  console.log('[seed] 已注入 ' + fixtures.length + ' 条历史日志（MOCK_SEED=1），覆盖近 4 个不同日期');
}

/* ==========================================================================
 * 三、JSON 路径取值 + 四、条件匹配 —— 实现见 lib/matching.js
 *   （纯函数，无状态依赖：tokenizePath / pick / evalCondition / matchRules）
 * ========================================================================== */
/* ==========================================================================
 * 五、响应渲染 —— 实现见 lib/render.js
 *   （FAULT_TYPES 也随之搬走，配置层从那里 import，避免常量两处定义）
 * ========================================================================== */
/* ==========================================================================
 * 六、请求解析
 * ========================================================================== */

/**
 * 读取请求体。
 *
 * 超过 MAX_BODY 时必须**仍然 resolve**：早期版本在这里直接 `req.destroy()` 就 return，
 * 实测 'end' 与 'error' 都不会再触发 → Promise 永不 settle → 调用方（handleMock 首行的
 * await）永远挂住 → 该请求既不进请求日志也不回任何响应，客户端只看到 EPIPE。
 * 对挡板来说"请求凭空消失"是最难排查的一类现象，所以现在：
 *   1. 打上 req.__bodyTooLarge 标记并立刻 resolve('')，让调用方继续走、回一个 413；
 *   2. 用 req.resume() 把余下的数据读掉丢弃——不这样做的话连接里塞着未读数据，
 *      响应可能发不出去，keep-alive 也会错乱。
 */
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;              // 已收的部分也丢掉，不留在内存里
        req.__bodyTooLarge = true;
        finish('');
        req.resume();                   // 继续读掉并丢弃剩余数据，保证连接可正常回包
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(''));
    /* 兜底：客户端中途断开时 'end'/'error' 之外还有 'close'，补一条保证 Promise 一定 settle */
    req.on('close', () => finish(''));
  });
}

/** 请求体超限时的统一回应（挡板与管理接口共用），并写一条日志让人能看见这次请求 */
function rejectTooLarge(req, res, info) {
  const message = '请求体超过上限 ' + Math.round(MAX_BODY / 1024 / 1024) + 'MB，本请求未被处理';
  addLog({
    kind: info.kind,
    apiId: info.apiId || null,
    apiName: info.apiName || '',
    pathname: info.pathname,
    method: req.method,
    status: 413,
    ms: Date.now() - (info.startedAt || Date.now()),
    reqBody: '（请求体过大，已丢弃，未留存）',
    respBody: message,
    ip: clientIp(req),
  });
  sendText(res, 413, message);
}

function buildContext(req, url, raw) {
  let body = {};
  if (raw) {
    try { body = JSON.parse(raw); } catch (e) { body = {}; }
  }
  const query = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  return {
    method: req.method,
    raw,
    body,
    query,
    headers: req.headers,
    path: url.pathname,
    vars: {},
  };
}

/* ==========================================================================
 * 七、接口匹配
 * ========================================================================== */

function apiFullPath(api) {
  return [api.module, api.path].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '');
}

function findApi(pathname, method) {
  if (apiIndexDirty) rebuildApiIndex();
  const target = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const candidates = apiPathIndex.get(target) || [];
  // 同一路径下按配置顺序取第一个 method 命中的接口；ALL 在后仍可能被前面的特定方法/ALL 遮蔽
  return candidates.find((api) => apiMethodMatches(api, method)) || null;
}

/* ==========================================================================
 * 八、代理透传
 * ========================================================================== */

/**
 * 回源路径 = 接口自己配的「接口路径」，模块名不带去上游。
 *
 * 模块名只用于挡板自身的路径匹配（挡板入口是 /{模块}/{接口}），上游通常没有这一段：
 *   挡板 /demo/query  →  上游 http://<host>/query
 *
 * 上游确实要带模块时，把模块写进代理地址即可：代理地址填 http://host/demo。
 * 接口没填路径（不推荐）时退回按原始请求路径透传。
 */
function proxySubPath(api, url) {
  const subPath = String(api.path || '').trim().replace(/^\/+/, '');
  return subPath ? '/' + subPath : url.pathname;
}

/**
 * 实际生效的上游地址：接口自己填了就用接口的，没填才继承所属分组的默认上游。
 * 空字符串表示两者都没配（此时不开启代理，仍走规则链）。
 */
function effectiveProxyUrl(api) {
  const own = String((api.proxy && api.proxy.url) || '').trim();
  if (own) return own;
  const group = (config.groups || []).find((row) => row.id === api.groupId);
  return (group && group.proxyUrl) || '';
}

/* 代理响应里不能直接转发的 hop-by-hop 头，否则 keep-alive / transfer-encoding 会串层 */
const PROXY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function filterProxyHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    if (!PROXY_HOP_HEADERS.has(key.toLowerCase())) out[key] = headers[key];
  }
  return out;
}

/** 流式代理：不等整份响应缓冲，直接把上游字节 pipe 给客户端；
 *  日志只保留前 LOG_BODY_LIMIT 字节的文本副本，避免大文件/二进制把内存和日志撑爆。 */
function proxyPass(api, req, url, raw, res) {
  return new Promise((resolve, reject) => {
    /* 必须用「实际生效」的上游地址，而不是接口自己那一格：
     * handleMock 是按 effectiveProxyUrl(api) 判断该不该代理的，接口 URL 留空、靠分组继承时，
     * 这里若只看 api.proxy.url 就会拿着空串去 new URL，白报一句「代理地址不合法」。 */
    const upstream = effectiveProxyUrl(api);
    let target;
    try {
      target = new URL(upstream);
    } catch (e) {
      reject(new Error('代理地址不合法：' + upstream));
      return;
    }
    const basePath = target.pathname.replace(/\/+$/, '');
    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: basePath + proxySubPath(api, url) + (url.search || ''),
      headers: Object.assign({}, req.headers, { host: target.host }),
      timeout: 30000,
    };
    const client = target.protocol === 'https:' ? https : http;
    const proxyReq = client.request(options, (proxyRes) => {
      if (res.headersSent) {
        proxyRes.resume();
        reject(new Error('客户端已开始响应，无法再写入代理结果'));
        return;
      }

      const headers = filterProxyHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode, headers);

      /* 日志预览：只保留前 LOG_BODY_LIMIT 字节文本；totalSeen 仍统计完整字节数。 */
      const logCap = LOG_BODY_LIMIT > 0 ? LOG_BODY_LIMIT : Number.MAX_SAFE_INTEGER;
      const logPieces = [];
      let logBytes = 0;
      let totalSeen = 0;
      proxyRes.on('data', (chunk) => {
        totalSeen += chunk.length;
        if (logBytes < logCap) {
          const take = Math.min(chunk.length, logCap - logBytes);
          logPieces.push(chunk.subarray(0, take));
          logBytes += take;
        }
      });
      proxyRes.on('end', () => {
        const logBuf = Buffer.concat(logPieces);
        let body = logBuf.toString('utf8');
        let respBodyTruncated = null;
        if (LOG_BODY_LIMIT > 0 && totalSeen > logBuf.length) {
          body = body.replace(/\uFFFD+$/, '');
          body = body + '\n\n…（日志已截断，仅保留前 ' + humanBytes(LOG_BODY_LIMIT)
            + '；原文 ' + humanBytes(totalSeen) + '，回给调用方的响应体是完整的）';
          respBodyTruncated = { kept: logBuf.length, total: totalSeen };
        }
        resolve({
          status: proxyRes.statusCode,
          headers,
          body,
          respBodyTruncated,
        });
      });
      proxyRes.on('error', (err) => {
        if (!res.headersSent) {
          reject(err);
        } else {
          res.destroy(err);
          resolve({
            status: proxyRes.statusCode || 502,
            headers,
            body: err && err.message ? err.message : '代理响应流中断',
            respBodyTruncated: null,
          });
        }
      });

      proxyRes.pipe(res);
    });
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('代理请求超时')));
    proxyReq.on('error', reject);
    // 客户端断开才销毁：不能用 req.on('close')，它会在请求体读完后就触发，导致上游流被提前截断
    res.on('close', () => proxyReq.destroy());
    if (raw) proxyReq.write(raw);
    proxyReq.end();
  });
}

/* ==========================================================================
 * 九、挡板请求处理
 * ========================================================================== */

async function handleMock(req, res, url) {
  const started = Date.now();
  const raw = await readRawBody(req);
  if (req.__bodyTooLarge) { rejectTooLarge(req, res, { kind: 'unmatched', pathname: url.pathname, startedAt: started }); return; }
  const api = findApi(url.pathname, req.method);

  /* 路径没匹配到任何接口 → 404。
   * 不用 500：500 会让调用方以为「挡板内部出故障」，而事实是「这个路径压根没配 mock」，
   * 调用方应该去补接口或改路径。真需要模拟 500 时，配一个接口把状态码写成 500 即可。 */
  if (!api) {
    const message = '模块/接口：' + url.pathname + '，未配置 mock';
    addLog({ kind: 'unmatched', pathname: url.pathname, method: req.method, status: 404, ms: Date.now() - started, reqBody: raw, respBody: message, ip: clientIp(req) });
    sendText(res, 404, message);
    return;
  }

  // 代理优先：开了代理就直接透传真实服务（不参与规则匹配）。
  // 上游地址接口没填则继承分组默认（A9），两边都空才认为没配代理。
  if (api.proxy && api.proxy.enable && effectiveProxyUrl(api)) {
    try {
      const result = await proxyPass(api, req, url, raw, res);
      const logEntry = {
        kind: 'proxy',
        apiId: api.id,
        apiName: api.name,
        pathname: url.pathname,
        method: req.method,
        status: result.status,
        ms: Date.now() - started,
        reqBody: raw,
        respBody: result.body,
        ip: clientIp(req),
      };
      if (result.respBodyTruncated) logEntry.respBodyTruncated = result.respBodyTruncated;
      addLog(logEntry);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const message = '代理失败：' + (err && err.message ? err.message : err);
      addLog({ kind: 'proxy', apiId: api.id, apiName: api.name, pathname: url.pathname, method: req.method, status: 502, ms: Date.now() - started, reqBody: raw, respBody: message, ip: clientIp(req) });
      sendText(res, 502, message);
    }
    return;
  }

  const ctx = buildContext(req, url, raw);
  ctx.vars = api.vars || {};

  const { rule, trace } = matchRules(api, ctx);
  const response = rule ? rule.response : (api.defaultResponse || defaultResponse());
  const rendered = renderResponse(response, ctx);

  // 命中计数：规则命中记 rule.id，兜底命中记空（界面显示为「兜底」）
  recordHit(api.id, rule ? rule.id : null);

  /* 故障注入（A6）：先记日志再制造故障——否则「请求挂住了」这件事在控制台里查不到原因。
   * 故障排在延迟之后：延迟照常生效，故障再覆盖真实的网络行为。 */
  const fault = rendered.fault || 'none';

  /* 本次请求会不会「挂住连接」：延迟要等，timeout 故障还要在延迟之后再挂满 FAULT_TIMEOUT_MS。
   * abort / malformed 都是立刻断开或立刻返回，不占连接，所以不参与计数。 */
  const holdMs = rendered.delayMs + (fault === 'timeout' ? FAULT_TIMEOUT_MS : 0);

  /* 到顶之后不排队：挡板对联调方应该「明确报错」而不是「悄悄变了行为」，
   * 排队会让对方以为配置没生效，所以直接 503 并把原因写进消息和日志。 */
  if (holdMs > 0 && heldRequests >= MAX_HELD_REQUESTS) {
    const message = '同时挂起的请求已达上限 ' + MAX_HELD_REQUESTS + ' 个，本次请求未按配置挂起'
      + '（延迟 ' + rendered.delayMs + 'ms' + (fault === 'timeout' ? ' + 故障 timeout' : '') + '）。'
      + '挂起的连接过多会把挡板的文件描述符占满，导致管理界面一起不可用。';
    addLog({
      kind: 'mock',
      apiId: api.id,
      apiName: api.name,
      pathname: url.pathname,
      method: req.method,
      ruleId: rule ? rule.id : null,
      ruleName: rule ? rule.name : '（兜底响应）',
      status: 503,                 // 实际返回码：不是配置里写的那一个
      ms: Date.now() - started,
      reqBody: raw,
      respBody: message,
      fault: fault,
      holdRejected: true,
      trace,
      ip: clientIp(req),
    });
    sendText(res, 503, message);
    return;
  }

  addLog({
    kind: 'mock',
    apiId: api.id,
    apiName: api.name,
    pathname: url.pathname,
    method: req.method,
    ruleId: rule ? rule.id : null,
    ruleName: rule ? rule.name : '（兜底响应）',
    status: rendered.status,
    ms: Date.now() - started,
    reqBody: raw,
    respBody: fault === 'malformed' ? malformedBody(rendered.body) : rendered.body,
    fault: fault,
    trace,
    ip: clientIp(req),
  });

  /* 挂起期间计数：上限看的只是「此刻挂住多少个」，所以进出必须成对。
   * 放在 try/finally 里而不是每条 return 前各减一次——abort / timeout 都会提前返回。 */
  if (holdMs > 0) {
    heldRequests += 1;
    try {
      if (rendered.delayMs > 0) await sleep(rendered.delayMs);
      if (fault === 'timeout') await sleep(FAULT_TIMEOUT_MS);
    } finally {
      heldRequests -= 1;
    }
  }

  if (fault === 'abort') {
    if (res.socket) res.socket.destroy();      // 客户端表现为连接被重置（ECONNRESET）
    return;
  }
  if (fault === 'timeout') {
    if (!res.writableEnded && res.socket) res.socket.destroy();
    return;
  }

  res.writeHead(rendered.status, {
    'Content-Type': rendered.contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  });
  res.end(fault === 'malformed' ? malformedBody(rendered.body) : rendered.body);
}

function clientIp(req) {
  // 只有显式配置 MOCK_TRUST_PROXY=1 才信任反向代理头，否则登录限速/日志 IP 容易被伪造
  if (process.env.MOCK_TRUST_PROXY === '1') {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket && req.socket.remoteAddress) || '-';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 可被 AbortSignal 提前唤醒的 sleep（用于「挂起期间客户端断开」时立即释放名额）
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' };
  /* 管理接口（/_admin/*）是「随改随生效」的：远端 config.json 一改，界面必须立刻看到新的。
   * 所以这些响应强制不缓存（由 admin 分发处打 res.__noStore 标记）。
   * 挡板响应不打标记 → 行为不变，避免影响被测端对缓存头的预期。 */
  if (res.__noStore) headers['Cache-Control'] = 'no-store, must-revalidate';
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain;charset=UTF-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

/* ==========================================================================
 * 十、管理接口
 * ========================================================================== */

async function handleAdmin(req, res, url) {
  const route = url.pathname.slice(ADMIN_PREFIX.length) || '/';
  const raw = await readRawBody(req);

  /* 超限请求同样要「有人应答」：回 413 + 写日志，不能让它静默消失（见 readRawBody 注释）。
   * 配置 JSON 正常只有几十 KB，走到这里通常是传错了文件。 */
  if (req.__bodyTooLarge) {
    const message = '请求体超过上限 ' + Math.round(MAX_BODY / 1024 / 1024) + 'MB，已拒绝（配置文件正常只有几十 KB，请检查是否传错）';
    addLog({ kind: 'admin', pathname: url.pathname, method: req.method, status: 413, ms: 0, reqBody: '（请求体过大，已丢弃，未留存）', respBody: message, ip: clientIp(req) });
    sendJson(res, 413, { ok: false, message: message });
    return;
  }

  // 只读隔离端口（req.__ro）：仅放行 GET 读操作，登录与任何写操作（改配置、增删分享等）一律拒绝，
  // 确保该端口永远无法变成可编辑面板——即便对方把 URL 上的 ?share= 去掉也一样只读。
  if (req.__ro && (req.method !== 'GET' || route === '/login')) {
    sendJson(res, 403, { ok: false, readonly: true, message: '只读端口仅支持查看，不支持该操作' });
    return;
  }

  // 认证状态查询：前端 boot 时用它判断要不要弹登录层
  if (route === '/auth' && req.method === 'GET') {
      // 只读隔离端口：永远 readonly、无需登录、无管理员身份（与去掉 ?share= 也只读的目标一致）
      const required = req.__ro ? false : needAuth();
      const loggedIn = required ? isLoggedIn(req) : true;
      // 只读端口安全策略：必须携带有效分享令牌才允许查看内容；无令牌或令牌失效时，
      // 前端应展示「需要分享链接」提示页，而非完整的只读配置面板。
      // 判定统一走 roShareOk()（同时认 ?share= 与 Bearer 头，别在这里另写一份）。
      const hasValidShare = roShareOk(req);
      sendJson(res, 200, {
        ok: true,
        required: required,
        loggedIn: loggedIn,
        username: req.__ro ? '' : (loggedIn ? currentUser(req) : ''),
        isDeployAdmin: req.__ro ? false : (loggedIn ? isDeployAdmin(req) : false),
        // 只读分享链接：前端据此隐藏全部编辑入口，后端也会拒绝写请求；只读端口强制 readonly
        readonly: req.__ro ? true : isShareRequest(req),
        // 分享令牌已失效/被撤销：URL 带 ?share= 但令牌不被认可 → 前端据以拒绝降级为可编辑面板
        shareInvalid: shareTokenInvalid(req),
        // 只读端口无有效分享令牌：前端应展示「需要有效分享链接」而非完整只读面板
        shareRequired: req.__ro && !hasValidShare,
        // 只读隔离端口号（0=未启用）：前端据此决定是否显示「分享」入口——免密且未启用时隐藏，避免分享链接指向可编辑主端口
        readonlyPort: RO_PORT,
      // 部署期默认语言（'' 表示没指定，前端按中文）：登录页与控制台都以它为初始语言
      defaultLang: resolvedDefaultLang(),
    });
    return;
  }

  /* 只读隔离端口：除 /auth（前端要靠它判断该显示提示页还是只读面板）之外，一律要求有效分享令牌。
   * 这道拦截必须在服务端：只读端口的「需要分享链接」原先只是前端渲染的提示页，
   * 直接 curl 打 /_admin/config、/_admin/share 仍能拿到全量配置（含口令哈希与全部令牌）。 */
  if (!roShareOk(req)) {
    sendJson(res, 403, { ok: false, readonly: true, shareRequired: true, message: '只读端口需要有效的分享链接' });
    return;
  }

  // 登录
  if (route === '/login' && req.method === 'POST') {
    // 登录失败限速：窗口内连续失败过多直接拒绝（缓解撞库），先于口令校验生效
    const loginIp = clientIp(req);
    if (!checkLoginAllowed(loginIp)) {
      sendJson(res, 429, { ok: false, message: '登录尝试过于频繁，请稍后再试' });
      return;
    }
    try {
      const input = JSON.parse(raw || '{}');
      const username = (input.username || '').trim();
      const password = (input.password || '').trim();

      // 1) 环境变量指定的管理员（部署时最常用）优先校验
      if (ADMIN_PASSWORD) {
        // 用户名放宽：允许省略（旧版前端只发密码），也允许等于 MOCK_ADMIN_USER
        const userOk = (username === '' || username === ADMIN_USER);
        if (userOk && safeEqual(password, ADMIN_PASSWORD)) {
          resetLoginFails(loginIp);
          sendJson(res, 200, { ok: true, token: issueToken(ADMIN_USER, true), username: ADMIN_USER, isDeployAdmin: true, message: '登录成功' });
          return;
        }
      }

      // 2) config.json 的 users 数组（可多个账号）
      const users = (config.users || []).filter((u) => u && u.username);
      const hit = users.find((u) => u.username === username && verifyPassword(password, u.passwordHash));
      if (hit) {
        resetLoginFails(loginIp);
        sendJson(res, 200, { ok: true, token: issueToken(username, false), username: username, isDeployAdmin: false, message: '登录成功' });
        return;
      }

      // 3) 两者都没配置：保持开放（无登录保护）
      if (!ADMIN_PASSWORD && !users.length) {
        resetLoginFails(loginIp);
        sendJson(res, 200, { ok: true, token: issueToken('', false), username: '', isDeployAdmin: false, message: '登录成功' });
        return;
      }

      // 统一提示，避免用户名枚举；同时记录失败次数用于限速
      registerLoginFail(loginIp);
      sendJson(res, 401, { ok: false, message: '用户名或密码错误' });
    } catch (e) {
      sendJson(res, 400, { ok: false, message: '登录请求格式错误' });
    }
    return;
  }

  // 其余管理接口需要登录
  if (!isLoggedIn(req)) {
    authJson(res, needAuth());
    return;
  }

  // 服务端登出：销毁当前会话令牌（前端清本地 token 之外，让令牌立即失效，而非等 24h TTL）
  if (route === '/session' && req.method === 'DELETE') {
    const t = extractToken(req);
    if (t) sessions.delete(t);
    sendJson(res, 200, { ok: true, message: '已退出登录' });
    return;
  }

  /* 只读分享身份：只放行读操作。前端会藏起编辑入口，这里是服务端兜底——
   * 拿着分享链接直接 POST 也改不了配置。 */
  if (req.method !== 'GET' && isShareRequest(req)) {
    sendJson(res, 403, { ok: false, readonly: true, message: '这是只读分享链接，不能修改配置' });
    return;
  }

  // 健康检查
  if (route === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      port: config.server.port,
      apis: config.apis.length,
      groups: config.groups.length,
      rules: config.apis.reduce((sum, api) => sum + api.rules.length, 0),
      uptimeSec: Math.floor(process.uptime()),
      now: new Date().toISOString(),
    });
    return;
  }

  // 用户管理（仅部署管理员 MOCK_ADMIN_USER/MOCK_ADMIN_PASS 可操作；config.json 的普通 users 账号无此权限）
  if (route === '/users') {
    if (!isDeployAdmin(req)) {
      sendJson(res, 403, { ok: false, message: '仅部署管理员可管理用户' });
      return;
    }
    // 列出用户
    if (req.method === 'GET') {
      const list = (config.users || []).filter((u) => u && u.username).map((u) => ({ username: u.username }));
      sendJson(res, 200, { ok: true, users: list });
      return;
    }
    // 新增 / 改密
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(raw || '{}');
        const name = String(body.username || '').trim();
        const password = body.password;
        if (!name) { sendJson(res, 400, { ok: false, message: '用户名不能为空' }); return; }
        if (password == null || String(password) === '') { sendJson(res, 400, { ok: false, message: '密码不能为空' }); return; }
        if (name.length > 64) { sendJson(res, 400, { ok: false, message: '用户名过长（建议 <= 64 字符）' }); return; }
        if (!Array.isArray(config.users)) config.users = [];
        const idx = config.users.findIndex((u) => u && u.username === name);
        const item = { username: name, passwordHash: hashPassword(password) };
        if (idx >= 0) config.users[idx] = item; else config.users.push(item);
        saveConfig();
        sendJson(res, 200, {
          ok: true,
          message: idx >= 0 ? '已更新用户：' + name : '已新增用户：' + name,
          users: config.users.filter((u) => u && u.username).map((u) => ({ username: u.username })),
        });
      } catch (e) {
        sendJson(res, 400, { ok: false, message: '请求格式错误' });
      }
      return;
    }
    // 删除
    if (req.method === 'DELETE') {
      const name = (url.searchParams.get('username') || '').trim();
      if (!name) { sendJson(res, 400, { ok: false, message: '请指定要删除的用户名' }); return; }
      if (!Array.isArray(config.users)) config.users = [];
      const before = config.users.length;
      config.users = config.users.filter((u) => u && u.username !== name);
      if (config.users.length === before) { sendJson(res, 404, { ok: false, message: '未找到用户：' + name }); return; }
      saveConfig();
      sendJson(res, 200, {
        ok: true,
        message: '已删除用户：' + name,
        users: config.users.filter((u) => u && u.username).map((u) => ({ username: u.username })),
      });
      return;
    }
    sendJson(res, 405, { ok: false, message: '不支持的请求方法' });
    return;
  }

  // 读配置
  if (route === '/config' && req.method === 'GET') {
    if (shareTokenInvalid(req)) {
      // 失效/已撤销的分享链接：连只读数据都不返回，避免「撤销后仍能看到配置」
      sendJson(res, 403, { ok: false, shareInvalid: true, message: '分享链接已失效或已被撤销' });
      return;
    }
    /* 敏感字段不下发：users 的口令哈希、shareTokens 的令牌本身都不该出现在读接口里
     * （原先任何登录用户、乃至持只读分享令牌的人都能整份拿到，等于把撞库原料和别人的令牌一起送出去）。
     * 前端从不读这两个字段——用户清单走 /_admin/users、分享清单走 /_admin/share——
     * 保存时由 POST /config 从服务端内存 carry 回来，所以这里删掉不会丢数据。 */
    const view = Object.assign({}, config);
    delete view.users;
    delete view.shareTokens;
    sendJson(res, 200, view);
    return;
  }

  // 存配置（界面保存 / 导入）
  if (route === '/config' && req.method === 'POST') {
    try {
      const next = JSON.parse(raw);
      next.groups = normalizeGroups(next.groups);
      next.apis = (next.apis || []).map(normalizeApi);

      /* 乐观并发控制：前端提交的是它加载时看到的版本。
       * 期间有人先保存过（rev 已 +1），这次提交就基于过期快照，返回 409 让前端重新载入，
       * 避免两个浏览器各改一条规则、后保存的把先保存的静默覆盖。 */
      const currentRev = configRev();
      const incomingRev = Number(next.meta && next.meta.rev) || 0;
      if (incomingRev !== currentRev) {
        sendJson(res, 409, {
          ok: false,
          conflict: true,
          currentRev: currentRev,
          message: '配置已被其他人更新（当前版本 ' + currentRev + '，你提交的版本 ' + incomingRev
            + '），已重新载入最新配置，请基于最新内容重新修改再保存',
        });
        return;
      }

      /* 保存前先比对，落一份「谁在什么时候改了什么」。
       * 前端每次编辑都整份提交，靠服务端 diff 才能知道真实改动，
       * 也避免把「点了保存但没改任何东西」记成一次变更。 */
      const entries = diffConfig(config, next);
      const who = currentUser(req) || '';
      const ts = Date.now();

      /* 变更流水与分享令牌跟着配置走：前端每次编辑都是整份提交，
       * 而它只渲染自己关心的字段，这两样不主动带过去就会被冲掉。 */
      const carried = Array.isArray(config.changelog) ? config.changelog : [];
      const carriedTokens = Array.isArray(config.shareTokens) ? config.shareTokens : [];
      const carriedUsers = Array.isArray(config.users) ? config.users : [];
      config = next;
      config.changelog = carried.slice(0, CHANGELOG_LIMIT);
      config.shareTokens = carriedTokens;
      // users 同理：读接口已不下发它，前端整份提交里也就没有，必须由服务端补回来，否则一次保存就把账号清空
      config.users = carriedUsers;
      config.logSize = logLimitOf(next.logSize);
      config.meta = Object.assign({}, next.meta || {}, { rev: currentRev + 1 });

      stampAuthors(entries, who, ts, config.apis);
      entries.forEach((entry) => pushChangelog(Object.assign({ by: who, ts: ts }, entry)));

      try {
        await saveConfig(true);
      } catch (saveErr) {
        sendJson(res, 500, { ok: false, message: '配置保存失败：' + (saveErr && saveErr.message ? saveErr.message : saveErr) });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        message: '配置已保存并生效',
        changed: entries.length,
        rev: configRev(),
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: '配置格式错误：' + err.message });
    }
    return;
  }

  // 变更流水（可按接口过滤）
  if (route === '/changelog' && req.method === 'GET') {
    const apiId = url.searchParams.get('apiId') || '';
    const limit = Number(url.searchParams.get('limit')) || 50;
    sendJson(res, 200, { ok: true, items: changelogList(apiId, Math.min(200, Math.max(1, limit))) });
    return;
  }

  // 命中计数（内存累加，与日志轮转无关）
  if (route === '/stats' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, stats: statsSnapshot() });
    return;
  }

  /* 只读分享链接（A11）：生成 / 列出 / 撤销。
   * 写操作已被上面的「只读身份拦截」挡住，所以分享链接自己无法再生成分享链接。 */
  if (route === '/share') {
    if (req.method === 'GET') {
      /* 令牌清单只给「可编辑身份」看：持一条只读分享链接的人（或只读端口）不该能枚举全部令牌，
       * 否则拿到任意一条只读链接就等于拿到所有链接的抄本。 */
      if (req.__ro || isShareRequest(req)) {
        sendJson(res, 403, { ok: false, readonly: true, message: '只读身份不能查看分享令牌清单' });
        return;
      }
      const items = shareTokens().map((row) => ({
        token: row.token,
        label: row.label || '',
        createdBy: row.createdBy || '',
        createdAt: row.createdAt || 0,
        url: shareUrl(req, row.token),
      }));
      sendJson(res, 200, { ok: true, items: items });
      return;
    }
    if (req.method === 'POST') {
      // 免密部署且未开启只读隔离端口：分享链接会指向可编辑主端口，对方去掉 ?share= 即可编辑，存在安全漏洞 → 禁止生成
      if (!req.__ro && !needAuth() && !RO_PORT) {
        sendJson(res, 403, { ok: false, message: '免密部署未开启只读隔离端口，暂不允许生成分享链接；请部署时配置 READONLY_PORT 后重试。' });
        return;
      }
      let label = '';
      try { label = String((JSON.parse(raw || '{}') || {}).label || '').slice(0, 60); } catch (e) { label = ''; }
      const token = 'shr-' + crypto.randomUUID().replace(/-/g, '');
      const item = { token: token, label: label, createdBy: currentUser(req) || '', createdAt: Date.now() };
      shareTokens().unshift(item);
      if (config.shareTokens.length > 20) config.shareTokens.length = 20;   // 上限，别让配置文件无限膨胀
      saveConfig();
      sendJson(res, 200, {
        ok: true,
        message: '已生成只读分享链接',
        item: Object.assign({}, item, { url: shareUrl(req, token) }),
      });
      return;
    }
    if (req.method === 'DELETE') {
      const token = (url.searchParams.get('token') || '').trim();
      const before = shareTokens().length;
      config.shareTokens = shareTokens().filter((row) => row.token !== token);
      if (config.shareTokens.length === before) {
        sendJson(res, 404, { ok: false, message: '分享链接不存在' });
        return;
      }
      saveConfig();
      sendJson(res, 200, { ok: true, message: '已撤销分享链接' });
      return;
    }
    sendJson(res, 405, { ok: false, message: '不支持的请求方法' });
    return;
  }

  // 从磁盘重新读取
  if (route === '/reload' && req.method === 'POST') {
    try {
      loadConfig();
      sendJson(res, 200, { ok: true, message: '已重新读取 config.json' });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: '读取失败：' + err.message });
    }
    return;
  }

  // 日志（可按接口过滤：apiId 为空则返回全部）
  if (route === '/logs' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    const apiId = url.searchParams.get('apiId') || '';
    const source = apiId ? logs.filter((row) => row.apiId === apiId) : logs;
    sendJson(res, 200, { ok: true, total: source.length, items: source.slice(0, limit) });
    return;
  }

  /* 日志实时推送（A7）。EventSource 不能自定义请求头，令牌只能走 ?token=，
   * 这一点在 extractToken 里单独处理（仅此路由）。 */
  if (route === '/logs/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream;charset=UTF-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',      // 有反向代理时别缓冲，否则推送会被攒成一批
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    if (res.setTimeout) res.setTimeout(0);   // 长连接不能被默认请求超时掐断
    logStreams.add(res);
    // 心跳：中间设备会把长时间无数据的连接静默断开
    const beat = setInterval(() => {
      if (!sseWrite(res, 'ping', { t: Date.now() })) {
        clearInterval(beat);
        logStreams.delete(res);
      }
    }, 15000);
    req.on('close', () => { clearInterval(beat); logStreams.delete(res); });
    return;
  }

  if (route === '/logs/clear' && req.method === 'POST') {
    logs.length = 0;
    broadcastLogClear();              // 推给所有订阅者，别让他们还挂着一屏旧日志
    sendJson(res, 200, { ok: true, message: '日志已清空' });
    return;
  }

  // 试打一枪：不经过网络，直接按规则匹配，返回命中链路
  if (route === '/test' && req.method === 'POST') {
    try {
      const input = JSON.parse(raw || '{}');
      const api = config.apis.find((item) => item.id === input.apiId);
      if (!api) { sendJson(res, 404, { ok: false, message: '接口不存在' }); return; }

      const ctx = {
        method: input.method || 'POST',
        raw: input.raw || '',
        body: input.body || {},
        query: input.query || {},
        headers: input.headers || {},
        path: '/' + apiFullPath(api),
        vars: api.vars || {},
      };
      const { rule, trace } = matchRules(api, ctx);
      const response = rule ? rule.response : (api.defaultResponse || defaultResponse());
      const started = Date.now();
      const rendered = renderResponse(response, ctx);
      const costMs = Date.now() - started;

      recordHit(api.id, rule ? rule.id : null);

      /* 试打同样进请求日志：「请求日志」空态本来就写着"点上面的「发送」试打一枪"，
       * 点完什么都不出现，会让人以为按钮没生效。kind=test 用于和真实请求区分。 */
      addLog({
        kind: 'test',
        apiId: api.id,
        apiName: api.name,
        pathname: '/' + apiFullPath(api),
        method: input.method || 'POST',
        ruleId: rule ? rule.id : null,
        ruleName: rule ? rule.name : '（兜底响应）',
        status: rendered.status,
        ms: costMs,
        reqBody: input.raw || '',
        respBody: rendered.body,
        trace,
        ip: '控制台试打',
      });

      sendJson(res, 200, {
        ok: true,
        apiId: api.id,
        matchedRuleId: rule ? rule.id : null,
        matchedRuleName: rule ? rule.name : '（兜底响应）',
        hitCount: trace.filter((row) => row.hit).length,
        ms: costMs,
        trace,
        /* 试打走的是进程内直连，造不出真的网络故障 —— 这里只把「配了哪种故障」告诉界面，
         * 由界面标注「实际调用会命中故障注入」。真实验证要用 curl 打挡板地址。 */
        fault: rendered.fault || 'none',
        response: rendered,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: '试打失败：' + err.message });
    }
    return;
  }

  // 静态资源目录下的管理接口不存在
  sendJson(res, 404, { ok: false, message: '未知的管理接口：' + route });
}

/* ==========================================================================
 * 十一、静态资源
 * ========================================================================== */

const MIME_TYPES = {
  '.html': 'text/html;charset=UTF-8',
  '.css': 'text/css;charset=UTF-8',
  '.js': 'application/javascript;charset=UTF-8',
  '.json': 'application/json;charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* 静态资源判定：根路径、样式/脚本目录，或带静态后缀的文件名。
 * 挡板接口路径（如 /demo/sample）不带后缀，不会被误判。 */
const STATIC_EXTENSION = /\.(html|css|js|json|map|ico|png|jpe?g|gif|svg|woff2?|ttf)$/i;

function isStaticPath(pathname) {
  if (pathname === '/') return true;
  if (pathname.startsWith('/styles/') || pathname.startsWith('/scripts/')) return true;
  return STATIC_EXTENSION.test(pathname);
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  /* 防目录穿越。
   * 不用 `path.join(...).startsWith(PUBLIC_DIR)`：PUBLIC_DIR 没有尾分隔符时，
   * `/app/public-evil/x.css` 也会被 startsWith('/app/public') 判成「在 public 里」。
   * path.resolve 会先把 `..` 折叠干净，再和「PUBLIC_DIR + 分隔符」比，
   * 语义没有歧义：要么正好等于 PUBLIC_DIR 本身，要么必须以 PUBLIC_DIR/ 开头。 */
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  /* 静态资源用「ETag + 必须回源校验」而不是一刀切 no-store：
   * 控制台是随改随生效的工具，不能长期缓存；但每次刷新都重下前端脚本 / CSS 也没必要。
   * Cache-Control: no-cache 的语义是「可以存，但每次用之前必须回源确认」，
   * 文件没变就回 304（省掉 body），变了（mtime/size 变 → ETag 变）就回 200 新内容。
   * ETag 由 size + mtime 得出，与 nginx 的做法一致；代价是 `cp -p`（保留 mtime）
   * 这种覆盖写入不会换 ETag —— 手工编辑和部署脚本都会刷新 mtime，不受影响。 */
  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) { sendText(res, 404, 'Not Found: ' + pathname); return; }
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const cacheHeaders = { 'ETag': etag, 'Cache-Control': 'no-cache' };

    const inm = String(req.headers['if-none-match'] || '');
    const fresh = inm.split(',').some((one) => one.trim() === etag || one.trim() === '*');
    if (fresh) {
      res.writeHead(304, cacheHeaders);
      res.end();
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { sendText(res, 404, 'Not Found: ' + pathname); return; }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, Object.assign({ 'Content-Type': type }, cacheHeaders));
      res.end(data);
    });
  });
}

/* ==========================================================================
 * 十二、入口
 * ========================================================================== */

/* 解析请求 URL。注意 req.url 可能是 '//' 这种非法形式（浏览器/脚本很容易发出），
 * `new URL('//', base)` 会直接抛 TypeError —— 不能让它把进程带崩。 */
function parseRequestUrl(req) {
  const base = 'http://' + (req.headers.host || 'localhost');
  const raw = String(req.url || '/');

  // 折叠路径里的重复斜杠，且必须在 new URL 之前做：
  //   new URL('//', base)                → 抛 TypeError（曾经把整个进程带崩）
  //   new URL('//styles/x.css', base)    → 把 styles 当主机名，路径变成 /x.css
  // 查询串保持原样（里面可能合法地出现 //）。
  const mark = raw.indexOf('?');
  const rawPath = (mark < 0 ? raw : raw.slice(0, mark)).replace(/\/{2,}/g, '/');
  const rawQuery = mark < 0 ? '' : raw.slice(mark);
  const safePath = rawPath.charAt(0) === '/' ? rawPath : '/' + rawPath;

  let parsed;
  try {
    parsed = new URL(safePath + rawQuery, base);
  } catch (e) {
    parsed = new URL('/', base);
  }
  return { pathname: parsed.pathname, search: parsed.search, searchParams: parsed.searchParams };
}

async function requestHandler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    res.end();
    return;
  }

  const url = parseRequestUrl(req);

  try {
    if (url.pathname === ADMIN_PREFIX || url.pathname.startsWith(ADMIN_PREFIX + '/')) {
      res.__noStore = true;   // 管理接口一律不缓存，见 sendJson
      await handleAdmin(req, res, url);
      return;
    }
    if (isStaticPath(url.pathname)) {
      serveStatic(req, res, url.pathname);
      return;
    }
    // 浏览器自动发起的探测请求不进日志，免得把「请求日志」刷满
    if (url.pathname.startsWith('/.well-known/')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    await handleMock(req, res, url);
  } catch (err) {
    sendText(res, 500, '服务内部错误：' + (err && err.message ? err.message : err));
  }
}

function localAddresses() {
  const result = [];
  const interfaces = require('os').networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) result.push(info.address);
    });
  });
  return result;
}

function main() {
  ensureConfigFile();
  loadConfig();

  /* 监听 config.json 变更，自动重载（让 tools/add-user.js 改完即生效，无需重启）。
   * 用 200ms 防抖避免编辑器/工具写文件时的重复触发；服务端自己 saveConfig() 写的同名文件也会触发，
   * 但重载读回的是同一份内容，幂等无害。
   *
   * 注意：这里监听的是**目录**而不是文件本身。saveConfig() 走的是「写临时文件 + rename 顶替」，
   * rename 之后原来那个 inode 已经不存在了，fs.watch(CONFIG_FILE) 的监听会静默失效——
   * 表现为保存一次配置后自动重载再也不工作。监听目录并按文件名过滤可以绕开这个坑。 */
  let reloadTimer = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        loadConfig();
        console.log('[config] 检测到 config.json 变更，已自动重载（含登录用户）');
      } catch (e) {
        console.error('[config] 自动重载失败：' + (e && e.message ? e.message : e));
      }
    }, 200);
  };
  try {
    fs.watch(ROOT, (eventType, filename) => {
      const name = filename ? String(filename) : '';
      // 只认 config.json 本身；临时文件与备份不触发
      if (name !== 'config.json') return;
      // 自己刚保存触发的事件直接忽略，避免保存中途又把内存 config 重载成旧快照
      if (savingNow) return;
      scheduleReload();
    });
  } catch (e) {
    console.error('[config] 无法监听 config.json 变更（自动重载不可用，需手动重启）：' + (e && e.message ? e.message : e));
  }

  // 未捕获异常：连接层异常（客户端已断开，ECONNRESET/EPIPE 等）属良性，宽容处理；
  // 其它说明进程状态可能已损坏，记录完整堆栈后退出，避免继续服务出错数据。
  process.on('uncaughtException', (err) => {
    const benign = err && (err.code === 'ECONNRESET' || err.code === 'EPIPE'
      || err.code === 'ECANCELED' || err.syscall === 'write' || err.syscall === 'read');
    if (benign) {
      console.error('[连接层异常，已忽略]', err && err.message);
      return;
    }
    console.error('[未捕获异常，进程退出]', err && err.stack ? err.stack : err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    // 单次请求级未处理 rejection 不直接杀进程（避免一个挂掉的请求拖垮整台），
    // 但记录下来，便于从日志定位根因。
    console.error('[未处理的 Promise 异常]', err && (err.stack || err.message || err));
  });

  // 优雅关停：先结束日志 SSE 长连接，再关服务器；否则 server.close() 会一直等这些连接结束
  let shuttingDown = false;
  let roServer = null;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[' + signal + '] 收到信号，准备优雅关停…');

    /* SSE 日志流是长连接：不主动 end 的话 server.close() 会一直等，直到超时强杀 */
    logStreams.forEach((res) => {
      try { res.end('event: shutdown\ndata: {}\n\n'); } catch (e) {}
    });
    logStreams.clear();

    const servers = [server, roServer].filter(Boolean);
    if (!servers.length) process.exit(0);

    servers.forEach((srv) => {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      if (typeof srv.closeIdleConnections === 'function') srv.closeIdleConnections();
    });

    let remaining = servers.length;
    const done = () => {
      remaining -= 1;
      if (remaining === 0) {
        console.log('[shutdown] 连接已关闭，退出');
        process.exit(0);
      }
    };
    servers.forEach((srv) => srv.close(done));
    setTimeout(() => { console.log('[shutdown] 超时，强制退出'); process.exit(1); }, 3000).unref();
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  if (process.env.MOCK_SEED === '1') {
    seedHistoricalLogs();   // 演示用日志种子，仅显式开启
  }

  const port = Number(process.env.PORT || config.server.port || 18080);
  const host = process.env.HOST || config.server.host || '0.0.0.0';
  LISTEN_PORT = port;
  // 只读隔离端口：env READONLY_PORT 优先，其次 config.server.readonlyPort；0/缺省=不启用
  RO_PORT = Number(process.env.READONLY_PORT || (config.server && config.server.readonlyPort) || 0);

  const server = http.createServer(requestHandler);
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[启动失败] 端口 ' + port + ' 已被占用。');
      console.error('[启动失败] 可改用其它端口启动，例如：PORT=18081 node server.js；或先停掉占用该端口的进程。');
      process.exit(1);
      return;
    }
    console.error('[启动失败]', e && e.stack ? e.stack : e);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const lan = localAddresses();
    console.log('==========================================================');
    console.log(' Mock Server 已启动');
    console.log('   挡板入口 : http://' + (lan[0] || '127.0.0.1') + ':' + port + '/{模块}/{接口}');
    console.log('   管理界面 : http://' + (lan[0] || '127.0.0.1') + ':' + port + '/');
    console.log('   配置数量 : ' + config.apis.length + ' 个接口 / ' +
      config.apis.reduce((sum, api) => sum + api.rules.length, 0) + ' 条规则');
    // 把登录状态打出来：部署时不用猜「到底哪个账号生效了」
    if (ADMIN_PASSWORD) {
      console.log('   控制台登录 : 已启用（账号 ' + ADMIN_USER + '，来源 MOCK_ADMIN_USER / MOCK_ADMIN_PASS）');
    } else if (config.users && config.users.length) {
      console.log('   控制台登录 : 已启用（config.json 的 users：' +
        config.users.map((u) => u.username).join('、') + '）');
    } else {
      console.log('   控制台登录 : 未启用（面板任何人可访问；设 MOCK_ADMIN_PASS 即开启）');
    }
    const lang = resolvedDefaultLang();
    if (lang) {
      console.log('   默认语言   : ' + lang + '（来源 ' +
        (DEFAULT_LANG ? 'MOCK_DEFAULT_LANG' : 'config.json 的 defaultLang') +
        '；用户手动切过语言后以用户选择为准）');
    }
    lan.forEach((address) => console.log('   监听地址 : ' + address + ':' + port));
    console.log('==========================================================');

    // 只读隔离端口：分享链接专用，剥离 ?share= 也只能是只读，无法暴露/变成可编辑主端口
    if (RO_PORT && RO_PORT !== port) {
      roServer = http.createServer((req, res) => {
        req.__ro = true;
        requestHandler(req, res);
      });
      roServer.listen(RO_PORT, host, () => {
        lan.forEach((address) => console.log('   只读端口 : http://' + address + ':' + RO_PORT + '/（分享链接专用，无法编辑）'));
        console.log('==========================================================');
      });
      roServer.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          console.error('[启动失败] 只读端口 ' + RO_PORT + ' 已被占用。');
          console.error('[启动失败] 主端口已启动，但只读分享不可用；可将 READONLY_PORT 改成其它端口后重启。');
          return;
        }
        console.error('[只读端口启动失败]', e && e.message ? e.message : e);
      });
    }
  });
}

main();
