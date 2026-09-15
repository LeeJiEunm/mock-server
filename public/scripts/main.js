/* ============================================================================
 * main.js —— 控制台逻辑
 * 纯原生 JS，无框架、无构建。所有状态留在内存，改动即写回服务端 config.json。
 * ========================================================================== */

'use strict';

/* ------------------------------ 全局状态 ------------------------------ */

const state = {
  config: null,
  activeApiId: null,
  logs: [],
  autoRefresh: true,
  hitRuleId: null,        // 试打/日志点选后需要高亮的规则
  drawerMode: 'rule',     // rule | api
  editingRuleId: null,    // null 表示新增
  editingApiId: null,     // null 表示新增
  /* 「复制接口」时原件的 id（null = 不是在复制）。两处要用它：
   *   ① 保存时把副本插在**原件当前下标的正下方**（不是 push 到末尾）；
   *   ② 判断"保存后这条会不会收不到请求"时，前缀要按「原件及其之前的条目」算（见 wouldBeShadowed）。
   * 抽屉关闭时清掉 —— 不清的话下一次「新增接口」会被误判成复制。 */
  duplicatingFromId: null,
  themePref: 'dark',      // auto | dark | light（默认沿用原来的暗色，不擅自跟着系统变）
  collapsedGroups: new Set(),  // 折叠起来的分组 id（持久化在 localStorage）
  /* 批量模式内的折叠集：进模式时清空（= 全展开），退出时整份丢弃。
   * 与 collapsedGroups 分开是有意的 —— 若进模式时快照、退出时还原，用户在模式中途
   * 关掉标签页就会把「全展开」写进 localStorage，把他整理好的折叠结构冲掉。
   * 渲染期按 state.selectMode 二选一，所以退出天然还原，不需要快照/还原代码。 */
  batchCollapsed: new Set(),
  selectedApiIds: new Set(),   // 侧栏勾选的接口 id（用于批量操作）
  tryDraft: null,         // 试打面板里用户还没发送的输入，重渲染后要原样还回去
  tryRows: { query: [], header: [] },  // 试打的 URL 参数 / 请求头行（结构化输入，见 B1）
  lastTry: null,          // 最近一次试打结果，重渲染后要重新画上去
  leftCollapsed: false,   // 左侧接口栏是否折叠
  rightCollapsed: false,  // 右侧日志栏是否折叠
  searchQuery: '',        // 接口搜索关键词
  filterStatus: 'all',    // all | enabled | disabled
  filterGroupIds: [],     // 多选分组过滤，空=全部
  showFilterPanel: true, // 是否展开过滤面板（默认展开）
  selectMode: false,      // 是否进入批量选择模式
  logApiOnly: false,      // 日志是否只显示当前选中接口
  stats: null,            // 规则命中计数快照（服务端内存累加器下发）
  auth: { required: false, loggedIn: false, token: readLocal('mockServer.token', ''), username: '', isDeployAdmin: false, readonly: false, fromShare: false, shareRequired: false }, // 登录态
};

/* 没有归属分组的接口统一挂到这个"伪分组"下（它不是一个真实分组，不可重命名/删除） */
const UNGROUPED = '__ungrouped__';
let dragGroupId = null;
let dragApiId = null;
/* 搜索框的防抖定时器句柄：清空搜索（Esc / 空态按钮 / 定位时清筛选）要能把它取消掉 */
let searchTimer = 0;
const THEME_KEY = 'mockServer.theme';
const COLLAPSE_KEY = 'mockServer.collapsedGroups';
const SIDEBAR_KEY = 'mockServer.sidebar';
const TOKEN_KEY = 'mockServer.token';
const LANG_KEY = 'mockServer.lang';

/* 搜索结果平铺列表的两个阈值，集中在这里方便调：
 * - 防抖：接口量级一两百条时逐字重渲染会明显卡顿，等用户停手再渲染；
 * - 上限：一次最多画多少张结果卡，多余的折成「还有 N 条」尾条（避免几百个 DOM 节点）。 */
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_RENDER_LIMIT = 100;

/* ⚠️ 下面这几张映射表里的文案，值**必须是 i18n key**（或纯符号），不能在模块顶层直接 t()。
 * 模块级常量只在脚本加载时求值一次，切语言后不会重算 —— 那正是「切到 English 后
 * 规则的运算符/取值位置、变量芯片仍然显示中文」的根因。取值统一走 labelOf()。 */
const OP_LABEL = {
  eq: '=', ne: '≠',
  contains: 'op.contains', notContains: 'op.notContains',
  startsWith: 'op.startsWith', endsWith: 'op.endsWith', regex: 'op.regex',
  in: 'op.in', notIn: 'op.notIn',
  gt: '>', gte: '≥', lt: '<', lte: '≤',
  exists: 'op.exists', notExists: 'op.notExists', empty: 'op.empty', notEmpty: 'op.notEmpty',
};

const OP_WITHOUT_VALUE = ['exists', 'notExists', 'empty', 'notEmpty'];
const SOURCE_LABEL = { body: 'source.body', query: 'source.query', header: 'source.header', raw: 'source.raw' };
const SOURCE_OPTIONS = ['body', 'query', 'header', 'raw'];

const PATH_PLACEHOLDER = {
  body: 'srcHint.body',
  query: 'srcHint.query',
  header: 'srcHint.header',
  raw: 'srcHint.raw',
};

/** 取映射表里的文案：带点号的值当 i18n key 翻译（'op.in'），纯符号原样返回（'≥'）。
 *  渲染时调用，所以切语言后重渲染即可拿到新语言。 */
function labelOf(map, key, fallback) {
  const value = map[key];
  if (value === undefined) return fallback === undefined ? key : fallback;
  return value.indexOf('.') > 0 ? t(value) : value;
}

/** JS 拼出来的节点顺手挂上 i18n 属性，让「抽屉已经开着时切语言」也能就地刷新
 *  （applyI18n 按属性把 textContent / placeholder 刷一遍，不需要重渲染 → 不会丢用户输入）。
 *  纯符号（'≥'）或没有 key 的项返回空串。attr 默认 data-i18n。 */
function i18nAttr(key, attr) {
  if (typeof key !== 'string' || key.indexOf('.') <= 0) return '';
  return ' ' + (attr || 'data-i18n') + '="' + escapeHtml(key) + '"';
}

/* 离线预览用的示例配置（与 config.json 同构，仅供没连到服务端时看界面用） */
const SAMPLE_CONFIG_URL = 'sample-config.json';

/* ------------------------------ 本地偏好存储 ------------------------------
 * localStorage 在 file:// 或隐私模式下可能直接抛异常，统一包一层，
 * 存不上就算了，绝不能因为"记不住主题"把整个控制台带崩。 */

function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) { /* 存不上就只影响本次记忆，忽略 */ }
}

function demoResponse(status, body, delayMs) {
  return {
    mode: 'static',
    status: status,
    delayMs: delayMs || 0,
    contentType: 'application/json;charset=UTF-8',
    body: body,
    script: '',
  };
}

/* 最后一道兜底：连服务端、连 sample-config.json 都取不到时（典型是用 file:// 直接打开本文件），
 * 用这份极简示例把界面填满，保证"打开就能看到长什么样"。真实使用请通过服务端访问。 */
const INLINE_SAMPLE = {
  logSize: 0,
  apis: [{
    id: 'demo-sample',
    name: '示例：条件响应',
    module: 'demo',
    path: 'sample',
    enabled: true,
    desc: '示例数据（离线预览）。根据请求体字段 code 返回不同响应。',
    proxy: { enable: false, url: '' },
    vars: {},
    rules: [
      {
        id: 'd1',
        name: 'code=500 → 返回 500',
        enabled: true,
        match: 'all',
        conditions: [{ source: 'body', path: 'code', op: 'eq', value: '500' }],
        response: demoResponse(500, '{"code":500,"message":"示例：服务异常"}'),
      },
      {
        id: 'd2',
        name: 'code=404 → 返回 404',
        enabled: true,
        match: 'all',
        conditions: [{ source: 'body', path: 'code', op: 'eq', value: '404' }],
        response: demoResponse(404, '{"code":404,"message":"示例：资源不存在"}'),
      },
      {
        id: 'd3',
        name: 'URL 带 slow=1 → 延迟 3 秒',
        enabled: true,
        match: 'all',
        conditions: [{ source: 'query', path: 'slow', op: 'eq', value: '1' }],
        response: demoResponse(200, '{"code":0,"message":"示例：模拟超时"}', 3000),
      },
      {
        id: 'd4',
        name: '默认：成功响应并回显 code',
        enabled: true,
        match: 'all',
        conditions: [],
        response: demoResponse(200, '{"code":0,"message":"ok","data":{"requestCode":"{{body.code}}","echo":"{{body}}"}}'),
      },
    ],
    defaultResponse: demoResponse(200, '{"code":0,"message":"示例：未命中任何规则"}'),
  }],
};

/* A10 · 从模板新建接口：把示例沉淀成可复用的起点，降低新人写规则的门槛。
 * 模板只决定「初始草稿」，保存时仍走正常校验（路径必填等），不会绕过任何既有规则。 */
const API_TEMPLATES = [
  {
    value: 'blank',
    labelKey: 'api.tpl.blank',
    descKey: 'api.tpl.blankDesc',
    build: () => ({
      id: 'api-' + Date.now().toString(36),
      name: '', module: '', path: '', method: 'POST', enabled: true,
      desc: '', proxy: { enable: false, url: '' }, vars: {}, rules: [],
      defaultResponse: { mode: 'static', status: 200, delayMs: 0, delayMaxMs: 0, fault: 'none', contentType: 'application/json;charset=UTF-8', body: '{}', script: '' },
    }),
  },
  {
    value: 'echo',
    labelKey: 'api.tpl.echo',
    descKey: 'api.tpl.echoDesc',
    build: () => ({
      id: 'api-' + Date.now().toString(36),
      name: t('api.tpl.echo'), module: '', path: 'echo', method: 'POST', enabled: true,
      desc: t('api.tpl.echoDesc'), proxy: { enable: false, url: '' }, vars: {},
      rules: [],
      defaultResponse: { mode: 'static', status: 200, delayMs: 0, delayMaxMs: 0, fault: 'none', contentType: 'application/json;charset=UTF-8', body: '{{body}}', script: '' },
    }),
  },
  {
    value: 'conditional',
    labelKey: 'api.tpl.conditional',
    descKey: 'api.tpl.conditionalDesc',
    build: () => ({
      id: 'api-' + Date.now().toString(36),
      name: t('api.tpl.conditional'), module: '', path: 'conditional', method: 'POST', enabled: true,
      desc: t('api.tpl.conditionalDesc'), proxy: { enable: false, url: '' }, vars: {},
      rules: [
        {
          id: 'r' + Date.now().toString(36) + 'a', name: 'code=500 → 返回 500', enabled: true,
          match: 'all', conditions: [{ source: 'body', path: 'code', op: 'eq', value: '500' }],
          response: { mode: 'static', status: 500, delayMs: 0, delayMaxMs: 0, fault: 'none', contentType: 'application/json;charset=UTF-8', body: '{"code":500,"message":"服务异常"}', script: '' },
        },
      ],
      defaultResponse: { mode: 'static', status: 200, delayMs: 0, delayMaxMs: 0, fault: 'none', contentType: 'application/json;charset=UTF-8', body: '{"code":0,"message":"ok"}', script: '' },
    }),
  },
];

/** 「＋接口」入口：先选模板，再打开预填好的抽屉。空白模板也是其中一个选项。 */
async function addApiFromTemplate() {
  if (!ensureEditable()) return;
  const picked = await askChoice({
    title: t('api.fromTemplate'),
    message: '',
    cancelText: t('prompt.cancel'),
    options: API_TEMPLATES.map((tp) => ({ value: tp.value, label: t(tp.labelKey), desc: t(tp.descKey) })),
  });
  if (!picked) return;
  const tp = API_TEMPLATES.find((x) => x.value === picked);
  if (!tp) return;
  openApiDrawer(null, tp.build());
}

/* ------------------------------ 小工具 ------------------------------ */

const $ = (selector) => document.querySelector(selector);

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettyJson(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return text;
  }
}

/* 日志时间：始终显示「年-月-日 时:分:秒」，避免隔天后无法分辨是哪天发生的。
 *   即便日志是今天产生的，也带完整日期——这样配合 MOCK_SEED 注入的历史日志，
 *   用户一眼就能看出每条是哪天的，可视化效果比"当天精简"更直观。 */
function timeText(ts) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function uptimeText(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
}

/* ---- 运行时长实时走秒 ---- */
let serverStartMs = 0;  // 服务端启动时刻（由 refreshHealth 校准）
function tickUptime() {
  if (!serverStartMs) return;
  const el = document.getElementById('statUptime');
  if (!el) return;
  const elapsed = Math.floor((Date.now() - serverStartMs) / 1000);
  el.textContent = uptimeText(elapsed);
}

async function api(path, options) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.auth.token) headers.Authorization = 'Bearer ' + state.auth.token;
  const response = await fetch(path, Object.assign({ headers: headers }, options));
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    payload = { ok: false, message: text };
  }
  // 登录接口自己的 401 是「用户名或密码错误」，属于业务失败，原样交给调用方处理
  const isLoginCall = String(path).indexOf('/login') >= 0;
  // 其他接口 401 = 登录态失效，清 token 并引导重新登录
  if (response.status === 401 && !isLoginCall) {
    state.auth.token = '';
    state.auth.loggedIn = false;
    writeLocal(TOKEN_KEY, '');
    showLogin();
    return { ok: false, message: t('login.expired') };
  }
  return payload;
}

/** 是否处于「需要登录但还没登录」的状态（此时不该再打后台轮询接口，否则每次都是 401） */
function needsLogin() {
  return !!(state.auth.required && !state.auth.token);
}

function toast(message, kind) {
  const host = $('#toastHost');
  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'bad' ? ' is-bad' : kind === 'ok' ? ' is-ok' : '');
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function activeApi() {
  if (!state.config) return null;
  return state.config.apis.find((item) => item.id === state.activeApiId) || null;
}

function apiFullPath(item) {
  return [item.module, item.path].filter(Boolean).join('/').replace(/^\/+|\/+$/g, '');
}

/* 复制接口时给副本算一个「下一个可用路径」。
 *
 * 为什么是"改路径"而不是"保留原路径 + 打警示"（前序设计稿 §2.2 的 E2 决策已被推翻，见
 * docs/接口复制改造设计.md）：实测用户实例里 14 条同路径副本的内容指纹**两两全等** ——
 * 这个功能历史上从未产出过变体。"保留原路径"意味着**默认结果就是一条收不到请求的死条目**，
 * 再靠一句黄字去对抗省力本能；预填可用值则让"什么都不做"直接得到正确结果，
 * 想留原路径的人手动改回去即可（而且看得见自己在改什么）。
 *
 * 只改 path 段、不动 module：模块名是挡板入口的分段，改了它上游透传路径也会跟着变。
 * 判定走「全表比对 apiFullPath」，**不看 enabled、也不看 method**：
 *   - 不看 enabled：停用项一旦启用就会冲突，路径是业务键，同一路径只该有一份配置；
 *   - 不看 method：服务的 findApi() 只比路径，method 完全不参与匹配（server.js:850-856）。
 * 口径与导入判重的 keyOf（mergeImported）一致。 */
function nextAvailablePath(item) {
  const module = String(item.module || '').replace(/^\/+|\/+$/g, '');
  const basePath = String(item.path || '').replace(/^\/+|\/+$/g, '');
  if (!basePath) return '';
  const taken = new Set(((state.config && state.config.apis) || []).map((api) => apiFullPath(api)));
  const isTaken = (path) => taken.has([module, path].filter(Boolean).join('/'));
  let candidate = basePath + '-copy';
  let n = 2;
  while (isTaken(candidate)) {
    candidate = basePath + '-copy-' + n;
    n += 1;
  }
  return candidate;
}

/* 内容指纹：判断「这条被遮蔽的条目和生效的那条是不是一模一样」。
 *
 * 用于把遮蔽拆成两种**出路完全不同**的情况（见 docs/接口复制改造设计.md §4 决策 3）：
 *   内容全同 → 纯冗余，删/停即可；
 *   内容不同 → 可能是「忘了改路径的变体」，改路径就能救活。
 * 与 server.js:410-423 的 apiFingerprint 同构，但**去掉 name**：名字不同而内容相同仍是冗余，
 * 让名字参与指纹的话，「（副本）」这种必然不同的名字会把所有重复项都漏掉。
 * **保留 groupId 是有意的**：分组不同说明用户有意归档，不该被提示成"可以删的重复项"。 */
function apiContentFingerprint(item) {
  return JSON.stringify({
    enabled: item.enabled !== false,
    module: item.module || '',
    path: item.path || '',
    desc: item.desc || '',
    groupId: item.groupId || '',
    proxy: item.proxy || null,
    vars: item.vars || null,
    defaultResponse: item.defaultResponse || null,
    rules: (item.rules || []).map((rule) => ({
      name: rule.name || '',
      enabled: rule.enabled !== false,
      match: rule.match || 'all',
      conditions: rule.conditions || [],
      response: rule.response || null,
    })),
  });
}

/* 判断「这条接口保存后会不会收不到请求」，用于抽屉里的实时提示与保存按钮改名。
 *
 * 触发条件是「保存后这条能不能被命中」，**不是「路径是否与原路径相同」** —— 两者不等价：
 * 路径与原路径相同、但原件已停用，这条会**接管生效**，此时说"不会命中"是撒谎。
 *
 * 怎么算：只看「保存后排在它前面」的那些条目里，有没有**启用的同路径**接口。
 * 不把 draft 真的插进 state.config（那会动到用户数据），而是按落点算前缀 ——
 * 编辑 → 原下标之前的；复制 → 原件及其之前的；新增 → 全部。
 *
 * 手写"比较下标"的版本边界多、而且每条都真会出 bug：
 *   - 编辑一条正在生效的接口、路径一字未改 → 占用者是它自己，不能算冲突；
 *   - 抽屉里把启用关掉 → 它根本不参与匹配，"不会命中"是废话（卡片上已有「已停用」tag）；
 *   - 占用者排在它后面 → 这条才是生效者。
 * 返回占用者（null = 会命中）。 */
function wouldBeShadowed(draft) {
  if (!draft || draft.enabled === false) return null;
  const key = apiFullPath(draft);
  if (!key) return null;
  const all = (state.config && state.config.apis) || [];
  let before;
  if (state.editingApiId) {
    const idx = all.findIndex((row) => row.id === state.editingApiId);
    before = all.slice(0, idx < 0 ? 0 : idx);
  } else if (state.duplicatingFromId) {
    const idx = all.findIndex((row) => row.id === state.duplicatingFromId);
    before = all.slice(0, idx < 0 ? all.length : idx + 1);
  } else {
    before = all;
  }
  return before.find((row) => row.id !== draft.id && row.enabled !== false && apiFullPath(row) === key) || null;
}

/**
 * 把导入的配置合进本地（A2）。返回 { config, summary }，不落库，调用方决定要不要用。
 *
 * 冲突判定：先按 id，再按「模块 + 路径 + 方法」——
 * 同事导出的文件里同一个接口 id 不一定一样，只比 id 会把同一接口当成新接口重复导入。
 *
 * strategy：
 *   skip      保留本地，只导入新增的
 *   overwrite 冲突项用文件里的替换（沿用本地 id，勾选态与外部引用不失效）
 *   rename    冲突项以新 id 并存，名称加「（导入）」后缀
 */
function mergeImported(local, incoming, strategy) {
  const base = local || { groups: [], apis: [] };
  const groups = (base.groups || []).slice();
  const apis = (base.apis || []).slice();
  const summary = { added: 0, overwritten: 0, skipped: 0, renamed: 0, groupsAdded: 0, groupsSkipped: 0 };
  const keyOf = (api) => (apiFullPath(api) + '|' + (api.method || '')).toLowerCase();

  // 分组按名字判重：id 在不同机器上必然不同，按 id 判会变成「每导入一次就多一批同名分组」
  const groupIdMap = {};
  (incoming.groups || []).forEach((group) => {
    const hit = groups.find((row) => row.name === group.name);
    if (hit) {
      groupIdMap[group.id] = hit.id;
      summary.groupsSkipped += 1;
    } else {
      groups.push(group);
      groupIdMap[group.id] = group.id;
      summary.groupsAdded += 1;
    }
  });

  (incoming.apis || []).forEach((api) => {
    const copy = JSON.parse(JSON.stringify(api));
    if (copy.groupId && groupIdMap[copy.groupId]) copy.groupId = groupIdMap[copy.groupId];

    let index = apis.findIndex((row) => row.id === copy.id);
    if (index < 0) index = apis.findIndex((row) => keyOf(row) === keyOf(copy));

    if (index < 0) {
      apis.push(copy);
      summary.added += 1;
      return;
    }
    if (strategy === 'skip') {
      summary.skipped += 1;
      return;
    }
    if (strategy === 'overwrite') {
      copy.id = apis[index].id;
      apis[index] = copy;
      summary.overwritten += 1;
      return;
    }
    copy.id = 'api-' + Math.random().toString(36).slice(2, 8);
    copy.name = (copy.name || '') + t('import.renameSuffix');
    apis.push(copy);
    summary.renamed += 1;
  });

  return { config: Object.assign({}, base, { groups: groups, apis: apis }), summary: summary };
}

function serviceBase() {
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  return 'http://<服务器IP>:18080';
}

function apiUrl(item) {
  return serviceBase() + '/' + apiFullPath(item);
}

/* 复制到剪贴板。
 * navigator.clipboard 只在「安全上下文」下有值（https 或 localhost）；
 * 从 http://内网IP:18080 打开时它是 undefined —— 而测试机上正是这么访问的，
 * 所以必须留一条 textarea + execCommand 的降级路径，否则「复制」按钮直接失效。 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 掉到下面的降级方案 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/* ------------------------------ 配置读写 ------------------------------ */

async function loadConfig() {
  let data = null;

  try {
    data = await api('/_admin/config');
    if (!data || !Array.isArray(data.apis)) throw new Error('返回结构不对');
    state.offline = false;
  } catch (e) {
    data = null;
  }

  if (!data) {
    // 连不上服务端（典型场景：在设计器/面板里直接打开 index.html）→ 用示例数据把界面渲染完整
    state.offline = true;
    try {
      data = await api(SAMPLE_CONFIG_URL);
    } catch (e) {
      data = null;
    }
    if (!data || !Array.isArray(data.apis)) data = JSON.parse(JSON.stringify(INLINE_SAMPLE));
  }

  state.config = data;
  state.config.apis = state.config.apis || [];
  state.config.groups = state.config.groups || [];
  if (!state.config.apis.some((item) => item.id === state.activeApiId)) {
    state.activeApiId = state.config.apis.length ? state.config.apis[0].id : null;
  }
  state.tryDraft = null;
  state.lastTry = null;
  $('#offlineNotice').hidden = !state.offline;
  renderAll();
  await loadStats();
}

/* 失效/已撤销的分享链接：不加载任何配置（连只读数据都不给），仅展示「链接已失效」提示。
 * 这样「撤销分享」才真正生效——对方打开旧链接既看不到配置、也不能编辑。 */
function renderShareInvalid() {
  // 失效链接无只读内容可看，只读横幅（"已失效，无法查看或编辑"）与下方全屏提示重复，直接隐藏横幅；
  // 保留 body.readonly 以继续隐藏顶栏的编辑入口（与只读视图一致，不暴露任何可改入口）
  const banner = $('#readonlyBanner');
  if (banner) banner.hidden = true;
  const ws = $('#workspace');
  if (ws) {
    ws.innerHTML = ''
      + '<div class="share-invalid">'
      + '  <div class="share-invalid__icon">🚫</div>'
      + '  <h2 class="share-invalid__title">' + escapeHtml(t('share.invalidTitle')) + '</h2>'
      + '  <p class="share-invalid__desc">' + escapeHtml(t('share.invalidDesc')) + '</p>'
      + '</div>';
  }
}

/** 只读端口无有效分享令牌：展示「需要分享链接」提示页，不加载任何配置内容 */
function renderShareRequired() {
  const banner = $('#readonlyBanner');
  if (banner) banner.hidden = true;
  const ws = $('#workspace');
  if (ws) {
    ws.innerHTML = ''
      + '<div class="share-invalid">'
      + '  <div class="share-invalid__icon">🔒</div>'
      + '  <h2 class="share-invalid__title">' + escapeHtml(t('share.requiredTitle')) + '</h2>'
      + '  <p class="share-invalid__desc">' + escapeHtml(t('share.requiredDesc')) + '</p>'
      + '</div>';
  }
}

/* 规则命中计数：服务端内存累加器，只在「进入界面 / 切换接口 / 试打之后」拉一次。
 * 不跟着 3 秒日志轮询一起刷 —— 命中数变化没那么快，频繁请求只会让界面抖。 */
async function loadStats(silent) {
  if (state.offline) { state.stats = null; return; }
  try {
    const result = await api('/_admin/stats');
    state.stats = result && result.ok ? result.stats : null;
  } catch (e) {
    state.stats = null;
  }
  // silent：只把已有徽标原地更新，不重建工作区（避免打断正在编辑的输入）
  if (silent) updateHitBadges(); else renderWorkspace();
}

/** 取某条规则的命中次数（null = 无数据，0 = 确实从未命中） */
function hitCountOf(apiId, ruleId) {
  const api = state.stats && state.stats[apiId];
  if (!api || !api.rules) return null;
  const item = api.rules[ruleId || ''];
  return item ? item.count : 0;
}

async function persist(successMessage) {
  if (state.offline) {
    toast(t('offline.toast'), 'bad');
    return;
  }
  const result = await api('/_admin/config', { method: 'POST', body: JSON.stringify(state.config) });
  if (result.ok) {
    if (successMessage) toast(successMessage, 'ok');
    renderTopbarStats();
  } else {
    toast('保存失败：' + (result.message || '未知错误'), 'bad');
  }
}

/* ------------------------------ 主题 ------------------------------ */

/** 六态主题：3 色（白天/夜晚/深夜）× 2 渐变档（渐变/纯色）
 *  pref 值：day / night / deepnight / day-flat / night-flat / deepnight-flat
 *  解析为 data-theme（颜色）+ data-aurora（渐变开关）两个正交维度 */
function resolveTheme(pref) {
  const base = pref.replace('-flat', '');
  return base === 'day' ? 'light' : base;
}

function isFlat(pref) {
  return pref.endsWith('-flat');
}

function applyTheme(pref) {
  state.themePref = pref;
  const resolved = resolveTheme(pref);
  const aurora = isFlat(pref) ? 'off' : 'on';
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-aurora', aurora);
  document.documentElement.setAttribute('data-theme-pref', pref);

  // 让浏览器原生控件（滚动条等）也跟着换配色：夜晚/深夜对浏览器来说都是 dark
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? 'light' : 'dark');

  updateThemeToggle();
  writeLocal(THEME_KEY, pref);
}

function initTheme() {
  const saved = readLocal(THEME_KEY, 'deepnight');
  // 兼容旧值（day/night/deepnight）和新值（*-flat）
  const valid = ['day','night','deepnight','day-flat','night-flat','deepnight-flat'];
  applyTheme(valid.indexOf(saved) >= 0 ? saved : 'deepnight');
}

const THEME_ORDER = ['day', 'night', 'deepnight', 'day-flat', 'night-flat', 'deepnight-flat'];

function themeIconSvg(pref) {
  const flat = isFlat(pref);
  const slash = flat ? '<line x1="2" y1="22" x2="22" y2="2" stroke="currentColor" stroke-width="2" opacity="0.4"/>' : '';
  if (pref === 'day' || pref === 'day-flat') {
    // 太阳：白天（flat 版加斜线表示无渐变）
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>' + slash + '</svg>';
  }
  if (pref === 'night' || pref === 'night-flat') {
    // 空半个月亮（描边）：夜晚
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path>' + slash + '</svg>';
  }
  // 实心半个月亮：深夜
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path>' + slash + '</svg>';
}

function updateThemeToggle() {
  const btn = $('#btnTheme');
  if (!btn) return;
  btn.innerHTML = themeIconSvg(state.themePref);
  const flat = isFlat(state.themePref);
  const base = state.themePref.replace('-flat', '');
  const colorLabel = base === 'day' ? t('theme.day')
    : base === 'night' ? t('theme.night') : t('theme.deep');
  const auroraLabel = flat ? t('theme.flat') : t('theme.aurora');
  btn.title = colorLabel + ' · ' + auroraLabel;
  btn.setAttribute('aria-pressed', String(state.themePref));
}

