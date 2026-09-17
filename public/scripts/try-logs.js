/* ============================================================================
 * try-logs.js —— 变更记录、试打一枪、请求日志
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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

/* 日志 SSE：连上之后服务端有新日志/清空操作会主动推，前端收到再拉一次快照。
 * 这让“自动刷新开关”关掉后日志仍能实时更新；3 秒轮询保留为 SSE 失败时的兜底。 */
function connectLogStream() {
  if (state.logStream || state.offline) return;
  if (!state.auth) return;
  if (state.auth.shareRequired || state.auth.shareInvalid) return;
  if (state.auth.required && !state.auth.loggedIn && !state.auth.readonly) return;

  let streamUrl = '/_admin/logs/stream';
  if (state.auth.fromShare && state.auth.token) {
    // EventSource 不能自定义请求头：share 让只读端口放行，token 让主端口的会话校验放行
    streamUrl += '?share=' + encodeURIComponent(state.auth.token) + '&token=' + encodeURIComponent(state.auth.token);
  } else if (state.auth.token) {
    streamUrl += '?token=' + encodeURIComponent(state.auth.token);
  }

  const es = new EventSource(streamUrl);
  es.addEventListener('log', () => { refreshLogs(); });
  es.addEventListener('clear', () => {
    state.logs = [];
    renderLogs();
  });
  es.addEventListener('error', () => {
    es.close();
    if (state.logStream === es) state.logStream = null;
    setTimeout(() => { if (!state.logStream && !state.offline) connectLogStream(); }, 3000);
  });
  state.logStream = es;
}

function closeLogStream() {
  if (state.logStream) {
    state.logStream.close();
    state.logStream = null;
  }
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
      /* 日志副本被截断时必须显式说明（正文末尾也带一行标记，但抽屉里先给结论）：
       * 否则排查时会拿半份 body 当全份用。 */
      const truncated = (log.reqBodyTruncated || log.respBodyTruncated)
        ? '<div style="margin:0 0 8px;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.5;'
          + 'color:var(--color-warn);background:var(--color-warn-soft);border:1px solid var(--color-warn-line)">'
          + escapeHtml(t('log.truncated')) + '</div>'
        : '';
      detail.innerHTML = ''
        + truncated
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
