/* ============================================================================
 * theme.js —— 主题切换与侧栏折叠状态
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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