function cycleTheme() {
  const idx = THEME_ORDER.indexOf(state.themePref);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  applyTheme(next);
}

function initSidebarState() {
  try {
    const saved = JSON.parse(readLocal(SIDEBAR_KEY, '{}'));
    state.leftCollapsed = saved.leftCollapsed === true;
    state.rightCollapsed = saved.rightCollapsed === true;
  } catch (e) {
    state.leftCollapsed = false;
    state.rightCollapsed = false;
  }
  applySidebarState();
}

/* 「全部接口」行右侧那个批量选择开关。
 * 位置放在这一行的**最末位**（⇅ / ☰ 之后）：它是模式开关，位置必须固定 ——
 * 进模式后 ☰ 让位隐藏，它在原地把 ☑ 换成 ✕ 并高亮，「从哪进就从哪出」，
 * 不用重新找出口。（上一版把它放在面板工具条上最别扭的地方，就是那一排按钮
 * **不随模式变**，入口和出口在视觉上毫无联系。）
 *
 * 做成图标，但**保留边框 + 底色**：这一行另外两个（⇅ / ☰）是透明无边框的
 * （.total-group .btn--icon），有框的才能从这排里跳出来 ——
 * 「看不出这儿能批量选」这个抱怨靠位置 + 这一点边框解决，不靠把按钮加宽。
 *
 * 两个图标（☑ / ✕）都写进 HTML，用 .is-on 靠 CSS 切显隐，不做 innerHTML 替换：
 * 这个按钮每次 renderApiList 都会重建，状态全由渲染字符串 + 类名决定，最不容易漏。
 * 文案必须自明 —— 图标本身认不出「这是批量选择」，title / aria-label 不能省。 */
function selectToggleHtml() {
  const on = state.selectMode;
  const titleKey = on ? 'select.exitTitle' : 'select.enterTitle';
  const title = escapeHtml(t(titleKey));
  return '<button class="btn btn--icon btn--select' + (on ? ' is-on' : '') + '" id="btnSelect" type="button" data-edit-only'
    + ' data-i18n-title="' + titleKey + '" aria-pressed="' + (on ? 'true' : 'false') + '"'
    + ' title="' + title + '" aria-label="' + title + '">'
    + '<svg data-icon="select" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><polyline points="8 12.6 11 15.6 16.2 9.2"/></svg>'
    + '<svg data-icon="exit" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="6.5" y2="17.5"/></svg>'
    + '</button>';
}

/* 「全部接口」行最左的「全选」勾选框（只在批量模式中出现）。
 * 与分组头的三态框**同款同列**（复用的就是 .group__check，加上 has-check 那 10px 左内边距）：
 * 一列到底全是勾选框，不需要分辨哪个属于哪一级。
 * 范围 = 「当前可见」的全部接口（与分组头同一个口径，也就是 filteredApis()）——
 * 搜索平铺态下没有分组头，这一颗就是唯一的全选入口，所以那边也必须渲染。
 * 平时不渲染：否则同一行会同时出现「全选勾选框」和右侧那个 ☑ 开关，
 * 两个都是勾选框、语义还不同，必然混淆。 */
function totalSelectHtml(apis) {
  if (!state.selectMode) return '';
  const picked = apis.filter((api) => state.selectedApiIds.has(api.id)).length;
  const allPicked = apis.length > 0 && picked === apis.length;
  const halfPicked = picked > 0 && picked < apis.length;
  return '  <label class="group__check" data-total-check title="' + t('total.selectTitle') + '">'
    + '<input type="checkbox"' + (allPicked ? ' checked' : '')
    + (halfPicked ? ' data-half="1"' : '')
    + (apis.length ? '' : ' disabled') + '></label>';
}

function applySidebarState() {
  const layout = $('.layout');
  if (!layout) return;
  layout.classList.toggle('is-left-collapsed', state.leftCollapsed);
  layout.classList.toggle('is-right-collapsed', state.rightCollapsed);
  const leftPane = $('#paneLeft');
  const rightPane = $('#paneRight');
  if (leftPane) leftPane.classList.toggle('is-collapsed', state.leftCollapsed);
  if (rightPane) rightPane.classList.toggle('is-collapsed', state.rightCollapsed);
  const leftBtn = $('#btnToggleLeft');
  const rightBtn = $('#btnToggleRight');
  if (leftBtn) {
    leftBtn.title = state.leftCollapsed ? t('pane.leftShow') : t('pane.leftHide');
  }
  if (rightBtn) {
    rightBtn.title = state.rightCollapsed ? t('pane.rightShow') : t('pane.rightHide');
  }
  writeLocal(SIDEBAR_KEY, JSON.stringify({ leftCollapsed: state.leftCollapsed, rightCollapsed: state.rightCollapsed }));
}

/* 只读分享（A11）：从 URL 的 ?share= 取令牌作为本次会话身份。
 * 只挂在内存里的 state.auth.token，不写 localStorage —— 否则管理员浏览器访问一次分享链接就被永久锁成只读。 */
function applyShareTokenFromUrl() {
  try {
    const tok = (new URLSearchParams(location.search).get('share') || '').trim();
    if (tok) {
      state.auth.token = tok;
      state.auth.fromShare = true;
    }
  } catch (e) {}
}

/** 所有「会改配置」的入口先过这一关；只读分享视图下直接拦掉并提示。返回 true 才放行。 */
function ensureEditable(showToast) {
  if (!state.auth.readonly) return true;
  if (showToast !== false) toast(t('readonly.blocked'), 'bad');
  return false;
}

/** 进入/退出只读模式：切 body 类（CSS 据此隐藏所有编辑入口）+ 显示横幅 + 刷新用户栏。 */
function applyReadonlyMode() {
  const on = !!state.auth.readonly;
  document.body.classList.toggle('readonly', on);
  // 分享入口显隐：仅当「非只读 且 （账密部署 或 免密但已开启只读隔离端口）」时可见。
  // 免密且未开启只读隔离端口时隐藏分享图标——否则分享链接会指向可编辑主端口，去掉 ?share= 即可编辑。
  const shareBtn = $('#btnShare');
  if (shareBtn) {
    const shareAllowed = !on && (state.auth.required || state.auth.readonlyPort);
    shareBtn.hidden = !shareAllowed;
  }
  const banner = $('#readonlyBanner');
  if (banner) {
    banner.hidden = !on;
    const txt = banner.querySelector('[data-i18n="readonly.banner"]');
    if (txt) txt.textContent = state.auth.shareInvalid ? t('readonly.bannerInvalid') : t('readonly.banner');
  }
  renderUserBar();
}

async function initAuth() {
  state.auth.token = readLocal(TOKEN_KEY, '');
  // 只读分享链接：URL 上的 ?share= 令牌优先于本地登录态（分享视图不带登录态）
  applyShareTokenFromUrl();
  try {
    const res = await api('/_admin/auth');
    state.auth.required = !!res.required;
    state.auth.loggedIn = !!res.loggedIn;
    state.auth.username = res.username || '';
    state.auth.isDeployAdmin = !!res.isDeployAdmin;
    // 只读分享链接：后端据此返回 readonly:true，前端据此隐藏全部编辑入口
    state.auth.readonly = !!res.readonly;
    // 只读隔离端口号（0=未启用）：免密且未启用时，前端隐藏「分享」入口（见 applyReadonlyMode）
    state.auth.readonlyPort = Number(res.readonlyPort) || 0;
    // 只读端口无有效分享令牌：必须通过有效分享链接才能访问，直接访问只读端口不予展示内容
    state.auth.shareRequired = !!res.shareRequired;
    if (state.auth.shareRequired) {
      // 强制只读 + 展示「需要分享链接」提示页，不加载配置
      state.auth.readonly = true;
      renderShareRequired();
      applyReadonlyMode();
      return; // 不继续执行后续的配置加载等逻辑
    }
    // 分享链接已失效/被撤销：URL 带 ?share= 但令牌不被后端认可 → 强制只读并提示，绝不降级为可编辑面板
    state.auth.shareInvalid = !!(state.auth.fromShare && res.shareInvalid);
    if (state.auth.shareInvalid) {
      toast(t('share.invalid'), 'bad');
      if (state.auth.required && state.auth.loggedIn) {
        // 已登录管理员误打开失效分享链接：按普通后台处理，忽略该失效分享
        state.auth.fromShare = false;
        state.auth.shareInvalid = false;
        state.auth.readonly = false;
      } else if (state.auth.required) {
        // 账密部署且未登录：失效分享链接回到登录界面（与未登录访问后台一致），不进入只读态
        state.auth.readonly = false;
      } else {
        // 免密部署：无登录界面，强制只读并展示「链接已失效」提示页
        state.auth.readonly = true;
      }
    }
    // 部署期默认语言（MOCK_DEFAULT_LANG / config.json 的 defaultLang）：
    // 只在用户自己没选过语言时套用，且不写入 localStorage ——
    // 否则「部署默认值」会被当成用户的显式选择固化下来，之后改部署配置就不生效了。
    if (!I18N.getSavedLang() && res.defaultLang) {
      I18N.setLang(res.defaultLang, { persist: false });
    }
    updateLangSwitch();
    if (state.auth.required && !res.loggedIn) {
      if (state.auth.readonly) {
        // 只读分享视图：即便服务端开启了登录，也直接进入只读态，不弹登录框、不清分享令牌
      } else {
        // 本地存的 token 已失效，清掉，避免后续轮询一直 401
        state.auth.token = '';
        writeLocal(TOKEN_KEY, '');
        showLogin();
      }
    }
    applyReadonlyMode();
  } catch (e) {
    // 离线预览模式：不需要登录
    state.auth.required = false;
    state.auth.readonly = false;
  }
}

/**
 * 显示登录层。
 * 注意：只有「首次弹出」或显式传 { reset: true } 时才清空输入并聚焦——
 * 否则后台轮询（health / logs）触发 401 会反复把用户正在输入的账号密码清掉、并把焦点抢回用户名框。
 */
function showLogin(opts) {
  const layer = $('#loginLayer');
  const err = $('#loginError');
  const userInput = $('#loginUsername');
  const pwInput = $('#loginPassword');
  if (!layer) return;
  const wasHidden = layer.hidden;
  layer.hidden = false;
  if (!wasHidden && !(opts && opts.reset)) return;
  if (err) err.textContent = '';
  if (pwInput) pwInput.value = '';
  if (userInput) userInput.value = '';
  setTimeout(() => {
    if (userInput && !layer.hidden) userInput.focus();
  }, 50);
}

function hideLogin() {
  const layer = $('#loginLayer');
  if (layer) layer.hidden = true;
}

