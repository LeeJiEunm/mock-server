/* ============================================================================
 * core.js —— 通用小工具、示例配置与接口模板、配置读写
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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

function methodOf(item) {
  const m = String((item && item.method) || '').trim().toUpperCase();
  return m || 'ALL';
}

/** method 是否互相遮蔽：ALL 和具体方法总是重叠，不同具体方法不重叠 */
function apiMethodOverlaps(a, b) {
  const ma = methodOf(a);
  const mb = methodOf(b);
  return ma === 'ALL' || ma === '*' || mb === 'ALL' || mb === '*' || ma === mb;
}

/** 接口业务键：模块 + 路径 + method，method 参与遮蔽/导入判重 */
function apiKeyOf(item) {
  return apiFullPath(item) + '|' + methodOf(item);
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
 * 判定走「全表比对 apiFullPath + method」，**不看 enabled**：
 *   - 不看 enabled：停用项一旦启用就会冲突；
 *   - 同路径不同 method 不再互相挡（GET 的副本不会因为别处有 POST 就强制改名）。
 * 口径与导入判重的 keyOf（mergeImported）一致。 */
function nextAvailablePath(item) {
  const module = String(item.module || '').replace(/^\/+|\/+$/g, '');
  const basePath = String(item.path || '').replace(/^\/+|\/+$/g, '');
  if (!basePath) return '';
  const apis = (state.config && state.config.apis) || [];
  const isTaken = (path) => apis.some((api) =>
    apiFullPath(api) === [module, path].filter(Boolean).join('/') && apiMethodOverlaps(api, item)
  );
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
    method: item.method || 'ALL',
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
  return before.find((row) =>
    row.id !== draft.id && row.enabled !== false && apiFullPath(row) === key && apiMethodOverlaps(row, draft)
  ) || null;
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
  const keyOf = (api) => apiKeyOf(api).toLowerCase();

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
    // 成功后把服务端新版本号同步回本地，下一次保存才不会误报冲突
    if (Number.isFinite(Number(result.rev))) {
      state.config.meta = state.config.meta || {};
      state.config.meta.rev = Number(result.rev);
    }
    if (successMessage) toast(successMessage, 'ok');
    renderTopbarStats();
  } else if (result.conflict) {
    // 其他人已保存过新版本：重新拉最新配置并提示，绝不用旧快照静默覆盖
    toast(t('save.conflict', { msg: result.message || '' }), 'bad');
    await loadConfig();
  } else {
    toast(t('save.fail', { msg: result.message || t('save.unknown') }), 'bad');
  }
}
