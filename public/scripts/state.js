/* ============================================================================
 * state.js —— 全局状态、常量与本地偏好读写
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

/* ------------------------------ 全局状态 ------------------------------ */

const state = {
  config: null,
  activeApiId: null,
  logs: [],
  logStream: null,
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