/** 同步登录卡片上「中文 / English」的选中态 */
function updateLangSwitch() {
  const box = $('#loginLang');
  if (!box) return;
  const cur = I18N.getLang();
  box.querySelectorAll('.login-lang').forEach((btn) => {
    const on = btn.getAttribute('data-lang') === cur;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

/**
 * 登录卡片上的语言切换。
 * 登录之前也要能选语言（界面文案、以及登录后才能看到的控制台文案都跟着变）；
 * 这里点一下就算用户的显式选择 → 持久化，之后不再被部署默认语言覆盖。
 */
function initLoginLang() {
  const box = $('#loginLang');
  if (!box) return;
  box.addEventListener('click', (event) => {
    const btn = event.target.closest('.login-lang');
    if (!btn) return;
    I18N.setLang(btn.getAttribute('data-lang'));
    updateLangSwitch();
  });
  updateLangSwitch();
}

/**
 * 顶栏头像：登录后最右侧显示头像，并仅在部署管理员(isDeployAdmin)时在下拉里显示「用户管理」入口。
 * 未登录 / 开放模式（无登录）时整体隐藏头像。
 */
/* 只读分享（A11）：生成 / 列出 / 复制 / 撤销分享链接。
 * 分享链接本身没有写权限，所以这套 UI 在只读视图下整体不可见（按钮带 data-edit-only）。 */
/* 复制图标（lucide 风格，与顶栏图标同参数：14px / stroke 2 / currentColor） */
var SHARE_COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

function shareRowHtml(it) {
  const when = it.createdAt ? timeText(it.createdAt) : '';
  const meta = [it.label, when].filter(Boolean).join(' · ');
  const copyTip = escapeHtml(t('share.copy'));
  return '<div class="share-row" data-token="' + escapeHtml(it.token) + '" data-url="' + escapeHtml(it.url) + '">'
    + '<button class="share-row__copy" type="button" data-share-copy title="' + copyTip + '" aria-label="' + copyTip + '">' + SHARE_COPY_ICON + '</button>'
    + '<div class="share-row__main">'
    + '<div class="share-row__url" title="' + escapeHtml(it.url) + '">' + escapeHtml(it.url) + '</div>'
    + (meta ? '<div class="share-row__meta">' + escapeHtml(meta) + '</div>' : '')
    + '</div>'
    + '<div class="share-row__acts">'
    + '  <button class="btn btn--ghost btn--danger-quiet" type="button" data-share-revoke>' + t('share.revoke') + '</button>'
    + '</div></div>';
}

function bindShareRow(row) {
  if (!row) return;
  const url = row.getAttribute('data-url');
  const copyBtn = row.querySelector('[data-share-copy]');
  const revokeBtn = row.querySelector('[data-share-revoke]');
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(url).then((ok) => toast(ok ? t('share.copyDone') : t('share.copyFail'), ok ? 'ok' : 'bad')));
  if (revokeBtn) revokeBtn.addEventListener('click', async () => {
    const token = row.getAttribute('data-token');
    const res = await api('/_admin/share?token=' + encodeURIComponent(token), { method: 'DELETE' });
    if (res && res.ok) {
      toast(t('share.revoked'), 'ok');
      row.remove();
      const list = $('#shareList');
      const empty = $('#shareEmpty');
      if (list && !list.children.length && empty) empty.hidden = false;
    } else {
      toast(t('share.genFail', { msg: (res && res.message) || '' }), 'bad');
    }
  });
}

async function loadShareLinks() {
  const list = $('#shareList');
  const empty = $('#shareEmpty');
  if (!list) return;
  const res = await api('/_admin/share');
  if (!res || !res.ok) { toast(t('share.loadFail'), 'bad'); return; }
  const items = res.items || [];
  list.innerHTML = items.map(shareRowHtml).join('');
  if (empty) empty.hidden = items.length > 0;
  list.querySelectorAll('.share-row').forEach(bindShareRow);
}

async function createShareLink() {
  if (!ensureEditable()) return;
  const label = (($('#shareLabel') && $('#shareLabel').value) || '').trim().slice(0, 60);
  const res = await api('/_admin/share', { method: 'POST', body: JSON.stringify({ label: label }) });
  if (res && res.ok && res.item) {
    toast(t('share.created'), 'ok');
    const list = $('#shareList');
    const empty = $('#shareEmpty');
    if (list) { list.insertAdjacentHTML('afterbegin', shareRowHtml(res.item)); bindShareRow(list.firstElementChild); }
    if (empty) empty.hidden = true;
    const lbl = $('#shareLabel');
    if (lbl) lbl.value = '';
  } else {
    toast(t('share.genFail', { msg: (res && res.message) || '' }), 'bad');
  }
}

function openShareModal() {
  if (!state.auth.required && !state.auth.readonlyPort) {
    toast(t('share.disabledNoPort'), 'bad');
    return;
  }
  if (!ensureEditable()) return;
  const modal = $('#shareModal');
  if (!modal) return;
  modal.hidden = false;
  loadShareLinks();
}

function renderUserBar() {
  const avatar = $('#btnUserMenu');
  if (!avatar) return;
  const chip = $('#readonlyChip');
  if (chip) chip.hidden = !state.auth.readonly;
  if (state.auth.readonly) { avatar.hidden = true; closeUserMenu(); return; }
  // 开放模式（不需要登录）没有用户态，整体隐藏头像
  if (!state.auth.loggedIn || !state.auth.required) {
    avatar.hidden = true;
    closeUserMenu();
    return;
  }
  avatar.hidden = false;
  const nameEl = $('#userMenuName');
  const roleEl = $('#userMenuRole');
  const mgmtItem = $('#btnUserMgmt');
  if (nameEl) nameEl.textContent = (state.auth.username || t('user.anonymous'));
  if (roleEl) roleEl.textContent = state.auth.isDeployAdmin ? t('user.roleAdmin') : t('user.roleUser');
  if (mgmtItem) mgmtItem.hidden = !state.auth.isDeployAdmin;
}

/**
 * 头像下拉的定位 —— 与 GitHub 同一套路：浮层挂到 <body>、用 position:fixed + 视口坐标。
 *
 * 为什么不用「相对 .user-menu 的 absolute」：
 *   顶栏带着 backdrop-filter(blur)，它会为后代创建包含块；窄屏下顶栏还会换行，
 *   祖先链上任何 overflow 也都可能裁剪浮层。只要祖先链改一点，absolute 版本就
 *   可能脱轨（用户看到的现象：下拉跑到页面底部 / 飘在内容中间）。
 *   挂到 body + fixed 之后，定位只与视口有关，和祖先链彻底脱钩。
 *
 * 规则：
 *   1) 水平：默认右对齐头像，再整体夹进 [EDGE, vw-EDGE]，任何宽度都不出视口；
 *   2) 垂直：默认贴头像下方；下方放不下且上方放得下时，翻到头像上方。
 */
function positionUserMenu() {
  const menu = $('#userDropdown');
  const avatar = $('#btnUserMenu');
  if (!menu || !avatar || menu.hidden) return;
  const GAP = 10;
  const EDGE = 8;
  const a = avatar.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = menu.offsetWidth;
  // 先清掉上一次的限高，量出「不限高」的自然高度，翻边判断才准
  menu.style.maxHeight = 'none';
  const h = menu.offsetHeight;

  // 水平：先右对齐头像右缘，再夹进视口
  let left = a.right - w;
  if (left + w > vw - EDGE) left = vw - w - EDGE;
  if (left < EDGE) left = EDGE;
  menu.style.right = 'auto';
  menu.style.left = Math.round(left) + 'px';

  // 垂直：fixed 定位下 top / bottom 都相对视口。
  // 下方放不下、上方放得下 → 翻到头像上方；否则留下方。
  // 关键：无论落在哪一侧，都把 maxHeight 限到该侧的可用空间 ——
  // 这样窗口很矮时（比如把浏览器窗口压扁、或在矮的预览面板里打开）
  // 菜单也只会内部滚动，绝不会被压出屏幕底部（用户看到的就是「下拉跑到最底部」）。
  const spaceBelow = vh - EDGE - (a.bottom + GAP);
  const spaceAbove = a.top - GAP - EDGE;
  if (spaceBelow < h && spaceAbove >= h) {
    menu.style.top = 'auto';
    menu.style.bottom = Math.round(vh - a.top + GAP) + 'px';
    menu.style.maxHeight = Math.round(Math.max(96, spaceAbove)) + 'px';
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = Math.round(a.bottom + GAP) + 'px';
    menu.style.maxHeight = Math.round(Math.max(96, spaceBelow)) + 'px';
  }
}

function openUserMenu() {
  const menu = $('#userDropdown');
  const avatar = $('#btnUserMenu');
  if (!menu || !avatar) return;
  // 关键：先让菜单脱离顶栏（backdrop-filter 包含块 / overflow 裁剪），再显示
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.hidden = false;
  positionUserMenu();   // 同一帧内完成定位，浏览器不会画出中间态
  avatar.setAttribute('aria-expanded', 'true');
}

function closeUserMenu() {
  const menu = $('#userDropdown');
  const avatar = $('#btnUserMenu');
  const wrap = $('#userMenu');
  if (menu) {
    menu.hidden = true;
    // 放回头像容器：保持 DOM 结构稳定，语言切换 / 整体重渲染时不会丢节点
    if (wrap && menu.parentElement !== wrap) wrap.appendChild(menu);
  }
  if (avatar) avatar.setAttribute('aria-expanded', 'false');
}
function toggleUserMenu() {
  const menu = $('#userDropdown');
  if (!menu) return;
  if (menu.hidden) openUserMenu(); else closeUserMenu();
}

/** 退出登录：清 token、重置登录态、回登录层 */
function logout() {
  state.auth.token = '';
  state.auth.loggedIn = false;
  state.auth.username = '';
  state.auth.isDeployAdmin = false;
  writeLocal(TOKEN_KEY, '');
  renderUserBar();
  // 关闭用户管理弹窗：closeUserMgmt 定义在用户管理模块内层作用域，顶层 logout 调不到，
  // 直接按 id 隐藏，避免 ReferenceError 中断导致 showLogin 跑不到（退出后卡在面板上）。
  const umModal = $('#userMgmtModal');
  if (umModal) umModal.hidden = true;
  closeUserMenu();
  showLogin({ reset: true });
}

/** 左侧分组的折叠状态存本地，刷新后保持原样 */
function initCollapsedGroups() {
  try {
    const list = JSON.parse(readLocal(COLLAPSE_KEY, '[]'));
    state.collapsedGroups = new Set(Array.isArray(list) ? list : []);
  } catch (e) {
    state.collapsedGroups = new Set();
  }
}

/* 当前该读哪一份折叠集：批量模式读临时的 batchCollapsed，平时读持久化的 collapsedGroups。
 * 渲染、展开、折叠、点组头 —— 全部走这一个函数，别各写一遍 if (state.selectMode)。 */
function collapsedSet() {
  return state.selectMode ? state.batchCollapsed : state.collapsedGroups;
}

/* 只有非批量模式才落盘。批量模式里的展开/折叠是临时的，写进 localStorage
 * 会在用户下次打开时把折叠结构变成他在模式里随手弄的那副样子。 */
function persistCollapsed() {
  if (state.selectMode) return;
  writeLocal(COLLAPSE_KEY, JSON.stringify(Array.from(state.collapsedGroups)));
}

function expandAllGroups() {
  collapsedSet().clear();
  persistCollapsed();
  renderApiList();
}

function collapseAllGroups() {
  const groups = (state.config && state.config.groups) || [];
  const ids = groups.map((g) => g.id);
  ids.push(UNGROUPED);
  if (state.selectMode) state.batchCollapsed = new Set(ids);
  else state.collapsedGroups = new Set(ids);
  persistCollapsed();
  renderApiList();
}

/* ------------------------------ 顶栏 ------------------------------ */

function renderTopbarStats() {
  const apis = (state.config && state.config.apis) || [];
  $('#statApis').textContent = apis.length;
  $('#statRules').textContent = apis.reduce((sum, item) => sum + (item.rules || []).length, 0);
}

async function refreshHealth() {
  try {
    const result = await api('/_admin/health');
    if (result && result.ok) {
      $('#health').classList.remove('is-down');
      $('#healthText').textContent = t('health.online');
      $('#statUptime').textContent = uptimeText(result.uptimeSec || 0);
      /* 校准走秒基准：用服务端 uptimeSec 反推启动时刻 */
      if (result.uptimeSec) {
        serverStartMs = Date.now() - result.uptimeSec * 1000;
      }
    } else {
      throw new Error('bad');
    }
  } catch (e) {
    $('#health').classList.add('is-down');
    $('#healthText').textContent = t('health.offline');
  }
}

/* ------------------------------ 左侧接口列表 ------------------------------ */

function methodLabel(method) {
  const m = (method || 'ALL').toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].indexOf(m) >= 0 ? m : 'ALL';
}
function methodClass(method) {
  const m = methodLabel(method);
  return m === 'ALL' ? 'all' : m.toLowerCase();
}

/* 命中片段高亮：把搜索结果里命中的关键词标出来（不区分大小写，同一串里出现多次全标）。
 * 必须「先按原文切段、再逐段 escapeHtml」—— 对已 escape 的串做替换会把 &amp; 之类当普通文本去匹配，
 * 关键词里带 & 或 < 时还会拼出非法 HTML。
 * 注意：返回值里已经含 <mark> 标签，调用方**不能再对它做任何字符串/正则替换**。
 * 要再拼别的 HTML（比如路径的 <wbr>），用 apiPathHtml，别在外面套 replace。 */
function highlightMatch(text, query) {
  const raw = String(text == null ? '' : text);
  if (!query) return escapeHtml(raw);
  const lower = raw.toLowerCase();
  let out = '';
  let cursor = 0;
  while (true) {
    const at = lower.indexOf(query, cursor);
    if (at < 0) break;
    out += escapeHtml(raw.slice(cursor, at))
      + '<mark class="hit-mark">' + escapeHtml(raw.slice(at, at + query.length)) + '</mark>';
    cursor = at + query.length;
  }
  return out + escapeHtml(raw.slice(cursor));
}

/* 路径渲染 = 命中高亮 + 每个 / 后插零宽断行点（换行时优先断在路径分隔处，
 * 避免出现 "…ampOpenapiServi / ce" 这种把接口名劈成两半的断法）。
 *
 * 为什么单独一个函数：这两件事都得做，而 escapeHtml 和 /\//g 替换**只能作用在原文片段上**。
 * 曾经写成 highlightMatch(...).replace(/\//g, '/<wbr>')（即先高亮、再对整个串做替换），
 * 结果 </mark> 里那个 / 也被换成了 /<wbr>，拼出 </<wbr>mark>；
 * 浏览器把残缺的 `</` 当注释吞掉，卡片上就漏出一个光秃秃的 "mark>"：
 *   /demo/sample → 显示成 /demomark>/sample
 * 且 <mark> 永不闭合，后面的 "/sample" 被一起吞进高亮里。 */
function apiPathHtml(apiPath, query) {
  const withWbr = (text) => escapeHtml(text).replace(/\//g, '/<wbr>');
  const raw = '/' + (apiPath || t('api.pathEmptyShort'));
  if (!query) return withWbr(raw);
  const lower = raw.toLowerCase();
  let out = '';
  let cursor = 0;
  while (true) {
    const at = lower.indexOf(query, cursor);
    if (at < 0) break;
    out += withWbr(raw.slice(cursor, at))
      + '<mark class="hit-mark">' + withWbr(raw.slice(at, at + query.length)) + '</mark>';
    cursor = at + query.length;
  }
  return out + withWbr(raw.slice(cursor));
}

/* 接口卡片。opts 只在「搜索结果平铺列表」里用：
 *   groupChip —— 分组 id（含 UNGROUPED），画一枚只读的「来自哪个分组」chip + 点击跳回该分组
 *   noDrag    —— 结果态没有 .group[data-group-id] 作为放置目标，拖拽把手留着是「拖不动的假象」，直接不渲染 */
function apiItemHtml(item, opts) {
  const options = opts || {};
  const ruleCount = (item.rules || []).length;
  const classes = ['api-item'];
  if (item.id === state.activeApiId) classes.push('is-active');
  if (item.enabled === false) classes.push('is-off');
  if (state.selectedApiIds.has(item.id)) classes.push('is-selected');
  // 侧栏里路径最多两行、超出省略，所以把「完整调用地址」挂到卡片 title 上：
  // 悬停拿到的就是能直接粘进被测系统的 URL，而不是只有一段路径。
  const apiPath = apiFullPath(item);
  const fullUrl = apiPath ? apiUrl(item) : t('api.pathEmpty');
  /* 当前搜索词（小写）：只在走平铺结果列表时非空 —— 分组树态下的 q 恒为空，
   * 所以树态渲染到这里时 highlightMatch 不会加 <mark>。 */
  const query = state.searchQuery.trim().toLowerCase();
  // 路径的高亮 + 断点插入都在 apiPathHtml 里做（它保证只 escape 一次原文）
  const pathHtml = apiPathHtml(apiPath, query);
  const selected = state.selectedApiIds.has(item.id) ? 'checked' : '';
  const enabledChecked = item.enabled === false ? '' : 'checked';
  /* 结果态（noDrag）不渲染拖拽把手：没有分组块当放置目标，留着把手只会给用户「能拖」的假象。
   * 拖拽属性挂在把手自己身上（不再挂在整张卡片上）—— 与分组头同一个理由：
   * 整卡可拖时，C2 的「点整行 = 勾选」会被原生拖拽阈值吞掉，手一抖就勾不上。 */
  const leading = state.selectMode
    ? '  <label class="api-item__check" title="' + t('api.selectTitle') + '"><input type="checkbox" data-api-check ' + selected + '></label>'
    : (options.noDrag ? '' : '  <span class="api-item__drag" draggable="true" title="' + t('api.dragTitle') + '">⋮⋮</span>');
  /* 路径被遮蔽：同一个「模块/路径」下，数组里更靠前的位置已经有另一条启用的接口。
   * 服务的路由是 findApi()（server.js:850-856）按 config.apis 顺序、跳过停用的、取第一个匹配，
   * 所以这条**收不到任何请求** —— 在界面上明说，别让用户对着一个永远没反应的挡板调半天。
   *
   * 两种情况的**出路不同**，所以文案必须分开。原来只有一句「不会命中」，于是一条
   * 「只差一个路径就能用」的条目和一条字节级冗余看起来一模一样 —— 这正是实例里
   * 14 条死条目长期挂着没被清理的原因。
   * 单独占一行而不是塞进 meta 行：那条是 nowrap + overflow:hidden，加第五个 tag 会被裁掉，
   * 而一条会被裁掉的警示比没有警示更糟。 */
  const shadow = shadowInfo().get(item.id);
  const shadowOwner = shadow ? (tSeed(shadow.by.name) || t('api.unnamed')) : '';
  const shadowed = shadow
    ? '    <div class="api-item__warn"><span class="tag tag--warn" title="'
      + escapeHtml(t(shadow.sameContent ? 'api.dupSameContentTitle' : 'api.shadowedByTitle', { name: shadowOwner })) + '">'
      + escapeHtml(t(shadow.sameContent ? 'api.dupSameContent' : 'api.shadowedBy', { name: shadowOwner }))
      + '</span></div>'
    : '';
  return ''
    + '<div class="' + classes.join(' ') + '" data-api-id="' + escapeHtml(item.id) + '" role="button" tabindex="0" title="' + escapeHtml(fullUrl) + '">'
    + leading
    + '  <div class="api-item__main">'
    + '    <span class="api-item__method method--' + methodClass(item.method) + '">' + methodLabel(item.method) + '</span>'
    + '    <div class="api-item__path">' + pathHtml + '</div>'
    + '    <div class="api-item__name">' + highlightMatch(tSeed(item.name) || t('api.unnamed'), query) + '</div>'
    + '    <div class="api-item__meta">'
    + '      <span>' + t('ruleCount', { n: ruleCount }) + '</span>'
    + (ruleCount === 0 && !(item.proxy && item.proxy.enable) ? '<span class="tag">' + t('api.fallback') + '</span>' : '')
    + (item.proxy && item.proxy.enable ? '<span class="tag tag--info">' + t('api.proxy') + '</span>' : '')
    + (item.enabled === false ? '<span class="tag">' + t('api.disabled') + '</span>' : '')
    + '    </div>'
    + shadowed
    /* 结果态专属：这条接口来自哪个分组。分组树态没有这一行（分组头已经说明了来源）。
     * 做成按钮而不是纯文字：点一下 = 清掉搜索词、跳回分组树里的那个分组，比「自己去找」省事。 */
    + (options.groupChip
      ? '    <div class="api-item__source">'
        + '<button class="api-item__source-chip" type="button" data-api-group-jump="' + escapeHtml(item.id) + '" title="' + t('search.jumpToGroup') + '">'
        + escapeHtml(groupName(options.groupChip)) + '</button>'
        + '</div>'
      : '')
    + '  </div>'
    + '  <label class="switch api-item__toggle" title="' + t('api.toggleTitle') + '"><input type="checkbox" data-api-toggle ' + enabledChecked + '><span class="switch__track"></span><span class="switch__thumb"></span></label>'
    + '</div>';
}

/* 一个分组块：折叠头 + 组内接口。editable=false 用于「未分组」这个伪分组 */
function groupBlockHtml(groupId, groupName, list, editable) {
  const collapsed = collapsedSet().has(groupId);
  const body = list.length
    /* 显式包一层：直接 list.map(apiItemHtml) 会把数组下标当成第二个参数（opts）传进去 */
    ? list.map((item) => apiItemHtml(item)).join('')
    : '<div class="group__empty">' + t('group.empty') + '</div>';

  /* 批量模式：组头最左格换成三态勾选框，和卡片完全同一套规则（卡片也是勾选时显示复选框）。
   * 三态由「组内当前可见的这些」推导 —— 范围必须与紧挨着的 .group__count 一致（那也是过滤后的
   * 可见数）：勾了组头而下面可见的框还空着，用户只会当成 bug。可见 0 条时禁用。
   * 半选态走原生 input.indeterminate（浏览器自带第三态，不用自己画图标），
   * 它是 DOM 属性而非 attribute，只能渲染后由 JS 设，见 bindApiListEvents。 */
  let leadHtml = '';
  if (state.selectMode) {
    const picked = list.filter((item) => state.selectedApiIds.has(item.id)).length;
    const allPicked = list.length > 0 && picked === list.length;
    const halfPicked = picked > 0 && picked < list.length;
    leadHtml = '    <label class="group__check" data-group-check="' + escapeHtml(groupId) + '"'
      + ' title="' + t('group.selectTitle') + '">'
      + '<input type="checkbox"' + (allPicked ? ' checked' : '')
      + (halfPicked ? ' data-half="1"' : '')
      + (list.length ? '' : ' disabled') + '></label>';
  }

  /* 分组的拖拽把手。**必须从 section 收窄到这里**：原来 draggable 挂在整块 .group 上，
   * 组头也是拖拽热区，单击组头经常被原生拖拽阈值（~5px）吞掉 —— 表现就是「点组头不折叠，
   * 只有点左边那根箭头才行」。收窄到把手后组头变回普通元素，单击绝对可靠，
   * 且「哪儿能拖」一眼可见（与卡片上的 ⋮⋮ 是同一套语言）。
   * 放在计数右边（不是最左）：名字与箭头的左缘因此保持原位，不会比组内的卡片还靠右。 */
  const dragHtml = editable
    ? '<span class="group__drag" draggable="true" data-edit-only title="' + t('group.dragTitle') + '">⋮⋮</span>'
    : '';

  return ''
    + '<section class="group' + (collapsed ? ' is-collapsed' : '') + '" data-group-id="' + escapeHtml(groupId) + '">'
    + '  <div class="group__head' + (state.selectMode ? ' has-check' : '') + '">'
    + leadHtml
    + '    <button class="group__toggle" type="button" data-group-toggle title="' + (collapsed ? t('group.expand') : t('group.collapse')) + '">'
    + '<svg data-icon="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button>'
    + '    <span class="group__name" title="' + escapeHtml(tSeed(groupName)) + '">' + escapeHtml(tSeed(groupName)) + '</span>'
    + '    <span class="group__count">' + list.length + '</span>'
    + '    <span class="group__spacer"></span>'
    + dragHtml
    + (editable
      ? '<button class="btn btn--icon group__menu" type="button" data-edit-only data-group-menu title="' + t('group.menu') + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg></button>'
      : '')
    + '  </div>'
    + '  <div class="group__body">' + body + '</div>'
    + '</section>';
}

/* 当前搜索词（小写 + 去首尾空白）。视图用它判断「是否处于搜索态」，
 * 有词就整体换成平铺结果列表，没词才渲染分组树。 */
function activeQuery() {
  return state.searchQuery.trim().toLowerCase();
}

/* 过滤后的接口列表：搜索词 / 状态 / 分组 chips 三个条件都在这一个地方。
 * ⚠️ renderApiList（渲染）与 ensureApiVisible（定位）必须共用这一份 —— 两边各算一遍的话，
 * 「定位时判断目标在不在结果里」会和「实际渲染出来的结果」对不上，就又回到「左侧没反应」了。 */
function filteredApis() {
  const allApis = (state.config && state.config.apis) || [];
  const q = activeQuery();
  return allApis.filter((item) => {
    if (q) {
      const name = (item.name || '').toLowerCase();
      const path = (item.path || '').toLowerCase();
      const module = (item.module || '').toLowerCase();
      if (name.indexOf(q) < 0 && path.indexOf(q) < 0 && module.indexOf(q) < 0) return false;
    }
    if (state.filterStatus === 'enabled' && item.enabled === false) return false;
    if (state.filterStatus === 'disabled' && item.enabled !== false) return false;
    if (state.filterGroupIds.length && !state.filterGroupIds.includes(item.groupId)) return false;
    return true;
  });
}

/* 一轮渲染内的遮蔽信息缓存：apiItemHtml 是逐卡调用的，不缓存就是 O(n²)。
 * 每次 renderApiList 开头置空重算，所以不存在「改了路径后警示不刷新」的陈旧问题。 */
let shadowCache = null;

/* 被遮蔽的接口 —— 这些接口**收不到任何请求**。
 * 判据：同一个「模块/路径」下，数组里更靠前的位置已经有另一条**启用**的接口。
 * 服务的 findApi()（server.js:850-856）按 config.apis 顺序、跳过停用的、返回第一个匹配的，
 * 所以排在后面的同路径接口是死代码。停用的不算「被遮蔽」（它本来就不参与匹配，
 * 卡片上已经有「已停用」tag 了），不重复报。
 *
 * 返回 Map<id, { by, sameContent }>：
 *   by          遮蔽它的那一条 —— **点名"凶手"**。原来那句「不会命中」是一份没有主语的判决书：
 *               它告诉你死了，却不说凶手是谁，而列表里可能有 8 个候选。用户实例里 14 条
 *               死条目长期挂着没人清理，这是原因之一。
 *   sameContent 与遮蔽者的内容指纹是否相同 → 决定卡片上是「重复项」还是「被「XX」遮蔽」，
 *               两者出路完全不同（删/停 vs 改路径救活）。
 *
 * ⚠️ 遮蔽**不是开关，是位置的副产物**：判据里的"更靠前"就是数组顺序。用户把副本拖到原件
 *    上面，副本立刻抢走路由 —— 所以"备份很安全"这个预期不能建立在遮蔽上，
 *    要稳定的封存只能用 enabled=false。 */
function shadowInfo() {
  if (shadowCache) return shadowCache;
  const apis = (state.config && state.config.apis) || [];
  const first = new Map();
  const info = new Map();
  apis.forEach((api) => {
    if (api.enabled === false) return;
    const key = apiFullPath(api);
    if (!key) return;
    const owner = first.get(key);
    if (!owner) { first.set(key, api); return; }
    info.set(api.id, { by: owner, sameContent: apiContentFingerprint(owner) === apiContentFingerprint(api) });
  });
  shadowCache = info;
  return info;
}

/* 批量工具条：勾选了接口才出现。
 * 有筛选时要额外明示「有几条不在当前结果里」—— 批量启停作用于**全部**勾选项（含被搜索/筛选
 * 挡住的那些），不提示的话用户会以为只改了眼前这几条。
 *
 * 固定两行。左栏内容区只有 216px，原来那套「计数 + 三个按钮挤一行」在这里根本放不下
 * （实测溢出到横向滚动条，底部的「取消」还得拖滚动条才点得到）：
 *   第 1 行 = 计数（允许换行）+ 右侧「清空」
 *   第 2 行 = 动作按钮（去掉「批量」二字 —— 工具条本身就是批量语境，那两字是纯冗余）
 * 结构固定、不抖，加上「移组」也仍然放得下。 */
function batchBarHtml(visibleIds) {
  if (state.selectedApiIds.size === 0) return '';
  const hidden = Array.from(state.selectedApiIds).filter((id) => !visibleIds.has(id)).length;
  const countText = hidden
    ? t('batch.selectedHidden', { n: state.selectedApiIds.size, m: hidden })
    : t('batch.selected', { n: state.selectedApiIds.size });
  return '<div class="batchbar" id="batchBar">'
    + '<div class="batchbar__row batchbar__row--info">'
    + '<span class="batchbar__count">' + countText + '</span>'
    + '<button class="btn btn--ghost batchbar__clear" type="button" id="btnBatchClear">' + t('batch.clear') + '</button>'
    + '</div>'
    + '<div class="batchbar__row batchbar__row--acts">'
    + '<button class="btn" type="button" id="btnBatchDisable">' + t('batch.disable') + '</button>'
    + '<button class="btn" type="button" id="btnBatchEnable">' + t('batch.enable') + '</button>'
    + '<button class="btn" type="button" id="btnBatchMove">' + t('batch.move') + '</button>'
    + '</div>'
    + '</div>';
}

/* 「发现 N 条不会命中的接口」提示条 + 一键停用。
 *
 * 为什么要给一键动作，而不是让用户逐条清理：实测用户实例里 16 条接口有 14 条收不到请求，
 * 且这 14 条的**内容指纹两两全等**（纯冗余）。逐条删要点 14 次确认框 ——
 * 那正是它们长期挂着没被清理的原因之一。
 *
 * 为什么是**停用**而不是删除：应用内没有撤销栈（前序设计稿 §2.1 定的「批量只做可逆动作」），
 * 所以一键入口只提供可逆的那一半；删除保持逐条 + 确认框，不给一键通道。
 *
 * 为什么不在批量模式里显示：那时用户正在手动挑，再摆一个「全选并停用」的按钮是抢方向盘。 */
function shadowBannerHtml() {
  const count = shadowInfo().size;
  if (!count || state.selectMode) return '';
  return '<div class="shadow-banner" id="shadowBanner">'
    + '<span class="shadow-banner__text">' + escapeHtml(t('api.shadowedBanner', { n: count })) + '</span>'
    + '<button class="btn btn--ghost shadow-banner__act" type="button" data-edit-only id="btnDisableShadowed">'
    + escapeHtml(t('api.shadowedDisableAll')) + '</button>'
    + '</div>';
}

/* 一次性把所有「不会命中」的接口停用（可逆，随时能再启用回来）。
 * 落盘走一次 persist —— 不在循环里逐条 persist（那会发 N 次整份配置的 POST）。 */
async function disableShadowedApis() {
  if (!ensureEditable()) return;
  const info = shadowInfo();
  if (!info.size) return;
  let n = 0;
  state.config.apis.forEach((api) => {
    if (info.has(api.id) && api.enabled !== false) {
      api.enabled = false;
      n += 1;
    }
  });
  if (!n) return;
  shadowCache = null;
  await persist(t('api.shadowedDisabled', { n: n }));
  renderAll();
}

/* 搜索结果平铺列表：有关键词时不再渲染分组树 —— 直接把命中的接口列出来。
 * 以前只把命中数标在分组标题上，用户得挨个展开分组去找，这正是要解决的问题。
 * 顺序保持 config.apis 原序（= 分组树里的相对顺序），不做相关度排序：
 * 逐字输入时结果顺序稳定，不会跳来跳去。 */
function searchResultHtml(list) {
  if (!list.length) {
    return '<div class="api-scroll"><div class="search-empty">'
      + '<p class="search-empty__text">' + t('search.empty') + '</p>'
      + '<button class="btn" type="button" id="btnClearSearch">' + t('search.clear') + '</button>'
      + '</div></div>';
  }
  const shown = list.slice(0, SEARCH_RENDER_LIMIT);
  const rest = list.length - shown.length;
  const known = new Set(((state.config && state.config.groups) || []).map((group) => group.id));
  let html = batchBarHtml(new Set(list.map((item) => item.id)));
  html += '<div class="search-result">';
  html += shown.map((item) => apiItemHtml(item, {
    groupChip: (item.groupId && known.has(item.groupId)) ? item.groupId : UNGROUPED,
    noDrag: true,
  })).join('');
  if (rest > 0) html += '<div class="search-more">' + t('search.more', { n: rest }) + '</div>';
  html += '</div>';
  return '<div class="api-scroll">' + html + '</div>';
}

function renderApiList() {
  const host = $('#apiList');
  const allApis = (state.config && state.config.apis) || [];
  const groups = (state.config && state.config.groups) || [];
  // 遮蔽信息（哪些接口收不到请求、被谁遮蔽、是不是重复项）本轮重算一次，供逐卡渲染复用 —— 见 shadowInfo
  shadowCache = null;

  const q = activeQuery();
  const apis = filteredApis();

  /* 计数：没有过滤时就是总数；一旦有过滤（搜索词 / 状态 / 分组 chips）就显示命中数 / 总数。
   *
   * ⚠️ 行内**只能用短形态**（`1/10`）。这里以前用的是完整句子「命中 1 / 共 10」，
   * 而它在 216px 的栏里根本放不下：标签盒（`.total-group__label`）没有 overflow 约束，
   * 撑破之后文字会**横穿到图标底下**。实测重叠量（真 Chrome，筛选一个分组）：
   *   改前基线 25.6px（本来就撞）→ 加上 ☑ 开关后 67.8px（撞得更狠）。
   * 换成 `1/10` 后（不带空格）到第一个图标还剩 10.4px；带空格的 `1 / 10` 仍是 −5.2px（会撞）。
   * 完整句子没丢 —— 就在这一格自带的 title 悬浮提示里（下面那行 title=）。 */
  const filtered = apis.length !== allApis.length;
  const countText = filtered
    ? t('total.countFilteredShort', { n: apis.length, m: allApis.length })
    : String(allApis.length);

  /* 「全部接口」行右侧的按钮簇，顺序 = **☑ ⇅ ☰**。
   * ☰ 必须固定在**最后一位（最右）**：分组头最右那颗也是 ☰，且两者的右侧留白相同
   * （.total-group 的 padding-right 与 .group__head 都是 12px，两者又都留了等宽的滚动条槽），
   * 只有 ☰ 一直占住最右那一列，「全部接口」的 ☰ 才能和下面每个分组的 ☰ 叠成一条竖线。
   * ⚠️ 别把 ☑ 放到 ☰ 右边：那样 ☰ 会被挤左 28px（按钮）+ 6px（gap）= **34px**（实测过的数），
   *     整列立刻错开。批量模式中 ☰ 隐掉（宽度不够），此时右端是 ⇅，但那不重要 ——
   *     该对齐的那颗已经不在了。
   *   ⇅ / ☰ —— 只在分组树态有意义（搜索平铺态既没有分组树、也没有分组可建），保持原条件渲染；
   *            批量模式中 ☰ 还要再让位（见 .total-group .btn--select.is-on 那段说明）。
   *   ☑ 批量选择开关 —— **两种态下都渲染**。上一版它挂在面板工具条上时，搜索态是它唯一的
   *            入口；搬到这一行之后更不能少，否则「搜出来 → 挑几条 → 批量停用」这条路
   *            直接断掉 —— 而搜索平铺态本身是支持批量的（searchResultHtml 里就渲染批量条）。 */
  const toggleAllHtml = q ? ''
    : '  <button class="btn btn--icon" id="btnToggleAllGroups" type="button" title="' + t('toggleAllGroups') + '">'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 15 12 20 17 15"></polyline><polyline points="7 9 12 4 17 9"></polyline></svg></button>';
  /* ☰ 在两种情况下不渲染：搜索平铺态（没有分组树、没有分组可建）、批量模式中。
   * 批量模式里让位的原因是宽度 —— 最左侧那颗「全选」勾选框要占 ~24px，216px 的栏里
   * 三个图标 + 勾选框 + 标签，中英都溢出（实测 26px）。
   * 代价要说清楚：☰ 里那三项里，「新建分组 / 新建接口」在面板工具条上有常驻按钮
   * （#btnAddGroup / #btnAddApi），不丢；但**「变更记录（全局）」只有这一个入口**
   * （逐接口那份在抽屉里另有按钮），所以批量模式中它暂时进不去 —— 退出模式即可，
   * 模式本身的语义就是「专心收拾已有的」，与新建/翻日志互斥。 */
  const totalMenuHtml = (q || state.selectMode) ? ''
    : '  <button class="btn btn--icon group__menu" type="button" data-edit-only data-total-menu title="' + t('totalMenu.title') + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg></button>';
  /* 三颗图标收进一个簇（`.total-group__acts`）：**图标彼此之间 2px，簇与文字仍是行级的 6px**。
   * 为什么不直接把这一行的 gap 改成 2px：那样批量模式里「全选框 ↔ 全部接口」也会变成 2px，
   * 而分组头的「全选框 ↔ 分组名」是 6px —— 两处并排就能看出不一致（用户已经在盯这类错位了）。
   * 收紧图标彼此之后，标签那一侧会自动多出等量余量（标签是这一行唯一 flex:1 的项，
   * `.group__spacer` 是 display:none），于是「文字 | 图标簇」的分隔从 18px 变成 26px（中文）。
   * 实测数字见 docs/批量选择与复制接口改造设计.md §8.8。 */
  const headerActions = '<span class="total-group__acts">'
    + selectToggleHtml() + toggleAllHtml + totalMenuHtml + '</span>';

  // 顶部「全部接口」总分组：含实时计数 + 全局汉堡，真实分组都排在它下面。
  // has-check 与分组头同一个类名，作用同一件事：把左内边距补到 10px，让勾选框落进同一列。
  const totalHeader = ''
    + '<div class="total-group' + (state.selectMode ? ' has-check' : '') + '" id="totalGroup">'
    + totalSelectHtml(apis)
    + '  <span class="total-group__label">'
    + '    <span class="group__name">' + t('total.allApis') + '</span>'
    + '    <span class="pane__count" id="apiTotal" title="' + t('total.countFiltered', { n: apis.length, m: allApis.length }) + '">' + countText + '</span>'
    + '  </span>'
    + '  <span class="group__spacer"></span>'
    + headerActions
    + '</div>';

  // 有关键词 → 整个列表换成平铺结果列表（搜索态下分组树没有意义）
  if (q) {
    host.innerHTML = totalHeader + searchResultHtml(apis);
    bindApiListEvents(host);
    return;
  }

  if (!apis.length && !groups.length) {
    host.innerHTML = totalHeader + '<div class="api-scroll">' + t('list.empty') + '</div>';
    /* 空态也要绑：开关现在住在 totalHeader 里，不绑的话这个按钮**看得见但点不动**
     * （列表为空时批量选择确实没什么可做，但「点了没反应」比「按钮不存在」更像坏了）。
     * 里面那些 querySelectorAll 在空态下全部命中 0 个，是空转，无副作用。 */
    bindApiListEvents(host);
    return;
  }

  // 先按分组建桶：groupId 为空、或指向一个已经不存在的分组，一律落到「未分组」
  const known = new Set(groups.map((group) => group.id));
  const buckets = new Map();
  groups.forEach((group) => buckets.set(group.id, []));
  buckets.set(UNGROUPED, []);

  apis.forEach((api) => {
    const key = api.groupId && known.has(api.groupId) ? api.groupId : UNGROUPED;
    buckets.get(key).push(api);
  });

  const visibleGroups = groups.filter((group) => !state.filterGroupIds.length || state.filterGroupIds.includes(group.id));
  const blocks = visibleGroups.map((group) => groupBlockHtml(group.id, group.name, buckets.get(group.id), true));
  const ungrouped = buckets.get(UNGROUPED) || [];
  if (!state.filterGroupIds.length) blocks.push(groupBlockHtml(UNGROUPED, t('group.ungrouped'), ungrouped, false));

  /* 顺序：提示条（发现 N 条不会命中 + 一键停用）挂在批量工具条之上。两者都可能吸顶，
   * 提示条在前是因为它说的是"整个列表有个问题"，而批量条只说"你已经勾了几条"。
   * 搜索平铺态走的是上面那条 return，所以提示条只在分组树态出现 —— 它是清理入口，
   * 不是每次搜完都要看的东西，不必挤进结果列表。 */
  const html = shadowBannerHtml() + batchBarHtml(new Set(apis.map((api) => api.id))) + blocks.join('');
  host.innerHTML = totalHeader + '<div class="api-scroll">' + html + '</div>';

  bindApiListEvents(host);
}

function bindApiListEvents(host) {
  host.querySelectorAll('[data-api-id]').forEach((node) => {
    const apiId = node.getAttribute('data-api-id');

    /* 卡片主体的点击语义随模式走：
     *   批量模式 —— 切换勾选（216px 宽的整行都是可点区域，比瞄准那个 16px 的小方框高效得多；
     *               Gmail / Finder / GitHub 的勾选模式都是这个做法）
     *   平时     —— 切换当前接口（中栏 / 右栏跟随它）
     * 排除项要连「标签壳」一起排除（不只里面的 input）：点 label 的空白照样会激活 input
     * 触发 change，若不同时排除，一次点击会「勾选 + 再切一次」，净效果等于没点。 */
    const isCardControl = (target) => !!(
      target.closest('[data-api-check]') || target.closest('.api-item__check')
      || target.closest('[data-api-toggle]') || target.closest('.api-item__toggle')
      || target.closest('[data-api-group-jump]')
    );
    node.addEventListener('click', (event) => {
      if (isCardControl(event.target)) return;
      if (state.selectMode) toggleApiSelected(apiId);
      else selectApi(apiId);
    });
    // 键盘与鼠标同步换语义 —— 只改鼠标不改键盘，等于留了一半旧行为
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (state.selectMode) toggleApiSelected(apiId);
      else selectApi(apiId);
    });

    // 批量勾选（点方框本身）
    const check = node.querySelector('[data-api-check]');
    if (check) check.addEventListener('change', (event) => {
      event.stopPropagation();
      setApiSelected(apiId, event.target.checked);
    });

    // 结果卡上的「来自哪个分组」chip：点它 = 清掉搜索词、跳回分组树里的那个分组。
    // 必须 stopPropagation，否则会冒泡到卡片的 click（selectApi），只是原地重渲染、跳不过去。
    const groupJump = node.querySelector('[data-api-group-jump]');
    if (groupJump) groupJump.addEventListener('click', (event) => {
      event.stopPropagation();
      jumpToApiGroup(apiId);
    });

    // 单个接口的启用 / 停用（与抽屉里的开关同源，直接写回 config）
    const toggle = node.querySelector('[data-api-toggle]');
    if (toggle) toggle.addEventListener('change', async (event) => {
      event.stopPropagation();
      const api = state.config.apis.find((row) => row.id === apiId);
      if (api) {
        api.enabled = event.target.checked;
        await persist(event.target.checked ? t('apiEnabled') : t('apiDisabled'));
      }
      // 同一条「点一行上的控件，位置别丢」的规则：这个开关也在列表里（见 keepingApiScroll）
      keepingApiScroll(renderApiList);
      if (apiId === state.activeApiId) renderWorkspace();
    });

    /* 接口可拖拽：拖到某个分组块上即归入该分组。
     * draggable 现在挂在 ⋮⋮ 把手上（不再是整张卡片），dragstart 靠冒泡到这里 ——
     * 这样「点整行 = 勾选」（C2）才不会被原生拖拽阈值吞掉。 */
    node.addEventListener('dragstart', (event) => {
      dragApiId = apiId;
      dragGroupId = null;
      event.stopPropagation(); // 阻止冒泡到外层 group，避免误触发分组排序
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', apiId);
      // 拖影默认只有被抓住的那个小把手，看着像「拖了一撮 ⋮⋮」；换成整张卡片
      if (event.dataTransfer.setDragImage) event.dataTransfer.setDragImage(node, 12, 12);
      node.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => {
      dragApiId = null;
      node.classList.remove('is-dragging');
    });
  });

  host.querySelectorAll('[data-group-id]').forEach((node) => {
    const groupId = node.getAttribute('data-group-id');

    /* 组头（勾选框 / ⋯ 菜单 / 拖拽把手以外的任何位置）单击 = 折叠 / 展开。
     * 原来只有最左边那根小箭头绑了 click，组头空白的点击什么都不做 —— 用户「点组头想折叠」
     * 得到的是没反应，只能去点那根 13px 的箭头。箭头按钮的 click 也会冒泡到这里，
     * 所以不要再给它单独绑一遍（否则一次点击折叠两次 = 等于没点）。 */
    const head = node.querySelector('.group__head');
    if (head) head.addEventListener('click', (event) => {
      if (event.target.closest('[data-group-check]')
        || event.target.closest('[data-group-menu]')
        || event.target.closest('.group__drag')) return;
      toggleGroupCollapsed(groupId);
    });

    /* 组头三态勾选框：勾 / 取消 = 组内「当前可见」的那些接口（B1）。
     * 范围与紧挨着的 .group__count 一致（那边也是过滤后的可见数）。 */
    const groupCheck = node.querySelector('[data-group-check]');
    if (groupCheck) {
      const box = groupCheck.querySelector('input');
      if (box) {
        // indeterminate 是 DOM 属性、不是 attribute，HTML 里写不出来，只能渲染后设
        if (box.hasAttribute('data-half')) box.indeterminate = true;
        box.addEventListener('change', (event) => {
          event.stopPropagation();
          const pick = event.target.checked;
          visibleApisOfGroup(groupId).forEach((api) => {
            if (pick) state.selectedApiIds.add(api.id);
            else state.selectedApiIds.delete(api.id);
          });
          keepingApiScroll(renderApiList);
        });
      }
    }

    const menuBtn = node.querySelector('[data-group-menu]');
    if (menuBtn) menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openGroupMenu(groupId, menuBtn);
    });

    /* 分组可被拖动来排序。draggable 挂在 ⋮⋮ 把手上（不再是整块 section）——
     * 整块可拖时组头本身就是拖拽热区，单击经常被原生拖拽阈值吞掉；把手不存在
     * （「未分组」伪分组没有把手）就没有这条。dragstart 靠冒泡到 section 上。 */
    const dragHandle = node.querySelector('.group__drag');
    if (dragHandle) {
      node.addEventListener('dragstart', (event) => {
        dragGroupId = groupId;
        dragApiId = null;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', groupId);
        // 拖影默认只有被抓住的那个小把手，换成整块分组
        if (event.dataTransfer.setDragImage) event.dataTransfer.setDragImage(node, 12, 12);
        node.classList.add('is-dragging');
      });
      node.addEventListener('dragend', () => {
        dragGroupId = null;
        node.classList.remove('is-dragging');
      });
    }

    // 分组块是放置目标：拖接口进来 = 归入该分组；拖分组进来 = 排序（仅真实分组）
    node.addEventListener('dragover', (event) => {
      if (dragApiId) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        node.classList.add('is-drop-target');
      } else if (dragGroupId && groupId !== UNGROUPED && dragGroupId !== groupId) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        node.classList.add('is-drop-target');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.classList.remove('is-drop-target');
      if (dragApiId) { moveApiToGroup(dragApiId, groupId); dragApiId = null; }
      else if (dragGroupId && groupId !== UNGROUPED && dragGroupId !== groupId) { reorderGroup(dragGroupId, groupId); dragGroupId = null; }
    });
  });

  // 顶部「全部接口」总分组的全局汉堡（#totalGroup 每次重渲染会重建，故此处重新绑定一次）
  const totalMenuBtn = host.querySelector('[data-total-menu]');
  if (totalMenuBtn) totalMenuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openGlobalMenu(totalMenuBtn);
  });

  /* 「全部接口」行最右那个批量选择开关（同上，每次重渲染重建）。
   * 它现在是全工程唯一能进批量模式的地方，所以按下必须可靠 —— 它挂在 #totalGroup 里，
   * 而 #totalGroup 是 #apiList 的直接子元素，点它不会冒泡进任何卡片/组头的处理器；
   * stopPropagation 是防它冒到 document 上那个「点空白关闭浮层」的监听。 */
  const selectBtn = host.querySelector('#btnSelect');
  if (selectBtn) selectBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelectMode();
  });

  /* 「全部接口」行的全选勾选框（只在批量模式中出现，见 totalSelectHtml）。
   * 范围 = filteredApis()，与分组头那颗三态框同一份数据、「当前可见」同一口径。
   * indeterminate 是 DOM 属性、不是 attribute，HTML 里写不出来，只能渲染后设。 */
  const totalCheck = host.querySelector('[data-total-check]');
  if (totalCheck) {
    const box = totalCheck.querySelector('input');
    if (box) {
      if (box.hasAttribute('data-half')) box.indeterminate = true;
      box.addEventListener('change', (event) => {
        event.stopPropagation();
        const pick = event.target.checked;
        filteredApis().forEach((api) => {
          if (pick) state.selectedApiIds.add(api.id);
          else state.selectedApiIds.delete(api.id);
        });
        keepingApiScroll(renderApiList);
      });
    }
  }

  const toggleAllBtn = host.querySelector('#btnToggleAllGroups');
  if (toggleAllBtn) toggleAllBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    // 当前有任一分组处于折叠态 → 全部展开；否则全部折叠。一个图标切换两种状态。
    if (collapsedSet().size > 0) expandAllGroups();
    else collapseAllGroups();
  });

  // 零命中空态里的「清除搜索」按钮（Esc 之外的显式出口）
  const clearBtn = host.querySelector('#btnClearSearch');
  if (clearBtn) clearBtn.addEventListener('click', clearSearch);

  /* 提示条上的「全部停用」。按钮每一轮渲染都重建，所以监听必须挂在这里
   * （不能在 bindGlobalEvents 里绑一次）—— 与 ☑ 开关同一个坑：漏了就是「看得见、点不动」。 */
  const btnDisableShadowed = host.querySelector('#btnDisableShadowed');
  if (btnDisableShadowed) btnDisableShadowed.addEventListener('click', disableShadowedApis);

  bindBatchBar();
}

