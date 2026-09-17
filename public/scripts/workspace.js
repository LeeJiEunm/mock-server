/* ============================================================================
 * workspace.js —— 工作区渲染与只读详情视图
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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
