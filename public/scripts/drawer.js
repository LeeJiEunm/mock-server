/* ============================================================================
 * drawer.js —— 抽屉（规则 / 接口 / 接口变量 / 骨架）
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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