/* ---- 批量勾选（左栏） ---- */

/* 某个分组里**当前可见**（未被搜索词 / 状态 / 分组 chips 挡掉）的接口。
 * 组头三态勾选框的作用范围就是它 —— 与 renderApiList 建桶用的是同一份数据
 * （filteredApis() + groupKeyOf），两边算出来必须完全一致。 */
function visibleApisOfGroup(groupId) {
  return filteredApis().filter((api) => groupKeyOf(api) === groupId);
}

/* 把「重渲染」包一层，保住左栏 .api-scroll 的滚动位置。
 *
 * 为什么必须有这个原语：renderApiList 是 `host.innerHTML = …`，整个滚动容器被重建，
 * 而滚动位置**不在 state 里** —— 一重建就归零。
 * 左栏「在某一行上做点什么」的操作几乎全是重渲染：
 *   ① 批量模式点一行 = 勾选（setApiSelected）
 *   ② 平时态点一行 = 切换当前接口（selectApi，走的是 renderAll）
 *   ③ 行尾的启用 / 停用开关（直接 renderApiList）
 * 这三种都是「往下翻着一路点」的高频操作，归零的表现就是用户报的那句：
 * **滚到中间点一条，列表嗖地跳回最上面**（实测：滚动 967px 处点一条 → 回到 0，
 * 被点的那张卡从视口里 303px 处直接掉到 1270px，跑出可视区）。
 *
 * 为什么做成「包一层」而不是在每个调用点各写一遍 scrollTop 存取：
 * 逐个调用点手写，新增一个调用点就一定漏一个（② 就是这么漏掉的 ——
 * ① 当年补了 renderApiListKeepingScroll，② 换了个函数名 renderAll 就绕过去了）。
 * render 传函数而不是写死 renderApiList，就是为了把 renderAll 那条路也一起收进来。 */
function keepingApiScroll(render) {
  const host = $('#apiList');
  const prev = host && host.querySelector('.api-scroll');
  const top = prev ? prev.scrollTop : 0;
  render();
  if (!top || !host) return;
  const next = host.querySelector('.api-scroll');
  if (next) next.scrollTop = top;
}

function setApiSelected(apiId, picked) {
  if (picked) state.selectedApiIds.add(apiId);
  else state.selectedApiIds.delete(apiId);
  keepingApiScroll(renderApiList);
}

function toggleApiSelected(apiId) {
  setApiSelected(apiId, !state.selectedApiIds.has(apiId));
}

/* 折叠 / 展开一个分组。写哪一份折叠集由 collapsedSet() 决定（批量模式写临时的 batchCollapsed） */
function toggleGroupCollapsed(groupId) {
  const set = collapsedSet();
  if (set.has(groupId)) set.delete(groupId);
  else set.add(groupId);
  persistCollapsed();
  renderApiList();
}

/* ------------------------------ 左栏定位（搜索态下最容易坏的地方） ------------------------------ */

/* 接口所属分组的「桶键」：groupId 为空、或指向一个已经不存在的分组，一律算「未分组」。
 * 建桶逻辑（renderApiList）与这里必须一致 —— 否则会去展开一个不存在的分组 id，
 * 而卡片其实落在 UNGROUPED 且仍折叠，表现就是「点了定位，左边没动静」。 */
function groupKeyOf(api) {
  const known = new Set(((state.config && state.config.groups) || []).map((group) => group.id));
  return (api && api.groupId && known.has(api.groupId)) ? api.groupId : UNGROUPED;
}

/* 展开某接口所在分组（已展开就什么都不做，不写 localStorage） */
function expandGroupOf(api) {
  const key = groupKeyOf(api);
  const set = collapsedSet();
  if (!set.has(key)) return;
  set.delete(key);
  persistCollapsed();
}

/* 把左栏当前定位到的接口卡片滚进可视区（选中态卡片带 is-active 高亮） */
function scrollToActiveApi() {
  const node = document.querySelector('.api-item.is-active');
  if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return node;
}

/* 清空搜索词（含输入框里的值）。去掉挂起的防抖定时器，免得刚清完又被一次旧输入渲染回搜索态。 */
function clearSearch() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = 0; }
  state.searchQuery = '';
  const input = $('#apiSearch');
  if (input) input.value = '';
}

/* 让某个接口在左栏可见可定位：只在「目标确实不在当前过滤结果中」时才清掉冲突的筛选。
 * 中间工作区本身不受搜索影响（renderWorkspace 不读 searchQuery），所以日志链路会出现
 * 「中间滚过去了、左边没反应」的半失效 —— 根因是定位依赖卡片此刻在左栏 DOM 里：
 *   document.querySelector('.api-item.is-active') → scrollIntoView()
 * 卡片被搜索词/状态/分组 chips 挡掉时，这个查询拿不到节点，静默失败、连提示都没有。
 * 中间「定位」按钮与右栏日志点击两处共用本函数，不要各写一遍。 */
function ensureApiVisible(apiId) {
  const api = ((state.config && state.config.apis) || []).find((row) => row.id === apiId);
  if (!api) return false;
  const inResult = filteredApis().some((row) => row.id === apiId);
  if (!inResult) {
    // 有筛选把它挡住了：清掉冲突筛选并明确告诉用户「为什么界面变了」
    clearSearch();
    state.filterStatus = 'all';
    state.filterGroupIds = [];
    renderFilterPanel();
    toast(t('search.clearedForLocate'), 'ok');
  }
  expandGroupOf(api);
  renderAll();
  scrollToActiveApi();
  return true;
}

/* 结果卡上的分组 chip：清掉搜索词、回到分组树，并展开该接口所在分组把它滚出来。
 * 与 ensureApiVisible 的区别是「无条件退搜索」—— 用户点 chip 的意图就是「我要看它在原分组里的位置」。 */
function jumpToApiGroup(apiId) {
  const api = ((state.config && state.config.apis) || []).find((row) => row.id === apiId);
  if (!api) return;
  clearSearch();
  // 退了搜索还可能被状态/分组 chips 挡住（清搜索后仍不在结果里），这时再清一遍冲突筛选
  if (!filteredApis().some((row) => row.id === apiId)) {
    state.filterStatus = 'all';
    state.filterGroupIds = [];
    renderFilterPanel();
  }
  expandGroupOf(api);
  state.activeApiId = apiId;
  renderAll();
  scrollToActiveApi();
}

/* 切换当前接口：试打的输入与上一次结果都属于「上一个接口」，必须清掉，
 * 否则会把 A 接口的试打结果画在 B 接口的规则列表上。 */
function selectApi(apiId) {
  if (apiId === state.activeApiId) return;
  state.activeApiId = apiId;
  state.hitRuleId = null;
  state.tryDraft = null;
  state.lastTry = null;
  /* 这里必须用 keepingApiScroll 而不是裸 renderAll：
   * renderAll 会把整站重画一遍，左栏 .api-scroll 跟着重建 ——
   * 用户报的就是这条路径：「往下滚，点中间某个分组里的一条，列表直接跳回最上面」。
   * 选中的是哪个接口没丢（is-active 是对的），丢的只是「我刚才翻到哪儿了」。
   * 注意别改成先 renderAll 再 scrollToActiveApi()：那是「把选中项拉到屏幕中间」，
   * 语义是**定位过去**（ensureApiVisible / jumpToApiGroup 用它），
   * 而这里是用户自己点的一张卡，它本来就在视口里，不该再动视口。 */
  keepingApiScroll(renderAll);
  /* 开了「只看当前接口」时，日志是按接口向服务端过滤的：这里不重新拉一次，
   * 切完接口日志还停在上一个接口的记录上，看起来像开关失效。 */
  if (state.logApiOnly) refreshLogs();
}

/* ------------------------------ 分组维护 ------------------------------ */

/* 全站弹窗共用一个品牌标记：只在这里定义一份 SVG，由 applyModalIcons() 填进所有 [data-modal-icon]
 * 占位，免得六个弹窗各抄一遍同样的路径。颜色用 currentColor，跟着主题的 accent 走。 */
const MODAL_MARK_SVG = ''
  + '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true" focusable="false">'
  + '<path d="M9 22V10l7 7 7-7v12" fill="none" stroke="currentColor" stroke-width="3.2"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

function applyModalIcons() {
  document.querySelectorAll('[data-modal-icon]').forEach((node) => {
    if (!node.querySelector('svg')) node.innerHTML = MODAL_MARK_SVG;
  });
}

/* 居中输入弹窗，替代浏览器原生 prompt()（原生弹窗默认在屏幕上方，且样式不可控） */
function askText(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = $('#promptLayer');
    const form = $('#promptForm');
    const titleEl = $('#promptTitle');
    const hintEl = $('#promptHint');
    const inputEl = $('#promptInput');
    const errEl = $('#promptError');
    if (!layer || !form) { resolve(null); return; }
    /* 多行模式：cURL 命令是多行的，单行 input 会把换行吃掉（粘贴进来只剩最后一段）。
     * 这里临时换成一个 textarea，关闭时移除 —— 不去改 index.html 的公共骨架。 */
    let area = null;
    let inputWrap = null;
    if (o.multiline) {
      area = document.createElement('textarea');
      area.className = 'textarea mono';
      area.spellcheck = false;
      area.rows = 6;
      area.style.width = '100%';
      area.value = o.value || '';
      /* 单行 input 所在的 .field 必须一起藏：`hidden` 属性只有 UA 的 `[hidden]{display:none}` 兜着，
       * 被作者样式里的 display 一比就输 —— 结果是多行模式下输入框仍在，下面多一个空框。
       * 内联 display:none 才压得住；textarea 插到 .field 的**外层**，别插进去（插进去会一起被藏掉）。 */
      inputWrap = inputEl.parentNode;
      inputEl.hidden = true;
      if (inputWrap) {
        inputWrap.style.display = 'none';
        inputWrap.parentNode.insertBefore(area, inputWrap.nextSibling);
      } else {
        inputEl.insertAdjacentElement('afterend', area);
      }
    }
    titleEl.textContent = o.title || t('prompt.title');
    hintEl.textContent = o.hint || '';
    hintEl.hidden = !o.hint;
    if (!o.multiline) inputEl.value = o.value || '';
    inputEl.placeholder = o.placeholder || o.hint || '';
    $('#promptOk').textContent = o.confirmText || t('prompt.ok');
    /* multiline 模式：加宽弹窗、换剪贴板图标、给 textarea 加占位 */
    const card = form;
    card.classList.toggle('is-multiline', !!o.multiline);
    card.classList.toggle('modal-card--wide', !!o.wide);
    if (o.multiline && area) {
      area.placeholder = o.placeholder || t('try.pastePh');
      const iconEl = card.querySelector('[data-modal-icon]');
      if (iconEl) iconEl.innerHTML = MODAL_MARK_SVG;
    }
    errEl.textContent = '';
    layer.hidden = false;
    setTimeout(() => (area || inputEl).focus(), 0);
    const onSubmit = (event) => { event.preventDefault(); close(true); };
    const onCancel = () => close(false);
    // 点遮罩 / 按 ESC 都算取消。必须走 close() 收尾：直接 hidden 掉的话 await 会永远挂着
    const onBackdrop = (event) => { if (event.target === layer) close(false); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();   // 捕获阶段拦下，别让全局 ESC 顺手把抽屉、菜单也一起关了
      close(false);
    };
    const close = (ok) => {
      const value = (area || inputEl).value.trim();
      layer.hidden = true;
      if (area) {
        area.remove();
        inputEl.hidden = false;
        if (inputWrap) inputWrap.style.display = '';
      }
      form.classList.remove('is-multiline');
      /* 恢复品牌图标（弹窗复用，下次可能不是 multiline） */
      const iconEl = form.querySelector('[data-modal-icon]');
      if (iconEl && !iconEl.querySelector('svg') || (iconEl && iconEl.innerHTML !== MODAL_MARK_SVG)) {
        iconEl.innerHTML = MODAL_MARK_SVG;
      }
      form.removeEventListener('submit', onSubmit);
      $('#promptCancel').removeEventListener('click', onCancel);
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(ok ? value : null);
    };
    form.addEventListener('submit', onSubmit);
    $('#promptCancel').addEventListener('click', onCancel);
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/* 居中确认弹窗，替代浏览器原生 confirm()。
 * 原生 confirm 固定挂在窗口顶部、字体配色全由浏览器决定，跟站内其他弹窗完全是两个长相；
 * 这里复用同一套弹窗骨架，危险操作再配上危险色的图标底板和主按钮。 */
function askConfirm(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = $('#confirmModal');
    const card = $('#confirmCard');
    const okBtn = $('#confirmOk');
    const cancelBtn = $('#confirmCancel');
    const titleEl = $('#confirmTitle');
    const textEl = $('#confirmText');
    // 弹窗结构缺失时退回原生 confirm：宁可丑，也不能把删除类操作卡死
    if (!layer || !card || !okBtn || !cancelBtn) { resolve(window.confirm(o.message || '')); return; }
    const danger = o.danger !== false;
    titleEl.textContent = o.title || t('confirm.title');
    textEl.textContent = o.message || '';
    textEl.hidden = !o.message;
    okBtn.textContent = o.okText || t('prompt.ok');
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--accent');
    card.classList.toggle('is-danger', danger);
    layer.hidden = false;
    setTimeout(() => okBtn.focus(), 0);
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (event) => { if (event.target === layer) close(false); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(false);
    };
    const close = (ok) => {
      layer.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(!!ok);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * 单选弹窗：给「导入冲突怎么处理」这类必须在几个方案里挑一个的场景用。
 * 结构与静态弹窗完全一致（.modal-layer > .modal-card，头区带品牌角标），
 * 只是选项数量不定，所以动态创建。返回所选 value；取消 / ESC / 点遮罩返回 null。
 */
function askChoice(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML = ''
      + '<div class="modal-card__head">'
      + '  <span class="modal-card__icon" data-modal-icon aria-hidden="true"></span>'
      + '  <div class="modal-card__heading">'
      + '    <h2 class="modal-card__title"></h2>'
      + '    <p class="modal-card__hint"></p>'
      + '  </div>'
      + '</div>'
      + '<div class="modal-card__body"><div class="choice-list"></div></div>'
      + '<div class="modal-card__acts"><button class="btn btn--ghost" type="button" data-choice-cancel></button></div>';

    card.querySelector('.modal-card__title').textContent = o.title || t('choice.title');
    const hintEl = card.querySelector('.modal-card__hint');
    hintEl.textContent = o.message || '';
    hintEl.hidden = !o.message;
    card.querySelector('[data-choice-cancel]').textContent = o.cancelText || t('prompt.cancel');

    const list = card.querySelector('.choice-list');
    (o.options || []).forEach((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (option.danger ? ' is-danger' : '');
      btn.setAttribute('data-choice-value', option.value);
      // 文案一律用 textContent：选项里可能带用户数据（接口名之类），不能拼 innerHTML
      const name = document.createElement('span');
      name.className = 'choice__name';
      name.textContent = option.label;
      btn.appendChild(name);
      if (option.desc) {
        const desc = document.createElement('span');
        desc.className = 'choice__desc';
        desc.textContent = option.desc;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => close(option.value));
      list.appendChild(btn);
    });

    layer.appendChild(card);
    document.body.appendChild(layer);
    applyModalIcons();

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      layer.remove();
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onBackdrop = (event) => { if (event.target === layer) close(null); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();   // 别让全局 ESC 顺手把抽屉、菜单一起关了
      close(null);
    };
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    card.querySelector('[data-choice-cancel]').addEventListener('click', () => close(null));
    setTimeout(() => {
      const first = list.querySelector('.choice');
      if (first) first.focus();
    }, 0);
  });
}

async function addGroup() {
  const name = (await askText({ title: t('group.newTitle'), hint: t('group.newHint'), value: '', confirmText: t('group.confirm'), wide: true }) || '').trim();
  if (!name) return;
  const groups = state.config.groups || (state.config.groups = []);
  if (groups.some((group) => group.name === name)) {
    toast(t('group.dupe'), 'bad');
    return;
  }
  groups.push({ id: 'g' + Date.now().toString(36), name: name });
  await persist(t('group.created'));
  renderAll();
}

async function renameGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const name = (await askText({ title: t('group.renameTitle'), hint: '', value: group.name, confirmText: t('group.renameConfirm') }) || '').trim();
  if (!name || name === group.name) return;
  group.name = name;
  await persist(t('group.renamed'));
  renderApiList();
}

/* 复制分组：新分组（名字由用户确认）+ 组内每个接口深拷贝一份、归入新分组。
 *
 * 定位是「整套场景副本」（见 docs/接口复制改造设计.md §4 决策 9）：组内接口的路径
 * **原样保留**。这套用法的前提是"调用方代码不改、只换挡板返回的数据"—— 路径一改，
 * 前端就得跟着改，那就不叫换一套数据了。代价是副本组整组都会被标成「被「XX」遮蔽」，
 * 这是**符合预期的**：它本来就是备用的那一套。
 * 切换方式：把原件组批量停用，副本组自动接管（副本组本来就启用着），不需要分组级开关。
 *
 * 加一次改名前确认：分组复制一次产生 **N 条**持久数据，比单个接口复制后果更大，
 * 而原来点一下就直接生成「XX（副本）」—— 与"点一下就产生数据"的抱怨是同一件事。 */
async function copyGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const groups = state.config.groups || (state.config.groups = []);
  const name = (await askText({
    title: t('group.copyTitle'),
    hint: t('group.copyHint'),
    value: group.name + t('group.copySuffix'),
    confirmText: t('group.copyConfirm'),
  }) || '').trim();
  if (!name) return;
  // 重名直接拒绝（与 addGroup 同一个约定）：分组在别处是按名字映射的（resolveGroupId）
  if (groups.some((row) => row.name === name)) { toast(t('group.dupe'), 'bad'); return; }

  const newId = 'g' + Date.now().toString(36);
  groups.push({ id: newId, name: name });
  const src = state.config.apis.filter((api) => api.groupId === groupId);
  src.forEach((api) => {
    const copy = JSON.parse(JSON.stringify(api));
    copy.id = 'api-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    copy.groupId = newId;
    copy.name = (copy.name || '') + t('group.copySuffix');
    state.config.apis.push(copy);
  });
  shadowCache = null;
  // 原来这里是硬编码中文（'分组已复制（N 个接口）'），英文界面下会漏出中文 —— 一并收进 i18n
  await persist(t('group.copied', { n: src.length }));
  renderAll();
}

/* 复制单个接口 —— **打开编辑抽屉，不再直接落盘**。
 *
 * 这是相对前序版本最大的行为改动（前序设计稿 §4.1 的 duplicateApi 规格已被推翻，
 * 背景与实测证据见 docs/接口复制改造设计.md）。原来是"深拷贝 → 直接入库 → 落盘"，
 * 三个问题叠在一起：
 *   ① 点了就产生持久化数据，没有确认与修改的机会（用户的原始抱怨）；
 *   ② 副本保持原路径 ⇒ 排在原件后面 ⇒ **每次复制都必然打出「不会命中」** ——
 *      功能自己否定自己的结果；
 *   ③ 落盘后不切 activeApiId，中栏纹丝不动 + 唯一的反馈是否定性的 ⇒ 用户以为失败 ⇒
 *      **再点一次** ⇒ n 份。实测用户实例里正是这个循环留下的 14 条副本，且内容指纹
 *      两两全等（0 条被改成过变体）。
 *
 * 现在改成：预填一条新接口 → 走**已经存在**的 openApiDrawer（它本来就支持 templateItem），
 * **保存才落盘**，取消 = 零副作用。路径预填"下一个可用值"，所以最省力的做法
 * （什么都不改直接保存）会直接得到一条能命中请求的接口。名字加「（副本）」后缀。
 *
 * 为什么 enabled 不再"跟随原件"：那条理由（副本启用而原件停用会"悄悄接管"）**已经被
 * 插入位置否掉了** —— 副本排在原件正下方，原件启用时它抢不到路由（第一条匹配是原件）；
 * 原件停用时它接管，而"接管"正是备份想要的回滚能力。反过来，"跟随原件"会让副本
 * **在任何情况下都不可能生效**（原件停 ⇒ 副本也停），只能靠用户事后手动去开它的开关。
 *
 * 保存时的插入位置、落盘后的定位都在 saveDrawer 里 —— 那里才知道原件当前的下标。 */
function duplicateApi(apiId) {
  const src = ((state.config && state.config.apis) || []).find((row) => row.id === apiId);
  if (!src) return;
  openApiDrawer(null, src, { duplicateOf: src.id });
}

async function removeGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const count = state.config.apis.filter((api) => api.groupId === groupId).length;
  if (!(await askConfirm({
    title: t('group.deleteTitle'),
    message: t('group.deleteConfirm', { name: group.name, count: count }),
    okText: t('btn.delete'),
  }))) return;

  state.config.groups = state.config.groups.filter((row) => row.id !== groupId);
  state.config.apis.forEach((api) => {
    if (api.groupId === groupId) api.groupId = '';
  });
  // 分组没了，折叠记录一并清掉（两份折叠集都清 —— 批量模式读的是 batchCollapsed）
  state.collapsedGroups.delete(groupId);
  state.batchCollapsed.delete(groupId);
  await persist(t('group.deleted'));
  renderAll();
}

/* 上移 / 下移：直接在 config.groups 数组里交换位置，顺序即渲染顺序 */
async function moveGroup(groupId, dir) {
  const groups = state.config.groups || [];
  const idx = groups.findIndex((group) => group.id === groupId);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= groups.length) return;
  const moved = groups[idx];
  groups[idx] = groups[target];
  groups[target] = moved;
  await persist(t('group.moved'));
  renderAll();
}

