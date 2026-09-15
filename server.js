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
 *   server.js        服务本体
 *   config.json      接口与规则配置（唯一数据源）
 *   public/          管理界面静态资源
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
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
const sessions = new Map();

// 只读隔离端口（免密部署隔离用）：分享链接走独立端口，剥离 ?share= 也只能是只读，
// 永远无法暴露/变成可编辑的主端口。0 表示不启用（默认关闭，按需配置）。
let LISTEN_PORT = 0;
let RO_PORT = 0;

// 密码以 SHA-256 哈希存储：passwordHash 格式 "sha256:<hex>"
function sha256Hex(pw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// isDeployAdmin=true 表示这是「部署期环境变量管理员」(MOCK_ADMIN_USER/MOCK_ADMIN_PASS)，
// 拥有用户管理（增删改 config.json 的 users）权限；config.json 里的普通 users 账号为 false。
function issueToken(username, isDeployAdmin) {
  const token = crypto.randomUUID();
  sessions.set(token, { ts: Date.now(), username: username || '', isDeployAdmin: !!isDeployAdmin });
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

let config = { server: {}, groups: [], apis: [] };
let configMtime = 0;

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  config = JSON.parse(raw);
  config.groups = normalizeGroups(config.groups);
  config.apis = config.apis || [];
  config.apis.forEach(normalizeApi);
  configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
  return config;
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

/* 故障注入类型：none 正常 / timeout 挂起不返回 / malformed 截断响应体 / abort 直接断开连接。
 * 三种故障分别对应客户端三种可观测现象：请求超时、JSON 解析失败、连接被重置。 */
const FAULT_TYPES = ['none', 'timeout', 'malformed', 'abort'];

/** 挂起多久后放弃：故障挂起不能把 socket 永久占死，到点强制断开；可用环境变量缩短（自检用） */
const FAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.MOCK_FAULT_TIMEOUT_MS) || 30000);

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

