/* ============================================================================
 * api-list.js —— 顶栏统计、左侧接口列表的渲染与交互、左栏定位
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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