/* 拖拽落点：把被拖的分组插到目标分组的位置 */
async function reorderGroup(fromId, toId) {
  const groups = state.config.groups || [];
  const fromIdx = groups.findIndex((group) => group.id === fromId);
  const toIdx = groups.findIndex((group) => group.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = groups.splice(fromIdx, 1);
  groups.splice(toIdx, 0, moved);
  await persist(t('group.moved'));
  renderAll();
}

/* 把接口移动到某个分组：groupId 为 UNGROUPED 时归入「未分组」（groupId 置空） */
async function moveApiToGroup(apiId, groupId) {
  const api = state.config.apis.find((row) => row.id === apiId);
  if (!api) return;
  const target = groupId === UNGROUPED ? '' : groupId;
  if (api.groupId === target) return;
  api.groupId = target;
  await persist('接口已移动到「' + groupName(groupId) + '」');
  renderAll();
}

function groupName(groupId) {
  if (groupId === UNGROUPED) return t('group.ungrouped');
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  return group ? group.name : t('group.ungrouped');
}

/* 抽屉里输入的「分组名」→ groupId：留空=未分组；已存在取 id；否则新建分组 */
function resolveGroupId(name) {
  const groups = (state.config && state.config.groups) || (state.config.groups = []);
  name = (name || '').trim();
  if (!name) return '';
  const found = groups.find((group) => group.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const created = { id: 'g' + Date.now().toString(36), name: name };
  groups.push(created);
  return created.id;
}

/* 批量工具条：勾选接口后出现。三个动作 + 「清空」。
 *
 * 「清空」只清空勾选、**不退出**批量模式（退出统一交给左栏常驻的「完成」按钮 / Esc）——
 * 批量操作天然是连续动作，想接着停下一组不该被踢出模式。
 * 三个动作做完同样是「清空 + 留在模式」：工具条会随之消失（它只在有勾选时存在），
 * 但左栏头部那个「完成」按钮一直亮着（.is-on），所以「我还在模式里」始终可见 ——
 * 不会再出现「工具条突然没了、不知道自己在哪」的困惑。 */
function bindBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;
  $('#btnBatchDisable').addEventListener('click', () => batchSetEnabled(false));
  $('#btnBatchEnable').addEventListener('click', () => batchSetEnabled(true));
  $('#btnBatchMove').addEventListener('click', (event) => {
    // 必须拦掉冒泡：document 上那个「点菜单以外区域关菜单」的处理器会把刚打开的菜单立刻收起来
    event.stopPropagation();
    openBatchMoveMenu(event.currentTarget);
  });
  $('#btnBatchClear').addEventListener('click', () => {
    state.selectedApiIds.clear();
    renderApiList();
  });
}

/* 批量移组的目标列表 = 所有分组 + 「未分组」。复用浮层菜单，与分组菜单同一套长相，零新 UI 语言。 */
function openBatchMoveMenu(anchor) {
  const groups = (state.config && state.config.groups) || [];
  const items = groups.map((group) => ({
    label: group.name, icon: '▸', onClick: () => batchMoveToGroup(group.id),
  }));
  items.push({ label: t('group.ungrouped'), icon: '▸', onClick: () => batchMoveToGroup(UNGROUPED) });
  openCtxMenu(anchor, items);
}

/* 批量移组。**不能循环调用 moveApiToGroup** —— 那里面每条都自带 persist + renderAll，
 * 一批 10 条就是 10 次落盘 + 10 次全量重渲染。这里统一「改完一批 → 一次 persist → 一次 render」。 */
async function batchMoveToGroup(groupId) {
  const ids = state.selectedApiIds;
  if (!ids.size) return;
  const target = groupId === UNGROUPED ? '' : groupId;
  let moved = 0;
  state.config.apis.forEach((api) => {
    if (!ids.has(api.id) || api.groupId === target) return;
    api.groupId = target;
    moved += 1;
  });
  // 全都在目标分组里：不动数据也不落盘，但要说清楚，别让用户以为按钮坏了
  if (!moved) { toast(t('batch.moveNoop'), 'ok'); return; }
  await persist(t('batch.moved', { n: moved, name: groupName(groupId) }));
  ids.clear();
  renderAll();
}

async function batchSetEnabled(enabled) {
  const ids = state.selectedApiIds;
  if (!ids.size) return;
  state.config.apis.forEach((api) => { if (ids.has(api.id)) api.enabled = enabled; });
  await persist('已' + (enabled ? '启用' : '停用') + ' ' + ids.size + ' 个接口');
  ids.clear();
  renderAll();
}

/* ------------------------------ 工作区 ------------------------------ */

/* 命中徽标：数据来自服务端内存累加器（/_admin/stats），与 200 条日志轮转无关。
 * 0 次不是"没数据"，而是"从未命中"——这是发现死规则最直接的信号。 */
function hitBadgeHtml(ruleId) {
  const count = hitCountOf(state.activeApiId, ruleId);
  if (count === null) return '<span class="hit-chip is-unknown" data-hit-badge hidden></span>';
  if (!count) {
    return '<span class="hit-chip is-never" data-hit-badge title="' + t('hit.neverTitle') + '">' + t('hit.never') + '</span>';
  }
  return '<span class="hit-chip" data-hit-badge title="' + t('hit.countTitle', { n: count }) + '">' + t('hit.count', { n: count }) + '</span>';
}

/** 只更新徽标，不整段重渲染（避免每轮拉取统计都把工作区重建一次） */
function updateHitBadges() {
  const targets = [];
  document.querySelectorAll('[data-rule-id]').forEach((node) => {
    targets.push({ node: node, badge: node.querySelector('[data-hit-badge]'), ruleId: node.getAttribute('data-rule-id') });
  });
  const fallback = document.querySelector('[data-fallback-row]');
  if (fallback) targets.push({ node: fallback, badge: fallback.querySelector('[data-hit-badge]'), ruleId: '' });

  targets.forEach((item) => {
    if (!item.badge) return;
    const count = hitCountOf(state.activeApiId, item.ruleId);
    if (count === null) { item.badge.hidden = true; return; }
    item.badge.hidden = false;
    item.badge.className = 'hit-chip' + (count ? '' : ' is-never');
    item.badge.textContent = count ? t('hit.count', { n: count }) : t('hit.never');
    item.badge.title = count ? t('hit.countTitle', { n: count }) : t('hit.neverTitle');
  });
}

/** 「最后由谁在什么时候改的」——多人共用面板时排查「规则为什么变了」的第一手线索 */
function updatedMetaHtml(owner) {
  if (!owner || !owner.updatedAt) return '';
  const at = timeText(owner.updatedAt);
  const by = owner.updatedBy || '';
  return '<span class="meta-text">' + escapeHtml(by
    ? t('meta.updated', { by: by, at: at })
    : t('meta.updatedNoUser', { at: at })) + '</span>';
}

function conditionSummary(rule) {
  if (!rule.conditions || !rule.conditions.length) return t('rule.condNone');
  const joiner = rule.match === 'any' ? ' <b>' + t('rule.or') + '</b> ' : ' <b>' + t('rule.and') + '</b> ';
  return rule.conditions.map((condition) => {
    const source = labelOf(SOURCE_LABEL, condition.source, condition.source);
    const path = condition.source === 'raw' ? t('rule.raw') : (condition.path || '?');
    const op = labelOf(OP_LABEL, condition.op, condition.op);
    const value = OP_WITHOUT_VALUE.indexOf(condition.op) >= 0 ? '' : ' ' + escapeHtml(condition.value);
    return escapeHtml(source) + ' <b>' + escapeHtml(path) + '</b> ' + escapeHtml(op) + value;
  }).join(joiner);
}

/* -------------------- 只读分享视图：规则响应摘要 / 只读详情 -------------------- */

/** 规则卡行内响应摘要（仅只读分享视图渲染）：一眼看到该规则返回什么 */
function ruleResponseSummaryHtml(rule) {
  const r = rule.response || {};
  const status = Number(r.status || 200);
  const delay = Number(r.delayMs || 0);
  const type = r.contentType || 'application/json;charset=UTF-8';
  const isScript = r.mode === 'script';
  const fault = (FAULT_OPTIONS.indexOf(r.fault) >= 0 && r.fault && r.fault !== 'none') ? r.fault : '';
  const body = isScript ? (r.script || '') : (r.body || '');
  const bits = ''
    + '<span class="rule__resp-status">' + status + '</span>'
    + '<span class="rule__resp-type">' + escapeHtml(type) + '</span>'
    + (delay ? '<span class="rule__resp-delay">⏱ ' + delay + 'ms</span>' : '')
    + (isScript ? '<span class="tag tag--info rule__resp-mode">' + t('resp.script') + '</span>' : '')
    + (fault ? '<span class="tag tag--warn">' + escapeHtml(t('resp.fault' + fault.charAt(0).toUpperCase() + fault.slice(1))) + '</span>' : '');
  return ''
    + '<div class="rule__resp" title="' + escapeHtml(t('rule.respTitle')) + '">'
    + '  <div class="rule__resp-head">' + bits + '</div>'
    + '  <pre class="rule__resp-body">' + escapeHtml(body) + '</pre>'
    + '</div>';
}

/** 只读抽屉里的「标签 : 值」一行 */
function readonlyRow(label, valueHtml) {
  return '<div class="readonly-row"><span class="readonly-row__label">' + escapeHtml(label)
    + '</span><span class="readonly-row__value">' + valueHtml + '</span></div>';
}

/** 只读抽屉里的响应配置（状态 / 延迟 / 方式 / Content-Type / 故障 / 响应体） */
function responseReadonlyHtml(response) {
  const r = response || {};
  const status = Number(r.status || 200);
  const delay = Number(r.delayMs || 0);
  const delayMax = Number(r.delayMaxMs || 0);
  const isScript = r.mode === 'script';
  const type = r.contentType || 'application/json;charset=UTF-8';
  const fault = (FAULT_OPTIONS.indexOf(r.fault) >= 0 && r.fault && r.fault !== 'none') ? r.fault : '';
  const rows = ''
    + readonlyRow(t('resp.status'), String(status))
    + readonlyRow(t('resp.delay'), delay ? (delay + ' ms' + (delayMax ? '（≤' + delayMax + 'ms）' : '')) : t('resp.delayNone'))
    + readonlyRow(t('resp.mode'), isScript ? t('resp.script') : t('resp.static'))
    + readonlyRow('Content-Type', escapeHtml(type));
  const faultRow = fault ? readonlyRow(t('resp.fault'), escapeHtml(t('resp.fault' + fault.charAt(0).toUpperCase() + fault.slice(1)))) : '';
  const content = '<pre class="readonly-pre">' + escapeHtml(isScript ? (r.script || '') : (r.body || '')) + '</pre>';
  return rows + faultRow
    + '<div class="section-label" style="margin-top:8px">' + (isScript ? t('resp.scriptLabel') : t('resp.body')) + '</div>'
    + content;
}

/** 只读抽屉：完整展示一条规则（基本信息 / 条件 / 响应 / 变更记录入口），无任何可编辑控件 */
function renderRuleReadonly(rule) {
  const item = activeApi();
  const body = $('#drawerBody');
  if (!body) return;
  body.innerHTML = ''
    + '<div class="section-label">' + t('rule.basic') + '</div>'
    + readonlyRow(t('rule.name'), escapeHtml(rule.name || t('rule.unnamed')))
    + readonlyRow(t('rule.enable'), rule.enabled === false ? t('rule.disabled') : t('rule.enabled'))
    + readonlyRow(t('rule.matchMode'), rule.match === 'any' ? t('rule.matchAny') : t('rule.matchAll'))
    + '<div class="section-label">' + t('rule.condSection') + '</div>'
    + '<div class="readonly-block">' + (rule.conditions && rule.conditions.length ? conditionSummary(rule) : t('rule.condNone')) + '</div>'
    + '<div class="section-label">' + t('rule.respSection') + '</div>'
    + responseReadonlyHtml(rule.response)
    + '<div class="btn-row" style="margin-top:16px">'
    + '  <button class="btn" type="button" id="btnRuleChangelog">' + t('changelog.btn') + '</button>'
    + '</div>';
  const btnCl = $('#btnRuleChangelog');
  if (btnCl && item) btnCl.addEventListener('click', () => openChangelogModal(item.id, item.name));
}

/** 只读分享视图：点规则卡「查看」打开只读抽屉 */
function openRuleReadonly(index) {
  const item = activeApi();
  if (!item) return;
  state.drawerMode = 'rule';
  state.drawerReadonly = true;
  state.editingRuleId = null;
  state.draft = null;
  setDrawerTitle('drawer.viewRule');
  const rule = item.rules[index];
  if (!rule) return;
  renderRuleReadonly(rule);
  openDrawer();
}

/** 只读分享视图：点兜底行「查看」打开只读抽屉（仅展示默认响应配置） */
function openDefaultReadonly() {
  const item = activeApi();
  if (!item) return;
  state.drawerMode = 'rule';
  state.drawerReadonly = true;
  state.editingRuleId = null;
  state.draft = null;
  setDrawerTitle('default.viewTitle');
  const body = $('#drawerBody');
  if (!body) return;
  body.innerHTML = ''
    + '<div class="section-label">' + t('rule.respSection') + '</div>'
    + responseReadonlyHtml(item.defaultResponse)
    + '<div class="btn-row" style="margin-top:16px">'
    + '  <button class="btn" type="button" id="btnRuleChangelog">' + t('changelog.btn') + '</button>'
    + '</div>';
  const btnCl = $('#btnRuleChangelog');
  if (btnCl) btnCl.addEventListener('click', () => openChangelogModal(item.id, item.name));
  openDrawer();
}

function renderWorkspace() {
  const host = $('#workspace');
  const item = activeApi();

  if (!item) {
    host.innerHTML = t('ws.empty');
    const rc0 = $('#ruleCount');
    if (rc0) rc0.textContent = t('ruleCount', { n: 0 });
    return;
  }

  const rc = $('#ruleCount');
  if (rc) rc.textContent = t('ruleCount', { n: (item.rules || []).length });

  const rules = item.rules || [];
  const rulesHtml = rules.map((rule, index) => {
    const indexClass = 'rule-index' + (state.hitRuleId === rule.id ? ' is-hit' : '');
    const classes = ['rule'];
    if (rule.enabled === false) classes.push('is-off');
    if (state.hitRuleId === rule.id) classes.push('is-hit');
    return ''
      + '<article class="' + classes.join(' ') + '" data-rule-id="' + escapeHtml(rule.id) + '">'
      + '  <span class="' + indexClass + '">R' + (index + 1) + '</span>'
      + '  <label class="switch" title="' + t('rule.toggleTitle') + '">'
      + '    <input type="checkbox" data-action="toggle" ' + (rule.enabled === false ? '' : 'checked') + (state.auth.readonly ? ' disabled' : '') + '>'
      + '    <span class="switch__track"></span><span class="switch__thumb"></span>'
      + '    <span class="sr-only">' + t('rule.srOnly', { name: rule.name || '' }) + '' + escapeHtml(tSeed(rule.name) || '') + '</span>'
      + '  </label>'
      + '  <div class="rule__main">'
      + '    <div class="rule__name">' + escapeHtml(tSeed(rule.name) || t('rule.unnamed')) + '</div>'
      + '    <div class="rule__cond">' + conditionSummary(rule) + '</div>'
      + '    <div class="rule__meta">'
      + hitBadgeHtml(rule.id)
      + updatedMetaHtml(rule)
      + '    </div>'
      + (state.auth.readonly ? ruleResponseSummaryHtml(rule) : '')
      + '  </div>'
      + '  <div class="rule__actions">'
      + (state.auth.readonly
          ? '    <button class="btn btn--icon" type="button" data-view-only data-action="view" title="' + t('rule.view') + '">👁</button>'
          : '')
      + '    <button class="btn btn--icon" type="button" data-edit-only data-action="up" title="' + t('rule.up') + '" ' + (index === 0 ? 'disabled' : '') + '>↑</button>'
      + '    <button class="btn btn--icon" type="button" data-edit-only data-action="down" title="' + t('rule.down') + '" ' + (index === rules.length - 1 ? 'disabled' : '') + '>↓</button>'
      + '    <button class="btn btn--icon" type="button" data-edit-only data-action="copy" title="' + t('rule.copy') + '">⧉</button>'
      + '    <button class="btn btn--icon" type="button" data-edit-only data-action="edit" title="' + t('rule.edit') + '">✎</button>'
      + '    <button class="btn btn--icon btn--danger-quiet" type="button" data-edit-only data-action="remove" title="' + t('rule.delete') + '">✕</button>'
      + '  </div>'
      + '</article>';
  }).join('');

  // 查找当前接口所属分组名称（左栏收缩时用户看不到左侧分组，需在头部展示）
  const apiGroup = (item.groupId && state.config.groups)
    ? state.config.groups.find(function (g) { return g.id === item.groupId; })
    : null;
  const groupName = apiGroup ? apiGroup.name : t('group.ungrouped');

  host.innerHTML = ''
    /* ---- 工作区标题行（在 workspace 内部，随内容滚动） ---- */
    + '<div class="ws-head">'
    + '  <h2 class="ws-head__title">' + t('pane.mid.title') + '</h2>'
    + '  <span class="tag ws-head__count" id="ruleCount">' + t('ruleCount', { n: (item.rules || []).length }) + '</span>'
    + '  <span class="ws-head__group" title="' + t('ws.head.groupTitle') + '">' + escapeHtml(tSeed(groupName)) + '</span>'
    + '  <button class="btn btn--icon ws-head__locate" id="btnLocateApi" type="button" title="' + t('ws.head.locate') + '">'
    + '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 13-13c0-3.87-3.13-7-7-7z"></path><circle cx="12" cy="9" r="2.5"></circle></svg>'
    + '  </button>'
    + '  <button class="btn btn--accent" id="btnAddRule" type="button" data-edit-only style="margin-left:auto">' + t('btn.addRule') + '</button>'
    + '</div>'
    /* ---- 接口头 ---- */
    + '<section class="card">'
    + '  <div class="card__body">'
    + '    <div style="display:flex; align-items:flex-start; gap:16px">'
    + '      <div style="flex:1; min-width:0">'
    + '        <h2 class="apibox__title">' + escapeHtml(tSeed(item.name) || t('api.unnamed')) + '</h2>'
    + '        <p class="apibox__desc">' + escapeHtml(tSeed(item.desc) || t('api.noDesc')) + '</p>'
    + (updatedMetaHtml(item) ? '<p class="apibox__desc apibox__meta">' + updatedMetaHtml(item) + '</p>' : '')
    + '      </div>'
    + '      <div class="btn-row">'
    + '        <button class="btn" type="button" id="btnApiChangelog">' + t('changelog.btn') + '</button>'
      + '        <button class="btn" type="button" data-edit-only id="btnDuplicateApi">' + t('api.duplicateBtn') + '</button>'
      + '        <button class="btn" type="button" data-edit-only id="btnEditApi">' + t('api.editBtn') + '</button>'
      + '        <button class="btn btn--danger" type="button" data-edit-only id="btnDeleteApi">' + t('api.deleteBtn') + '</button>'
    + '      </div>'
    + '    </div>'
    + '    <div class="urlbar">'
    + '      <span class="urlbar__method">POST</span>'
    + '      <code class="urlbar__text">' + escapeHtml(apiUrl(item)) + '</code>'
    + '      <button class="btn btn--ghost" type="button" id="btnCopyUrl">' + t('api.copyBtn') + '</button>'
    + '    </div>'
    + '    <div class="btn-row" style="margin-top:12px">'
    + (item.proxy && item.proxy.enable
      ? '<span class="tag tag--info">' + t('api.proxying') + '' + escapeHtml(item.proxy.url) + '</span>'
      : '<span class="tag">' + t('api.ruleMatch') + '</span>')
    + (item.enabled === false ? '<span class="tag tag--warn">' + t('api.disabledTag') + '</span>' : '<span class="tag tag--ok">' + t('api.enabledTag') + '</span>')
    + '    </div>'
    + '  </div>'
    + '</section>'

    /* ---- 试打一枪 ---- */
    + '<section class="card">'
    + '  <div class="card__head"><h3 class="card__title">' + t('try.title') + '</h3>'
    + '    <span class="field__hint" style="margin-left:auto">' + t('try.hint') + '</span>'
    + '  </div>'
    + '  <div class="card__body tryit">'
    + '    <div style="display:flex; flex-direction:column; gap:12px; min-width:0">'
    + '      <div class="field">'
    + '        <label class="field__label" for="tryBody">' + t('source.body') + '</label>'
    + '        <textarea class="textarea mono" id="tryBody" spellcheck="false"></textarea>'
    + '      </div>'
    + kvFieldHtml('tryQuery', t('try.query'), t('try.addQuery'))
    + kvFieldHtml('tryHeader', t('try.header'), t('try.addHeader'))
    + '      <div class="btn-row">'
    + '        <button class="btn btn--accent" type="button" id="btnTry" data-edit-only>'
    + '          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' + t('try.send') + '</button>'
    + '        <button class="btn" type="button" id="btnTryReset" data-edit-only><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' + t('try.reset') + '</button>'
    + '      </div>'
    + '    </div>'
    + '    <div class="tryit__result">'
    + '      <div class="field">'
    + '        <span class="field__label">' + t('try.trace') + '</span>'
    + '        <ul class="trace" id="tryTrace"><li class="trace__item">' + t('try.notYet') + '</li></ul>'
    + '      </div>'
    + '      <div class="field">'
    + '        <span class="field__label">' + t('try.response') + '</span>'
    + '        <div class="trystatus" id="tryStatusBar" hidden></div>'
    + '        <pre class="code" id="tryResponse">—</pre>'
    + '        <pre class="code code--fault" id="tryFaultPreview" hidden></pre>'
    + '      </div>'
    + '    </div>'
    + '  </div>'
    + '</section>'

    /* ---- 规则列表 ---- */
    + '<section class="card">'
    + '  <div class="card__head"><h3 class="card__title">' + t('rules.title') + '</h3></div>'
    + '  <div class="card__body">'
    + '    <div class="rule-list">' + (rulesHtml || t('rules.empty')) + '</div>'
    + '    <article class="rule" style="margin-top:8px" data-fallback-row>'
    + '      <span class="rule-index is-default">' + t('default.tag') + '</span>'
    + '      <span></span>'
    + '      <div class="rule__main">'
    + '        <div class="rule__name">' + t('default.desc') + '</div>'
    + '        <div class="rule__cond">HTTP ' + escapeHtml((item.defaultResponse || {}).status || 200) + '</div>'
    + '        <div class="rule__meta">' + hitBadgeHtml('') + '</div>'
    + (state.auth.readonly ? ruleResponseSummaryHtml({ response: item.defaultResponse }) : '')
    + '      </div>'
    + '      <div class="rule__actions">'
    + (state.auth.readonly
        ? '        <button class="btn btn--icon" type="button" data-view-only id="btnViewDefault" title="' + t('rule.view') + '">👁</button>'
        : '')
    + '        <button class="btn btn--icon" type="button" data-edit-only id="btnEditDefault" title="' + t('default.editTitle') + '">✎</button>'
    + '      </div>'
    + '    </article>'
    + '  </div>'
    + '</section>';

  bindWorkspaceEvents(item);

  /* 重渲染会把「试打一枪」整段重建，这里把用户输入与上一次结果原样还回去。
   * 少了这一步就会出现：点「发送」→ 结果被紧随其后的重渲染冲掉 → 看着毫无反应。 */
  const draft = state.tryDraft;
  state.tryRows = {
    query: (draft && draft.queryRows) || [],
    header: (draft && draft.headerRows) || [],
  };
  $('#tryBody').value = draft ? draft.body : sampleBody(item);
  renderKvRows('tryQuery', state.tryRows.query);
  renderKvRows('tryHeader', state.tryRows.header);
  bindKvActions();
  if (state.lastTry) renderTryResult(state.lastTry);
}

function sampleBody(item) {
  if (item.vars && item.vars.sampleBody !== undefined) {
    return typeof item.vars.sampleBody === 'string' ? item.vars.sampleBody : JSON.stringify(item.vars.sampleBody, null, 2);
  }
  if (item.id === 'demo-sample') {
    return JSON.stringify({
      code: '500',
    }, null, 2);
  }
  return '{\n  "id": "1001"\n}';
}

function bindWorkspaceEvents(item) {
  const workspace = $('#workspace');

  $('#btnDuplicateApi').addEventListener('click', () => duplicateApi(item.id));
  $('#btnEditApi').addEventListener('click', () => openApiDrawer(item.id));
  $('#btnDeleteApi').addEventListener('click', async () => {
    // 删除接口会连带删掉它下面的所有规则，确认框必须把影响范围写清楚
    if (!(await askConfirm({
      title: t('api.deleteTitle'),
      message: t('api.deleteConfirm', {
        name: item.name || apiFullPath(item),
        count: (item.rules || []).length,
      }),
      okText: t('btn.delete'),
    }))) return;
    state.config.apis = state.config.apis.filter((row) => row.id !== item.id);
    state.activeApiId = state.config.apis.length ? state.config.apis[0].id : null;
    await persist(t('api.deleted'));
    renderAll();
  });
  const btnChangelog = $('#btnApiChangelog');
  if (btnChangelog) btnChangelog.addEventListener('click', () => openChangelogModal(item.id, item.name));
  $('#btnCopyUrl').addEventListener('click', async () => {
    const ok = await copyText(apiUrl(item));
    // 原来是硬编码中文（'完整调用地址已复制：' + url），英文界面下会漏出中文 —— 收进 i18n
    toast(ok ? t('url.copied', { url: apiUrl(item) }) : t('url.copyFail'), ok ? 'ok' : 'bad');
  });
  $('#btnEditDefault').addEventListener('click', () => openRuleDrawer(-1, true));
  const btnViewDefault = $('#btnViewDefault');
  if (btnViewDefault) btnViewDefault.addEventListener('click', openDefaultReadonly);
  $('#btnTry').addEventListener('click', runTryIt);
  $('#btnTryReset').addEventListener('click', () => {
    state.tryDraft = null;
    state.lastTry = null;
    state.tryRows = { query: [], header: [] };
    $('#tryBody').value = sampleBody(item);
    renderKvRows('tryQuery', state.tryRows.query);
    renderKvRows('tryHeader', state.tryRows.header);
    bindKvActions();
  });

  $('#tryBody').addEventListener('input', rememberTryInput);

  workspace.querySelectorAll('[data-rule-id]').forEach((node) => {
    const ruleId = node.getAttribute('data-rule-id');
    const index = item.rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return;

    node.querySelector('[data-action="toggle"]').addEventListener('change', async (event) => {
      item.rules[index].enabled = event.target.checked;
      await persist('规则已' + (event.target.checked ? '启用' : '停用'));
      renderAll();
    });
    node.querySelector('[data-action="up"]').addEventListener('click', () => moveRule(index, -1));
    node.querySelector('[data-action="down"]').addEventListener('click', () => moveRule(index, 1));
    node.querySelector('[data-action="edit"]').addEventListener('click', () => openRuleDrawer(index, false));
    const viewBtn = node.querySelector('[data-action="view"]');
    if (viewBtn) viewBtn.addEventListener('click', () => openRuleReadonly(index));
    node.querySelector('[data-action="copy"]').addEventListener('click', () => copyRule(index));
    node.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (!(await askConfirm({
        title: t('rule.deleteTitle'),
        message: t('rule.deleteConfirm', { name: item.rules[index].name || t('rule.unnamed') }),
        okText: t('btn.delete'),
      }))) return;
      item.rules.splice(index, 1);
      await persist(t('rule.deleted'));
      renderAll();
    });
  });
}

async function moveRule(index, delta) {
  const item = activeApi();
  const target = index + delta;
  if (!item || target < 0 || target >= item.rules.length) return;
  const tmp = item.rules[index];
  item.rules[index] = item.rules[target];
  item.rules[target] = tmp;
  await persist(t('order.adjusted'));
  renderAll();
}

/** 复制一条规则插到原规则下方：团队里造变体最快的方式（照着同事的规则改改）
 *  顺带把「谁改的」清掉——新规则是新规则，不该继承上一条的署名 */
async function copyRule(index) {
  const item = activeApi();
  if (!item || !item.rules[index]) return;
  const clone = JSON.parse(JSON.stringify(item.rules[index]));
  clone.id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  clone.name = (clone.name || t('rule.unnamed')) + ' ' + t('rule.copySuffix');
  delete clone.updatedBy;
  delete clone.updatedAt;
  item.rules.splice(index + 1, 0, clone);
  await persist(t('rule.copied'));
  renderAll();
}

/* ------------------------------ 变更记录 ------------------------------ */

/* 示例 / 默认种子数据翻译：部署自带的示例接口、分组、规则名是中文硬编码「数据」，
 * 用户要求它们跟随界面语言。这里用已知中文 → i18n key 的映射，zh 映射回原文（不变），
 * en 映射到译文；无匹配则原样返回，绝不破坏用户自建数据。 */
var SEED_MAP = {
  '示例接口': 'seed.groupDemo',
  '我的第一个分组': 'seed.groupFirst',
  '示例：条件响应': 'seed.apiConditional',
  '示例：回显请求': 'seed.apiEcho',
  '我的第一个接口': 'seed.apiFirst',
  '演示用。根据请求体字段 code 返回不同响应（500 / 404 / 默认成功），用于演示条件匹配与脚本响应。': 'seed.descConditional',
  '演示用。任何请求都回显入参，可按 header 里的 X-Mock-Case 定制返回。': 'seed.descEcho',
  'code=500 → 返回 500': 'seed.rule500',
  'code=404 → 返回 404': 'seed.rule404',
  'URL 带 slow=1 → 延迟 3 秒': 'seed.ruleSlow',
  '默认：成功响应并回显 code': 'seed.ruleDefault',
  '以上规则都不命中时返回': 'seed.ruleFallback',
  'X-Mock-Case=error → 400': 'seed.ruleCase',
  '其他：回显': 'seed.ruleOther',
};
function tSeed(raw) {
  if (raw == null) return raw;
  var key = SEED_MAP[raw];
  return key ? t(key) : raw;
}

/* 变更日志详情翻译：服务端返回硬编码中文，客户端映射到 i18n key。
 * 策略：按已知前缀匹配，提取动态部分（如规则名），再拼接翻译后的模板。 */
function tChangelogDetail(raw) {
  if (!raw) return '';
  // 新增接口（含 N 条规则）
  var m = raw.match(/^新增接口（含 (\d+) 条规则）$/);
  if (m) return t('changelog.detailApiAdd', { n: m[1] });
  // 新增规则「name」
  m = raw.match(/^新增规则「(.+)」$/);
  if (m) return t('changelog.detailRuleAdd', { name: m[1] });
  // 删除规则「name」
  m = raw.match(/^删除规则「(.+)」$/);
  if (m) return t('changelog.detailRuleDel', { name: m[1] });
  // 调整规则顺序
  if (raw === '调整规则顺序') return t('changelog.detailRuleOrder');
  // 修改接口设置
  if (raw === '修改接口设置') return t('changelog.detailApiUpdate');
  // 修改规则「name」：field1 / field2 ...
  m = raw.match(/^修改规则「(.+)」：(.+)$/);
  if (m) {
    var fields = m[2].split(/\s*\/\s*/).map(function (f) {
      var map = { '名称': 'name', '停用': 'disabled', '启用': 'enabled', '条件': 'conditions', '匹配方式': 'matchMode', '响应': 'response' };
      return t('changelog.field.' + (map[f] || f));
    }).join(' · ');
    return t('changelog.detailRuleUpdate', { name: m[1], fields: fields });
  }
  // 兜底：原文透传
  return raw;
}