/** 补全响应字段：老配置里没有 delayMaxMs / fault，读进来必须补齐，否则界面上是 undefined */
function normalizeResponse(response) {
  const out = Object.assign(defaultResponse(), response || {});
  out.mode = out.mode === 'script' ? 'script' : 'static';
  out.status = Number(out.status) || 200;
  out.delayMs = Math.max(0, Number(out.delayMs) || 0);
  out.delayMaxMs = Math.max(0, Number(out.delayMaxMs) || 0);
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
function saveConfig() {
  const tmpFile = CONFIG_FILE + '.tmp';
  const payload = JSON.stringify(config, null, 2);
  const fd = fs.openSync(tmpFile, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);            // 先落盘再改名，避免 rename 成功但内容还在页缓存里
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, CONFIG_FILE);
  configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
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

function addLog(entry) {
  entry.id = ++logSeq;
  if (!entry.ts) entry.ts = Date.now();          // 没传 ts 默认使用当前时间
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

/** 摘要一条规则的关键信息，用来做「改了哪条」的对比 */
function ruleFingerprint(rule) {
  return JSON.stringify({
    name: rule.name || '',
    enabled: rule.enabled !== false,
    match: rule.match || 'all',
    conditions: rule.conditions || [],
    response: rule.response || null,
  });
}

function apiFingerprint(api) {
  return JSON.stringify({
    name: api.name || '',
    enabled: api.enabled !== false,
    module: api.module || '',
    path: api.path || '',
    desc: api.desc || '',
    groupId: api.groupId || '',
    proxy: api.proxy || null,
    vars: api.vars || null,
    defaultResponse: api.defaultResponse || null,
    rules: (api.rules || []).map(ruleFingerprint),
  });
}

/**
 * 对比新旧配置，列出这次保存到底改了什么。
 * 返回 { summary, entries } —— entries 直接进变更流水，summary 给保存提示用。
 */
function diffConfig(before, after) {
  const entries = [];
  const oldApis = new Map(((before && before.apis) || []).map((api) => [api.id, api]));
  const newApis = new Map(((after && after.apis) || []).map((api) => [api.id, api]));

  newApis.forEach((api, id) => {
    const old = oldApis.get(id);
    if (!old) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.add', detail: '新增接口（含 ' + (api.rules || []).length + ' 条规则）' });
      return;
    }
    const oldRules = new Map((old.rules || []).map((rule) => [rule.id, rule]));
    const newRules = new Map((api.rules || []).map((rule) => [rule.id, rule]));
    newRules.forEach((rule, ruleId) => {
      const oldRule = oldRules.get(ruleId);
      if (!oldRule) {
        entries.push({ apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.add', detail: '新增规则「' + (rule.name || ruleId) + '」' });
      } else if (ruleFingerprint(oldRule) !== ruleFingerprint(rule)) {
        const changed = [];
        if ((oldRule.name || '') !== (rule.name || '')) changed.push('名称');
        if ((oldRule.enabled !== false) !== (rule.enabled !== false)) changed.push(rule.enabled === false ? '停用' : '启用');
        if (JSON.stringify(oldRule.conditions || []) !== JSON.stringify(rule.conditions || [])) changed.push('条件');
        if (oldRule.match !== rule.match) changed.push('匹配方式');
        if (JSON.stringify(oldRule.response || null) !== JSON.stringify(rule.response || null)) changed.push('响应');
        entries.push({
          apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.update',
          detail: '修改规则「' + (rule.name || ruleId) + '」：' + (changed.join(' / ') || '内容'),
        });
      }
    });
    oldRules.forEach((rule, ruleId) => {
      if (!newRules.has(ruleId)) {
        entries.push({ apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.remove', detail: '删除规则「' + (rule.name || ruleId) + '」' });
      }
    });
    // 规则顺序变了也算一次改动（自上而下命中即停，顺序就是语义）
    const orderBefore = (old.rules || []).map((rule) => rule.id).join(',');
    const orderAfter = (api.rules || []).map((rule) => rule.id).join(',');
    if (orderBefore !== orderAfter && (old.rules || []).length === (api.rules || []).length) {
      const sameMembers = (old.rules || []).every((rule) => newRules.has(rule.id));
      if (sameMembers) {
        entries.push({ apiId: id, apiName: api.name || '', action: 'rule.order', detail: '调整规则顺序' });
      }
    }
    if (apiFingerprint(old) === apiFingerprint(api)) return;
    if ((old.name || '') !== (api.name || '') || (old.path || '') !== (api.path || '') ||
        (old.module || '') !== (api.module || '') || (old.desc || '') !== (api.desc || '') ||
        JSON.stringify(old.proxy || null) !== JSON.stringify(api.proxy || null) ||
        JSON.stringify(old.vars || null) !== JSON.stringify(api.vars || null) ||
        JSON.stringify(old.defaultResponse || null) !== JSON.stringify(api.defaultResponse || null) ||
        (old.groupId || '') !== (api.groupId || '') ||
        (old.enabled !== false) !== (api.enabled !== false)) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.update', detail: '修改接口设置' });
    }
  });

  oldApis.forEach((api, id) => {
    if (!newApis.has(id)) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.remove', detail: '删除接口（连带 ' + (api.rules || []).length + ' 条规则）' });
    }
  });

  return entries;
}

/** 给这次改动过的接口 / 规则盖上「谁、什么时候」的戳 */
function stampAuthors(entries, user, ts) {
  const byApi = new Map();
  entries.forEach((entry) => {
    if (!byApi.has(entry.apiId)) byApi.set(entry.apiId, new Set());
    if (entry.ruleId) byApi.get(entry.apiId).add(entry.ruleId);
  });
  byApi.forEach((ruleIds, apiId) => {
    const api = (config.apis || []).find((row) => row.id === apiId);
    if (!api) return;
    api.updatedBy = user || '';
    api.updatedAt = ts;
    (api.rules || []).forEach((rule) => {
      if (ruleIds.has(rule.id)) {
        rule.updatedBy = user || '';
        rule.updatedAt = ts;
      }
    });
  });
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
 * 三、JSON 路径取值
 *   支持 a.b.c、a[0].b、a[*].b（数组通配，收集全部匹配值）
 *   取值统一返回数组：无匹配为空数组，条件判断里"任一命中即为真"
 * ========================================================================== */

const PATH_TOKEN_RE = /([^.[\]]+)|\[(\*|\d+)\]/g;

function tokenizePath(expr) {
  const text = String(expr || '').trim().replace(/^\$\.?/, '');
  const tokens = [];
  let matched;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((matched = PATH_TOKEN_RE.exec(text)) !== null) {
    if (matched[1] !== undefined) {
      tokens.push({ kind: 'key', value: matched[1] });
    } else if (matched[2] === '*') {
      tokens.push({ kind: 'wild' });
    } else {
      tokens.push({ kind: 'index', value: Number(matched[2]) });
    }
  }
  return tokens;
}

/** 从 node 上按 tokens 递归收集取值 */
function collectValues(node, tokens, out) {
  if (tokens.length === 0) {
    out.push(node);
    return;
  }
  if (node === null || node === undefined) return;

  const head = tokens[0];
  const rest = tokens.slice(1);

  if (head.kind === 'key') {
    if (Array.isArray(node)) {
      // 数组上直接取字段：自动逐元素展开（写 list.name 也能拿到所有 name）
      node.forEach((item) => collectValues(item, tokens, out));
    } else if (typeof node === 'object') {
      collectValues(node[head.value], rest, out);
    }
    return;
  }

  if (head.kind === 'index') {
    if (Array.isArray(node)) collectValues(node[head.value], rest, out);
    return;
  }

  // wild：数组逐元素 / 对象逐值
  if (Array.isArray(node)) {
    node.forEach((item) => collectValues(item, rest, out));
  } else if (typeof node === 'object') {
    Object.keys(node).forEach((key) => collectValues(node[key], rest, out));
  }
}

function pick(source, expr) {
  if (source === null || source === undefined) return [];
  if (typeof source !== 'object') {
    // 原始字符串（如 raw 请求体）只能整体比较，表达式无意义
    return [source];
  }
  const out = [];
  collectValues(source, tokenizePath(expr), out);
  return out.filter((value) => value !== undefined);
}

/* ==========================================================================
 * 四、条件匹配
 * ========================================================================== */

function compareOne(actual, op, expected) {
  const text = actual === null || actual === undefined ? '' : String(actual);
  const expectText = expected === null || expected === undefined ? '' : String(expected);

  switch (op) {
    case 'eq':
    case 'ne': {
      // 数字优先：双方都能转成数字时按数值比较（避免 "100" != 100）
      const a = Number(text), b = Number(expectText);
      const equal = (text !== '' && expectText !== '' && !Number.isNaN(a) && !Number.isNaN(b))
        ? a === b
        : text.trim() === expectText.trim();
      return op === 'eq' ? equal : !equal;
    }
    case 'contains': return text.includes(expectText);
    case 'notContains': return !text.includes(expectText);
    case 'startsWith': return text.startsWith(expectText);
    case 'endsWith': return text.endsWith(expectText);
    case 'regex':
      try { return new RegExp(expectText).test(text); } catch (e) { return false; }
    case 'in': return expectText.split(',').map((s) => s.trim()).some((s) => s === text.trim());
    case 'notIn': return !expectText.split(',').map((s) => s.trim()).some((s) => s === text.trim());
    case 'gt': return Number(text) > Number(expectText);
    case 'gte': return Number(text) >= Number(expectText);
    case 'lt': return Number(text) < Number(expectText);
    case 'lte': return Number(text) <= Number(expectText);
    default: return false;
  }
}

function evalCondition(condition, ctx) {
  const op = condition.op || 'eq';
  // 前端把"请求头"来源写作 header，上下文里存的是 headers，这里做一次映射
  const sourceKey = condition.source === 'header' ? 'headers' : condition.source;
  const values = condition.source === 'raw'
    ? [ctx.raw]
    : pick(ctx[sourceKey] || {}, condition.path);

  if (op === 'exists') {
    return values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  if (op === 'notExists') {
    return !values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  if (op === 'empty') {
    return values.length === 0 || values.every((v) => v === null || v === undefined || String(v) === '');
  }
  if (op === 'notEmpty') {
    return values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  return values.some((value) => compareOne(value, op, condition.value));
}

/** 生成判定说明，供"试打一枪"的链路展示 */
function describeMatch(rule, hit) {
  if (rule.conditions.length === 0) return '无条件 · 恒命中';
  const joiner = rule.match === 'any' ? '任一条件' : '全部条件';
  if (hit) return joiner + '满足';
  return rule.match === 'any' ? '条件均不满足' : '存在条件不满足';
}

/** 返回 { rule, trace } —— trace 记录每条规则的判定结果，供"试打一枪"展示 */
function matchRules(api, ctx) {
  const trace = [];
  for (const rule of api.rules) {
    if (!rule.enabled) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, hit: false, reason: '规则已停用' });
      continue;
    }
    const results = rule.conditions.map((condition) => evalCondition(condition, ctx));
    const hit = rule.conditions.length === 0
      ? true
      : (rule.match === 'any' ? results.some(Boolean) : results.every(Boolean));
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      hit,
      reason: describeMatch(rule, hit),
    });
    if (hit) return { rule, trace };
  }
  return { rule: null, trace };
}

/* ==========================================================================
 * 五、响应渲染
 * ========================================================================== */

/** 模板变量：{{body.x}} {{query.x}} {{header.host}} {{vars.x}} {{now}} {{ts}} {{uuid}} {{random}} */
function renderTemplate(text, ctx) {
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const key = expr.trim();
    try {
      if (key === 'now') return new Date().toLocaleString('zh-CN', { hour12: false });
      if (key === 'ts') return String(Date.now());
      if (key === 'uuid') return crypto.randomUUID();
      if (key === 'random') return String(Math.floor(Math.random() * 1000000));

      const dot = key.indexOf('.');
      if (dot > 0) {
        const head = key.slice(0, dot);
        const rest = key.slice(dot + 1);
        let node = null;
        if (head === 'body') node = ctx.body;
        else if (head === 'query') node = ctx.query;
        else if (head === 'header') node = ctx.headers;
        else if (head === 'vars') node = ctx.vars;
        if (node !== null) {
          const values = pick(node, rest);
          const value = values[0];
          if (value === undefined || value === null) return '';
          return typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
      }
      return '';
    } catch (e) {
      return whole;
    }
  });
}

const helpers = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  base64: (text) => Buffer.from(String(text), 'utf8').toString('base64'),
  pick,
};