function openChangelogModal(apiId, apiName) {
  const modal = $('#changelogModal');
  if (!modal) return;
  const title = $('#changelogTitle');
  const body = $('#changelogBody');
  title.textContent = apiName
    ? t('changelog.title') + ' · ' + apiName
    : t('changelog.title');
  body.innerHTML = '<p class="meta-text">' + t('changelog.loading') + '</p>';
  modal.hidden = false;

  const query = '/_admin/changelog?limit=80' + (apiId ? '&apiId=' + encodeURIComponent(apiId) : '');
  api(query).then((result) => {
    if (!result || !result.ok) {
      body.innerHTML = '<p class="meta-text">' + t('changelog.loadFail') + '</p>';
      return;
    }
    if (!result.items.length) {
      body.innerHTML = '<p class="meta-text">' + t('changelog.empty') + '</p>';
      return;
    }
    body.innerHTML = '<ul class="changelog">' + result.items.map((item) => {
      return '<li class="changelog__item">'
        + '  <div class="changelog__head">'
        + '    <span class="changelog__time">' + escapeHtml(timeText(item.ts)) + '</span>'
        + '    <span class="tag">' + escapeHtml(item.by || t('changelog.anonymous')) + '</span>'
        + (apiId ? '' : '<span class="tag">' + escapeHtml(item.apiName || '') + '</span>')
        + '  </div>'
        + '  <div class="changelog__detail">' + escapeHtml(tChangelogDetail(item.detail) || tChangelogDetail(item.action)) + '</div>'
        + '</li>';
    }).join('') + '</ul>';
  });
}

function closeChangelogModal() {
  const modal = $('#changelogModal');
  if (modal) modal.hidden = true;
}

/* ------------------------------ 试打一枪 ------------------------------ */

/* --------------------------------------------------------------------------
 * 试打输入的结构化行（B1）
 *   原来是两行整串文本：URL 参数按 & 分、值按第一个 = 截；请求头按 & 分。
 *   于是 filter=a&b 会被拆成两个参数、x-token=a=b 的值会丢一半 —— 这两处规则还不一致。
 *   改成 key/value 行编辑后，值原样保留，另给「粘贴 cURL」把外面的命令拆成行。
 * ------------------------------------------------------------------------ */

/** 行 → 对象：key 去空格，值原样（含 & 与 =，这是本项要解决的核心问题） */
function rowsToPairs(rows) {
  const out = {};
  (rows || []).forEach((row) => {
    const key = String(row.key || '').trim();
    if (!key) return;
    out[key] = String(row.value === undefined || row.value === null ? '' : row.value);
  });
  return out;
}

/** 对象 → 行（回填用；`{{{}}}` 之类的值原样保留） */
function pairsToRows(obj) {
  return Object.keys(obj || {}).map((key) => ({
    key: key,
    value: String(obj[key] === undefined || obj[key] === null ? '' : obj[key]),
  }));
}

/**
 * 粘贴 cURL / Postman 文本 → 行。
 *   header：优先取 -H / --header，其次按「每行一条 k: v」解析；
 *   query ：优先取 URL 里的查询串，其次同样按行解析。
 * 只做「拆行」，不做 URL 解码之外的加工 —— 拆错了用户还能手改，猜错了没法查。
 */
function parsePastedPairs(text, kind) {
  const source = String(text || '');
  const clean = (value) => String(value === undefined || value === null ? '' : value).trim().replace(/^['"]|['"]$/g, '');
  const rows = [];
  const add = (key, value) => {
    const k = clean(key);
    if (!k) return;
    rows.push({ key: k, value: clean(value) });
  };

  // cURL 的 -H 'k: v'
  const headers = [];
  const headerRe = /(?:-H|--header)\s+('[^']*'|"[^"]*"|\S+)/g;
  let hit = headerRe.exec(source);
  while (hit) {
    const raw = clean(hit[1]);
    const at = raw.indexOf(':');
    if (at > 0) headers.push({ key: raw.slice(0, at), value: raw.slice(at + 1) });
    hit = headerRe.exec(source);
  }

  // cURL / 纯 URL 里的查询串
  const query = [];
  const urlHit = /https?:\/\/[^\s'"\\]+/.exec(source);
  if (urlHit) {
    const at = urlHit[0].indexOf('?');
    if (at >= 0) {
      String(urlHit[0].slice(at + 1)).split('&').forEach((pair) => {
        if (!pair) return;
        const eq = pair.indexOf('=');
        if (eq < 0) query.push({ key: decodeURIComponent(pair), value: '' });
        else query.push({ key: decodeURIComponent(pair.slice(0, eq)), value: decodeURIComponent(pair.slice(eq + 1)) });
      });
    }
  }

  // 兜底：每行一条「k: v」或「k=v」（Postman 的表格复制出来就是这个形状）
  const lines = [];
  source.split('\n').forEach((line) => {
    const text2 = line.trim().replace(/\\$/, '').trim();
    if (!text2 || /^-/.test(text2) || /^curl\b/i.test(text2)) return;
    const colon = text2.indexOf(':');
    const equal = text2.indexOf('=');
    const at = colon > 0 && (equal < 0 || colon < equal) ? colon : equal;
    if (at > 0) lines.push({ key: text2.slice(0, at), value: text2.slice(at + 1) });
  });

  const picked = kind === 'header' ? (headers.length ? headers : lines) : (query.length ? query : lines);
  picked.forEach((row) => add(row.key, row.value));
  return rows;
}

/** 试打面板的一行 key/value 编辑器 */
function kvFieldHtml(id, label, addLabel) {
  return ''
    + '<div class="field">'
    + '  <div class="kv-header">'
    + '    <span class="field__label">' + label + '</span>'
    + '    <div class="kv-actions">'
    + '    <button class="btn btn--ghost btn--sm" type="button" data-kv-add="' + id + '">'
    + '      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' + addLabel + '</button>'
    + '    <button class="btn btn--ghost btn--sm" type="button" data-kv-paste="' + id + '">'
    + '      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>' + t('try.paste') + '</button>'
    + '    </div>'
    + '  </div>'
    + '  <div class="kv-list" id="' + id + 'List"></div>'
    + '</div>';
}

function renderKvRows(id, rows) {
  const host = document.getElementById(id + 'List');
  if (!host) return;
  if (!rows.length) {
    host.innerHTML = '<span class="field__hint">' + t('try.kvEmpty') + '</span>';
    return;
  }
  host.innerHTML = rows.map((row, index) => ''
    + '<div class="kv-row" data-kv-index="' + index + '">'
    + '  <input class="input mono" data-kv="key" value="' + escapeHtml(row.key) + '" placeholder="' + escapeHtml(t('try.kvKeyPh')) + '">'
    + '  <input class="input mono" data-kv="value" value="' + escapeHtml(row.value) + '" placeholder="' + escapeHtml(t('try.kvValuePh')) + '">'
    + '  <button class="btn btn--icon btn--danger-quiet" type="button" data-kv-remove="' + index + '" title="' + escapeHtml(t('api.varRemove')) + '">✕</button>'
    + '</div>').join('');

  host.querySelectorAll('[data-kv-index]').forEach((node) => {
    const index = Number(node.getAttribute('data-kv-index'));
    node.querySelector('[data-kv="key"]').addEventListener('input', (event) => {
      rows[index].key = event.target.value;
      rememberTryInput();
    });
    node.querySelector('[data-kv="value"]').addEventListener('input', (event) => {
      rows[index].value = event.target.value;   // 值不做 trim：前后空格可能是测试数据的一部分
      rememberTryInput();
    });
    node.querySelector('[data-kv-remove]').addEventListener('click', () => {
      rows.splice(index, 1);
      renderKvRows(id, rows);
      rememberTryInput();
    });
  });
}

/** 「添加参数 / 粘贴 cURL」的按钮绑定。DOM 每次重渲染都会重建，所以每次渲染都要重新绑 */
function bindKvActions() {
  document.querySelectorAll('[data-kv-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-add');
      const rows = state.tryRows[id === 'tryQuery' ? 'query' : 'header'];
      rows.push({ key: '', value: '' });
      renderKvRows(id, rows);
      rememberTryInput();
      const inputs = document.getElementById(id + 'List').querySelectorAll('[data-kv="key"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
  });
  document.querySelectorAll('[data-kv-paste]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-kv-paste');
      const kind = id === 'tryQuery' ? 'query' : 'header';
      const text = await askText({
        title: t('try.pasteTitle'),
        hint: t('try.pasteHint'),
        multiline: true,
        confirmText: t('try.pasteOk'),
      });
      if (!text) return;
      const parsed = parsePastedPairs(text, kind);
      if (!parsed.length) { toast(t('try.pasteEmpty'), 'bad'); return; }
      const rows = state.tryRows[kind];
      parsed.forEach((row) => rows.push(row));
      renderKvRows(id, rows);
      rememberTryInput();
      toast(t('try.pasteDone', { n: parsed.length }), 'ok');
    });
  });
}

/** 试打输入随手记下来：切规则、动开关、写日志都会触发重渲染，不能把用户输入弄丢 */
function rememberTryInput() {
  if (!state.tryRows) return;
  state.tryDraft = {
    body: $('#tryBody') ? $('#tryBody').value : '',
    queryRows: state.tryRows.query,
    headerRows: state.tryRows.header,
  };
}

async function runTryIt() {
  const item = activeApi();
  if (!item) return;
  if (state.offline) {
    toast(t('try.offline'), 'bad');
    return;
  }

  const raw = $('#tryBody').value;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    toast(t('try.badJson'), 'bad');
  }

  const result = await api('/_admin/test', {
    method: 'POST',
    body: JSON.stringify({
      apiId: item.id,
      raw: raw,
      body: body,
      query: rowsToPairs(state.tryRows.query),
      headers: rowsToPairs(state.tryRows.header),
    }),
  });

  if (!result.ok) {
    toast(result.message || t('try.fail'), 'bad');
    return;
  }

  state.hitRuleId = result.matchedRuleId;
  state.lastTry = result;
  // 只渲染一次：renderWorkspace 会把命中结果和规则高亮一起画上，不会再被覆盖
  renderWorkspace();
  await refreshLogs();
  await loadStats(true);   // 试打也计入命中，顺手把徽标刷成最新
}

/* 服务端 describeMatch() 返回的 reason 是硬编码中文，客户端映射到 i18n key */
const REASON_MAP = {
  '无条件 · 恒命中': 'trace.reasonAlways',
  '全部条件满足': 'trace.reasonAllMatch',
  '任一条件满足': 'trace.reasonAnyMatch',
  '存在条件不满足': 'trace.reasonSomeMiss',
  '条件均不满足': 'trace.reasonAllMiss',
  '规则已停用': 'trace.reasonDisabled',
};
function tReason(reason) {
  return t(REASON_MAP[reason] || reason);
}

function renderTryResult(result) {
  const traceHost = $('#tryTrace');
  if (!traceHost) return;

  if (!result.trace || !result.trace.length) {
    traceHost.innerHTML = '<li class="trace__item is-hit">' + t('ws.ruleMatchNone') + '</li>';
  } else {
    traceHost.innerHTML = result.trace.map((row, index) => {
      const isHit = row.ruleId === result.matchedRuleId;
      return '<li class="trace__item' + (isHit ? ' is-hit' : '') + '">'
        + '  <span class="rule-index' + (isHit ? ' is-hit' : '') + '">R' + (index + 1) + '</span>'
        + '  <span>' + escapeHtml(row.ruleName || t('trace.ruleName')) + ' · ' + escapeHtml(tReason(row.reason)) + '</span>'
        + '  <span>' + (row.hit ? t('trace.hit') : t('trace.skip')) + '</span>'
        + '</li>';
    }).join('');
  }

  const status = result.response.status;
  const fault = result.fault || 'none';
  // 状态码是操作员判断「规则配得对不对」的主信号：按语义着色，并补上耗时与命中条数
  const bar = $('#tryStatusBar');
  if (bar) {
    const statusClass = status >= 500 ? 'tag--bad' : status >= 400 ? 'tag--warn' : 'tag--ok';
    const hitCount = typeof result.hitCount === 'number'
      ? result.hitCount
      : (result.trace || []).filter((row) => row.hit).length;
    bar.hidden = false;
    let barHtml = ''
      + '<span class="tag ' + statusClass + '">HTTP ' + escapeHtml(String(status)) + '</span>'
      + '<span class="tag">' + escapeHtml(t('try.ms', { n: typeof result.ms === 'number' ? result.ms : 0 })) + '</span>'
      + '<span class="tag' + (hitCount ? ' tag--accent' : '') + '">'
      + (hitCount ? t('try.hitRules', { n: hitCount }) : t('try.fallbackHit')) + '</span>';
    /* 故障注入在试打中不执行：明确标出来，免得操作者看到完整 JSON 误以为「故障没配上」。
     * 复用抽屉里同名的 fault 文案（resp.faultXxx），保持措辞一致。 */
    if (fault !== 'none') {
      const faultLabel = t('resp.fault' + fault.charAt(0).toUpperCase() + fault.slice(1));
      barHtml += '<span class="tag tag--warn">⚠ ' + escapeHtml(faultLabel) + ' · ' + escapeHtml(t('try.faultRealtime')) + '</span>';
    }
    bar.innerHTML = barHtml;
  }
  $('#tryResponse').textContent = 'HTTP ' + status + '  ' + result.response.contentType + '\n'
    + prettyJson(result.response.body);

  /* malformed：额外展示「真实调用会收到的半截 JSON」，让操作者直观看到截断效果，
   * 而不是对着完整 JSON 发懵。截断逻辑与服务端 malformedBody() 对齐（server.js:778）。 */
  const faultPreview = $('#tryFaultPreview');
  if (faultPreview) {
    if (fault === 'malformed') {
      const text = String(result.response.body == null ? '' : result.response.body);
      const cut = Math.max(1, Math.floor(text.length / 2));
      faultPreview.hidden = false;
      faultPreview.textContent = t('try.faultPreview') + '\n\n' + text.slice(0, cut).replace(/[\s}\]]+$/, '');
    } else {
      faultPreview.hidden = true;
      faultPreview.textContent = '';
    }
  }
}

/* ------------------------------ 日志 ------------------------------ */

async function refreshLogs() {
  try {
    // 只看当前接口时把 apiId 带上，由服务端过滤：多人共用时日志很快就被别的接口刷掉
    const query = state.logApiOnly && state.activeApiId
      ? '?limit=60&apiId=' + encodeURIComponent(state.activeApiId)
      : '?limit=60';
    const result = await api('/_admin/logs' + query);
    state.logs = result && result.ok ? result.items : [];
  } catch (e) {
    state.logs = [];
  }
  renderLogs();
}

function renderLogs() {
  const host = $('#logList');
  $('#logCount').textContent = state.logs.length;

  if (!state.logs.length) {
    host.innerHTML = state.logApiOnly && state.activeApiId ? t('log.filteredEmpty') : t('log.empty');
    return;
  }

  host.innerHTML = state.logs.map((log) => {
    const ruleIndex = findRuleIndex(log.apiId, log.ruleId);
    const statusClass = log.status >= 500 ? 'tag--bad' : log.status >= 400 ? 'tag--warn' : 'tag--ok';
    const classes = ['log'];
    if (log.status >= 400) classes.push('is-bad');
    return ''
      + '<article class="' + classes.join(' ') + '" data-log-id="' + log.id + '">'
      + '  <div class="log__head">'
      + '    <span class="log__time">' + timeText(log.ts) + '</span>'
      + '    <div class="log__meta">'
      + (log.kind === 'test' ? '<span class="tag tag--accent">' + t('log.test') + '</span>' : '')
      + '      <span class="tag ' + statusClass + '">' + escapeHtml(String(log.status)) + '</span>'
      + '      <span class="tag">' + escapeHtml(String(log.ms)) + 'ms</span>'
      + '    </div>'
      + '  </div>'
      + '  <div class="log__api">' + escapeHtml(log.pathname || '') + '</div>'
      + '  <div class="log__rule">'
      + (log.kind === 'proxy'
        ? '<span class="tag tag--info">' + t('log.proxy') + '</span>'
        : '<span class="rule-index' + (ruleIndex > 0 ? '' : ' is-default') + '">'
          + (ruleIndex > 0 ? 'R' + ruleIndex : '兜底') + '</span>')
      + '    <span class="log__rule-name">' + escapeHtml(log.ruleName || log.kind || '') + '</span>'
      + '    <span style="margin-left:auto">' + escapeHtml(log.ip || '') + '</span>'
      + '  </div>'
      + '</article>';
  }).join('');

  host.querySelectorAll('[data-log-id]').forEach((node) => {
    node.addEventListener('click', () => {
      const id = Number(node.getAttribute('data-log-id'));
      const log = state.logs.find((row) => row.id === id);
      if (!log) return;
      const opened = node.classList.contains('is-open');
      host.querySelectorAll('.log__detail').forEach((detail) => detail.remove());
      host.querySelectorAll('.log').forEach((item) => item.classList.remove('is-open'));
      if (opened) return;

      node.classList.add('is-open');
      const detail = document.createElement('div');
      detail.className = 'log__detail';
      detail.innerHTML = ''
        + '<span class="field__label">' + t('source.body') + '</span>'
        + '<pre class="code">' + escapeHtml(prettyJson(log.reqBody) || t('log.emptyBody')) + '</pre>'
        + '<span class="field__label">' + t('log.respBody') + '</span>'
        + '<pre class="code">' + escapeHtml(prettyJson(log.respBody) || t('log.emptyBody')) + '</pre>';
      node.appendChild(detail);

      // 点日志定位接口：只要日志带 apiId 就执行（命中兜底默认规则时 ruleId 为 null，
      // 但日志仍属于某个接口，必须能定位过去并展开所在分组）。
      if (log.apiId) {
        const apiChanged = log.apiId !== state.activeApiId;
        if (apiChanged) {
          state.activeApiId = log.apiId;
          state.tryDraft = null;   // 试打输入与结果属于上一个接口，跟着一起清
          state.lastTry = null;
        }
        // 命中规则时高亮对应规则行；兜底（ruleId 为空）则不高亮
        state.hitRuleId = log.ruleId || null;
        /* 定位统一走 ensureApiVisible：它会展开所在分组、把卡片滚进可视区，并且——
         * 关键——当目标被搜索词/状态/分组筛选挡在结果之外时先清掉冲突筛选。
         * 否则卡片根本不在左栏 DOM 里，scrollIntoView 静默失败，而中间规则照常定位，
         * 就成了「中间滚过去了、左边没反应」的半失效。
         * renderAll 只重建左侧列表与工作区、不碰日志区，所以已展开的报文详情不会被冲掉。 */
        ensureApiVisible(log.apiId);
        if (apiChanged && state.logApiOnly) refreshLogs();
        // 中间：命中的是具体规则时才把规则滚到可视区（兜底没有命中规则，跳过）
        if (log.ruleId) {
          const target = document.querySelector('[data-rule-id="' + cssAttrEscape(log.ruleId) + '"]');
          if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    });
  });
}

function findRuleIndex(apiId, ruleId) {
  if (!ruleId || !state.config) return 0;
  const item = state.config.apis.find((row) => row.id === apiId);
  if (!item) return 0;
  return (item.rules || []).findIndex((rule) => rule.id === ruleId) + 1;
}

/** 属性选择器的取值在双引号内，只有反斜杠和引号需要转义；不转义时 id 里带引号会让 querySelector 抛错 */
function cssAttrEscape(value) {
  return String(value === undefined || value === null ? '' : value).replace(/(["\\])/g, '\\$1');
}

/* ------------------------------ 抽屉：规则 ------------------------------ */

function openRuleDrawer(index, isDefault) {
  const item = activeApi();
  if (!item) return;

  state.drawerMode = 'rule';
  state.drawerReadonly = false;
  setDrawerTitle(isDefault ? 'default.editTitle' : (index >= 0 ? 'drawer.editRule' : 'drawer.addRule'));

  if (isDefault) {
    state.editingRuleId = '__default__';
    state.draft = { isDefault: true, response: Object.assign({}, item.defaultResponse || {}) };
    renderRuleDrawer(item);
  } else if (index >= 0) {
    const rule = JSON.parse(JSON.stringify(item.rules[index]));
    state.editingRuleId = rule.id;
    state.draft = { isDefault: false, rule: rule };
    renderRuleDrawer(item);
  } else {
    const rule = {
      id: 'r' + Date.now().toString(36),
      name: t('rule.newName'),
      enabled: true,
      match: 'all',
      conditions: [{ source: 'body', path: '', op: 'eq', value: '' }],
      response: { mode: 'static', status: 200, delayMs: 0, contentType: 'application/json;charset=UTF-8', body: '{}', script: '' },
    };
    state.editingRuleId = null;
    state.draft = { isDefault: false, rule: rule };
    renderRuleDrawer(item);
  }
  openDrawer();
}

function renderRuleDrawer() {
  const body = $('#drawerBody');
  const isDefault = state.draft.isDefault;

  if (isDefault) {
    const response = state.draft.response;
    body.innerHTML = ''
      + '<div class="section-label">' + t('rule.defaultSection') + '</div>'
      + responseFieldsHtml(response, 'default');
    bindResponseModeSwitch('default');
    bindTemplateVars(body);
    return;
  }

  const rule = state.draft.rule;
  body.innerHTML = ''
    + '<div class="section-label">' + t('rule.basic') + '</div>'
    + '<div class="field">'
    + '  <label class="field__label" for="ruleName">' + t('rule.name') + '</label>'
    + '  <input class="input" id="ruleName" value="' + escapeHtml(rule.name) + '"'
    + ' placeholder="' + t('rule.namePh') + '" data-i18n-placeholder="rule.namePh"'
    /* 只有「新建的、还没改过名」的规则才带 data-i18n-value：
     * 切语言时 applyI18n 会把 value 一起刷成新语言（否则英文界面里新规则仍叫「新规则」）。
     * 用户一旦动手改名，input 监听器会把这个属性摘掉，绝不覆盖用户输入。 */
    + (state.editingRuleId === null ? ' data-i18n-value="rule.newName"' : '') + '>'
    + '</div>'
    + '<div style="display:flex; gap:24px; align-items:center">'
    + '  <label style="display:flex; align-items:center; gap:10px; font-size:var(--text-sm)">'
    + '    <span class="switch"><input type="checkbox" id="ruleEnabled" ' + (rule.enabled === false ? '' : 'checked') + '>'
    + '    <span class="switch__track"></span><span class="switch__thumb"></span></span>' + t('rule.enable') + '</label>'
    + '  <label style="display:flex; align-items:center; gap:10px; font-size:var(--text-sm)">' + t('rule.matchMode') + ''
    + '    <select class="select" id="ruleMatch" style="width:132px">'
    + '      <option value="all"' + (rule.match === 'all' ? ' selected' : '') + '>' + t('rule.matchAll') + '</option>'
    + '      <option value="any"' + (rule.match === 'any' ? ' selected' : '') + '>' + t('rule.matchAny') + '</option>'
    + '    </select></label>'
    + '</div>'
    + '<div class="section-label">' + t('rule.condSection') + '<span class="field__hint" style="margin-left:auto; text-transform:none; letter-spacing:0">' + t('rule.condHint') + '</span></div>'
    + '<div id="condList" style="display:flex; flex-direction:column; gap:8px"></div>'
    + '<div><button class="btn" type="button" id="btnAddCond">' + t('rule.addCond') + '</button></div>'
    + '<div class="section-label">' + t('rule.respSection') + '</div>'
    + responseFieldsHtml(rule.response, 'rule');

  renderConditionRows();
  bindResponseModeSwitch('rule');
  bindTemplateVars(body);

  $('#ruleName').addEventListener('input', (event) => {
    rule.name = event.target.value;
    // 改名后就不再跟随语言：摘掉 data-i18n-value，免得切语言把用户输入冲掉
    event.target.removeAttribute('data-i18n-value');
  });
  $('#ruleEnabled').addEventListener('change', (event) => { rule.enabled = event.target.checked; });
  $('#ruleMatch').addEventListener('change', (event) => { rule.match = event.target.value; });
  $('#btnAddCond').addEventListener('click', () => {
    rule.conditions.push({ source: 'body', path: '', op: 'eq', value: '' });
    renderConditionRows();
  });
}

/* 模板变量说明：与 server.js 的 renderTemplate / pick 一一对应。
 * - 只有 now / ts / uuid / random 是无点号的整词匹配，其余写法一律取不到值；
 * - 其余必须写成 head.path（head ∈ body | query | header | vars），取不到时替换成空字符串；
 * - insert 是点击后插入响应体的文本：带字段名的留成 {{body.}}，光标停在点后面接着敲字段名。
 * - 可翻译的芯片文案**必须存 key、渲染时再 t()**：本数组是模块级常量，
 *   在这里直接调 t() 会把加载时的语言烤死（切 English 后芯片仍显示中文）。 */
const TEMPLATE_VARS = [
  { group: 'req', labelKey: 'resp.varBodyLabel',   insert: '{{body.}}',   desc: 'resp.varBody' },
  { group: 'req', labelKey: 'resp.varQueryLabel',  insert: '{{query.}}',  desc: 'resp.varQuery' },
  { group: 'req', labelKey: 'resp.varHeaderLabel', insert: '{{header.}}', desc: 'resp.varHeader' },
  { group: 'req', labelKey: 'resp.varVarsLabel',   insert: '{{vars.}}',   desc: 'resp.varVars' },
  { group: 'gen', label: '{{now}}',        insert: '{{now}}',     desc: 'resp.varNow' },
  { group: 'gen', label: '{{ts}}',         insert: '{{ts}}',      desc: 'resp.varTs' },
  { group: 'gen', label: '{{uuid}}',       insert: '{{uuid}}',    desc: 'resp.varUuid' },
  { group: 'gen', label: '{{random}}',     insert: '{{random}}',  desc: 'resp.varRandom' },
];

/* 变量名在「接口设置 → 接口变量」里定义，取值区分大小写。
 * 所以这里把本接口**实际配了哪些变量**直接列成可点芯片 ——
 * 让操作员点一下就插入，而不是照着别处的名字手敲（敲错大小写只会静默拿到空字符串）。 */
const RESERVED_VARS = ['sampleBody']; // 保留名：不是返回文案，是「试打一枪」的默认请求体，不列进芯片免得误用

/** 变量值的单行摘要：换行压成空格，过长交给 CSS 截断，全文放 tooltip */
function varValueSummary(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text).replace(/\s+/g, ' ').trim();
}

function apiVarChips(prefix) {
  const item = activeApi();
  const vars = (item && item.vars) || {};
  const names = Object.keys(vars).filter((name) => RESERVED_VARS.indexOf(name) < 0);
  const head = '<span class="varshint__group" data-i18n="resp.varsApiGroup">' + t('resp.varsApiGroup') + '</span>';

  /* 本接口一个变量都没有时也要留一行说明：直接 return '' 的话这一组会凭空消失，
   * 操作员只会盲写 {{vars.x}}，然后拿到空字符串还不知道为什么。 */
  if (!names.length) {
    return '<div class="varshint__row varshint__row--note">' + head
      + '<span class="varshint__note" data-i18n="resp.varsApiEmpty">' + t('resp.varsApiEmpty') + '</span></div>';
  }

  return '<div class="varshint__row">' + head
    + names.map((name) => {
      const token = '{{vars.' + name + '}}';
      const shown = varValueSummary(vars[name]) || t('resp.varsEmptyValue');
      return '<button class="varchip varchip--api" type="button"'
        + ' data-var-insert="' + escapeHtml(token) + '"'
        + ' data-var-target="' + prefix + 'Body"'
        + ' title="' + escapeHtml(t('resp.varApiOne', { name: name, value: shown })) + '">'
        + '<span class="varchip__tok">' + escapeHtml(token) + '</span>'
        + '<span class="varchip__eq">=</span>'
        + '<span class="varchip__val">' + escapeHtml(shown) + '</span>'
        + '</button>';
    }).join('')
    + '</div>';
}

/** 变量说明面板：分「取自本次请求」「每次自动生成」（+ 本接口变量）三组，点一下插进响应体 */
function templateVarsHtml(prefix) {
  /* 文案在**渲染时**取，而不是在模块加载时烤进常量 —— 否则切语言后芯片文案不跟着变。
   * 同时挂 data-i18n：抽屉开着时切语言，applyI18n 会就地把它刷成新语言。 */
  const chip = (item) => ''
    + '<button class="varchip" type="button"'
    + ' data-var-insert="' + escapeHtml(item.insert) + '"'
    + ' data-var-target="' + prefix + 'Body"'
    + i18nAttr(item.labelKey)
    + ' title="' + escapeHtml(t(item.desc)) + '">'
    + escapeHtml(item.labelKey ? t(item.labelKey) : item.label) + '</button>';
  const ofGroup = (group) => TEMPLATE_VARS.filter((item) => item.group === group).map(chip).join('');
  return ''
    + '<div class="varshint">'
    + '  <div class="varshint__row"><span class="varshint__group" data-i18n="resp.varsReqGroup">' + t('resp.varsReqGroup') + '</span>' + ofGroup('req') + '</div>'
    + '  <div class="varshint__row"><span class="varshint__group" data-i18n="resp.varsGenGroup">' + t('resp.varsGenGroup') + '</span>' + ofGroup('gen') + '</div>'
    + apiVarChips(prefix)
    + '  <div class="varshint__tip" data-i18n="resp.varsSub">' + t('resp.varsSub') + '</div>'
    + '</div>';
}

/** 点击变量 → 插入到对应响应体输入框的光标处 */
function bindTemplateVars(root) {
  if (!root) return;
  root.querySelectorAll('[data-var-insert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = root.querySelector('#' + btn.getAttribute('data-var-target'));
      if (!target) return;
      const token = btn.getAttribute('data-var-insert');
      const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
      target.value = target.value.slice(0, start) + token + target.value.slice(end);
      target.focus();
      const caret = start + token.length;
      target.setSelectionRange(caret, caret);
    });
  });
}

/* 故障注入类型：取值必须与 server.js 的 FAULT_TYPES 对齐 */
const FAULT_OPTIONS = ['none', 'timeout', 'malformed', 'abort'];

function responseFieldsHtml(response, scope) {
  const prefix = scope === 'default' ? 'def' : 'res';
  const delayMax = Math.max(0, Number(response.delayMaxMs || 0));
  const fault = FAULT_OPTIONS.indexOf(response.fault) >= 0 ? response.fault : 'none';
  return ''
    + '<div class="field-grid">'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'Status">' + t('resp.status') + '</label>'
    + '    <input class="input mono" id="' + prefix + 'Status" type="number" value="' + Number(response.status || 200) + '"></div>'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'Delay">' + t('resp.delay') + '</label>'
    + '    <input class="input mono" id="' + prefix + 'Delay" type="number" min="0" value="' + Number(response.delayMs || 0) + '"></div>'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'DelayMax">' + t('resp.delayMax') + '</label>'
    + '    <input class="input mono" id="' + prefix + 'DelayMax" type="number" min="0" value="' + delayMax + '"></div>'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'Mode">' + t('resp.mode') + '</label>'
    + '    <select class="select" id="' + prefix + 'Mode">'
    + '      <option value="static"' + (response.mode !== 'script' ? ' selected' : '') + '">' + t('resp.static') + '</option>'
    + '      <option value="script"' + (response.mode === 'script' ? ' selected' : '') + '">' + t('resp.script') + '</option>'
    + '    </select></div>'
    + '</div>'
    + '<div class="field-grid field-grid--wide">'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'Type">Content-Type</label>'
    + '    <input class="input mono" id="' + prefix + 'Type" value="' + escapeHtml(response.contentType || 'application/json;charset=UTF-8') + '"></div>'
    + '  <div class="field"><label class="field__label" for="' + prefix + 'Fault">' + t('resp.fault') + '</label>'
    + '    <select class="select" id="' + prefix + 'Fault">'
    + FAULT_OPTIONS.map((value) => '<option value="' + value + '"' + (value === fault ? ' selected' : '') + '>'
        + t('resp.fault' + value.charAt(0).toUpperCase() + value.slice(1)) + '</option>').join('')
    + '    </select></div>'
    + '</div>'
    + '<span class="field__hint">' + t('resp.delayRangeTip') + ' ' + t('resp.faultHint') + '</span>'
    + '<div class="field" id="' + prefix + 'StaticWrap"><label class="field__label" for="' + prefix + 'Body">' + t('resp.body') + '</label>'
    + '  <textarea class="textarea mono" id="' + prefix + 'Body" spellcheck="false">' + escapeHtml(response.body || '') + '</textarea>'
    + templateVarsHtml(prefix) + '</div>'
    + '<div class="field" id="' + prefix + 'ScriptWrap"><label class="field__label" for="' + prefix + 'Script">' + t('resp.scriptLabel') + '</label>'
    + '  <textarea class="textarea mono" id="' + prefix + 'Script" spellcheck="false" style="min-height:160px">' + escapeHtml(response.script || '') + '</textarea>'
    + '  <span class="field__hint">' + t('resp.scriptHint') + '</span></div>';
}

function bindResponseModeSwitch(scope) {
  const prefix = scope === 'default' ? 'def' : 'res';
  const apply = () => {
    const isScript = $('#' + prefix + 'Mode').value === 'script';
    $('#' + prefix + 'StaticWrap').style.display = isScript ? 'none' : '';
    $('#' + prefix + 'ScriptWrap').style.display = isScript ? '' : 'none';
  };
  $('#' + prefix + 'Mode').addEventListener('change', apply);
  apply();
}

function renderConditionRows() {
  const rule = state.draft.rule;
  const host = $('#condList');
  if (!host) return;

  host.innerHTML = rule.conditions.map((condition, index) => {
    const needsValue = OP_WITHOUT_VALUE.indexOf(condition.op) < 0;
    return ''
      + '<div class="cond-row" data-cond-index="' + index + '">'
      + '  <select class="select" data-cond="source">'
      + SOURCE_OPTIONS.map((source) =>
        '<option value="' + source + '"' + (condition.source === source ? ' selected' : '') + i18nAttr(SOURCE_LABEL[source]) + '>' + labelOf(SOURCE_LABEL, source) + '</option>').join('')
      + '  </select>'
      + '  <input class="input mono" data-cond="path" value="' + escapeHtml(condition.path || '') + '" placeholder="' + escapeHtml(labelOf(PATH_PLACEHOLDER, condition.source, '')) + '"' + i18nAttr(PATH_PLACEHOLDER[condition.source], 'data-i18n-placeholder') + (condition.source === 'raw' ? ' disabled' : '') + '>'
      + '  <select class="select" data-cond="op">'
      + Object.keys(OP_LABEL).map((op) =>
        '<option value="' + op + '"' + (condition.op === op ? ' selected' : '') + i18nAttr(OP_LABEL[op]) + '>' + labelOf(OP_LABEL, op) + '</option>').join('')
      + '  </select>'
      + '  <input class="input mono" data-cond="value" value="' + escapeHtml(condition.value === undefined ? '' : condition.value) + '" placeholder="' + t('cond.valuePh') + '"' + (needsValue ? '' : ' disabled') + '>'
      + '  <button class="btn btn--icon btn--danger-quiet" type="button" data-cond-remove="' + index + '" title="' + t('cond.remove') + '">✕</button>'
      + '</div>';
  }).join('');

  host.querySelectorAll('[data-cond-index]').forEach((row) => {
    const index = Number(row.getAttribute('data-cond-index'));
    const condition = rule.conditions[index];

    row.querySelector('[data-cond="source"]').addEventListener('change', (event) => {
      condition.source = event.target.value;
      renderConditionRows();
    });
    row.querySelector('[data-cond="path"]').addEventListener('input', (event) => {
      condition.path = event.target.value;
    });
    row.querySelector('[data-cond="op"]').addEventListener('change', (event) => {
      condition.op = event.target.value;
      renderConditionRows();
    });
    row.querySelector('[data-cond="value"]').addEventListener('input', (event) => {
      condition.value = event.target.value;
    });
    row.querySelector('[data-cond-remove]').addEventListener('click', () => {
      rule.conditions.splice(index, 1);
      renderConditionRows();
    });
  });
}

/* ------------------------------ 抽屉：接口 ------------------------------ */

/** 所属分组：下拉选已有分组，或手动输入新名称（保存时自动新建）；留空=未分组。
 *  用 input + datalist 实现「选择 / 输入二合一」，分组只用于左侧列表归类，不参与请求路径拼接。 */
function apiGroupFieldHtml(item) {
  const groups = (state.config && state.config.groups) || [];
  const current = groups.find((group) => group.id === item.groupId);
  const currentName = current ? current.name : '';
  const listOptions = groups.map((group) =>
    '<option value="' + escapeHtml(group.name) + '">' + escapeHtml(tSeed(group.name)) + '</option>').join('');

  return ''
    + '<div class="field"><label class="field__label" for="apiGroup">' + t('api.group') + '</label>'
    + '  <input class="input" id="apiGroup" list="apiGroupList" value="' + escapeHtml(currentName) + '" placeholder="' + t('api.groupPh') + '" autocomplete="off">'
    + '  <datalist id="apiGroupList">' + listOptions + '</datalist>'
    + '  <span class="field__hint">' + t('api.groupHint') + '</span></div>';
}

/* ------------------------------ 接口变量 ------------------------------
 * {{vars.名称}} 的定义处：变量挂在「接口」上（不是规则上），响应体里用 {{vars.名称}} 取。
 * 服务端是按对象属性精确取值的（server.js 里 ctx.vars = api.vars），也就是**区分大小写**，
 * 名字写错只会静默变成空字符串 —— 所以这里必须把变量名显式列出来给人看、给人选，
 * 而不是让操作员照着响应体去猜大小写。 */
function varsToRows(vars) {
  return Object.keys(vars || {}).map((key) => {
    const value = vars[key];
    return {
      key: key,
      // 非字符串值（如保留名 sampleBody 存的是对象）按 JSON 文本展示；原值留着，未改动时原样写回
      value: typeof value === 'string' ? value : JSON.stringify(value),
      original: value,
    };
  });
}

/** 编辑行 → vars 对象。文本没被动过就原样保留原值与类型，改过则按文本存 */
function rowsToVars(rows) {
  const out = {};
  (rows || []).forEach((row) => {
    const key = (row.key || '').trim();
    if (!key) return;
    const untouched = typeof row.original !== 'string'
      && row.original !== undefined
      && row.value === JSON.stringify(row.original);
    out[key] = untouched ? row.original : row.value;
  });
  return out;
}

/** 同名变量后者会把前者盖掉，保存前先拦一道，避免悄悄丢值 */
function firstDuplicateVarName(rows) {
  const seen = {};
  const keys = (rows || []).map((row) => (row.key || '').trim()).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1) {
    if (seen[keys[i]]) return keys[i];
    seen[keys[i]] = true;
  }
  return null;
}