/**
 * 生成响应。两种模式：
 *   static —— 响应体按 {{}} 模板替换
 *   script —— 响应体由一小段 JS 生成，可访问 ctx.body / ctx.query / ctx.headers / ctx.vars
 *             （内网测试工具，直接执行；不要把管理端口暴露到公网）
 */
function renderResponse(response, ctx) {
  /* 延迟：delayMaxMs > delayMs 时按区间随机（如 800~1200 模拟真实抖动），否则就是固定值。
   * 这里算出来的延迟是「本次实际等待」，试打结果与请求日志展示的也是它。 */
  const minDelay = Math.max(0, Number(response.delayMs) || 0);
  const maxDelay = Math.max(minDelay, Number(response.delayMaxMs) || 0);
  const result = {
    status: Number(response.status) || 200,
    contentType: response.contentType || 'application/json;charset=UTF-8',
    delayMs: maxDelay > minDelay ? minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1)) : minDelay,
    delayMinMs: minDelay,
    delayMaxMs: maxDelay,
    fault: FAULT_TYPES.indexOf(response.fault) >= 0 ? response.fault : 'none',
    body: '',
    error: null,
  };

  if (response.mode === 'script') {
    try {
      const fn = new Function('ctx', 'helpers', response.script || 'return {};');
      const out = fn(ctx, helpers);
      result.body = typeof out === 'string' ? out : JSON.stringify(out);
    } catch (err) {
      result.status = 500;
      result.error = String(err && err.message ? err.message : err);
      result.body = JSON.stringify({ mockError: '脚本执行失败', detail: result.error });
    }
  } else {
    result.body = renderTemplate(response.body || '', ctx);
  }
  return result;
}

/**
 * 畸形响应体：截掉一半并去掉尾部的闭合符，让客户端 JSON.parse 必然失败。
 * 用来模拟「上游返回了半截 JSON」这种真实故障，客户端应当表现为解析错误而不是拿到空对象。
 */
function malformedBody(body) {
  const text = String(body === undefined || body === null ? '' : body);
  const cut = Math.max(1, Math.floor(text.length / 2));
  return text.slice(0, cut).replace(/[\s}\]]+$/, '');
}

/* ==========================================================================
 * 六、请求解析
 * ========================================================================== */

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
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

function findApi(pathname) {
  const target = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  for (const api of config.apis) {
    if (!api.enabled) continue;
    if (apiFullPath(api) === target) return api;
  }
  return null;
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

function proxyPass(api, req, url, raw) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(api.proxy.url);
    } catch (e) {
      reject(new Error('代理地址不合法：' + api.proxy.url));
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
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => resolve({
        status: proxyRes.statusCode,
        headers: proxyRes.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('代理请求超时')));
    proxyReq.on('error', reject);
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
  const api = findApi(url.pathname);

  if (!api) {
    const message = '模块/接口：' + url.pathname + '，未配置 mock';
    addLog({ kind: 'unmatched', pathname: url.pathname, method: req.method, status: 500, ms: Date.now() - started, reqBody: raw, respBody: message, ip: clientIp(req) });
    sendText(res, 500, message);
    return;
  }

  // 代理优先：开了代理就直接透传真实服务（不参与规则匹配）。
  // 上游地址接口没填则继承分组默认（A9），两边都空才认为没配代理。
  if (api.proxy && api.proxy.enable && effectiveProxyUrl(api)) {
    try {
      const result = await proxyPass(api, req, url, raw);
      addLog({ kind: 'proxy', apiId: api.id, apiName: api.name, pathname: url.pathname, method: req.method, status: result.status, ms: Date.now() - started, reqBody: raw, respBody: result.body, ip: clientIp(req) });
      res.writeHead(result.status, Object.assign({}, result.headers));
      res.end(result.body);
    } catch (err) {
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

  if (rendered.delayMs > 0) await sleep(rendered.delayMs);

  if (fault === 'abort') {
    if (res.socket) res.socket.destroy();      // 客户端表现为连接被重置（ECONNRESET）
    return;
  }
  if (fault === 'timeout') {
    await sleep(FAULT_TIMEOUT_MS);             // 挂起不返回，客户端表现为请求超时
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
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress)
    || '-';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // 只读端口安全策略：必须携带有效分享令牌才允许查看内容；
      // 无令牌或令牌失效时，前端应展示「需要分享链接」提示页，而非完整的只读配置面板。
      // 注意：前端发起 /_admin/auth 时，分享令牌放在 Authorization: Bearer 头里（页面 URL 的 ?share=
      //       仅用于初始识别，fetch 的 auth 请求 URL 是 /_admin/auth 不带 ?share=）；因此需同时
      //       检查 req.url 的 ?share= 参数与 Bearer 头，二者任一为有效令牌即可。
      let hasValidShare = !req.__ro;
      if (req.__ro && !hasValidShare) {
        const urlHit = /[?&]share=([^&]+)/.exec(req.url || '');
        const urlToken = urlHit ? decodeURIComponent(urlHit[1]) : '';
        const bearerToken = extractToken(req); // 读 Authorization: Bearer <shareToken>
        const token = urlToken || bearerToken;
        hasValidShare = !!token && !!findShareToken(token);
      }
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

  // 登录
  if (route === '/login' && req.method === 'POST') {
    try {
      const input = JSON.parse(raw || '{}');
      const username = (input.username || '').trim();
      const password = (input.password || '').trim();

      // 1) 环境变量指定的管理员（部署时最常用）优先校验
      if (ADMIN_PASSWORD) {
        // 用户名放宽：允许省略（旧版前端只发密码），也允许等于 MOCK_ADMIN_USER
        const userOk = (username === '' || username === ADMIN_USER);
        if (userOk && password === ADMIN_PASSWORD) {
          sendJson(res, 200, { ok: true, token: issueToken(ADMIN_USER, true), username: ADMIN_USER, isDeployAdmin: true, message: '登录成功' });
          return;
        }
      }

      // 2) config.json 的 users 数组（可多个账号）
      const users = (config.users || []).filter((u) => u && u.username);
      const hit = users.find((u) => u.username === username && sha256Hex(password) === u.passwordHash);
      if (hit) {
        sendJson(res, 200, { ok: true, token: issueToken(username, false), username: username, isDeployAdmin: false, message: '登录成功' });
        return;
      }

      // 3) 两者都没配置：保持开放（无登录保护）
      if (!ADMIN_PASSWORD && !users.length) {
        sendJson(res, 200, { ok: true, token: issueToken('', false), username: '', isDeployAdmin: false, message: '登录成功' });
        return;
      }

      // 统一提示，避免用户名枚举
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
        const item = { username: name, passwordHash: sha256Hex(password) };
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
    sendJson(res, 200, config);
    return;
  }

  // 存配置（界面保存 / 导入）
  if (route === '/config' && req.method === 'POST') {
    try {
      const next = JSON.parse(raw);
      next.groups = normalizeGroups(next.groups);
      next.apis = (next.apis || []).map(normalizeApi);

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
      config = next;
      config.changelog = carried.slice(0, CHANGELOG_LIMIT);
      config.shareTokens = carriedTokens;
      config.logSize = logLimitOf(next.logSize);

      stampAuthors(entries, who, ts);
      entries.forEach((entry) => pushChangelog(Object.assign({ by: who, ts: ts }, entry)));

      saveConfig();
      sendJson(res, 200, {
        ok: true,
        message: '配置已保存并生效',
        changed: entries.length,
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

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, path.normalize(relative));

  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) { sendText(res, 403, 'Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { sendText(res, 404, 'Not Found: ' + pathname); return; }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 控制台是随改随生效的工具，禁止缓存，避免改完前端还看到旧页面
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, must-revalidate' });
    res.end(data);
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
      serveStatic(res, url.pathname);
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
      scheduleReload();
    });
  } catch (e) {
    console.error('[config] 无法监听 config.json 变更（自动重载不可用，需手动重启）：' + (e && e.message ? e.message : e));
  }

  // 兜底：任何一个请求处理里漏出的异常都不该让挡板整台挂掉——联调中途服务没了最难受
  process.on('uncaughtException', (err) => {
    console.error('[未捕获异常，进程继续运行]', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[未处理的 Promise 异常，进程继续运行]', err && err.stack ? err.stack : err);
  });

  if (process.env.MOCK_SEED === '1') {
    seedHistoricalLogs();   // 演示用日志种子，仅显式开启
  }

  const port = Number(process.env.PORT || config.server.port || 18080);
  const host = process.env.HOST || config.server.host || '0.0.0.0';
  LISTEN_PORT = port;
  // 只读隔离端口：env READONLY_PORT 优先，其次 config.server.readonlyPort；0/缺省=不启用
  RO_PORT = Number(process.env.READONLY_PORT || (config.server && config.server.readonlyPort) || 0);

  const server = http.createServer(requestHandler);
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
      const roServer = http.createServer((req, res) => {
        req.__ro = true;
        requestHandler(req, res);
      });
      roServer.listen(RO_PORT, host, () => {
        lan.forEach((address) => console.log('   只读端口 : http://' + address + ':' + RO_PORT + '/（分享链接专用，无法编辑）'));
        console.log('==========================================================');
      });
      roServer.on('error', (e) => {
        console.error('[只读端口启动失败]', e && e.message ? e.message : e);
      });
    }
  });
}

main();