function varsEditorHtml() {
  return ''
    + '<div class="section-label">' + t('api.varsSection')
    + '  <span class="field__hint" style="margin-left:auto; text-transform:none; letter-spacing:0">' + t('api.varsHint') + '</span></div>'
    + '<div id="varList" style="display:flex; flex-direction:column; gap:8px"></div>'
    + '<div class="field__hint">' + t('api.varsTip') + '</div>'
    + '<div><button class="btn" type="button" id="btnAddVar">' + t('api.addVar') + '</button></div>';
}

function renderVarRows() {
  const rows = (state.draft && state.draft.varsRows) || [];
  const host = $('#varList');
  if (!host) return;

  if (!rows.length) {
    host.innerHTML = '<span class="field__hint">' + t('api.varsEmpty') + '</span>';
    return;
  }

  host.innerHTML = rows.map((row, index) => ''
    + '<div class="var-row" data-var-index="' + index + '">'
    + '  <input class="input mono" data-var="key" value="' + escapeHtml(row.key) + '" placeholder="' + escapeHtml(t('api.varKeyPh')) + '">'
    + '  <textarea class="textarea mono" data-var="value" spellcheck="false" placeholder="' + escapeHtml(t('api.varValPh')) + '">' + escapeHtml(row.value) + '</textarea>'
    + '  <button class="btn btn--icon btn--danger-quiet" type="button" data-var-remove="' + index + '" title="' + escapeHtml(t('api.varRemove')) + '">✕</button>'
    + '</div>').join('');

  host.querySelectorAll('[data-var-index]').forEach((node) => {
    const index = Number(node.getAttribute('data-var-index'));
    node.querySelector('[data-var="key"]').addEventListener('input', (event) => { rows[index].key = event.target.value; });
    node.querySelector('[data-var="value"]').addEventListener('input', (event) => { rows[index].value = event.target.value; });
    node.querySelector('[data-var-remove]').addEventListener('click', () => {
      rows.splice(index, 1);
      renderVarRows();
    });
  });
}

/* opts.duplicateOf = 原件 id，表示这是「复制接口」进来的（见 duplicateApi）。
 * 复制模式在这里收口，而不是在调用方改 item：深拷贝 + 新 id 本来就是本函数干的活，
 * 放到调用方就要重复一遍"什么算新对象"的假设。 */
function openApiDrawer(apiId, templateItem, opts) {
  if (!ensureEditable()) return;
  const o = opts || {};
  state.drawerMode = 'api';
  const isNew = !apiId;
  let item;
  if (isNew && templateItem) {
    item = JSON.parse(JSON.stringify(templateItem));
    item.id = 'api-' + Date.now().toString(36);
  } else if (isNew) {
    item = { id: 'api-' + Date.now().toString(36), name: '', module: '', path: '', method: 'POST', enabled: true, desc: '', proxy: { enable: false, url: '' }, rules: [], vars: {}, defaultResponse: { mode: 'static', status: 200, delayMs: 0, contentType: 'application/json;charset=UTF-8', body: '{}', script: '' } };
  } else {
    item = JSON.parse(JSON.stringify(activeApi()));
  }

  state.editingApiId = isNew ? null : apiId;
  /* 复制模式：三个字段预填，其余（规则 / 兜底响应 / 变量 / 代理）都是原件的深拷贝。
   *   - 名字加「（副本）」后缀
   *   - 路径预填**下一个可用值**（见 nextAvailablePath —— 这是"最省力的做法直接得出正确结果"）
   *   - enabled 强制 true（理由见 duplicateApi 的注释）
   *   - id 重新生成并补随机后缀：模板那条走的是纯时间戳 id，同毫秒连续复制两条会撞 id */
  state.duplicatingFromId = o.duplicateOf || null;
  if (state.duplicatingFromId) {
    item.id = 'api-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    item.name = (item.name || t('api.unnamed')) + t('api.copySuffix');
    item.path = nextAvailablePath(item);
    item.enabled = true;
    // 副本是新接口，不该继承原件的署名（原来 duplicateApi 里那段 delete 挪到了这里）
    delete item.updatedBy;
    delete item.updatedAt;
  }
  // varsRows 是「接口变量」的编辑态，保存时由 rowsToVars() 还原成接口的 vars 对象
  state.draft = { api: item, varsRows: varsToRows(item.vars) };
  setDrawerTitle(o.duplicateOf ? 'drawer.duplicateApi' : (isNew ? 'drawer.addApi' : 'drawer.editApi'));

  $('#drawerBody').innerHTML = ''
    + '<div class="section-label">' + t('api.identity') + '</div>'
    + '<div class="field"><label class="field__label" for="apiName">' + t('api.nameLabel') + '</label>'
    + '  <input class="input" id="apiName" value="' + escapeHtml(item.name) + '" placeholder="' + t('api.namePh') + '"></div>'
    + '<div style="display:grid; grid-template-columns:1fr 1.4fr; gap:12px">'
    + '  <div class="field"><label class="field__label" for="apiModule">' + t('api.moduleLabel') + '</label>'
    + '    <input class="input mono" id="apiModule" value="' + escapeHtml(item.module || '') + '" placeholder="' + t('api.modulePh') + '"></div>'
    + '  <div class="field"><label class="field__label" for="apiPath">' + t('api.pathLabel') + '</label>'
    + '    <input class="input mono" id="apiPath" value="' + escapeHtml(item.path || '') + '" placeholder="' + t('api.pathPh') + '"></div>'
    + '</div>'
    + '<span class="field__hint" id="urlPreview"></span>'
    /* 路径冲突的实时提示。用内联 style 控制显隐而不是 `hidden` 属性 —— 后者只有 UA 的
     * [hidden]{display:none} 兜着，被作者样式里任何 display 一比就输（本工程踩过一次）。
     * 与 urlPreview 分成两个节点：一个是"地址长什么样"，一个是"这个地址会不会被命中"，
     * 语义不同、样式也不同（后者走 warn 色）。 */
    + '<span class="field__hint field__hint--warn" id="pathConflict" style="display:none"></span>'
    + '<div class="field"><label class="field__label" for="apiDesc">' + t('api.descLabel') + '</label>'
    + '  <input class="input" id="apiDesc" value="' + escapeHtml(item.desc || '') + '" placeholder="' + t('api.descPh') + '"></div>'
    + '<div class="field"><label class="field__label" for="apiMethod">' + t('api.methodLabel') + '</label>'
    + '  <select class="input" id="apiMethod">'
    + '    <option value="ALL">' + t('api.methodAll') + '</option>'
    + '    <option value="GET">GET</option>'
    + '    <option value="POST">POST</option>'
    + '    <option value="PUT">PUT</option>'
    + '    <option value="DELETE">DELETE</option>'
    + '    <option value="PATCH">PATCH</option>'
    + '  </select></div>'
    + apiGroupFieldHtml(item)
    + '<label style="display:flex; align-items:center; gap:10px; font-size:var(--text-sm)">'
    + '  <span class="switch"><input type="checkbox" id="apiEnabled" ' + (item.enabled === false ? '' : 'checked') + '>'
    + '  <span class="switch__track"></span><span class="switch__thumb"></span></span>' + t('api.enableLabel') + '</label>'
    + '<div class="section-label">' + t('api.proxySection') + '</div>'
    + '<label style="display:flex; align-items:center; gap:10px; font-size:var(--text-sm)">'
    + '  <span class="switch"><input type="checkbox" id="proxyEnable" ' + (item.proxy && item.proxy.enable ? 'checked' : '') + '>'
    + '  <span class="switch__track"></span><span class="switch__thumb"></span></span>' + t('api.proxyEnable') + '</label>'
    + '<div class="field"><label class="field__label" for="proxyUrl">' + t('api.proxyUrlLabel') + '</label>'
    + '  <input class="input mono" id="proxyUrl" value="' + escapeHtml((item.proxy && item.proxy.url) || '') + '" placeholder="http://10.x.x.x:8080"></div>'
    + '<span class="field__hint">' + t('api.proxyUrlHint') + ''
    + '</span>'
    + varsEditorHtml();

  renderVarRows();
  $('#btnAddVar').addEventListener('click', () => {
    state.draft.varsRows.push({ key: '', value: '', original: undefined });
    renderVarRows();
    const rows = $('#varList').querySelectorAll('[data-var="key"]');
    if (rows.length) rows[rows.length - 1].focus();
  });

  const updatePreview = () => {
    const module = $('#apiModule').value.trim().replace(/^\/+|\/+$/g, '');
    const pathValue = $('#apiPath').value.trim().replace(/^\/+|\/+$/g, '');
    $('#urlPreview').textContent = t('api.urlPreview') + location.origin + '/' + [module, pathValue].filter(Boolean).join('/');
    updatePathConflict();
  };
  ['apiModule', 'apiPath'].forEach((id) => $('#' + id).addEventListener('input', updatePreview));
  /* 启用开关也是判据的一部分：关掉之后这条根本不参与匹配，"不会命中"就成了废话
   * （卡片上会有「已停用」tag），提示与按钮改名必须跟着消失。 */
  $('#apiEnabled').addEventListener('change', updatePathConflict);
  const methodSel = $('#apiMethod');
  if (methodSel) methodSel.value = methodLabel(item.method);
  updatePreview();
  openDrawer();
  /* openDrawer() 会按用途重设底部主按钮的文案（data-i18n 一起换），所以冲突态必须在它
   * **之后**再算一次 —— 否则首次渲染时按钮上还挂着旧的「保存接口」。 */
  updatePathConflict();
}

/* 抽屉里「路径冲突」的实时提示 + 底部主按钮改名。
 *
 * 只在这条接口**保存后真的收不到请求**时点亮（判定见 wouldBeShadowed）——
 * 无条件显示「保存（不会命中）」的话这个提示就恒真了，用户两三次之后会彻底忽略它。
 * 恒真的告警等于没有告警，这也正是本设计否掉"复制前必然弹窗告知不会命中"的同一理由：
 * **提示的存活周期取决于它的稀有度。**
 *
 * 冲突时**不拦截**：同路径是"备份 + 回滚"这一用法的正当形态（软唯一，见设计稿 §4 决策 2），
 * 不让保存等于把回滚能力砍掉。只把后果说清楚，并且挂在必经路径（按钮文案）上。 */
function updatePathConflict() {
  const hint = $('#pathConflict');
  if (!hint || !state.draft || !state.draft.api) return;
  const draft = {
    id: state.draft.api.id,
    enabled: $('#apiEnabled').checked,
    module: $('#apiModule').value.trim().replace(/^\/+|\/+$/g, ''),
    path: $('#apiPath').value.trim().replace(/^\/+|\/+$/g, ''),
  };
  const owner = wouldBeShadowed(draft);
  const key = apiFullPath(draft);
  /* 撞上一条**已停用**的同路径接口：这是"接管"场景（备份回滚生效的样子），
   * 不能报成警告 —— 但也不能沉默，用户此刻正需要知道"保存后这条会生效"。 */
  const disabledOwner = (!owner && key && draft.enabled !== false)
    ? ((state.config && state.config.apis) || []).find(
        (row) => row.id !== draft.id && row.enabled === false && apiFullPath(row) === key)
    : null;

  if (owner) {
    hint.textContent = '⚠ ' + t('api.pathTaken', { name: tSeed(owner.name) || t('api.unnamed') });
    hint.style.color = 'var(--color-warn)';
    hint.style.display = '';
  } else if (disabledOwner) {
    hint.textContent = t('api.pathTakenDisabled');
    hint.style.color = 'var(--color-muted)';
    hint.style.display = '';
  } else {
    hint.textContent = '';
    hint.style.display = 'none';
  }
  state.draft.pathConflict = owner || null;
  refreshDrawerSaveBtn();
}

/* 底部主按钮的文案：按用途 + 是否有路径冲突决定。
 * data-i18n 必须跟着一起换 —— 只改 textContent 的话，切语言时 applyI18n() 会按旧键
 * 把文案刷回去（与 setDrawerTitle / openDrawer 里那段同一个坑）。 */
function refreshDrawerSaveBtn() {
  if (state.drawerMode !== 'api') return;
  const btn = $('#btnDrawerSave');
  if (!btn || btn.hidden) return;
  const conflicted = !!(state.draft && state.draft.pathConflict);
  const key = conflicted ? 'drawer.saveWillNotHit' : 'drawer.saveApi';
  btn.setAttribute('data-i18n', key);
  btn.textContent = t(key);
  btn.classList.toggle('is-warn', conflicted);
}

/* ------------------------------ 抽屉骨架 ------------------------------ */

/* 抽屉标题：文案与 data-i18n 必须一起换。
 * 只写 textContent 的话，切语言时 applyI18n() 覆盖不到它 —— 抽屉不在 renderAll() 里，
 * 于是「抽屉开着切语言」标题会停在旧语言（实测：英文界面里标题还是「新增规则」）。
 * 挂上 data-i18n 后由 applyI18n 就地刷新，既跟着语言走又不会把抽屉内容重渲染掉。 */
function setDrawerTitle(key) {
  const el = $('#drawerTitle');
  if (!el) return;
  el.setAttribute('data-i18n', key);
  el.textContent = t(key);
}

function openDrawer() {
  /* 抽屉是一个壳、两种用途（编规则 / 编接口 / 编兜底响应），底部主按钮的文案跟着用途走。
   * 原来 index.html 里写死「保存规则」，于是「编辑接口」抽屉的标题是「编辑接口」、
   * 按钮却是「保存规则」，看着像点错了按钮。
   * 同时把 data-i18n 一起换掉 —— 否则切换语言时 applyI18n() 会把它按旧键刷回去。 */
  const saveKey = state.drawerMode === 'api'
    ? 'drawer.saveApi'
    : (state.editingRuleId === '__default__' ? 'drawer.saveDefault' : 'drawer.saveRule');
  const saveBtn = $('#btnDrawerSave');
  if (saveBtn) {
    if (state.drawerReadonly) {
      saveBtn.hidden = true;
    } else {
      saveBtn.hidden = false;
      saveBtn.setAttribute('data-i18n', saveKey);
      saveBtn.textContent = t(saveKey);
      /* 抽屉是复用的壳：上一次打开时可能停在「保存（不会命中）」的警示态，
       * 这次必须先清掉。接口抽屉随后会由 updatePathConflict() 重新算一遍。 */
      saveBtn.classList.remove('is-warn');
    }
  }
  $('#drawer').classList.add('is-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('is-open');
}

function closeDrawer() {
  $('#drawer').classList.remove('is-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('is-open');
  state.draft = null;
  state.drawerReadonly = false;
  /* 复制标记只在"这一次抽屉会话"里有效，必须在这里清掉 ——
   * 留着的话下一次「新增接口」保存时会被当成复制（插到某个原件下面、toast 也说复制）。 */
  state.duplicatingFromId = null;
}

async function saveDrawer() {
  if (!ensureEditable()) return;
  if (state.drawerMode === 'api') {
    const data = state.draft.api;
    data.name = $('#apiName').value.trim();
    data.module = $('#apiModule').value.trim().replace(/^\/+|\/+$/g, '');
    data.path = $('#apiPath').value.trim().replace(/^\/+|\/+$/g, '');
    data.desc = $('#apiDesc').value.trim();
    data.method = $('#apiMethod').value;
    data.groupId = resolveGroupId($('#apiGroup').value.trim());
    data.enabled = $('#apiEnabled').checked;
    data.proxy = { enable: $('#proxyEnable').checked, url: $('#proxyUrl').value.trim() };

    if (!data.path) { toast(t('api.pathRequired'), 'bad'); return; }

    const duplicate = firstDuplicateVarName(state.draft.varsRows);
    if (duplicate) { toast(t('api.varsDup', { name: duplicate }), 'bad'); return; }
    data.vars = rowsToVars(state.draft.varsRows);

    /* 落点三种：编辑（原位替换）／复制（原件当前下标的正下方）／新增（末尾）。
     * 复制为什么按 id **现查**下标、而不用 openApiDrawer 那一刻记下的：
     * 抽屉开着的时候用户可能已经在别处动过列表（拖拽排序、批量移组），那一刻的下标会过期。 */
    let savedToast = t('api.saved');
    if (state.editingApiId) {
      const index = state.config.apis.findIndex((row) => row.id === state.editingApiId);
      state.config.apis[index] = Object.assign({}, state.config.apis[index], data);
      state.activeApiId = state.editingApiId;
    } else {
      const srcId = state.duplicatingFromId;
      const srcIdx = srcId ? state.config.apis.findIndex((row) => row.id === srcId) : -1;
      if (srcIdx >= 0) state.config.apis.splice(srcIdx + 1, 0, data);
      else state.config.apis.push(data);
      state.activeApiId = data.id;
      if (srcId) savedToast = t('api.dupSaved', { name: data.name, path: apiFullPath(data) });
    }
    await persist(savedToast);
    closeDrawer();
    /* 保存后**定位到新接口**，而不是裸 renderAll —— 这是治「n 份」的关键一步。
     * 原来落盘后中栏纹丝不动、唯一反馈是否定性的，用户会以为操作失败然后接着点；
     * ensureApiVisible 会展开所在分组、把卡片滚进可视区，被筛选挡住时还会清掉冲突筛选
     * 并说明原因（它内部已调 renderAll）。 */
    if (!ensureApiVisible(state.activeApiId)) renderAll();
    return;
  }

  // 规则 / 兜底
  const isDefault = state.draft.isDefault;
  const prefix = isDefault ? 'def' : 'res';
  const response = {
    mode: $('#' + prefix + 'Mode').value,
    status: Number($('#' + prefix + 'Status').value) || 200,
    delayMs: Number($('#' + prefix + 'Delay').value) || 0,
    delayMaxMs: Number($('#' + prefix + 'DelayMax').value) || 0,
    fault: $('#' + prefix + 'Fault').value,
    contentType: $('#' + prefix + 'Type').value.trim() || 'application/json;charset=UTF-8',
    body: $('#' + prefix + 'Body').value,
    script: $('#' + prefix + 'Script').value,
  };

  const item = activeApi();
  if (isDefault) {
    item.defaultResponse = response;
  } else {
    const rule = state.draft.rule;
    rule.name = $('#ruleName').value.trim() || t('rule.unnamed');
    rule.enabled = $('#ruleEnabled').checked;
    rule.match = $('#ruleMatch').value;
    rule.response = response;
    // 清掉空条件，避免"看起来有条件其实永远不匹配"
    rule.conditions = rule.conditions.filter((condition) =>
      condition.source === 'raw' || OP_WITHOUT_VALUE.indexOf(condition.op) >= 0 || (condition.path || '').trim() !== '');

    if (state.editingRuleId) {
      const index = item.rules.findIndex((row) => row.id === state.editingRuleId);
      item.rules[index] = rule;
    } else {
      item.rules.push(rule);
    }
  }

  await persist(t('rule.saved'));
  closeDrawer();
  renderAll();
}

/* ------------------------------ 渲染总入口 ------------------------------ */

function renderAll() {
  renderTopbarStats();
  renderFilterPanel();
  renderApiList();
  renderWorkspace();
}

function renderFilterPanel() {
  const area = $('#searchFilterArea');
  const panel = $('#filterPanel');
  const row = $('#filterGroupRow');
  if (!area || !panel || !row) return;
  area.hidden = !state.showFilterPanel;

  // 状态单选
  document.querySelectorAll('[data-filter-status]').forEach((node) => {
    const input = node.querySelector('input');
    if (input) input.checked = (node.getAttribute('data-filter-status') === state.filterStatus);
    node.classList.toggle('is-on', node.getAttribute('data-filter-status') === state.filterStatus);
  });

  // 分组筛选 chips（多选；「全部」清空选择）
  // 标签与芯片分离：标签是行内固定列，芯片包在 .filter-group-chips 里独立滚动，
  // 这样「分组」二字永远不会被滚动条带走（也不出现 sticky 表头那种「两个面板」观感）
  const groups = (state.config && state.config.groups) || [];
  const noneSelected = state.filterGroupIds.length === 0;
  let groupHtml = '<span class="filter-panel__label">' + t('filter.group') + '</span>'
    + '<div class="filter-group-chips">'
    + '<label class="filter-chip' + (noneSelected ? ' is-on' : '') + '" data-filter-group="">'
    + '<input type="checkbox" data-filter-group-all' + (noneSelected ? ' checked' : '') + '">' + t('filter.all') + '</label>';
  groups.forEach((group) => {
    const on = state.filterGroupIds.includes(group.id);
    groupHtml += '<label class="filter-chip' + (on ? ' is-on' : '') + '" data-filter-group="' + escapeHtml(group.id) + '">'
      + '<input type="checkbox"' + (on ? ' checked' : '') + '>' + escapeHtml(tSeed(group.name)) + '</label>';
  });
  groupHtml += '</div>';
  row.innerHTML = groupHtml;
}

/* ------------------------------ 事件绑定 ------------------------------ */

/* 浮动操作菜单（全局 / 分组通用） */
function openCtxMenu(anchor, items) {
  const menu = $('#ctxMenu');
  if (!menu) return;
  menu.innerHTML = items.map((item, i) =>
    '<button class="ctx-menu__item' + (item.danger ? ' is-danger' : '') + '" type="button" data-ctx="' + i + '">'
    + (item.icon ? '<span class="ctx-menu__icon">' + item.icon + '</span>' : '')
    + '<span>' + escapeHtml(item.label) + '</span></button>'
  ).join('');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let top = r.bottom + 6;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  menu.querySelectorAll('[data-ctx]').forEach((node) => {
    node.addEventListener('click', () => { menu.hidden = true; items[Number(node.getAttribute('data-ctx'))].onClick(); });
  });
}

function openGlobalMenu(anchor) {
  if (state.auth.readonly) return;
  const items = [
    { label: t('group.newTitle'), icon: '＋', onClick: addGroup },
    { label: t('drawer.addApi'), icon: '＋', onClick: () => openApiDrawer(null) },
    { label: t('menu.changelog'), icon: '☰', onClick: () => openChangelogModal('', '') },
  ];
  /* 批量模式中不再提供这一项：它的文案永远是「批量选择」，留在菜单里既不是入口
   * （已经在模式里了）也不像个出口（看不出「点了会退出」）。出口统一交给「全部接口」
   * 行最右那个变成 ✕ 的开关和 Esc —— 而且模式中 ☰ 本来就不渲染，这一条其实是双保险。
   * 平时保留：那一行里 ☑ 只是个图标，菜单里这行**带文字**的「批量选择」是它的
   * 可读性兜底（图标认不出来的用户，从这儿进去）。 */
  if (!state.selectMode) {
    items.push({ label: t('menu.batchSelect'), icon: '☑', onClick: enterSelectMode });
  }
  openCtxMenu(anchor, items);
}

function openGroupMenu(groupId, anchor) {
  if (state.auth.readonly) return;
  openCtxMenu(anchor, [
    { label: t('drawer.addApi'), icon: '＋', onClick: () => addApiToGroup(groupId) },
    { label: t('group.renameTitle'), icon: '✎', onClick: () => renameGroup(groupId) },
    { label: t('group.copyMenu'), icon: '⧉', onClick: () => copyGroup(groupId) },
    { label: t('rule.up'), icon: '↑', onClick: () => moveGroup(groupId, -1) },
    { label: t('rule.down'), icon: '↓', onClick: () => moveGroup(groupId, 1) },
    { label: t('group.delete'), icon: '✕', danger: true, onClick: () => removeGroup(groupId) },
  ]);
}

/* ------------------------------ 批量选择模式 ------------------------------ */

/* 进模式：全展开（只写临时的 batchCollapsed，不动持久化的折叠结构）。
 * 不展开的话，折叠着的分组里那张勾选框根本看不见 —— 用户点了「批量选择」得到的
 * 就是「界面好像没反应」，这正是要解决的第一个问题。 */
function enterSelectMode() {
  if (state.selectMode) return;
  state.selectMode = true;
  state.batchCollapsed = new Set();
  // 开关本身、全选勾选框、☰ 的隐显都随这一次 renderApiList 重建，无需单独同步按钮态
  renderApiList();
}

/* 退出模式：勾选与临时折叠态一起丢弃 —— 折叠结构天然还原成 collapsedGroups 那一份，
 * 不需要任何「快照 / 还原」代码（也就不会出现「模式中途关掉页面，把全展开写进 localStorage」）。 */
function exitSelectMode() {
  if (!state.selectMode) return;
  state.selectMode = false;
  state.selectedApiIds.clear();
  state.batchCollapsed = new Set();
  renderApiList();
}

/* 批量模式的进出走同一个 toggle，但内部是两个具名函数 —— 按钮 / Esc / 菜单三条路都调到
 * 同一个出口，避免「多出口各自还原」这种漏一处就出错的写法。 */
function toggleSelectMode() {
  if (state.selectMode) exitSelectMode(); else enterSelectMode();
}

/* 在指定分组下新增接口：先打开抽屉，再把所属分组预填为该分组 */
function addApiToGroup(groupId) {
  if (!ensureEditable()) return;
  openApiDrawer(null);
  const sel = $('#apiGroup');
  if (sel) sel.value = groupName(groupId);
}

function bindGlobalEvents() {
  // 服务根地址：顶栏图标点击弹出居中弹窗显示并复制
  const baseUrl = serviceBase();
  const hostModal = $('#hostModal');
  const hostModalInput = $('#hostModalInput');

  function openHostModal() {
    if (!hostModal || !hostModalInput) return;
    hostModalInput.value = baseUrl;
    hostModal.hidden = false;
    hostModalInput.select();
  }
  function closeHostModal() {
    if (hostModal) hostModal.hidden = true;
  }

  const btnHost = $('#btnHost');
  if (btnHost) {
    btnHost.addEventListener('click', openHostModal);
  }
  const hostModalCopy = $('#hostModalCopy');
  if (hostModalCopy) {
    hostModalCopy.addEventListener('click', async () => {
      const ok = await copyText(baseUrl);
      toast(ok ? t('host.copied', { url: baseUrl }) : t('host.copyFail'), ok ? 'ok' : 'bad');
      if (ok) closeHostModal();
    });
  }
  const hostModalClose = $('#hostModalClose');
  if (hostModalClose) {
    hostModalClose.addEventListener('click', closeHostModal);
  }
  if (hostModal) {
    hostModal.addEventListener('click', (event) => {
      if (event.target === hostModal) closeHostModal();
    });
  }

  // 联系方式弹窗：邮箱来自 config.json 的 meta.contactEmail（部署者自行修改，不写死作者）
  const contactModal = $('#contactModal');
  const contactModalInput = $('#contactModalInput');
  function getContactEmail() {
    const meta = (state && state.config && state.config.meta) || {};
    return meta.contactEmail || 'maintainer@example.com';
  }
  function openContactModal() {
    if (!contactModal || !contactModalInput) return;
    contactModalInput.value = getContactEmail();
    contactModal.hidden = false;
    contactModalInput.select();
  }
  function closeContactModal() {
    if (contactModal) contactModal.hidden = true;
  }
  const btnContact = $('#btnContact');
  if (btnContact) {
    btnContact.addEventListener('click', openContactModal);
  }
  const contactModalCopy = $('#contactModalCopy');
  if (contactModalCopy) {
    contactModalCopy.addEventListener('click', async () => {
      const ok = await copyText(getContactEmail());
      toast(ok ? t('contact.copied') : t('contact.copyFail'), ok ? 'ok' : 'bad');
      if (ok) closeContactModal();
    });
  }
  const contactModalClose = $('#contactModalClose');
  if (contactModalClose) {
    contactModalClose.addEventListener('click', closeContactModal);
  }
  if (contactModal) {
    contactModal.addEventListener('click', (event) => {
      if (event.target === contactModal) closeContactModal();
    });
  }

  // ============ 用户管理（仅部署管理员 MOCK_ADMIN_* 可操作） ============
  const userMgmtModal = $('#userMgmtModal');
  const userMgmtForm = $('#userMgmtForm');
  const umUsername = $('#umUsername');
  const umPassword = $('#umPassword');
  const userList = $('#userList');
  const userMgmtMsg = $('#userMgmtMsg');

  function openUserMgmt() {
    if (!state.auth.isDeployAdmin) return;          // 普通 users 账号不开放
    closeUserMenu();
    if (!userMgmtModal) return;
    if (userMgmtMsg) userMgmtMsg.hidden = true;
    if (umUsername) umUsername.value = '';
    if (umPassword) umPassword.value = '';
    userMgmtModal.hidden = false;
    loadUsers();
    if (umUsername) setTimeout(() => umUsername.focus(), 50);
  }
  function closeUserMgmt() {
    if (userMgmtModal) userMgmtModal.hidden = true;
  }
  function setUserMgmtMsg(text, bad) {
    if (!userMgmtMsg) return;
    userMgmtMsg.hidden = !text;
    userMgmtMsg.textContent = text || '';
    userMgmtMsg.classList.toggle('is-bad', !!bad);
  }
  async function loadUsers() {
    if (!userList) return;
    const res = await api('/_admin/users');
    if (!res.ok) {
      userList.innerHTML = '';
      setUserMgmtMsg(res.message || t('user.loadFail'), true);
      return;
    }
    const users = Array.isArray(res.users) ? res.users : [];
    if (!users.length) {
      userList.innerHTML = '<p class="user-list__empty">' + t('user.empty') + '</p>';
      return;
    }
    userList.innerHTML = users.map((u) => (
      '<div class="user-item" data-user="' + escapeHtml(u.username) + '">' +
        '<span class="user-item__name">' + escapeHtml(u.username) + '</span>' +
        '<button class="btn btn--danger-quiet btn--sm um-del" type="button" data-user="' + escapeHtml(u.username) + '">' + t('user.delete') + '</button>' +
      '</div>'
    )).join('');
  }
  async function submitUser(event) {
    if (event) event.preventDefault();
    const name = umUsername ? umUsername.value.trim() : '';
    const password = umPassword ? umPassword.value : '';
    if (!name) { setUserMgmtMsg(t('user.nameRequired'), true); return; }
    if (!password) { setUserMgmtMsg(t('user.pwdRequired'), true); return; }
    const res = await api('/_admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: name, password: password }),
    });
    if (res.ok) {
      setUserMgmtMsg(res.message || t('user.saved'), false);
      if (umPassword) umPassword.value = '';
      loadUsers();
    } else {
      setUserMgmtMsg(res.message || t('user.saveFail'), true);
    }
  }
  async function removeUser(name) {
    const res = await api('/_admin/users?username=' + encodeURIComponent(name), { method: 'DELETE' });
    if (res.ok) { setUserMgmtMsg(res.message || t('user.deleted'), false); loadUsers(); }
    else { setUserMgmtMsg(res.message || t('user.delFail'), true); }
  }

  const btnUserMgmt = $('#btnUserMgmt');
  if (btnUserMgmt) btnUserMgmt.addEventListener('click', openUserMgmt);
  const btnLogout = $('#btnLogout');
  if (btnLogout) btnLogout.addEventListener('click', logout);
  // 头像：点击切换下拉；点击头像/菜单之外或按 Esc 关闭
  const btnUserMenu = $('#btnUserMenu');
  if (btnUserMenu) btnUserMenu.addEventListener('click', (event) => { event.stopPropagation(); toggleUserMenu(); });
  document.addEventListener('click', (event) => {
    const menu = $('#userDropdown');
    if (!menu || menu.hidden) return;
    const avatar = $('#btnUserMenu');
    if (avatar && (avatar.contains(event.target) || menu.contains(event.target))) return;
    closeUserMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeUserMenu(); closeUserMgmt(); }
  });
  // 下拉打开期间，窗口尺寸 / 页面滚动变化都要重新贴回头像 ——
  // 窄屏下顶栏会换行、头像位置随之变化，不重算就会脱轨
  const repositionUserMenu = () => {
    const menu = $('#userDropdown');
    if (menu && !menu.hidden) positionUserMenu();
  };
  window.addEventListener('resize', repositionUserMenu);
  window.addEventListener('scroll', repositionUserMenu, true);
  const userMgmtClose = $('#userMgmtClose');
  if (userMgmtClose) userMgmtClose.addEventListener('click', closeUserMgmt);
  if (userMgmtForm) userMgmtForm.addEventListener('submit', submitUser);
  if (userMgmtModal) userMgmtModal.addEventListener('click', (event) => { if (event.target === userMgmtModal) closeUserMgmt(); });
  if (userList) userList.addEventListener('click', (event) => {
    const btn = event.target.closest('.um-del');
    if (btn) removeUser(btn.getAttribute('data-user'));
  });

  /* 弹窗统一收口：① 填上品牌图标 ② 点遮罩关闭。
   * 输入 / 确认弹窗不列在这里 —— 它们自己管遮罩，且关闭必须 resolve，被这里接管会让 await 挂住；
   * 用户管理弹窗也已有自己的遮罩处理（要顺带清空表单），不重复接管。 */
  applyModalIcons();
  const backdropClosers = {
    hostModal: () => { const m = $('#hostModal'); if (m) m.hidden = true; },
    contactModal: () => { const m = $('#contactModal'); if (m) m.hidden = true; },
    changelogModal: closeChangelogModal,
  };
  Object.keys(backdropClosers).forEach((id) => {
    const layer = document.getElementById(id);
    if (!layer) return;
    layer.addEventListener('click', (event) => { if (event.target === layer) backdropClosers[id](); });
  });

  // 全局汉堡已移入「全部接口」总分组头（见 renderApiList），此处不再单独绑定
  $('#btnTheme').addEventListener('click', cycleTheme);
  // btnAddRule 现在由 renderWorkspace() 动态生成（在 #workspace 内），用事件委托绑定，
  // 否则 init 时该按钮尚未创建会导致 $('#btnAddRule') 为 null 而抛错、整页白屏
  $('#workspace').addEventListener('click', (event) => {
    const addBtn = event.target.closest('#btnAddRule');
    if (addBtn && activeApi()) openRuleDrawer(-1, false);
    // 定位按钮：走统一入口（展开所在分组 + 清掉会挡住目标的筛选 + 滚到卡片）
    const locBtn = event.target.closest('#btnLocateApi');
    if (locBtn) {
      const api = activeApi();
      if (!api) return;
      ensureApiVisible(api.id);
    }
  });
  $('#btnDrawerClose').addEventListener('click', closeDrawer);
  $('#btnDrawerCancel').addEventListener('click', closeDrawer);
  $('#btnDrawerSave').addEventListener('click', saveDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const hostModal = $('#hostModal');
      if (hostModal && !hostModal.hidden) {
        hostModal.hidden = true;
        return;
      }
      const contactModal = $('#contactModal');
      if (contactModal && !contactModal.hidden) {
        contactModal.hidden = true;
        return;
      }
      // 变更记录也是弹窗，ESC 就该跟其他弹窗一样能关（以前只有点「关闭」一条路）
      const changelogModal = $('#changelogModal');
      if (changelogModal && !changelogModal.hidden) {
        closeChangelogModal();
        return;
      }
      /* 浮层菜单（分组菜单 / 全局菜单 / 批量移组）是最上层，ESC 先收它。
       * 这里必须 return：不拦的话，批量模式那条判断会把「我想关个菜单」办成「退出批量模式」。
       * 顺带纠正了原来的行为 —— 以前菜单开着按 ESC 会连抽屉一起关掉（末尾那句 closeDrawer
       * 无条件执行），一层 ESC 干了两层的事。 */
      const ctxMenu = $('#ctxMenu');
      if (ctxMenu && !ctxMenu.hidden) {
        ctxMenu.hidden = true;
        return;
      }
      /* 批量模式 → 退模式。必须排在下面那句 closeDrawer() **之前并 return**：
       * 那句是条件链末尾无条件执行的，不拦下来，「按 ESC 退出批量模式」会顺带把抽屉也关了。 */
      if (state.selectMode) {
        exitSelectMode();
        return;
      }
      closeDrawer();
      const m = $('#ctxMenu');
      if (m) m.hidden = true;
    }
  });

  // 点击浮动菜单及触发按钮以外的区域，关闭菜单（汉堡按钮已 stopPropagation，不会误关）
  document.addEventListener('click', (event) => {
    const menu = $('#ctxMenu');
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target)) return;
    if (event.target.closest('[data-group-menu], [data-total-menu]')) return;
    menu.hidden = true;
  });

  $('#btnReload').addEventListener('click', async () => {
    const result = await api('/_admin/reload', { method: 'POST' });
    toast(result.message || t('reload.done'), result.ok ? 'ok' : 'bad');
    await loadConfig();
  });

  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'mock-server-config.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $('#btnImport').addEventListener('click', () => {
    if (!ensureEditable()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed.apis) throw new Error(t('import.noApis'));

        /* 导入 = 合并进本地，不再是「整份覆盖」。
         * 以前导入一份旧备份会把本地几十个接口静默冲掉；现在：
         *   ① 先算清楚有多少是新增、多少与本地冲突；
         *   ② 有冲突时让人选处理方式（跳过 / 覆盖 / 重命名并存）；
         *   ③ 选完再确认一次实际会动到什么。 */
        const local = state.config || { groups: [], apis: [] };
        const probe = mergeImported(local, parsed, 'skip');
        const incomingCount = (parsed.apis || []).length;
        const fresh = probe.summary.added;
        const conflict = incomingCount - fresh;

        if (!incomingCount) throw new Error(t('import.noApis'));

        let strategy = 'skip';
        if (conflict > 0) {
          const picked = await askChoice({
            title: t('import.strategyTitle'),
            message: t('import.strategyHint', { total: incomingCount, same: conflict, fresh: fresh }),
            cancelText: t('import.strategyCancel'),
            options: [
              { value: 'skip', label: t('import.strategySkip'), desc: t('import.strategySkipDesc') },
              { value: 'overwrite', label: t('import.strategyOverwrite'), desc: t('import.strategyOverwriteDesc'), danger: true },
              { value: 'rename', label: t('import.strategyRename'), desc: t('import.strategyRenameDesc') },
            ],
          });
          if (!picked) return;              // 取消导入
          strategy = picked;
        }

        const merged = mergeImported(local, parsed, strategy);
        const s = merged.summary;
        if (!(await askConfirm({
          title: t('import.confirmTitle'),
          message: t('import.result', { add: s.added, over: s.overwritten, skip: s.skipped, rename: s.renamed }),
          okText: t('import.confirmOk'),
        }))) return;

        state.config = merged.config;
        await persist(t('import.done'));
        state.activeApiId = state.config.apis.length ? state.config.apis[0].id : null;
        renderAll();
      } catch (e) {
        toast(t('import.fail', { msg: e.message }), 'bad');
      }
    });
    input.click();
  });

  $('#btnClearLogs').addEventListener('click', async () => {
    if (!(await askConfirm({
      title: t('log.clearTitle'),
      message: t('log.clearConfirm'),
      okText: t('log.clearOk'),
    }))) return;
    await api('/_admin/logs/clear', { method: 'POST' });
    await refreshLogs();
  });

  // 日志只显示当前接口：多人共用时，全局日志很快被其他接口刷掉
  const logApiOnly = $('#logApiOnly');
  if (logApiOnly) {
    logApiOnly.addEventListener('change', async (event) => {
      state.logApiOnly = event.target.checked;
      await refreshLogs();
    });
  }

  const changelogClose = $('#changelogClose');
  if (changelogClose) changelogClose.addEventListener('click', closeChangelogModal);
  const changelogModal = $('#changelogModal');
  if (changelogModal) {
    changelogModal.addEventListener('click', (event) => {
      if (event.target === changelogModal) closeChangelogModal();
    });
  }

  $('#autoRefresh').addEventListener('change', (event) => {
    state.autoRefresh = event.target.checked;
  });

  // 侧栏显隐
  $('#btnToggleLeft').addEventListener('click', () => {
    state.leftCollapsed = !state.leftCollapsed;
    applySidebarState();
  });
  $('#btnToggleRight').addEventListener('click', () => {
    state.rightCollapsed = !state.rightCollapsed;
    applySidebarState();
  });

  // 左侧常驻「＋分组 / ＋接口」：与「全部接口」总分组的 ☰ 菜单功能一致，作为显式入口
  const btnAddGroup = $('#btnAddGroup');
  if (btnAddGroup) btnAddGroup.addEventListener('click', addGroup);
  const btnAddApi = $('#btnAddApi');
  if (btnAddApi) btnAddApi.addEventListener('click', addApiFromTemplate);

  /* 批量选择的开关不在这里绑 —— 它已经搬到「全部接口」行（#totalGroup），
   * 而那一行每次 renderApiList 都会重建，所以监听统一放在 bindApiListEvents 里。
   * boot 阶段这里去 querySelector('#btnSelect') 只会拿到 null（列表还没渲染）。 */

  // 搜索框：输入防抖（逐字重渲染在接口多时会卡）+ ESC 清空
  const searchInput = $('#apiSearch');
  if (searchInput) {
    searchInput.value = state.searchQuery;
    searchInput.addEventListener('input', (event) => {
      const value = event.target.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = 0;
        if (state.searchQuery === value) return;
        state.searchQuery = value;
        renderApiList();
      }, SEARCH_DEBOUNCE_MS);
    });
    /* ESC 清空搜索词。必须挂在搜索框自己的 keydown 上并 stopPropagation：
     * 全局 ESC 链（document 的 keydown）末尾是无条件 closeDrawer()，把那套扩展到这里
     * 会让「按 ESC 关抽屉」顺带把搜索词也清掉。搜索框里没内容时不拦截，
     * 让 ESC 继续走全局链，抽屉/菜单照常能关。 */
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!searchInput.value && !state.searchQuery) return;
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      renderApiList();
    });
  }

  // 漏斗按钮：展开/收起搜索和筛选区
  const btnToggleFilter = $('#btnToggleFilter');
  btnToggleFilter.addEventListener('click', () => {
    state.showFilterPanel = !state.showFilterPanel;
    btnToggleFilter.classList.toggle('is-on', state.showFilterPanel);
    renderFilterPanel();
  });

  // 语言切换：默认中文，点击在 中文 / English 间切换并持久化
  const btnLang = $('#btnLang');
  if (btnLang) {
    btnLang.addEventListener('click', () => {
      const next = (I18N.getLang() === 'zh-CN') ? 'en' : 'zh-CN';
      I18N.setLang(next);
      updateLangSwitch();
      toast(t('lang.switched', { name: next === 'en' ? 'English' : '中文' }), 'ok');
    });
  }

  // GitHub 仓库：地址取自 config.json 的 meta.repoUrl（部署者在配置里改，不写死在代码里）
  const btnGitHub = $('#btnGitHub');
  if (btnGitHub) {
    btnGitHub.addEventListener('click', () => {
      const meta = (state && state.config && state.config.meta) || {};
      const url = String(meta.repoUrl || '').trim();
      // 只放行 http(s)：配置是外部可编辑的，别让 javascript: 之类的东西进了 window.open
      if (!/^https?:\/\/\S+$/i.test(url)) { toast(t('github.placeholder')); return; }
      window.open(url, '_blank', 'noopener');
    });
  }

  // 只读分享（A11）：生成 / 管理分享链接。只读视图下该按钮带 data-edit-only，已被 CSS 隐藏
  const btnShare = $('#btnShare');
  if (btnShare) btnShare.addEventListener('click', openShareModal);
  // 操作手册：新标签页打开网页版帮助（public/help.html），只读分享视图下也可见
  const btnHelp = $('#btnHelp');
  if (btnHelp) btnHelp.addEventListener('click', () => window.open('help.html', '_blank'));
  const btnShareGen = $('#btnShareGen');
  if (btnShareGen) btnShareGen.addEventListener('click', createShareLink);
  const shareModalClose = $('#shareModalClose');
  if (shareModalClose) shareModalClose.addEventListener('click', () => { const m = $('#shareModal'); if (m) m.hidden = true; });
  const shareModal = $('#shareModal');
  if (shareModal) shareModal.addEventListener('click', (event) => { if (event.target === shareModal) shareModal.hidden = true; });

  // 分组过滤（事件委托，因为会重渲染）
  document.addEventListener('change', (event) => {
    const target = event.target.closest('#filterPanel');
    if (!target) return;
    const statusRadio = event.target.closest('[name="filterStatus"]');
    if (statusRadio) {
      state.filterStatus = statusRadio.value;
      renderFilterPanel();
      renderApiList();
      return;
    }
    const groupBox = event.target.closest('[data-filter-group]');
    if (groupBox) {
      const id = groupBox.getAttribute('data-filter-group');
      if (id === '') {
        state.filterGroupIds = [];
      } else {
        const checked = groupBox.querySelector('input').checked;
        if (checked) {
          if (!state.filterGroupIds.includes(id)) state.filterGroupIds.push(id);
        } else {
          state.filterGroupIds = state.filterGroupIds.filter((x) => x !== id);
        }
      }
      renderFilterPanel();
      renderApiList();
    }
  });

  // 登录
  const loginForm = $('#loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const userEl = $('#loginUsername');
      const pwEl = $('#loginPassword');
      const username = userEl ? userEl.value.trim() : '';
      const password = pwEl ? pwEl.value : '';
      const err = $('#loginError');
      const res = await api('/_admin/login', {
        method: 'POST',
        body: JSON.stringify({ username: username, password: password }),
      });
      if (res.ok && res.token) {
        state.auth.token = res.token;
        state.auth.loggedIn = true;
        state.auth.username = res.username || '';
        state.auth.isDeployAdmin = !!res.isDeployAdmin;
        writeLocal(TOKEN_KEY, res.token);
        hideLogin();
        renderUserBar();
        await loadConfig();
        await refreshHealth();
        await refreshLogs();
      } else {
        // 失败时只清密码、保留用户名，方便改密重试
        if (err) err.textContent = res.message || t('login.wrong');
        if (pwEl) {
          pwEl.value = '';
          pwEl.focus();
        }
      }
    });
  }

  // 入场序列：错峰揭示（只跑一次）
  requestAnimationFrame(() => {
    document.querySelectorAll('.reveal').forEach((node) => node.classList.add('is-in'));
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  applyI18n();
  initLoginLang();
  initTheme();
  initSidebarState();
  initCollapsedGroups();
  bindGlobalEvents();
  await initAuth();
  if (state.auth.shareInvalid) {
    if (state.auth.required) {
      // 账密部署：initAuth 已走 showLogin 流程（未登录）或按后台加载（已登录），
      // 这里不再加载配置、不渲染失效提示页
      return;
    }
    // 免密部署：无登录界面，仅展示「链接已失效」提示，不加载配置、不启动轮询
    renderShareInvalid();
    return;
  }
  if (state.auth.shareRequired) {
    // 只读端口无有效分享令牌：initAuth 已调用 renderShareRequired() 展示🔒提示页
    return;
  }
  await loadConfig();
  // 未登录时先不打后台轮询接口（否则每次都 401，还会干扰登录框输入）
  if (!needsLogin()) {
    await refreshHealth();
    await refreshLogs();
  }

  setInterval(() => { if (state.autoRefresh && !needsLogin()) refreshLogs(); }, 3000);
  setInterval(() => { if (!needsLogin()) refreshHealth(); }, 10000);
  setInterval(tickUptime, 1000);  // 运行时长实时走秒
}

boot();
