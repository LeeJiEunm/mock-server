#!/usr/bin/env node
'use strict';

/**
 * verify-ui.js —— 控制台界面的「真浏览器」自检
 *
 * 为什么需要它：只看「文件写成功」是抓不到下面这两类问题的，
 *   1) 点了按钮没反应（事件没绑上 / 结果被重渲染冲掉）；
 *   2) 元素看得见但点不动（被别的元素盖住）。
 * 这两类都真的发生过，所以这里用真实 Chrome 把它们固化成断言。
 *
 * 零依赖：Node 22 自带 WebSocket，不需要 puppeteer。
 *
 * 用法：
 *   node tools/verify-ui.js                      # 默认测 http://127.0.0.1:18080/
 *   node tools/verify-ui.js http://<HOST_IP>:18080/
 *
 * 退出码：0 = 全部通过；1 = 有断言失败（详细结果打印在下面）。
 */

const cdp = require('./lib/cdp');

const BASE = (process.argv[2] || 'http://127.0.0.1:18080/').replace(/\/+$/, '') + '/';
let PORT = 0; // 运行时动态选空闲端口，避免连到上一轮残留的 Chrome（由 cdp.launchChrome 现取）

const sleep = cdp.sleep;

/* ------------------------------ CDP 客户端 ------------------------------ */
/* 起 Chrome / 连接 / 命令超时 / 页面报错采集统一在 tools/lib/cdp.js。
 * 这里只保留 send 这个旧名字（转发给 page.send，同名同参），
 * 这样下面两千多行的调用点一行都不用动。 */
let chrome = null;
let page = null;

function send(method, params) { return page.send(method, params); }

/* 只读护栏：前端有些开关一拨就会把配置 POST 回服务端（例如左侧的接口启停开关，
 * 它测的是「停用后右侧状态标签同步变色」，一拨就真的落盘）。
 * 自检是拿来验证的，不该动目标实例的数据 —— 所以把写配置的请求拦在页面里，
 * 返回一个假的成功响应，让前端逻辑照常走完。 */
const READONLY_GUARD = `
(() => {
  const real = window.fetch;
  window.fetch = function (url, opt) {
    const method = String((opt && opt.method) || 'GET').toUpperCase();
    if (method === 'POST' && String(url).indexOf('/_admin/config') >= 0) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, message: '(自检拦截，未落盘)' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real.apply(this, arguments);
  };
})();
`;

/** 在指定窗口宽度下加载页面，跑一段注入脚本，返回 { consoleErrors, result } */
async function runAt(width, height, source, extraQuery) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: width, height: height, deviceScaleFactor: 1, mobile: false,
  });

  const consoleErrors = [];
  const collect = (data) => {
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      consoleErrors.push(data.params.args.map((arg) => arg.value || arg.description || '').join(' '));
    }
    if (data.method === 'Runtime.exceptionThrown') {
      const details = data.params.exceptionDetails;
      consoleErrors.push('[异常] ' + (details.exception ? details.exception.description : details.text));
    }
    if (data.method === 'Runtime.evaluate' && data.params.context) { /* noop */ }
  };
  const stopCollect = page.on(collect);

  // 带宽高变化的缓存：每次都重新加载，避免拿到上一次的 DOM
  // 只读分享校验需要把 ?share= 令牌带进导航地址，extraQuery 非空时拼在前面
  const navUrl = BASE + (extraQuery ? ('?' + extraQuery + '&t=') : '?t=') + Date.now();
  await send('Page.navigate', { url: navUrl });
  await sleep(2200);

  const out = await send('Runtime.evaluate', {
    expression: '(async () => {' + READONLY_GUARD + source + '})()',
    awaitPromise: true,
    returnByValue: true,
  });

  stopCollect();
  return {
    consoleErrors: consoleErrors,
    result: out.result ? out.result.value : null,
    thrown: out.exceptionDetails ? out.exceptionDetails.text : null,
  };
}

/* ------------------------------ 被注入的检查脚本 ------------------------------ */

/** 宽屏：试打有没有反馈、有没有进日志、主题能不能切、分组有没有渲染 */
const WIDE_CHECK = `
const out = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 对比度按 WCAG 相对亮度公式实算，不靠目测
const hexToRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const lum = (rgb) => {
  const m = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
};
const contrast = (fg, bgc) => {
  const a = lum(fg), b = lum(bgc);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
};
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// 最弱一级文字会落在 surface-3 上（最亮、最难达标的底），以它为准
const contrastReport = () => ({
  faint: contrast(hexToRgb(token('--color-faint')), hexToRgb(token('--color-surface-3'))),
  muted: contrast(hexToRgb(token('--color-muted')), hexToRgb(token('--color-surface-3'))),
  text: contrast(hexToRgb(token('--color-text')), hexToRgb(token('--color-bg'))),
});

out.groups = Array.from(document.querySelectorAll('#apiList .group')).map((g) => ({
  name: g.querySelector('.group__name').textContent,
  count: Number(g.querySelector('.group__count').textContent),
}));

// 几何：侧栏根地址条已隐藏；搜索工具条正常显示
const filterBtn = document.querySelector('#btnToggleFilter');
if (filterBtn) {
  filterBtn.click();
  await wait(200);
}
out.paneHostExists = !!document.querySelector('#paneHost');
const toolbarRect = document.querySelector('#apiToolbar').getBoundingClientRect();
out.toolbarTop = Math.round(toolbarRect.top);
out.toolbarOverlap = false;

// 试打：必须真的回填结果，不能只是"请求发出去了"
const body = document.querySelector('#tryBody');
body.value = '{"code":"500","MARKER_XYZ":"typed"}';
body.dispatchEvent(new Event('input', { bubbles: true }));
document.querySelector('#btnTry').click();
await wait(1500);

out.trace = document.querySelector('#tryTrace').textContent.replace(/\\s+/g, ' ').trim();
out.response = document.querySelector('#tryResponse').textContent.replace(/\\s+/g, ' ').trim();
out.typedKept = document.querySelector('#tryBody').value.indexOf('MARKER_XYZ') >= 0;
out.ruleHighlighted = !!document.querySelector('.rule.is-hit');
out.logCount = Number(document.querySelector('#logCount').textContent);
out.logHasTestTag = !!document.querySelector('#logList .tag--accent');

const theme = () => document.documentElement.getAttribute('data-theme');
const bg = () => getComputedStyle(document.body).backgroundColor;
// 三态循环：深夜 -> 白天 -> 夜晚 -> 深夜，依次停下来采样
out.themeDeep = theme();
out.bgDeep = bg();
out.deepContrast = contrastReport();
let guard = 0;
while (theme() !== 'light' && guard < 5) { document.querySelector('#btnTheme').click(); await wait(350); guard++; }
out.themeLight = theme();
out.bgLight = bg();
out.lightCardBg = getComputedStyle(document.querySelector('.card')).backgroundColor;
out.lightContrast = contrastReport();
guard = 0;
while (theme() !== 'night' && guard < 5) { document.querySelector('#btnTheme').click(); await wait(350); guard++; }
out.themeNight = theme();
out.bgNight = bg();
out.nightContrast = contrastReport();
guard = 0;
while (theme() !== 'deepnight' && guard < 5) { document.querySelector('#btnTheme').click(); await wait(350); guard++; }
out.themeBack = theme();
out.bgBack = bg();
out.backContrast = contrastReport();

// ---- 排版：字号 / 字重，取计算值 ----
const fontOf = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const s = getComputedStyle(el);
  return { size: Math.round(parseFloat(s.fontSize) * 10) / 10, weight: s.fontWeight };
};
out.type = {
  totalGroupTitle: fontOf('.total-group .group__name'),
  apiPath: fontOf('.api-item__path'),
  ruleName: fontOf('.rule__name'),
  drawerTitle: fontOf('.drawer__title'),
};

// 全页最小实际字号：揪出"凑近才能读"的小字
const leaves = [];
document.querySelectorAll('body *').forEach((el) => {
  if (el.children.length || !el.textContent.trim()) return;
  const size = parseFloat(getComputedStyle(el).fontSize);
  if (size > 0) leaves.push({ size: size, where: el.className || el.tagName });
});
leaves.sort((a, b) => a.size - b.size);
out.minFont = leaves.length
  ? { size: Math.round(leaves[0].size * 10) / 10, where: String(leaves[0].where) }
  : null;

// 顶栏根地址按钮：应存在，点击弹出居中弹窗并回填 baseUrl
const hostBtn = document.querySelector('#btnHost');
out.hostBtnExists = !!hostBtn;
if (hostBtn) {
  hostBtn.click();
  await wait(300);
  const hostModal = document.querySelector('#hostModal');
  out.hostModalOpen = hostModal && !hostModal.hidden;
  out.hostModalValue = (document.querySelector('#hostModalInput') || {}).value || '';
  const hostCopyBtn = document.querySelector('#hostModalCopy');
  const toastBeforeHost = document.querySelectorAll('.toast').length;
  if (hostCopyBtn) {
    hostCopyBtn.click();
    await wait(300);
    out.hostCopyToastShown = document.querySelectorAll('.toast').length > toastBeforeHost;
  }
  const hostCloseBtn = document.querySelector('#hostModalClose');
  if (hostCloseBtn) hostCloseBtn.click();
  await wait(200);
  out.hostModalClosed = hostModal && hostModal.hidden;
}

const tryit = document.querySelector('.tryit');
out.paneWidth = Math.round(document.querySelector('.pane--mid').getBoundingClientRect().width);
out.tryitColumns = getComputedStyle(tryit).gridTemplateColumns.split(' ').length;

// 接口停用同步：左侧 toggle 关闭后，右侧详情状态标签应同步变为"已停用"
// 关键：点 toggle 会触发列表重渲染，原 DOM 节点随即失效 —— 恢复时必须重新查一次，
// 否则第二次 click() 打在脱离文档的旧节点上不生效，停用状态会被真的写进 config.json。
// 要拨的是「当前选中那一条」的开关：右侧详情显示的就是它，拨别人不会同步。
const toggleSel = '#apiList .api-item.is-active [data-api-toggle]';
const toggleSelFallback = '#apiList .api-item [data-api-toggle]';
const pickToggle = () => document.querySelector(toggleSel) || document.querySelector(toggleSelFallback);
const firstApiToggle = pickToggle();
out.apiToggleSync = { tested: false, beforeChecked: null, afterTagText: null, restored: false };
if (firstApiToggle) {
  out.apiToggleSync.beforeChecked = firstApiToggle.checked;
  if (firstApiToggle.checked) {
    try {
      firstApiToggle.click();
      await wait(400);
      const tagWarn = document.querySelector('#workspace .tag--warn');
      const tagOk = document.querySelector('#workspace .tag--ok');
      out.apiToggleSync.tested = true;
      out.apiToggleSync.afterTagText = tagWarn ? tagWarn.textContent.trim() : (tagOk ? tagOk.textContent.trim() : '(无标签)');
      out.apiToggleSync.hasWarnTag = !!tagWarn;
    } finally {
      // 无论断言中间发生什么，都要把开关拨回去
      const nowToggle = pickToggle();
      if (nowToggle && !nowToggle.checked) nowToggle.click();
      await wait(600);
      const backToggle = pickToggle();
      out.apiToggleSync.restored = !!backToggle && backToggle.checked === out.apiToggleSync.beforeChecked;
    }
  }
}

// 联系方式按钮：应存在，点击打开居中弹窗，复制邮箱成功
const contactBtn = document.querySelector('#btnContact');
out.contactBtnExists = !!contactBtn;
if (contactBtn) {
  contactBtn.click();
  await wait(300);
  const contactModal = document.querySelector('#contactModal');
  out.contactModalOpen = contactModal && !contactModal.hidden;
  out.contactModalValue = (document.querySelector('#contactModalInput') || {}).value || '';
  const contactCopyBtn = document.querySelector('#contactModalCopy');
  const toastBeforeContact = document.querySelectorAll('.toast').length;
  if (contactCopyBtn) {
    contactCopyBtn.click();
    await wait(300);
    out.contactCopyToastShown = document.querySelectorAll('.toast').length > toastBeforeContact;
  }
  const contactCloseBtn = document.querySelector('#contactModalClose');
  if (contactCloseBtn) contactCloseBtn.click();
  await wait(200);
  out.contactModalClosed = contactModal && contactModal.hidden;
}

// 全部展开 / 全部折叠按钮（v16 新增）：每次点击后 DOM 会重绘，需重新 query
const toggleAllBtn = document.querySelector('#btnToggleAllGroups');
if (toggleAllBtn) {
  // 每次点击都会触发 renderApiList 重建按钮，必须重新 query，否则点到脱离 DOM 的旧节点
  const clickToggleAll = () => { const b = document.querySelector('#btnToggleAllGroups'); if (b) b.click(); };
  const groups = () => Array.from(document.querySelectorAll('#apiList .group'));
  const allCollapsed = () => groups().every((g) => g.classList.contains('is-collapsed'));
  const allExpanded = () => groups().every((g) => !g.classList.contains('is-collapsed'));
  // 先归一化到"全部展开"（抵消 localStorage 里可能残留的折叠态），再测切换
  if (!allExpanded()) { clickToggleAll(); await wait(200); }
  clickToggleAll();
  await wait(200);
  const c = allCollapsed();
  clickToggleAll();
  await wait(200);
  const e = allExpanded();
  out.expandCollapseAll = { allCollapsed: c, allExpanded: e };
}

// 顶栏品牌区竖线：应已移除（.brand 不再有右边框）
const brandEl = document.querySelector('.brand');
out.brandBorderRight = brandEl ? getComputedStyle(brandEl).borderRightWidth : 'no-brand';

// 语言切换：默认中文，点击切英文并持久化，再点切回中文
const langBtn = document.querySelector('#btnLang');
const statRulesNode = document.querySelector('[data-i18n="stat.rules"]');
out.langBefore = document.documentElement.lang;
out.langStorageBefore = (function () { try { return localStorage.getItem('mockServer.lang'); } catch (e) { return null; } })();
out.statRulesZh = statRulesNode ? statRulesNode.textContent : null;
langBtn.click();
await wait(500);
out.langAfterEn = document.documentElement.lang;
out.langStorageEn = (function () { try { return localStorage.getItem('mockServer.lang'); } catch (e) { return null; } })();
out.statRulesEnText = statRulesNode ? statRulesNode.textContent : null;
langBtn.click();
await wait(500);
out.langAfterBack = document.documentElement.lang;

// GitHub 按钮：地址取自 config.json 的 meta.repoUrl（配了就直接打开，没配才弹提示、且不跳转）
const ghBtn = document.querySelector('#btnGitHub');
const ghToastsBefore = document.querySelectorAll('.toast').length;
const ghOpened = [];
const ghRealOpen = window.open;
window.open = (url) => { ghOpened.push(String(url)); return null; };
ghBtn.click();
await wait(300);
window.open = ghRealOpen;
out.githubToasts = document.querySelectorAll('.toast').length - ghToastsBefore;
out.githubOpened = ghOpened.slice();

/* 提示条要挂在页面**顶部**（原先在底部，容易被内容/滚动条压住，用户看不到反馈） */
const tHost = document.getElementById('toastHost');
out.toastHostPosition = tHost ? getComputedStyle(tHost).position : null;
out.toastHostTop = tHost ? Math.round(tHost.getBoundingClientRect().top) : null;
out.viewportH = window.innerHeight;

/* 切语言后，JS 动态生成的抽屉内容也必须跟着变
 * （曾经：运算符 / 取值位置 / 变量芯片停在中文，只有静态 data-i18n 节点被刷新） */
const cjk = (s) => /[\u4e00-\u9fa5]/.test(s || '');
document.getElementById('btnAddRule').click();
await wait(450);
I18N.setLang('en');
await wait(450);
const condOpts = Array.from(document.querySelectorAll('.cond-row select[data-cond="op"] option')).map((o) => o.textContent.trim());
const srcOpts = Array.from(document.querySelectorAll('.cond-row select[data-cond="source"] option')).map((o) => o.textContent.trim());
const chipTexts = Array.from(document.querySelectorAll('.varchip')).map((b) => b.textContent.trim());
const pathInput = document.querySelector('.cond-row input[data-cond="path"]');
const ruleNameInput = document.getElementById('ruleName');
out.i18nRuleName = ruleNameInput ? ruleNameInput.value : null;
out.i18nRuleNamePh = ruleNameInput ? ruleNameInput.placeholder : null;
out.i18nOpText = condOpts.join('/');
out.i18nSourceText = srcOpts.join('/');
out.i18nPathPh = pathInput ? pathInput.placeholder : null;
/* 通用变量芯片（{{body.x}} 那四个）不该有中文；本接口变量芯片的数据来自 config，允许中文 */
out.i18nGenericChipCJK = chipTexts
  .filter((s) => /^\{\{(body|query|header|vars)\./.test(s) && s.length <= 24)
  .filter(cjk);
out.i18nCondHasCJK = condOpts.some(cjk) || srcOpts.some(cjk);
/* 抽屉标题同样是 JS 写进 #drawerTitle 的：抽屉不在 renderAll() 覆盖范围，
 * 必须靠 data-i18n + applyI18n 就地刷新，否则抽屉开着切语言标题会停在旧语言 */
const dTitle = document.getElementById('drawerTitle');
out.i18nDrawerTitle = dTitle ? dTitle.textContent : null;
out.i18nDrawerTitleAttr = dTitle ? dTitle.getAttribute('data-i18n') : null;
const c1 = document.getElementById('btnDrawerCancel');
if (c1) c1.click();
await wait(250);
I18N.setLang('zh-CN');
await wait(350);

/* 粘贴 cURL 弹窗：多行模式只该有 1 个可见输入框（曾多出一个空的单行框），占位符要带示例 */
const pasteBtn = document.querySelector('[data-kv-paste="tryQuery"]');
if (pasteBtn) {
  pasteBtn.click();
  await wait(450);
  const pBody = document.querySelector('#promptForm .modal-card__body');
  out.pasteVisibleControls = Array.from(pBody.querySelectorAll('input, textarea, select')).filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetHeight > 0;
  }).map((el) => el.tagName.toLowerCase() + '.' + el.className);
  const hint = document.getElementById('promptHint');
  out.pasteHintText = hint ? hint.textContent : null;
  out.pasteHintLines = hint ? hint.textContent.split('\\n').length : 0;
  out.pasteHintHasExample = !!hint
    && hint.textContent.indexOf('curl') >= 0 && hint.textContent.indexOf('Authorization') >= 0;
  out.pasteHintWhiteSpace = hint ? getComputedStyle(hint).whiteSpace : null;
  const ta = pBody.querySelector('textarea');
  /* 占位符里不能塞多行示例：Chrome 会把 textarea placeholder 的换行折叠成空格，
   * 6 行示例挤成一行还被横向截断（比没有更差），所以多行示例放说明区。 */
  out.pastePhMultiline = ta ? ta.placeholder.indexOf('\\n') >= 0 : false;
  /* 但占位符本身要是一条**具体示例**（含 curl），不能只是"在此输入…"这种提示：
   * 操作员不知道格式时长什么样，照着能跑的一行抄最快。 */
  out.pastePhText = ta ? ta.placeholder : null;
  out.pastePhHasExample = ta ? ta.placeholder.indexOf('curl') >= 0 : false;
  /* 弹窗宽度：说明区那行最长示例（约 76 字符）必须一行放得下，窄了会折行被截断 */
  const pCard = document.getElementById('promptForm');
  out.pasteCardWidth = pCard ? Math.round(pCard.getBoundingClientRect().width) : null;
  out.pasteHintWidth = hint ? Math.round(hint.getBoundingClientRect().width) : null;
  document.getElementById('promptCancel').click();
  await wait(250);
}
out.inputRestored = (() => {
  const wrap = document.getElementById('promptInput').parentNode;
  return getComputedStyle(wrap).display !== 'none';
})();

/* 左栏吸顶条：sticky 的 top:0 是相对滚动容器的**内容盒**算的，.pane__body 的上内边距
 * 那一条会漏出滚动内容（实测：接口卡片从「全部接口」条上方透出来）。用 ::before 补齐挡住。 */
const totalGroup = document.querySelector('.total-group');
const paneBody = document.querySelector('.pane__body');
out.panePaddingTop = paneBody ? getComputedStyle(paneBody).paddingTop : null;
out.stickyCoverHeight = totalGroup ? getComputedStyle(totalGroup, '::before').height : null;
out.stickyCoverContent = totalGroup ? getComputedStyle(totalGroup, '::before').content : null;
out.stickyTop = totalGroup ? getComputedStyle(totalGroup).top : null;

/* ---- 侧栏折叠：展开按钮必须完整落在 32px 窄轨里（2026-09-13 用户报「右边栏收缩有点叠在一起」）
 * 坑：'#paneRight .pane__head{padding:0 var(--space-4)}' 特异性 (1,1,0) 会压掉
 * '.pane.is-collapsed .pane__head{padding:0}' 的 (0,3,0)（id 权重最高），
 * 残留的 16px 右内边距把 22px 按钮挤出轨道左边界 6px，直接压在中栏「+ 新增规则」上。 */
out.collapse = {};
{
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!document.querySelector('#btnAddRule')) {
    const first = document.querySelector('.api-item');
    if (first) { first.click(); await tick(600); }
  }
  const geo = (side) => {
    const pane = document.getElementById(side === 'left' ? 'paneLeft' : 'paneRight');
    const btn = document.getElementById(side === 'left' ? 'btnToggleLeft' : 'btnToggleRight');
    if (!pane || !btn) return null;
    const pb = pane.getBoundingClientRect(), bb = btn.getBoundingClientRect();
    const head = pane.querySelector('.pane__head');
    return {
      paneW: Math.round(pb.width),
      btnW: Math.round(bb.width),
      insetLeft: Math.round(bb.left - pb.left),
      insetRight: Math.round(pb.right - bb.right),
      outside: bb.left < pb.left - 0.5 || bb.right > pb.right + 0.5,
      headPaddingLeft: head ? getComputedStyle(head).paddingLeft : null,
      headPaddingRight: head ? getComputedStyle(head).paddingRight : null,
    };
  };
  const flip = async (side) => {
    document.getElementById(side === 'left' ? 'btnToggleLeft' : 'btnToggleRight').click();
    await tick(480);
  };

  await flip('right');
  out.collapse.right = geo('right');
  {
    const addRule = document.querySelector('#btnAddRule');
    const paneR = document.getElementById('paneRight');
    if (addRule && paneR) {
      out.collapse.right.gapToAddRule = Math.round(
        paneR.getBoundingClientRect().left - addRule.getBoundingClientRect().right);
    }
  }
  await flip('right');

  await flip('left');
  out.collapse.left = geo('left');
  await flip('left');
}

return out;
`;

/** 窄屏：滚动到试打面板后，输入框必须真的可点、可聚焦、可输入 */
const NARROW_CHECK = `
const out = {};
const probe = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return { sel: selector, clickable: false, focusable: false, coveredBy: 'missing', missing: true };
  el.scrollIntoView({ block: 'center' });
  const rect = el.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  el.focus();
  return { sel: selector, clickable: top === el, focusable: document.activeElement === el, coveredBy: top === el ? null : (top ? top.tagName + '.' + top.className : null) };
};

out.layoutHeight = Math.round(parseFloat(getComputedStyle(document.querySelector('.layout')).height));
out.pageScrollable = document.documentElement.scrollHeight > innerHeight;
// 注意：试打面板的「查询参数 / 请求头」是 KV 列表，kvFieldHtml 生成的容器 ID 是
// tryQueryList / tryHeaderList（不是 tryQuery / tryHeader），空列表时只有「+ 添加」按钮
// （data-kv-add="tryQuery" / "tryHeader"）。这里探真实可达的元素，避免误报 missing。
out.probes = ['#tryBody', '[data-kv-add="tryQuery"]', '[data-kv-add="tryHeader"]', '#btnTry'].map(probe);
out.missing = out.probes.filter((p) => p.missing).map((p) => p.sel);

const body = document.querySelector('#tryBody');
if (body) {
  body.scrollIntoView({ block: 'center' });
  body.focus();
  document.execCommand('insertText', false, 'MARKER');
  out.typed = body.value.indexOf('MARKER') >= 0;
} else {
  out.typed = false;
}

const tryBtn = document.querySelector('#btnTry');
if (tryBtn) {
  tryBtn.click();
  await new Promise((r) => setTimeout(r, 1500));
  out.trace = document.querySelector('#tryTrace').textContent.replace(/\\s+/g, ' ').trim();
}
return out;
`;

/* ---- A10 模板新建 / A11 只读分享：前端集成校验 ----
 * A10：普通视图点「＋接口」应弹出模板选择（空白 / 回显 / 条件），选回显模板后抽屉预填名称。
 * A11：用真实分享令牌走 ?share= 集成校验，横幅可见、进入只读、编辑入口隐藏。 */
const A10_CHECK = `
const out = {};
const addBtn = document.querySelector('#btnAddApi');
out.addBtnExists = !!addBtn;
if (addBtn) {
  addBtn.click();
  await new Promise((r) => setTimeout(r, 450));
  const list = document.querySelector('.choice-list');
  out.choiceOpened = !!list;
  out.choiceCount = list ? list.querySelectorAll('.choice').length : 0;
  const echo = list ? Array.from(list.querySelectorAll('.choice')).find((b) => (b.textContent || '').indexOf('回显') >= 0) : null;
  out.echoFound = !!echo;
  if (echo) {
    echo.click();
    await new Promise((r) => setTimeout(r, 500));
    const drawer = document.querySelector('#drawer');
    out.drawerOpen = !!drawer && drawer.classList.contains('is-open');
    const nameEl = document.querySelector('#apiName');
    out.prefillName = nameEl ? nameEl.value : null;
    const cancel = document.querySelector('#btnDrawerCancel');
    if (cancel) cancel.click();
    await new Promise((r) => setTimeout(r, 250));
    out.drawerClosed = !!drawer && !drawer.classList.contains('is-open');
  }
}
return out;
`;

const A11_CHECK = `
const out = {};
out.url = location.href;
out.search = location.search;
out.tHasShare = location.search.indexOf('share=') >= 0;
let waited = 0;
while (!document.body.classList.contains('readonly') && waited < 5000) {
  await new Promise((r) => setTimeout(r, 200));
  waited += 200;
}
const banner = document.querySelector('#readonlyBanner');
out.bannerVisible = !!banner && !banner.hidden;
out.bodyReadonly = document.body.classList.contains('readonly');
out.bodyClass = document.body.className;
const addBtn = document.querySelector('#btnAddApi');
out.addBtnHidden = addBtn ? getComputedStyle(addBtn).display === 'none' : false;
const shareBtn = document.querySelector('#btnShare');
out.shareBtnHidden = shareBtn ? getComputedStyle(shareBtn).display === 'none' : false;
const chip = document.querySelector('#readonlyChip');
out.chipVisible = !!chip && !chip.hidden;
return out;
`;

/* ---- A11 分享链接管理弹窗：生成链接（真实写 config.shareTokens）→ 列表出现带 URL 的行
 *      → 撤销（真实 DELETE /_admin/share）→ 行移除。创建与撤销成对，不污染配置指纹。 ---- */
const A11_SHARE_MODAL = `
const out = {};
const openBtn = document.querySelector('#btnShare');
out.shareBtnExists = !!openBtn;
if (openBtn) {
  openBtn.click();
  await new Promise((r) => setTimeout(r, 450));
  const modal = document.querySelector('#shareModal');
  out.modalOpen = !!modal && !modal.hidden;
  const list = document.querySelector('#shareList');
  const empty = document.querySelector('#shareEmpty');
  out.initialRows = list ? list.querySelectorAll('.share-row').length : 0;
  out.emptyVisibleInitially = !!empty && !empty.hidden;
  const genBtn = document.querySelector('#btnShareGen');
  out.genBtnExists = !!genBtn;
  if (genBtn) {
    genBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    const rows = list ? Array.from(list.querySelectorAll('.share-row')) : [];
    out.rowsAfterCreate = rows.length;
    out.rowAdded = rows.length === out.initialRows + 1;
    const first = rows[0] || null;
    out.urlShown = !!first && !!first.getAttribute('data-url') && (first.querySelector('.share-row__url') || {}).textContent.trim().length > 0;
    const revoke = first ? first.querySelector('[data-share-revoke]') : null;
    out.revokeBtnExists = !!revoke;
    if (revoke) {
      revoke.click();
      await new Promise((r) => setTimeout(r, 800));
      out.rowsAfterRevoke = list ? list.querySelectorAll('.share-row').length : -1;
      out.revokeRemoved = (list ? list.querySelectorAll('.share-row').length : -1) === out.initialRows;
    }
  }
  const closeBtn = document.querySelector('#shareModalClose');
  if (closeBtn) closeBtn.click();
  await new Promise((r) => setTimeout(r, 250));
  out.modalClosed = !!modal && modal.hidden;
}
return out;
`;

/* ---- A12 试打结果故障标注：fault≠none 时状态栏出警告 tag，malformed 额外显示截断预览块 ----
 * 复现场景：操作者给某条响应配了「畸形响应体」，在试打一枪里却只看到完整 JSON，
 * 容易误以为「故障没配上」。这里改内存里的兜底 fault=malformed（保存被只读护栏拦掉，不落盘），
 * 再试打，断言状态栏出现故障标注、且 malformed 预览块可见并展示截断内容。 */
const FAULT_CHECK = `
const out = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const active = document.querySelector('#apiList .api-item.is-active');
out.hasActiveApi = !!active;

const editDefault = document.querySelector('#btnEditDefault');
out.editDefaultBtn = !!editDefault;
if (editDefault) {
  editDefault.click();
  await wait(500);
  const select = document.querySelector('#defFault');
  out.faultSelectExists = !!select;
  if (select) {
    select.value = 'malformed';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    out.faultValueSet = select.value;
    const saveBtn = document.querySelector('#btnDrawerSave');
    out.saveBtnExists = !!saveBtn;
    if (saveBtn) { saveBtn.click(); await wait(700); }
  }
}
const drawer = document.querySelector('#drawer');
out.drawerClosedAfterSave = !!drawer && !drawer.classList.contains('is-open');

const body = document.querySelector('#tryBody');
out.tryBodyExists = !!body;
if (body) {
  body.value = '{"code":"500","padding":"XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"}';
  body.dispatchEvent(new Event('input', { bubbles: true }));
  const tryBtn = document.querySelector('#btnTry');
  if (tryBtn) tryBtn.click();
  await wait(1600);
}
const bar = document.querySelector('#tryStatusBar');
out.statusBarText = bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : null;
out.warnTagShown = !!bar && /畸形|截断/.test(bar.textContent);
const preview = document.querySelector('#tryFaultPreview');
out.previewExists = !!preview;
out.previewVisible = !!preview && !preview.hidden;
out.previewShowsTruncated = !!preview && !preview.hidden && /真实调用将收到/.test(preview.textContent);
// 预览块背景要和正常响应体（.code）区分：取计算样式比对背景色
const respBlock = document.querySelector('#tryResponse');
out.previewBgDistinct = !!(preview && respBlock && preview.hidden === false
  && getComputedStyle(preview).backgroundColor !== getComputedStyle(respBlock).backgroundColor);
return out;
`;

/* ------------------------------ 断言 ------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/** 解析 rgb()/rgba() 字符串为 [r,g,b]（0-255） */
function parseRgb(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s || '');
  if (!m) return null;
  return m[1].split(',').slice(0, 3).map((x) => parseFloat(x));
}

/** 两个背景色是否肉眼可区分：取三通道最大差，阈值 12/255（约 5%）+ 经验判断 */
function bgDistinct(a, b) {
  const A = parseRgb(a), B = parseRgb(b);
  if (!A || !B) return false;
  const maxDiff = Math.max(
    Math.abs(A[0] - B[0]),
    Math.abs(A[1] - B[1]),
    Math.abs(A[2] - B[2]),
  );
  return maxDiff >= 12;
}

/* ------------------------------ 主流程 ------------------------------ */

/* ---- 回归专项：日志点规则定位 / 日志过滤联动 / 模板变量面板 ----
 * 这三条都属于「点了没反应」类问题（事件绑了但结果被重渲染冲掉、
 * 或者目标元素压根没渲染出来），只看源码看不出来，必须在真浏览器里跑。
 * 界面只有一个接口时无法构造跨接口场景，此时 skip 而不是判失败。 */
const FIX_CHECK = `
const out = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const activeName = () => {
  const node = document.querySelector('#apiList .api-item.is-active');
  return node ? (node.querySelector('.api-item__name') || {}).textContent : null;
};
const wsTitle = () => {
  const node = document.querySelector('#workspace .apibox__title');
  return node ? node.textContent : null;
};

out.startApi = activeName();

// 挑一个「不是当前选中」的接口，用它制造一条跨接口日志
const otherItem = Array.from(document.querySelectorAll('#apiList .api-item'))
  .find((n) => !n.classList.contains('is-active'));
const rawPath = otherItem ? (otherItem.querySelector('.api-item__path') || {}).textContent.trim() : '';
const otherPath = rawPath ? (rawPath.charAt(0) === '/' ? rawPath : '/' + rawPath) : '';
out.otherPath = otherPath;

if (!otherPath) {
  out.jump = { skipped: true, reason: '界面上只有一个接口，构造不出跨接口场景' };
  out.logOnly = { skipped: true };
} else {
  await fetch(otherPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"JUMPTEST"}' });
  await wait(3600);   // 请求日志是 3 秒轮询

  const target = Array.from(document.querySelectorAll('#logList .log')).find((row) => {
    const api = row.querySelector('.log__api');
    return api && api.textContent.indexOf(otherPath) >= 0;
  });
  out.targetLogFound = !!target;

  if (target) {
    const beforeTitle = wsTitle();
    target.click();
    await wait(700);
    const afterTitle = wsTitle();
    out.jump = {
      titleBefore: beforeTitle,
      titleAfter: afterTitle,
      highlighted: !!document.querySelector('#workspace .rule.is-hit'),
      crossApiWorked: (beforeTitle !== afterTitle) && !!document.querySelector('#workspace .rule.is-hit'),
    };
  } else {
    out.jump = { skipped: true, reason: '日志列表里没找到 ' + otherPath };
  }

  // 开了「只看当前接口」后切换接口，日志必须跟着换
  const sw = document.querySelector('#logApiOnly');
  if (sw && !sw.checked) {
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(1000);
  }
  const hasTarget = () => Array.from(document.querySelectorAll('#logList .log'))
    .some((row) => { const a = row.querySelector('.log__api'); return a && a.textContent.indexOf(otherPath) >= 0; });
  const beforeSwitch = hasTarget();
  const nextItem = Array.from(document.querySelectorAll('#apiList .api-item')).find((n) => !n.classList.contains('is-active'));
  if (nextItem) nextItem.click();
  await wait(1400);
  out.logOnly = {
    beforeSwitchHas: beforeSwitch,
    afterSwitchHas: hasTarget(),
    apiNow: activeName(),
    works: beforeSwitch && !hasTarget(),
  };
}

// 响应体「可用变量」面板：分组说明 + 点击插入
const editBtn = document.querySelector('#workspace [data-action="edit"]');
out.editBtnFound = !!editBtn;
if (editBtn) {
  editBtn.click();
  await wait(600);
  const chips = Array.from(document.querySelectorAll('#drawerBody .varchip'));
  const bodyEl = document.querySelector('#resBody');
  out.vars = {
    chipCount: chips.length,
    groups: Array.from(document.querySelectorAll('#drawerBody .varshint__group')).map((n) => n.textContent),
    tip: (document.querySelector('#drawerBody .varshint__tip') || {}).textContent,
  };
  if (bodyEl && chips.length >= 8) {
    bodyEl.value = '';
    chips[0].click();
    await wait(150);
    out.vars.inserted = bodyEl.value;
    out.vars.insertOk = bodyEl.value.indexOf('{{body.}}') >= 0;
    chips[7].click();
    await wait(150);
    out.vars.twoOk = bodyEl.value.indexOf('{{random}}') >= 0;
    // 本接口自己的变量（接口设置里配的）必须是完整名字的芯片，点一下插入 {{vars.名字}}
    // 注意要用 data-var-insert 区分：通用芯片的插入文本是 {{vars.}}（留空待填），
    // 本接口变量芯片才是完整名字 {{vars.名字}}
    const apiChip = chips.find((c) => {
      const ins = c.getAttribute('data-var-insert') || '';
      return ins.indexOf('{{vars.') === 0 && ins !== '{{vars.}}';
    });
    if (apiChip) {
      const token = apiChip.getAttribute('data-var-insert');
      // 芯片上必须同时显示「当前值」——只给名字的话，写规则时仍然不知道这个变量是什么数据
      const valEl = apiChip.querySelector('.varchip__val');
      out.vars.apiChipValue = valEl ? (valEl.textContent || '') : null;
      out.vars.apiChipValueOk = !!out.vars.apiChipValue && out.vars.apiChipValue !== token;
      bodyEl.value = '';
      apiChip.click();
      await wait(150);
      out.vars.apiChip = token;
      out.vars.apiChipOk = bodyEl.value === token;
    }
    // 不变式：要么列出本接口变量芯片，要么给一行「还没定义变量」的说明——
    // 不能两者都没有（早先直接 return '' 时这一组会凭空消失，操作员只能盲写）
    out.vars.apiEmptyNote = !!document.querySelector('#drawerBody .varshint__note');
    out.vars.apiGroupNeverSilent = !!apiChip || out.vars.apiEmptyNote;
  }
}

// 接口变量：{{vars.x}} 的定义处。以前只能改配置文件，界面上看不到也改不了，
// 操作员只能照着响应体猜变量名（还区分大小写，猜错静默变成空字符串）。
const closeRuleDrawer = document.querySelector('#btnDrawerCancel');
if (closeRuleDrawer) { closeRuleDrawer.click(); await wait(300); }
const apiEdit = document.querySelector('#btnEditApi');
out.apiEditFound = !!apiEdit;
if (apiEdit) {
  apiEdit.click();
  await wait(700);
  const rows = Array.from(document.querySelectorAll('#varList .var-row'));
  const keys = rows.map((r) => (r.querySelector('[data-var="key"]') || {}).value);
  const addBtn = document.querySelector('#btnAddVar');
  out.apiVars = {
    title: (document.querySelector('#drawerTitle') || {}).textContent,
    rowCount: rows.length,
    keys: keys,
    hasAddBtn: !!addBtn,
    skipped: rows.length === 0,
  };
  if (addBtn) {
    addBtn.click();
    await wait(250);
    out.apiVars.addWorks = document.querySelectorAll('#varList .var-row').length === rows.length + 1;
    // 删掉刚加的空行并「取消」关抽屉：整个断言不落盘，不污染配置
    const removes = document.querySelectorAll('#varList [data-var-remove]');
    if (removes.length) removes[removes.length - 1].click();
    await wait(200);
    out.apiVars.cleanupOk = document.querySelectorAll('#varList .var-row').length === rows.length;
  }
  const cancelApi = document.querySelector('#btnDrawerCancel');
  if (cancelApi) cancelApi.click();
}

/* ---- 弹窗统一：所有弹窗共用同一套骨架（图标 + 标题头区），
 *      删除这类确认不再走浏览器原生 confirm（原生弹窗挂窗口顶部、样式不可控） ---- */
const dlgCards = Array.from(document.querySelectorAll('.modal-layer > .modal-card'));
out.dialogs = {
  layerCount: document.querySelectorAll('.modal-layer').length,
  cardCount: dlgCards.length,
  legacyCount: document.querySelectorAll('.prompt-card, .prompt-layer').length,
  headCount: dlgCards.filter((c) => c.querySelector('.modal-card__head')).length,
  iconCount: dlgCards.filter((c) => c.querySelector('.modal-card__icon svg')).length,
};
{
  // 原生 confirm 一旦被调用就说明改回老路了，这里换成记账桩子
  let nativeCalls = 0;
  const nativeConfirm = window.confirm;
  window.confirm = function () { nativeCalls += 1; return false; };
  /* 前置条件：确认弹窗挂在「当前接口」上，必须先真的选中一个接口，工作区标题行才会出现删除按钮。
   * 历史写法是直接 querySelector('#workspace [data-action="remove"]')（每条规则行末的 ✕），
   * 只要当前接口恰好是 0 条规则，就拿不到按钮 → 整段 if (delBtn) 被静默跳过，
   * 下面所有弹窗断言一起 FAIL，而 detail 只剩一个 {} —— 长期被当成「历史遗留」没人往下追。
   * 改：先点一下左栏第一张接口卡（就是用户的那一下），再用工作区标题行的「删除」按钮，
   * 它只要求「有选中的接口」，不要求「接口里有规则」。 */
  const firstApiItem = document.querySelector('#apiList .api-item');
  if (firstApiItem) { firstApiItem.click(); await wait(240); }
  const delBtn = document.querySelector('#btnDeleteApi');
  out.dialogs.delBtnFound = !!delBtn;
  if (delBtn) {
    const rulesBefore = document.querySelectorAll('#workspace [data-rule-id]').length;
    const apisBefore = document.querySelectorAll('#apiList .api-item').length;
    delBtn.click();
    await wait(450);   // 等入场动画跑完再量坐标，否则量到的是动画中途的位置
    const layer = document.querySelector('#confirmModal');
    const card = layer ? layer.querySelector('.modal-card') : null;
    out.dialogs.open = !!layer && !layer.hidden;
    out.dialogs.title = (document.querySelector('#confirmTitle') || {}).textContent;
    out.dialogs.okText = (document.querySelector('#confirmOk') || {}).textContent;
    out.dialogs.dangerStyle = !!(card && card.classList.contains('is-danger'));
    out.dialogs.iconInConfirm = !!(card && card.querySelector('.modal-card__icon svg'));
    if (card) {
      const r = card.getBoundingClientRect();
      out.dialogs.offsetX = Math.round(Math.abs((r.left + r.width / 2) - window.innerWidth / 2));
      out.dialogs.offsetY = Math.round(Math.abs((r.top + r.height / 2) - window.innerHeight / 2));
    }
    /* 确认弹窗宽度：文案里要塞操作对象的**名字**，长度不可控，所以不能跟输入框弹窗
     * 共用 360px 那档（2026-09-15 用户报「字都换行了」）。
     * 量法用一段**固定长度**的探针文案，不去读真实接口名 —— 真实名字可长可短
     * （config 里是「示例：条件响应」，用户实例里可能是「我的第一个接口（副本）」），
     * 拿它做断言会跟着数据变脆。这里写死用户报的那条 20 个全角字。 */
    if (card) {
      const tEl = document.querySelector('#confirmText');
      const lh = tEl ? parseFloat(getComputedStyle(tEl).lineHeight) || 0 : 0;
      const savedText = tEl ? tEl.textContent : '';
      if (tEl && lh) {
        tEl.textContent = '确定删除接口「我的第一个接口（副本）」？';
        out.dialogs.cardWidth = Math.round(card.getBoundingClientRect().width);
        out.dialogs.textBoxWidth = tEl.clientWidth;
        out.dialogs.probeLines = Math.max(1, Math.round(tEl.getBoundingClientRect().height / lh));
        tEl.textContent = savedText;
      }
    }
    // ESC 关掉：事件打在当前焦点元素上（真实按键就是这条路径），
    // 弹窗在捕获阶段就能拦下，不会顺手把抽屉、菜单也一起关了
    const escTarget = document.activeElement || document.body;
    escTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(250);
    out.dialogs.closedByEsc = !!layer && layer.hidden;
    out.dialogs.rulesBefore = rulesBefore;
    out.dialogs.rulesAfter = document.querySelectorAll('#workspace [data-rule-id]').length;
    /* 这个弹窗的危险动作是「删接口」，所以两样都要数：ESC 关掉之后接口和规则都不许少一个。 */
    out.dialogs.apisBefore = apisBefore;
    out.dialogs.apisAfter = document.querySelectorAll('#apiList .api-item').length;
  }
  window.confirm = nativeConfirm;
  out.dialogs.nativeCalls = nativeCalls;
}

/* ---- 弹窗角色统一：同一个角色（品牌底板 / 标题 / 说明 / 主按钮 / 次按钮）在六个弹窗里
 *      必须拿到同一套位置、字号、字重、颜色。
 *      三个真实踩过的坑固化在这里（都是用户当面否掉过的版本）：
 *        ① 图标做过「贴死卡角的角贴」—— 不是用户要的；
 *        ② 改回「卡片左上角、标题上方」—— 也不是，用户要的是「标题左边」；
 *          现在：在头区里、标题左边、与标题同一行（断言 leftOfTitle && sameRow）。
 *        ③ .btn--danger 曾经只有 :hover、没有基础样式，「删除」渲染成普通灰按钮，
 *           跟「保存」长得一模一样；危险操作必须实心带色。
 *      另外弹窗按钮统一胶囊形、卡片顶部有强调色渐隐洗底，这两条也断在下面。 ---- */
out.modalRoles = {};
out.modalRoleIssues = [];
{
  /* 有选中接口才有工作区标题行，才有「删除」按钮 —— confirm 这个 case 靠它打开。
   * 前面 out.dialogs 段已经点过一张接口卡，但中途的折叠/隐藏操作可能把选中态弄没了，
   * 这里再稳一手（点不到就跳过，下面那条断言会如实报 missing）。 */
  const seedItem = document.querySelector('#apiList .api-item');
  if (seedItem) { seedItem.click(); await wait(200); }
  const hideAll = () => {
    document.querySelectorAll('.modal-layer').forEach((n) => { n.hidden = true; });
  };
  const styleOf = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight, color: s.color, bg: s.backgroundColor };
  };
  /* 按钮多带一个圆角（胶囊断言用）；单独一个函数，免得给 title / hint 也塞进 radius
   * 把 sameAs() 的比对对象搅浑。 */
  const btnStyleOf = (el) => {
    const s = styleOf(el);
    if (s) s.radius = el ? getComputedStyle(el).borderRadius : null;
    return s;
  };
  const cases = [
    ['confirm', '#confirmModal', () => { const b = document.querySelector('#btnDeleteApi'); if (b) b.click(); }],
    ['prompt', '#promptLayer', () => { const b = document.querySelector('#btnAddGroup'); if (b) b.click(); }],
    ['changelog', '#changelogModal', () => { const b = document.querySelector('#btnApiChangelog'); if (b) b.click(); }],
    ['host', '#hostModal', () => { const b = document.querySelector('#btnHost'); if (b) b.click(); }],
    ['contact', '#contactModal', () => { const b = document.querySelector('#btnContact'); if (b) b.click(); }],
    ['userMgmt', '#userMgmtModal', () => { const m = document.querySelector('#userMgmtModal'); if (m) m.hidden = false; }],
  ];
  for (const row of cases) {
    const name = row[0];
    hideAll();
    out.modalRoleIssues = out.modalRoleIssues || [];
    row[2]();
    await wait(260);
    /* 入场动画 modal-in 带 scale(0.985)：动画没跑完就量，44px 会量成 43px、
     * 460px 会量成 453px（截图脚本里就真撞到过）。260ms 的固定等待偶尔会撞上尾巴，
     * 所以显式等卡片上的动画结束，量出来的才是最终尺寸。 */
    await Promise.all(Array.from(document.querySelectorAll('.modal-card'))
      .flatMap((el) => el.getAnimations().map((a) => a.finished.catch(() => {}))));
    const layer = document.querySelector(row[1]);
    const card = layer && layer.querySelector('.modal-card');
    if (!layer || !card || layer.hidden) { out.modalRoles[name] = { missing: true }; continue; }
    const rect = card.getBoundingClientRect();
    const iconEl = card.querySelector('.modal-card__icon');
    const iconRect = iconEl ? iconEl.getBoundingClientRect() : null;
    const acts = card.querySelector('.modal-card__acts');
    const btns = acts ? Array.from(acts.querySelectorAll('.btn')) : [];
    const mainBtn = btns.filter((b) => b.classList.contains('btn--accent') || b.classList.contains('btn--danger'))[0] || null;
    const ghostBtn = btns.filter((b) => b.classList.contains('btn--ghost'))[0] || null;
    const kindOf = (b) => (b ? (b.classList.contains('btn--danger') ? 'danger' : 'accent') : null);
    out.modalRoles[name] = {
      title: styleOf(card.querySelector('.modal-card__title')),
      hint: styleOf(card.querySelector('.modal-card__hint:not([hidden])')),
      text: styleOf(card.querySelector('.modal-card__text:not([hidden])')),
      main: btnStyleOf(mainBtn),
      mainKind: kindOf(mainBtn),
      ghost: btnStyleOf(ghostBtn),
      cardBg: getComputedStyle(card).backgroundImage,
      corner: iconRect ? {
        dx: Math.round(iconRect.left - rect.left),
        dy: Math.round(iconRect.top - rect.top),
        // 尺寸用 offsetWidth（布局尺寸，不吃 transform），动画没等干净也不会少 1.5%
        size: iconEl.offsetWidth + 'px',
        // 图标必须在标题的**左边**（用户原话：「图标在 服务根地址 这五个字的左边」）
        leftOfTitle: (() => {
          const t = card.querySelector('.modal-card__title');
          return !!t && iconRect.right <= t.getBoundingClientRect().left + 1;
        })(),
        // 且必须与标题**同一行**（不是标题上方 —— 那是上一版，被否了）
        sameRow: (() => {
          const t = card.querySelector('.modal-card__title');
          if (!t) return false;
          const tr = t.getBoundingClientRect();
          return iconRect.top < tr.bottom && iconRect.bottom > tr.top;
        })(),
        // 四角同圆的方块；角贴（只圆右下、左上交给卡片裁）会在这里露馅
        radius: (() => {
          const s = getComputedStyle(iconEl);
          return s.borderTopLeftRadius + '/' + s.borderTopRightRadius + '/'
            + s.borderBottomRightRadius + '/' + s.borderBottomLeftRadius;
        })(),
      } : null,
      cardScrolls: card.scrollHeight > card.clientHeight + 1,
      hintPre: card.querySelector('.modal-card__hint:not([hidden])')
        ? getComputedStyle(card.querySelector('.modal-card__hint:not([hidden])')).whiteSpace : null,
    };
    // 输入弹窗挂着 await，必须点取消把 Promise 结掉，不然 addGroup 一直悬着
    if (name === 'prompt') {
      const cancel = document.querySelector('#promptCancel');
      if (cancel) cancel.click();
    }
    hideAll();
    await wait(150);
    hideAll();
  }
}

/* ---- 长内容时的滚动行为：滚动只能发生在主体区，卡片本身不能滚，
 *      否则贴角角的品牌标会跟着内容一起被卷走。 ---- */
out.modalScroll = null;
{
  const btn = document.querySelector('#btnApiChangelog');
  if (btn) {
    btn.click();
    await wait(420);
    const layer = document.querySelector('#changelogModal');
    const card = layer ? layer.querySelector('.modal-card') : null;
    const body = layer ? layer.querySelector('.modal-card__body') : null;
    const wrap = document.querySelector('#changelogBody');
    if (card && body && wrap) {
      // 只往 DOM 里塞假记录看滚动，不碰配置
      let html = '<ul class="changelog">';
      for (let i = 0; i < 60; i++) {
        html += '<li class="changelog__item"><div class="changelog__head">'
          + '<span class="changelog__time">2026-09-12 17:00:0' + (i % 10) + '</span></div>'
          + '<div class="changelog__detail">伪造记录 ' + i + '</div></li>';
      }
      wrap.innerHTML = html + '</ul>';
      await wait(160);
      body.scrollTop = body.scrollHeight;
      await wait(160);
      const rect = card.getBoundingClientRect();
      const iconEl = card.querySelector('.modal-card__icon');
      const iconRect = iconEl ? iconEl.getBoundingClientRect() : null;
      out.modalScroll = {
        bodyScrollable: body.scrollHeight > body.clientHeight + 1,
        bodyScrolled: body.scrollTop > 0,
        cardScrolled: card.scrollTop > 0,
        iconDx: iconRect ? Math.round(iconRect.left - rect.left) : null,
        iconDy: iconRect ? Math.round(iconRect.top - rect.top) : null,
      };
    }
    document.querySelectorAll('.modal-layer').forEach((n) => { n.hidden = true; });
    await wait(150);
  }
}

/* ---- 左侧接口列表：选中态必须有底色，分组内 / 未分组都要有（2026-09-12 用户报）----
 * 现象：未分组的接口（示例：条件响应）点上去底色会变；分组内的接口（示例：回显请求）
 *       点上去只有左边那根 2px 强调色竖线变色、底色一动不动，看着像没选中。
 * 根因：components.css 里给「分组内的 .api-item」垫底色的那条选择器裸写特异度是 (0,5,0)，
 *       而 .api-item.is-active / :hover / .is-selected 都只有 (0,2,0) —— 状态底色被按住。
 *       修法：整条包进 :where()，特异度归零。
 * 双保险：
 *   (a) 量真点击后的计算样式（用户眼睛看到的那一层）；
 *   (b) 扫 CSSOM：凡能命中该元素、又声明了 background 的规则取最高特异度，
 *       不许超过 .api-item.is-active 的水平 —— 否则 :hover / .is-selected 这些静态
 *       量不到的状态会用同样的手法再被按住一次。
 * 特异度是粗算（只数 id 与 类/属性/伪类，忽略元素选择器；:where(...) 整块按 0 算）；
 * 参与比较的规则全是类选择器，够用。 */
out.selHighlight = {};
out.cascade = {};
{
  const all = Array.prototype.slice.call(document.querySelectorAll('#apiList .api-item[data-api-id]'));
  const inGroup = (el) => !!el.closest('.group[data-group-id]:not([data-group-id="__ungrouped__"])');
  const groupedEl = all.filter(inGroup)[0] || null;
  const looseEl = all.filter((el) => !inGroup(el))[0] || null;
  // 列表每点一次就整块重建 innerHTML，点了之后旧引用脱离文档，得按 id 重新取
  const again = (el) => el
    ? document.querySelector('#apiList .api-item[data-api-id="' + el.getAttribute('data-api-id') + '"]')
    : null;
  const snap = (el) => {
    const node = again(el);
    if (!node) return null;
    const s = getComputedStyle(node);
    return { bg: s.backgroundColor, left: s.borderLeftColor, active: node.classList.contains('is-active') };
  };
  const pick = async (el) => { const node = again(el); if (node) { node.click(); await wait(420); } };

  out.selHighlight.groupedId = groupedEl ? groupedEl.getAttribute('data-api-id') : null;
  out.selHighlight.looseId = looseEl ? looseEl.getAttribute('data-api-id') : null;
  if (looseEl) {
    await pick(looseEl);
    out.selHighlight.looseActive = snap(looseEl);
    out.selHighlight.groupedIdle = snap(groupedEl);
  }
  if (groupedEl) {
    await pick(groupedEl);
    out.selHighlight.groupedActive = snap(groupedEl);
    out.selHighlight.looseIdle = snap(looseEl);
  }

  const specificity = (sel) => {
    const s = sel.replace(/:where\\((?:[^()]|\\([^()]*\\))*\\)/g, ' ');
    const ids = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
    const parts = (s.match(/\\.[A-Za-z0-9_-]+/g) || []).length
      + (s.match(/\\[[^\\]]*\\]/g) || []).length
      + (s.match(/:(?!:)[a-z-]+/g) || []).length;
    return ids * 10000 + parts * 100;
  };
  const setsBg = (decl) => {
    for (let i = 0; i < decl.length; i++) if (String(decl[i]).indexOf('background') === 0) return true;
    return false;
  };
  const maxBgSpec = (el) => {
    const node = again(el);
    if (!node) return null;
    let max = 0, who = '';
    for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
      let rules = [];
      try { rules = sheet.cssRules; } catch (e) { continue; }
      const walk = (list) => {
        for (const r of Array.prototype.slice.call(list)) {
          if (!r.selectorText && r.cssRules) { walk(r.cssRules); continue; }
          if (!r.selectorText || !r.style || !setsBg(r.style)) continue;
          // 静态下 :hover 之类不匹配，先把状态伪类摘掉，再问「这条规则会不会落到该元素上」
          const probe = r.selectorText.replace(/:(hover|focus|focus-visible|active|focus-within)\\b/g, '');
          let hit = false;
          try { hit = node.matches(probe); } catch (e) { hit = false; }
          if (!hit) continue;
          const sp = specificity(r.selectorText);
          if (sp > max) { max = sp; who = r.selectorText; }
        }
      };
      walk(rules);
    }
    return { max: max, who: who };
  };
  out.cascade.grouped = maxBgSpec(groupedEl);
  out.cascade.loose = maxBgSpec(looseEl);
  out.cascade.stateRef = specificity('.api-item.is-active');
}

/* ---- 抽屉底部主按钮文案要跟着「在编辑什么」走（2026-09-12 用户报）----
 * 抽屉是一个壳、多种用途：编规则 / 编接口 / 编兜底响应。文案原来写死在 index.html 里，
 * 于是「编辑接口」抽屉的标题是「编辑接口」、按钮却是「保存规则」。 */
out.drawerSave = {};
{
  const read = () => {
    const b = document.querySelector('#btnDrawerSave');
    return b ? { text: b.textContent.trim(), key: b.getAttribute('data-i18n') } : null;
  };
  const titleOf = () => {
    const el = document.querySelector('#drawerTitle');
    return el ? el.textContent.trim() : null;
  };
  const probe = async (sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return null;
    btn.click();
    await wait(320);
    const value = read();
    if (value) value.title = titleOf();
    const closeBtn = document.querySelector('#btnDrawerClose');
    if (closeBtn) closeBtn.click();
    await wait(280);
    return value;
  };
  out.drawerSave.api = await probe('#btnEditApi');
  out.drawerSave.newApi = await probe('#btnAddApi');
  out.drawerSave.rule = await probe('#btnAddRule');
  out.drawerSave.fallback = await probe('#btnEditDefault');
}

return out;
`;

async function main() {
  /* 起 Chrome、连页面目标、命令超时、页面报错采集，统一由 tools/lib/cdp.js 负责 */
  chrome = await cdp.launchChrome({ profilePrefix: 'mock-verify-' });
  PORT = chrome.port;
  page = await cdp.connect(PORT);

  console.log('目标：' + BASE);

  /* 自检必须只读。跑之前先记一份配置指纹，全部跑完再取一次比对；
   * 变更流水和 updatedAt/updatedBy 只要有人保存就会增长，单独看它们没有意义，先剔掉。 */
  const configFingerprint = async () => {
    try {
      const res = await fetch(BASE + '_admin/config');
      const body = await res.json();
      const copy = JSON.parse(JSON.stringify(body));
      delete copy.changelog;
      (copy.apis || []).forEach((api) => { delete api.updatedAt; delete api.updatedBy; });
      return JSON.stringify(copy);
    } catch (e) {
      return null;
    }
  };
  /* ---- A11 只读分享：用真实分享令牌走 ?share= 集成校验（创建后随即撤销，不污染配置指纹）---- */
  let a11Token = null;
  try {
    const mk = await fetch(BASE + '_admin/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const mkj = await mk.json();
    a11Token = mkj && mkj.item && mkj.item.token;
  } catch (e) { a11Token = null; }
  let a11 = { result: null, consoleErrors: [], thrown: null };
  if (a11Token) {
    a11 = await runAt(1440, 900, A11_CHECK, 'share=' + encodeURIComponent(a11Token));
    try { await fetch(BASE + '_admin/share?token=' + encodeURIComponent(a11Token), { method: 'DELETE' }); } catch (e) {}
  }
  const ar = a11.result || {};
  if (a11.thrown) check('A11 脚本执行', false, a11.thrown);
  else check('A11 控制台无报错', (a11.consoleErrors || []).length === 0, (a11.consoleErrors || []).join(' | '));
  check('A11 只读分享：?share= 访问时横幅可见且进入只读', !!ar.bannerVisible && !!ar.bodyReadonly, JSON.stringify(ar));
  check('A11 只读分享：编辑入口（＋接口 / 分享）被隐藏', !!ar.addBtnHidden && !!ar.shareBtnHidden, JSON.stringify(ar));
  check('A11 只读分享：顶栏显示「只读」标记', !!ar.chipVisible, JSON.stringify(ar));

  /* ---- A10 模板新建：普通视图下点「＋接口」弹出模板选择并预填 ---- */
  const a10run = await runAt(1440, 900, A10_CHECK);
  const a10 = a10run.result || {};
  if (a10run.thrown) check('A10 脚本执行', false, a10run.thrown);
  else check('A10 控制台无报错', (a10run.consoleErrors || []).length === 0, (a10run.consoleErrors || []).join(' | '));
  check('A10 模板新建：＋接口弹出模板选择（3 项）', !!a10.addBtnExists && !!a10.choiceOpened && a10.choiceCount === 3, JSON.stringify(a10));
  check('A10 模板新建：选「回显模板」打开抽屉并预填名称', !!a10.echoFound && !!a10.drawerOpen && a10.prefillName === '回显模板', JSON.stringify(a10));
  check('A10 模板新建：取消后抽屉关闭（不落盘）', !!a10.drawerClosed, JSON.stringify(a10));

  /* ---- A11 分享链接管理弹窗：生成→撤销（真实写/删 config.shareTokens，成对不污染指纹）---- */
  const smRun = await runAt(1440, 900, A11_SHARE_MODAL);
  const sm = smRun.result || {};
  if (smRun.thrown) check('A11 分享弹窗脚本执行', false, smRun.thrown);
  else check('A11 分享弹窗：控制台无报错', (smRun.consoleErrors || []).length === 0, (smRun.consoleErrors || []).join(' | '));
  check('A11 分享弹窗：点「分享」打开弹窗', !!sm.shareBtnExists && !!sm.modalOpen, JSON.stringify(sm));
  check('A11 分享弹窗：生成链接后列表出现带 URL 的行', !!sm.genBtnExists && !!sm.rowAdded && !!sm.urlShown, JSON.stringify(sm));
  check('A11 分享弹窗：撤销后该行被移除（真实 DELETE）', !!sm.revokeBtnExists && !!sm.revokeRemoved, JSON.stringify(sm));
  check('A11 分享弹窗：关闭后隐藏', !!sm.modalClosed, JSON.stringify(sm));

  /* ---- A12 试打结果故障标注：fault=malformed 时状态栏出警告、malformed 额外显示截断预览块 ---- */
  const fcRun = await runAt(1440, 900, FAULT_CHECK);
  const fc = fcRun.result || {};
  if (fcRun.thrown) check('A12 试打故障标注脚本执行', false, fcRun.thrown);
  else check('A12 控制台无报错', (fcRun.consoleErrors || []).length === 0, (fcRun.consoleErrors || []).join(' | '));
  check('A12 故障注入：试打结果状态栏出现「故障注入」警告标注', !!fc.warnTagShown, JSON.stringify(fc));
  check('A12 畸形响应体：试打结果显示截断预览块且可见', !!fc.previewVisible && !!fc.previewShowsTruncated, JSON.stringify(fc));
  check('A12 畸形预览块背景与正常响应体可区分', !!fc.previewBgDistinct, JSON.stringify({ preview: fc.previewExists, distinct: fc.previewBgDistinct }));

  /* ---- A13 搜索平铺结果：命中高亮不能破坏卡片 DOM ----
 * 复现场景（真实踩过）：搜索后左栏路径显示成 "/demomark>/sample"。
 * 根因是先做高亮、再对整串做 replace(/\\//g, '/<wbr>')，顺手把 </mark> 里那个 / 也换掉了，
 * 拼出 </<wbr>mark>；残缺的 "</" 被浏览器当注释吞掉，页面上就漏出一个光秃秃的 "mark>"，
 * 且 <mark> 永不闭合、后面的 "/sample" 被一起吞进高亮。
 * 这里断言：搜索态下每条卡片的路径文本必须与分组树态逐字一致，且页面不新增裸露的 "mark>"。 */
const SEARCH_CHECK = `
const out = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const search = async (q) => {
  const input = document.querySelector('#apiSearch');
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(450);   // 防抖 150ms + 渲染
};
// 分组树态先记一份「接口 id -> 路径文本」基准（折叠分组里的卡片也在 DOM 里，只是 display:none）
const treePaths = {};
document.querySelectorAll('#apiList .api-item').forEach((el) => {
  const pathEl = el.querySelector('.api-item__path');
  treePaths[el.getAttribute('data-api-id')] = pathEl ? pathEl.textContent : null;
});
out.treeCards = Object.keys(treePaths).length;
const leakCount = () => (document.body.textContent.match(/mark>/g) || []).length;
out.leakTree = leakCount();

await search('demo');
out.hitCount = document.querySelectorAll('#apiList .api-item').length;
out.markCount = document.querySelectorAll('#apiList .hit-mark').length;
out.cardsWithMark = Array.from(document.querySelectorAll('#apiList .api-item'))
  .filter((el) => el.querySelector('.hit-mark')).length;
out.leakSearch = leakCount();
// 逐条比对：搜索态路径文本不能变（变了就是拼出了非法 HTML）
out.mismatch = [];
document.querySelectorAll('#apiList .api-item').forEach((el) => {
  const id = el.getAttribute('data-api-id');
  const pathEl = el.querySelector('.api-item__path');
  const now = pathEl ? pathEl.textContent : null;
  if (treePaths[id] !== undefined && treePaths[id] !== now) {
    out.mismatch.push(id + ': ' + treePaths[id] + ' -> ' + now);
  }
});
out.samplePath = (document.querySelector('#apiList .api-item__path') || {}).textContent || null;

await search('');
out.afterClearCards = document.querySelectorAll('#apiList .api-item').length;
out.afterClearGroups = document.querySelectorAll('#apiList .group').length;
return out;
`;

  const sqRun = await runAt(1440, 900, SEARCH_CHECK);
  const sq = sqRun.result || {};
  if (sqRun.thrown) check('A13 搜索平铺结果脚本执行', false, sqRun.thrown);
  else check('A13 搜索态控制台无报错', (sqRun.consoleErrors || []).length === 0, (sqRun.consoleErrors || []).join(' | '));
  check('A13 搜索命中后平铺列出接口（不再是「只有分组标题在变」）',
    sq.hitCount > 0, '命中 ' + sq.hitCount + ' 条 / 树态 ' + sq.treeCards + ' 条');
  check('A13 搜索态路径文本与分组树态逐字一致（高亮没拼坏标签）',
    (sq.mismatch || []).length === 0 && sq.treeCards > 0,
    '不一致 ' + JSON.stringify(sq.mismatch) + ' 首条路径=' + JSON.stringify(sq.samplePath));
  check('A13 命中关键词被标出（<mark> 真的渲染成高亮，而不是漏成文本）',
    sq.cardsWithMark > 0 && sq.cardsWithMark <= sq.hitCount && sq.leakSearch === sq.leakTree,
    '带高亮卡片=' + sq.cardsWithMark + ' / 命中=' + sq.hitCount
      + ' / 裸露 mark> 树态=' + sq.leakTree + ' 搜索态=' + sq.leakSearch);
  check('A13 清空搜索词后还原分组树',
    sq.afterClearGroups >= 1 && sq.afterClearCards === sq.treeCards,
    '分组=' + sq.afterClearGroups + ' 卡片=' + sq.afterClearCards + '（树态 ' + sq.treeCards + '）');

/* ---- A14 批量选择模式 / 复制接口：本次改造的回归护栏 ----
 * 这一批全是「点了没反应 / 看着像坏了」类问题，只看源码看不出来（事件绑了、元素也在，
 * 但视觉与交互被别的东西压住），必须在真浏览器里量像素、点真事件。四个被复现过的真问题：
 *   ① 进批量模式时分组还是折叠的 → 组头没有任何勾选框，用户以为「勾选没生效」；
 *      想退出还得多点两次汉堡菜单，且退出后折叠结构被改乱（回不到原来的展开态）。
 *   ② 批量条与 .api-scroll **各带一份 -16px 负边距**（双层出血）→ 条比容器宽出 32px，
 *      左栏底部冒出横向滚动条，「取消」被推出可视区，要拖滚动条才够得到。
 *   ③ 分组整块 draggable，组头被拖拽光标占住 → 单击组头不折叠，只有最左边那个小箭头能点。
 *   ④ 单个接口压根没有「复制成一条新接口」的入口；中栏那个「复制」其实复制的是**调用地址**文本，
 *      用户按字面理解成「复制这个接口」，点了发现没多出一条接口，判定为 bug。
 * 另外：复制接口保持原路径 ⇒ 服务端 findApi() 先命中者胜，副本永远打不中，
 * 旧代码路径下用户实例里已经积了 7 条这样的「死副本」，所以副本必须打「不会命中」警示。
 *
 * 断言写法上踩过的三个坑（都已修，别再退回去）：
 *   a) 三态那块**不能取「第一个分组」**：示例数据里前两个分组各只有 1 条接口，
 *      `if (cards.length >= 2)` 整块被跳过 → 采集值全是 undefined，看着像功能坏了。
 *      改成取「卡片最多的那个分组」。
 *   b) 拖拽把手必须量**平时态**（非批量模式）：批量模式里卡片首位是勾选框、把手本就不渲染
 *      （见 apiItemHtml 的三元），在批量模式里量 `.api-item__drag` 恒为 0。
 *   c) 「勾选态 vs 当前接口」的左边竖线要拿**不同两张卡**比：点最后一张卡时它往往同时是
 *      `.is-selected` 和 `.is-active`，两张量到同一条规则，断言就变成自己跟自己比。
 *      改成取 `.api-item.is-selected:not(.is-active)`。 */
const BATCH_CHECK = `
const out = {};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => Array.from(document.querySelectorAll(s));
const txt = (el) => (el ? el.textContent.trim() : null);
const selNum = () => qa('#apiList .api-item.is-selected').length;
const collapsedNum = () => qa('#apiList .group.is-collapsed').length;
const byId = (id) => qa('#apiList .api-item').find((n) => n.getAttribute('data-api-id') === id) || null;

if (!q('#apiList')) { out.fatal = '没有 #apiList（可能停在登录层）'; return out; }

// 起始：先把分组全折起来，才看得出「进批量模式会自动展开」
if (collapsedNum() === 0) { q('#btnToggleAllGroups').click(); await tick(250); }
out.collapsedBefore = collapsedNum();
out.groupCount = qa('#apiList .group').length;

/* ---- ③（平时态）拖拽属性已从容器收窄到 ⋮⋮ 把手 ---- */
const idleCards = qa('#apiList .api-item');
out.idleCardCount = idleCards.length;
out.cardDraggableAttrIdle = idleCards.length ? idleCards[0].getAttribute('draggable') : 'noCard';
out.cardHandleDraggableIdle = qa('#apiList .api-item__drag[draggable="true"]').length;
out.groupSectionDraggableIdle = qa('#apiList .group[draggable="true"]').length;
out.groupHandleDraggableIdle = qa('#apiList .group__drag[draggable="true"]').length;

/* ---- ① 进批量模式：开关态 + ☰ 让位 + 自动全展开 + 组头勾选框 ----
 * 开关已从面板工具条搬到「全部接口」行，且由文字按钮改成图标 ——
 * 所以这里要量的是「位置 + 两个图标互斥 + 尺寸」这三件事，而不是文案。 */
const visOf = (el) => {
  if (!el) return null;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
};
const btnIconVisible = (which) => {
  const b = q('#btnSelect');
  return b ? visOf(b.querySelector('[data-icon="' + which + '"]')) : null;
};
/* 「全部接口」行放不放得下 —— 不能看 scrollWidth/clientWidth：
 * .total-group 是 overflow-y:hidden，水平溢出会被裁掉，scrollWidth 恒等于 clientWidth
 * （上一轮就是这么被骗过一次：量出来「没溢出」，实际末端按钮已经在可视区外）。
 * 换成两条硬信号：
 *   ① 标签里的文字有没有被 ellipsis 裁掉（.group__name 有 overflow:hidden + text-overflow:ellipsis，
 *      .pane__count 是 pill 也会被撑破）—— 真裁了就是放不下；
 *   ② 三个图标是不是都还顶着 28px（这一行现在有 ⇅ / ☰ / ☑ 三个，
 *      没给 flex:none 时英文长标签会把它们悄悄压成 26.6px）。 */
const rowFit = () => {
  const row = q('#totalGroup');
  if (!row) return null;
  const nameEl = row.querySelector('.group__name');
  const countEl = row.querySelector('.pane__count');
  const icons = qa('#totalGroup .btn--icon').filter((n) => visOf(n));
  return {
    nameClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
    countClipped: countEl ? countEl.scrollWidth > countEl.clientWidth + 1 : null,
    iconWs: icons.map((n) => Math.round(n.getBoundingClientRect().width)),
    iconHs: icons.map((n) => Math.round(n.getBoundingClientRect().height)),
  };
};

out.hasSelectBtn = !!q('#btnSelect');
out.selectBtnInTotalGroup = !!(q('#btnSelect') && q('#btnSelect').closest('#totalGroup'));
out.selectBtnOutOfPaneActs = !(q('#btnSelect') && q('#btnSelect').closest('.pane__acts'));
out.idleBtnIconSelect = btnIconVisible('select');    // 期望 true（平时是 ☑）
out.idleBtnIconExit = btnIconVisible('exit');        // 期望 false
out.idleBtnSize = (() => {
  const b = q('#btnSelect');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return Math.round(r.width) + 'x' + Math.round(r.height);
})();
out.idleBtnBorder = (() => { const b = q('#btnSelect'); return b ? getComputedStyle(b).borderTopWidth : null; })();
out.idleBtnAria = q('#btnSelect') ? q('#btnSelect').getAttribute('aria-pressed') : null;
out.idleTotalCheck = !!q('#totalGroup [data-total-check]');    // 期望 false（平时没有全选勾选框）
out.idleMenuBtn = !!q('#totalGroup [data-total-menu]');
out.idleToggleAllBtn = !!q('#totalGroup #btnToggleAllGroups');
out.idleRowFit = rowFit();
/* 「全局 ☰」与「分组 ☰」必须落在**同一列**。
 * 两处 ☰ 的右侧留白相同（.total-group 与 .group__head 都是 12px padding-right，
 * 且都留了等宽的滚动条槽），所以只要 ☰ 一直占着各自行的最右一格，就会叠成一条竖线。
 * ⚠️ 这是个**会被"往 ☰ 右边再塞一个按钮"静默破坏**的性质：塞一个 28px 按钮 + 6px gap，
 * 整列立刻错开 34px（实测的数，肉眼一眼就能看出，但代码里没有任何东西会报错）。
 * 在批量模式中量不到（☰ 那时不渲染），所以必须在 idle 态量。 */
out.menuAlign = (() => {
  const tot = q('#totalGroup [data-total-menu]');
  const grp = q('#apiList [data-group-menu]');
  if (!tot || !grp) return null;
  const a = tot.getBoundingClientRect();
  const b = grp.getBoundingClientRect();
  return {
    dLeft: Math.round(b.left - a.left),
    dRight: Math.round(b.right - a.right),
    totRight: Math.round(a.right), grpRight: Math.round(b.right),
  };
})();

/* ---- 图标簇内部间距：**图标彼此 2px**，行级 gap 仍是 6px ----
 * 用户要求「三颗图标靠近一点」。收的必须是**图标彼此**，不能把整行的 gap 一起改小：
 * 行 gap 一改，批量模式里「全选框 ↔ 全部接口」也会跟着从 6px 变 2px，
 * 而分组头的「全选框 ↔ 分组名」还是 6px —— 两处并排一眼就能看出不一致。
 * 所以这里同时断言「簇内 2px」与「行 gap 6px」两个数，缺一条都锁不住这个设计。 */
out.iconClusterGap = (() => {
  const acts = q('#totalGroup .total-group__acts');
  return acts ? getComputedStyle(acts).columnGap : null;
})();
out.rowGapPx = (() => { const r = q('#totalGroup'); return r ? getComputedStyle(r).columnGap : null; })();
out.idleIconGaps = (() => {
  const icons = qa('#totalGroup .btn--icon').filter((n) => visOf(n));
  const gaps = [];
  for (let i = 1; i < icons.length; i++) {
    gaps.push(Math.round(icons[i].getBoundingClientRect().left - icons[i - 1].getBoundingClientRect().right));
  }
  return gaps;
})();

/* ---- 计数 pill 永不与图标簇重叠（筛选态）----
 * 触发条件：**把一个分组筛上**。此时计数从「16」变成「1/16」，宽度翻两倍多，
 * 而 .total-group__label（这一行唯一 flex:1 的项，.group__spacer 是 display:none）
 * 已经被三颗 28px 图标 + 行 gap 吃掉一大截。
 * 老版本用的是完整句子「命中 1 / 共 16」：标签盒没有 overflow 约束，撑破后文字直接横穿到图标底下，
 * 实测重叠 25.6px，加 ☑ 开关之后 67.8px。现在 ① 计数改短形态 {n}/{m}；
 * ② .pane__count 加 ellipsis 兜底。两条一起断言——
 * 只测「没重叠」的话，把计数裁成一个空串也能过。 */
out.countTextIdle = (() => { const c = q('#totalGroup .pane__count'); return c ? c.textContent.trim() : null; })();
out.filteredPick = (() => {
  const chip = q('#filterGroupRow .filter-chip:not([data-filter-group=""])');
  if (chip) { chip.click(); return 'group'; }
  const st = q('[data-filter-status="disabled"]');
  if (st) { st.click(); return 'status'; }
  return null;
})();
await tick(380);
out.filteredCount = (() => {
  const count = q('#totalGroup .pane__count');
  const icons = qa('#totalGroup .btn--icon').filter((n) => visOf(n));
  if (!count || !icons.length) return null;
  return {
    text: count.textContent.trim(),
    // 计数右缘 → 第一颗图标左缘：负数就是已经横穿到图标底下
    clearance: Math.round(icons[0].getBoundingClientRect().left - count.getBoundingClientRect().right),
    clipped: count.scrollWidth > count.clientWidth + 1,
    title: count.getAttribute('title'),
  };
})();
// 还原成全量态 —— 忘了还原会把后面所有步骤都带进筛选里（那种「后面全挂」最难查）
if (out.filteredPick === 'group') {
  const back = q('#filterGroupRow .filter-chip[data-filter-group=""]');
  if (back) back.click();
} else if (out.filteredPick === 'status') {
  const back = q('[data-filter-status="all"]');
  if (back) back.click();
}
await tick(380);
out.countTextAfterUnfilter = (() => { const c = q('#totalGroup .pane__count'); return c ? c.textContent.trim() : null; })();

if (q('#btnSelect')) { q('#btnSelect').click(); await tick(320); }
out.selectBtnIsOn = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on'));
out.selectBtnAria = q('#btnSelect') ? q('#btnSelect').getAttribute('aria-pressed') : null;
out.modeBtnIconSelect = btnIconVisible('select');    // 期望 false（模式中是 ✕）
out.modeBtnIconExit = btnIconVisible('exit');        // 期望 true
out.modeMenuBtn = !!q('#totalGroup [data-total-menu]');        // 期望 false：☰ 让位
out.modeToggleAllBtn = !!q('#totalGroup #btnToggleAllGroups'); // 期望 true：⇅ 保留
out.modeTotalCheck = !!q('#totalGroup [data-total-check]');    // 期望 true
out.modeRowFit = rowFit();
// 全选勾选框必须与组头勾选框落进同一列（差 ≤1px），否则「一列到底的勾选框」就不成立
const totalBoxIn = q('#totalGroup [data-total-check] input');
const groupBoxIn = q('#apiList [data-group-check] input');
out.totalCheckAlignDx = (totalBoxIn && groupBoxIn)
  ? Math.abs(Math.round(totalBoxIn.getBoundingClientRect().left - groupBoxIn.getBoundingClientRect().left))
  : null;
out.totalRowPadLeft = (() => { const r = q('#totalGroup'); return r ? getComputedStyle(r).paddingLeft : null; })();

out.collapsedAfterEnter = collapsedNum();                 // 期望 0 —— 进模式即全展开
out.groupChecks = qa('#apiList [data-group-check]').length;
out.cardChecks = qa('#apiList [data-api-check]').length;

// 批量模式下容器同样不许可拖（把手此时不渲染，首位让给勾选框）
const inModeCards = qa('#apiList .api-item');
out.cardDraggableAttrInMode = inModeCards.length
  ? inModeCards[0].getAttribute('draggable') : 'noCard';
out.groupSectionDraggableInMode = qa('#apiList .group[draggable="true"]').length;

/* ---- ③ 组头恢复「单击折叠」：光标必须是 pointer 而不是拖拽光标 ---- */
const headEl = q('#apiList .group__head');
out.groupHeadCursor = headEl ? getComputedStyle(headEl).cursor : null;

// 组头勾选框与卡片勾选框得在同一列，否则视觉上「组头没有勾选」
const gcb = q('#apiList .group__check input');
const ccb = q('#apiList .api-item__check input');
out.checkAlignDx = (gcb && ccb)
  ? Math.round(Math.abs(gcb.getBoundingClientRect().left - ccb.getBoundingClientRect().left)) : null;

/* ---- C2：点卡片主体 = 勾选（整行可点），且不动「当前接口」。
 * 特意挑一张**不是当前接口**的卡：否则「勾选态 vs 当前接口」的左边竖线量到同一张，比不出东西。 ---- */
out.activeTitleBefore = txt(q('#workspace .apibox__title'));
const idlePick = idleCards.filter((n) => !n.classList.contains('is-active'))[0]
  || idleCards[idleCards.length - 1] || null;
out.pickedId = idlePick ? idlePick.getAttribute('data-api-id') : null;
out.pickedWasActive = idlePick ? idlePick.classList.contains('is-active') : null;
if (idlePick) { idlePick.click(); await tick(300); }
out.afterCardClickSelected = selNum();
out.activeTitleUnchangedBySelect = txt(q('#workspace .apibox__title')) === out.activeTitleBefore;
out.batchBarExists = !!q('#batchBar');

// 兜底：万一卡片主体没接上勾选（改前版本就是如此），退回点真勾选框把批量条逼出来，
// 否则下面「条宽 / 双层出血」这几条会因为「条压根不存在」而侥幸 FAIL，测不到真正的出血问题。
out.barFallbackUsed = false;
if (!q('#batchBar')) {
  const anyCheck = q('#apiList .api-item__check input');
  if (anyCheck) { anyCheck.click(); await tick(320); out.barFallbackUsed = true; }
}
out.batchBarRows = qa('#batchBar .batchbar__row').length;      // 期望 2
out.hasMoveBtn = !!q('#btnBatchMove');
out.enableBtnText = txt(q('#btnBatchEnable'));
out.clearBtnText = txt(q('#btnBatchClear'));

// 勾选态不借用「当前接口」那根左边竖线（两种状态各表各的，且必须是两张不同的卡）
const selIdleCard = q('#apiList .api-item.is-selected:not(.is-active)');
const actCard = q('#apiList .api-item.is-active');
out.selIdleCardFound = !!selIdleCard;
out.selectedBorderLeftWidth = selIdleCard ? getComputedStyle(selIdleCard).borderLeftWidth : null;
out.activeBorderLeftWidth = actCard ? getComputedStyle(actCard).borderLeftWidth : null;
out.selectedBg = selIdleCard ? getComputedStyle(selIdleCard).backgroundColor : null;

/* ---- ② 双层出血：左栏不得出横向滚动条；条不得超容器、也不得被吸顶裁掉 ---- */
const sc = q('#apiList .api-scroll');
out.scrollClient = sc ? sc.clientWidth : null;
out.scrollWidth = sc ? sc.scrollWidth : null;
out.noHScroll = sc ? (sc.scrollWidth <= sc.clientWidth + 1) : null;
const bar = q('#batchBar');
out.barWidth = bar ? Math.round(bar.getBoundingClientRect().width) : null;
out.scrollBoxWidth = sc ? Math.round(sc.getBoundingClientRect().width) : null;
out.barFits = (bar && sc) ? (bar.getBoundingClientRect().width <= sc.clientWidth + 1) : null;
out.barTopVsScrollTop = (bar && sc)
  ? Math.round(bar.getBoundingClientRect().top - sc.getBoundingClientRect().top) : null;

// ---- 再点同一张卡 = 取消勾选，批量条随之消失 ----
out.barExistedBeforeDeselect = !!q('#batchBar');
const picked2 = out.pickedId ? byId(out.pickedId) : null;
if (picked2) { picked2.click(); await tick(300); }
out.afterSecondClickSelected = selNum();      // 期望 0
out.batchBarGoneOnEmpty = !q('#batchBar');

/* ---- 组头三态：部分勾选 = indeterminate（DOM 属性，CSS 之外还得真设上）----
 * 取「卡片最多的那个分组」——示例数据里前两个分组各只有 1 条，取第一个会让整块被跳过。 */
const groupsNow = qa('#apiList .group');
const gBig = groupsNow.slice().sort((a, b) =>
  b.querySelectorAll('.api-item').length - a.querySelectorAll('.api-item').length)[0] || null;
const gBigId = gBig ? gBig.getAttribute('data-group-id') : null;
const gOf = () => qa('#apiList .group').find((n) => n.getAttribute('data-group-id') === gBigId) || null;
const gBigCards = gBig ? Array.from(gBig.querySelectorAll('.api-item')) : [];
out.triGroupId = gBigId;
out.triGroupCardCount = gBigCards.length;
out.halfIndeterminate = null;

if (gBigCards.length >= 2) {
  gBigCards[0].click();
  await tick(300);
  const box = gOf().querySelector('[data-group-check] input');
  out.halfIndeterminate = box ? box.indeterminate : null;      // 期望 true
  out.halfChecked = box ? box.checked : null;                  // 期望 false

  // 点组头勾选框 = 全选本组「当前可见」的成员；且不该顺带把分组折起来
  const collapsedBefore = gOf().classList.contains('is-collapsed');
  if (box) { box.click(); await tick(320); }
  const box2 = gOf().querySelector('[data-group-check] input');
  out.groupAllChecked = box2 ? box2.checked : null;            // 期望 true
  out.groupAllIndeterminate = box2 ? box2.indeterminate : null; // 期望 false
  out.groupSelectedCards = gOf().querySelectorAll('.api-item.is-selected').length;
  out.groupVisibleCards = gOf().querySelectorAll('.api-item').length;
  out.collapseUnchangedByCheckbox = (gOf().classList.contains('is-collapsed') === collapsedBefore);

  // 单击组头 = 折叠，再点 = 展开
  gOf().querySelector('.group__head').click();
  await tick(300);
  out.collapsedByHeadClick = gOf().classList.contains('is-collapsed');   // 期望 true
  gOf().querySelector('.group__head').click();
  await tick(300);
  out.expandedByHeadClick = !gOf().classList.contains('is-collapsed');   // 期望 true
}

/* ---- 「全部接口」行的全选勾选框：范围 = 当前可见的全部（与分组头同口径）+ 三态联动 ---- */
// 上一步把某个分组全勾了，先清空，量出来才是确定的
if (q('#btnBatchClear')) { q('#btnBatchClear').click(); await tick(320); }
const tBox = () => q('#totalGroup [data-total-check] input');
out.totalBoxBefore = tBox() ? { checked: tBox().checked, ind: tBox().indeterminate } : null;

if (tBox()) { tBox().click(); await tick(380); }
out.totalAllSelected = selNum();
out.totalAllVisible = qa('#apiList .api-item').length;
out.totalBoxAfterAll = tBox() ? { checked: tBox().checked, ind: tBox().indeterminate } : null;
out.totalBarVisible = !!q('#batchBar');

if (tBox()) { tBox().click(); await tick(380); }     // 再点一次 = 取消全选
out.totalClearedSelected = selNum();
out.totalBoxAfterClear = tBox() ? { checked: tBox().checked, ind: tBox().indeterminate } : null;
out.totalBarGoneAfterClear = !q('#batchBar');

// 只勾一张卡 → 全选必须进半选态（原生 indeterminate），否则「全选」成了个假的真值框
const oneCard = qa('#apiList .api-item')[0];
if (oneCard) { oneCard.click(); await tick(340); }
out.totalHalfAfterOne = tBox() ? { checked: tBox().checked, ind: tBox().indeterminate } : null;
if (oneCard) { oneCard.click(); await tick(340); }   // 还原成未勾选

/* ---- 退出：Esc 一次搞定；折叠结构还原成进模式前那份；勾选清空。 ---- */
out.selectModeBeforeEsc = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on'));
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await tick(340);
out.selectModeAfterEsc = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on')); // 期望 false
out.checksAfterExit = qa('#apiList [data-group-check]').length;   // 期望 0
out.collapsedAfterExit = collapsedNum();                          // 期望 == collapsedBefore
out.batchBarAfterExit = !!q('#batchBar');                         // 期望 false
out.totalCheckAfterExit = !!q('#totalGroup [data-total-check]');   // 期望 false
out.menuBtnBackAfterExit = !!q('#totalGroup [data-total-menu]');   // 期望 true（☰ 回来）

/* ---- 搜索平铺态也必须留下入口（本轮修的一个真问题）----
 * renderApiList 里原本写的是 q ? '' : …，有关键词时整排按钮被清空，
 * 于是「搜出来 → 挑几条 → 批量停用」这条路直接断掉（而平铺态本身是支持批量的，
 * searchResultHtml 里就在渲染批量条）。这条断言就是钉住那个条件判断别退回去。 */
const sbox = q('#apiSearch');
out.searchFlat = null;
out.searchBtnExists = null;
out.searchInMode = null;
if (sbox) {
  sbox.value = 'demo';
  sbox.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(950);
  out.searchFlat = !!q('#apiList .search-result');
  out.searchBtnExists = !!q('#btnSelect');
  out.searchBtnInRow = !!(q('#btnSelect') && q('#btnSelect').closest('#totalGroup'));
  out.searchMenuBtn = !!q('#totalGroup [data-total-menu]');       // 平铺态本来就没有 ☰
  out.searchRowFit = rowFit();

  const sb = q('#btnSelect');
  if (sb) { sb.click(); await tick(360); }
  out.searchInMode = !!(q('#btnSelect') && q('#btnSelect').classList.contains('is-on'));
  out.searchTotalCheck = !!q('#totalGroup [data-total-check]');
  const stb = q('#totalGroup [data-total-check] input');
  if (stb) { stb.click(); await tick(380); }
  out.searchAllSelected = selNum();
  out.searchVisible = qa('#apiList .api-item').length;

  if (q('#btnSelect')) { q('#btnSelect').click(); await tick(320); }    // 退出模式
  sbox.value = '';
  sbox.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(950);
  out.searchCleared = !q('#apiList .search-result');
}

/* ---- 平时态点一行 = 切换当前接口：**滚动位置必须守住** ----
 * 用户报的真问题：往下滚，点中间某个分组里的一条，列表直接跳回最上面。
 * 实测（1440×560，列表可滚 1933px）：在 967px 处点一条 → scrollTop 回到 0，
 * 被点的那张卡从视口里 top=303px 掉到 top=1270px，自己跑出可视区。
 * 根因：selectApi 走的是 renderAll，而 renderApiList 是 host.innerHTML = … 重建整个
 * .api-scroll，滚动位置**不在 state 里**，一重建就归零（勾选那条路当年补过，
 * 「切换当前接口」这条路因为换成了 renderAll 就绕过去了）。
 *
 * 两条判据一起才锁得住：
 *   ① 点击前后 scrollTop 相等；
 *   ② **被点卡片在视口里的纵向位置**也没动 —— 只测 ① 的话，
 *      用 scrollIntoView 把卡片居中同样能让 scrollTop 非 0，凑出个假通过。
 *
 * ⚠️ 量之前必须**先把分组全展开**：前面几步的折叠测试会把 3 个分组留在折叠态，
 *    1440×900 的栏里只剩几个组头，内容不满一屏 → 可滚上限 = 0 → 整条测例空转
 *    （第一版就是这样「PASS」的，实测值 reason=列表不够长，纯属侥幸通过）。 */
qa('#apiList .group.is-collapsed .group__head').forEach((h) => h.click());
await tick(300);
out.scrollKeepMax = (() => {
  const sc = q('#apiList .api-scroll');
  return sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null;
})();
out.scrollKeep = { skipped: true, reason: '列表不够长，滚不动（上限 ' + out.scrollKeepMax + 'px）' };
if (out.scrollKeepMax !== null && out.scrollKeepMax >= 80) {
  const sc1 = q('#apiList .api-scroll');
  sc1.scrollTop = Math.round(out.scrollKeepMax / 2);
  await tick(240);
  const beforeTop = Math.round(sc1.scrollTop);
  const band = sc1.getBoundingClientRect();
  // 挑一张「中心落在可视带里、且不是当前接口」的卡：点当前接口会被 selectApi 的早退挡掉，测不到东西
  const pickCard = qa('#apiList .api-item').find((c) => {
    const r = c.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return cy > band.top + 6 && cy < band.bottom - 6 && !c.classList.contains('is-active');
  });
  if (!pickCard) {
    out.scrollKeep = { skipped: true, reason: '可视带里挑不到非当前接口的卡' };
  } else {
    const pickId = pickCard.getAttribute('data-api-id');
    const pickTop = Math.round(pickCard.getBoundingClientRect().top);
    pickCard.click();
    await tick(560);
    const sc2 = q('#apiList .api-scroll');
    const card2 = sc2 ? sc2.querySelector('.api-item[data-api-id="' + pickId + '"]') : null;
    out.scrollKeep = {
      skipped: false,
      before: beforeTop,
      after: sc2 ? Math.round(sc2.scrollTop) : null,
      pickedId: pickId,
      pickedTopBefore: pickTop,
      pickedTopAfter: card2 ? Math.round(card2.getBoundingClientRect().top) : null,
      pickedIsActive: !!card2 && card2.classList.contains('is-active'),
    };
  }
}

/* ---- 只读分享态：开关必须跟着其它编辑入口一起消失（data-edit-only） ---- */
out.readonlyHidesBtn = (() => {
  const b = q('#btnSelect');
  if (!b) return null;
  document.body.classList.add('readonly');
  const hidden = getComputedStyle(b).display === 'none';
  document.body.classList.remove('readonly');
  return hidden;
})();
out.editableShowsBtn = (() => {
  const b = q('#btnSelect');
  return b ? getComputedStyle(b).display !== 'none' : null;
})();

/* ---- ④ 复制接口（2026-09-15 改造：从「点了就入库」改为「打开编辑抽屉、保存才落盘」） ----
 * 旧断言挂在旧行为上，两条都已失效，所以整段重写：
 *   - 「点一下列表 +1」   → 现在点一下**只打开抽屉**，列表必须一条都不多
 *   - 「副本必然有警示」   → 现在预填的是可用路径，副本**不该**有警示
 * 并补上本次改造的核心承诺：**取消抽屉 = 一条数据都不产生**。
 *
 * ⚠️ 断言必须盯「新复制出来的那张卡」，不能用"全列表遮蔽数 > 0" —— 用户实例本身
 *    就有 9 条遮蔽项，那种写法在本例数据下**恒真**（等于没测）。 */
const dupToggle = q('#btnSelect');
if (dupToggle && dupToggle.classList.contains('is-on')) { dupToggle.click(); await tick(300); }
out.dupInNormalMode = !!dupToggle && !dupToggle.classList.contains('is-on');

out.duplicateBtnText = txt(q('#btnDuplicateApi'));
out.copyUrlBtnText = txt(q('#btnCopyUrl'));    // 期望「复制地址」，与「复制接口」区分开
const namesBefore = qa('#apiList .api-item .api-item__name').map((n) => n.textContent.trim());
out.listCountBefore = namesBefore.length;
const dupSrcCard = q('#apiList .api-item.is-active');
out.dupSourceName = dupSrcCard ? txt(dupSrcCard.querySelector('.api-item__name')) : null;
out.dupSourcePath = dupSrcCard ? txt(dupSrcCard.querySelector('.api-item__path')) : null;

// ① 点「复制接口」：只打开抽屉，列表条数必须不变
if (q('#btnDuplicateApi')) { q('#btnDuplicateApi').click(); await tick(420); }
out.dupListUnchangedOnClick = qa('#apiList .api-item').length === out.listCountBefore;
out.dupDrawerOpen = !!(q('#drawer') && q('#drawer').classList.contains('is-open'));
out.dupDrawerTitle = txt(q('#drawerTitle'));
out.dupNamePrefill = q('#apiName') ? q('#apiName').value : null;
out.dupPathPrefill = q('#apiPath') ? q('#apiPath').value.trim() : null;
out.dupModulePrefill = q('#apiModule') ? q('#apiModule').value.trim() : null;
// 抽屉里 path 输入框装的是 **path 段**，卡片上显示的是 **模块/路径**（且带前导斜杠）——
// 直接比会**恒不相等**，那是个假 PASS 的洞：预填逻辑坏掉、返回原路径也照样"通过"。
// 所以先归一化再比，并且额外要求「前缀就是原件那段、后缀恰好是 -copy」。
//
// ⚠️ 两条硬约束（都在 2026-09-15 踩过，见 tools/check-injected.js）：
//   1. 归一化只用 split/filter/join，**不要用正则**。注入脚本整体包在模板字符串里，
//      正则是靠反斜杠转义斜杠的，而模板字符串这一层会把「反斜杠+斜杠」煮成单个斜杠
//      （只有「反斜杠+反引号 / 反斜杠+反斜杠 / 反斜杠+美元符 / n / r / t / u / x」才是转义语义），
//      到页面上就成了非法正则 → 整段 A14 断言 Uncaught 全崩。
//   2. 这段注释里**一个反引号都不能有**：模板字符串会被它提前闭合，整个文件直接不过解析器
//      （报 SyntaxError: Invalid or unexpected token）。**别用反引号去引用代码片段，写成文字。**
const segsOf = (s) => String(s || '').split('/').filter(Boolean);
const normPath = (s) => segsOf(s).join('/');
out.dupFullPathPrefill = [out.dupModulePrefill, out.dupPathPrefill].filter(Boolean).join('/');
out.dupPathChanged = !!out.dupFullPathPrefill
  && normPath(out.dupFullPathPrefill) !== normPath(out.dupSourcePath);
const dupSrcSeg = segsOf(out.dupSourcePath).pop() || '';
// 本实例的路径里没有任何 -copy 字样（16 条只有 demo/sample 与 demo/echo 两个名字），
// 所以「下一个可用值」是确定值：原件末段 + -copy（不会退化成 -copy-2）。
out.dupPathSuffixed = !!dupSrcSeg && out.dupPathPrefill === dupSrcSeg + '-copy';
out.dupNameSuffixed = !!out.dupNamePrefill && !!out.dupSourceName
  && out.dupNamePrefill !== out.dupSourceName && out.dupNamePrefill.indexOf(out.dupSourceName) === 0;
out.dupEnabledOn = !!q('#apiEnabled') && q('#apiEnabled').checked;
out.dupSaveBtnText = txt(q('#btnDrawerSave'));
out.dupSaveBtnWarned = !!q('#btnDrawerSave') && q('#btnDrawerSave').classList.contains('is-warn');
out.dupConflictHintVisible = !!q('#pathConflict') && getComputedStyle(q('#pathConflict')).display !== 'none';

// ② 取消抽屉：一条数据都不能产生（本次改造的核心承诺）
if (q('#btnDrawerCancel')) { q('#btnDrawerCancel').click(); await tick(420); }
out.listCountAfterCancel = qa('#apiList .api-item').length;
out.cancelLeftNoTrace = out.listCountAfterCancel === out.listCountBefore;
// ③ 再复制一次、这次保存：列表 +1、副本紧跟原件、落盘后它就是当前接口、且**没有遮蔽警示**
let namesAfter = [];
if (q('#btnDuplicateApi')) {
  q('#btnDuplicateApi').click();
  await tick(420);
  if (q('#btnDrawerSave')) { q('#btnDrawerSave').click(); await tick(1400); }
  namesAfter = qa('#apiList .api-item .api-item__name').map((n) => n.textContent.trim());
}
out.listCountAfter = namesAfter.length;
out.dupAddedOne = out.listCountAfter === out.listCountBefore + 1;
const dupIdx = out.dupNamePrefill ? namesAfter.findIndex((n) => n === out.dupNamePrefill) : -1;
out.dupName = dupIdx >= 0 ? namesAfter[dupIdx] : null;
out.dupPrevName = dupIdx > 0 ? namesAfter[dupIdx - 1] : null;
out.dupInsertedAfterOriginal = dupIdx > 0 && out.dupPrevName === out.dupSourceName;
const dupActiveCard = q('#apiList .api-item.is-active');
out.dupActiveIsNew = !!dupActiveCard && txt(dupActiveCard.querySelector('.api-item__name')) === out.dupNamePrefill;
out.dupNewCardWarned = !!(dupActiveCard && dupActiveCard.querySelector('.api-item__warn'));
// 信息性：全列表还有多少条遮蔽项（实例本身就有，所以只记录、不断言）
out.warnCount = qa('#apiList .api-item__warn').length;
out.warnText = txt(q('#apiList .api-item__warn .tag'));

/* ④ 冲突态：把路径改回当前接口自己的 path 段（必然被它占用）→ 按钮该改名、提示该出现；
 *    再关掉「启用」→ 提示必须立刻消失（停用项不参与匹配，"不会命中"是废话）。
 *    全程**不保存**，收尾用取消，并断言条数没变 —— 探针必须无副作用。 */
if (q('#btnDuplicateApi')) {
  q('#btnDuplicateApi').click();
  await tick(420);
  const activePathSeg = (txt(q('#apiList .api-item.is-active .api-item__path')) || '').split('/').pop();
  const pathInput = q('#apiPath');
  if (pathInput && activePathSeg) {
    pathInput.value = activePathSeg;
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(220);
  }
  out.dupConflictBtnText = txt(q('#btnDrawerSave'));
  out.dupConflictBtnWarned = !!q('#btnDrawerSave') && q('#btnDrawerSave').classList.contains('is-warn');
  out.dupConflictHintText = txt(q('#pathConflict'));
  out.dupConflictHintShown = !!q('#pathConflict') && getComputedStyle(q('#pathConflict')).display !== 'none';

  const enBox = q('#apiEnabled');
  if (enBox) {
    enBox.checked = false;
    enBox.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(220);
  }
  out.dupHintHiddenWhenDisabled = !!q('#pathConflict') && getComputedStyle(q('#pathConflict')).display === 'none';
  out.dupBtnTextWhenDisabled = txt(q('#btnDrawerSave'));

  if (q('#btnDrawerCancel')) { q('#btnDrawerCancel').click(); await tick(360); }
  out.conflictProbeNoSideEffect = qa('#apiList .api-item').length === out.listCountAfter;
}

/* ⑤ 提示条 + 一键停用：只验存在性与只读态隐藏，**不点击** ——
 *    点它会真的改掉页面内 state 的 enabled（连带 banner 消失），污染后面的断言。 */
out.shadowBannerText = txt(q('#shadowBanner .shadow-banner__text'));
out.shadowBannerHasBtn = !!q('#btnDisableShadowed');
out.shadowBtnHiddenInReadonly = (() => {
  const b = q('#btnDisableShadowed');
  if (!b) return null;
  document.body.classList.add('readonly');
  const hidden = getComputedStyle(b).display === 'none';
  document.body.classList.remove('readonly');
  return hidden;
})();

/* ---- 中英双语：新增文案不得漏出 key 本身 ---- */
const langBtn = q('#btnLang') || qa('[data-lang]')[0];
out.langBtnExists = !!langBtn;
out.enCopyUrlBtn = null;
out.enDuplicateBtn = null;
out.leakedKeys = null;
if (langBtn) {
  langBtn.click();
  await tick(480);
  out.enCopyUrlBtn = txt(q('#btnCopyUrl'));
  out.enDuplicateBtn = txt(q('#btnDuplicateApi'));
  out.enSelectTitle = q('#btnSelect') ? q('#btnSelect').title : null;
  out.enSelectIconSelect = btnIconVisible('select');
  out.enRowFit = rowFit();          // 英文标签更长，这一行的宽度余量最小，必须单独量
  const html = document.body.innerHTML;
  /* 抽查的 key 来自「本次改造新加 / 改名的文案」。两个约束：
   *   ① 只能挑**纯文本**的 key —— 挂在 data-i18n 属性上的 key（如 drawer.saveWillNotHit）
   *      会常驻 innerHTML，查它必然误报；
   *   ② 只挑此时真会渲染出来的 —— 提示条此刻应存在（实例自带 9 条遮蔽项）。 */
  out.leakedKeys = ['api.duplicateBtn', 'batch.move', 'group.selectTitle', 'api.shadowedBanner', 'api.shadowedDisableAll', 'total.selectTitle']
    .filter((k) => html.indexOf(k) >= 0);
  langBtn.click();
  await tick(320);
}
return out;
`;

  const btRun = await runAt(1440, 900, BATCH_CHECK);
  const bt = btRun.result || {};
  if (btRun.thrown) check('A14 批量模式脚本执行', false, btRun.thrown);
  else check('A14 批量模式态控制台无报错',
    (btRun.consoleErrors || []).length === 0, (btRun.consoleErrors || []).join(' | '));

  check('A14 批量选择开关挂在「全部接口」行内，且已从面板工具条搬走',
    !!bt.hasSelectBtn && bt.selectBtnInTotalGroup === true && bt.selectBtnOutOfPaneActs === true,
    JSON.stringify({ inRow: bt.selectBtnInTotalGroup, outOfPaneActs: bt.selectBtnOutOfPaneActs }));
  check('A14 平时态：开关是 28×28 带边框的图标（☑ 显 / ✕ 隐），右侧 ☰ 与 ⇅ 都在，且没有全选框',
    bt.idleBtnSize === '28x28' && bt.idleBtnBorder === '1px'
      && bt.idleBtnIconSelect === true && bt.idleBtnIconExit === false
      && bt.idleMenuBtn === true && bt.idleToggleAllBtn === true
      && bt.idleTotalCheck === false && bt.idleBtnAria === 'false',
    JSON.stringify({ size: bt.idleBtnSize, border: bt.idleBtnBorder, iconSel: bt.idleBtnIconSelect,
      iconExit: bt.idleBtnIconExit, menu: bt.idleMenuBtn, toggleAll: bt.idleToggleAllBtn,
      totalCheck: bt.idleTotalCheck, aria: bt.idleBtnAria }));
  check('A14 全局 ☰ 与分组 ☰ 同列（右缘对齐；往 ☰ 右边塞按钮会静默把整列推歪 34px）',
    !!bt.menuAlign && bt.menuAlign.dLeft === 0 && bt.menuAlign.dRight === 0,
    JSON.stringify(bt.menuAlign));
  check('A14 「全部接口」三颗图标收成一簇：图标彼此 2px，行 gap 仍是 6px（不能把全选框一起带小）',
    bt.iconClusterGap === '2px' && bt.rowGapPx === '6px'
      && bt.idleIconGaps.length >= 1 && bt.idleIconGaps.every((g) => g === 2),
    JSON.stringify({ clusterGap: bt.iconClusterGap, rowGap: bt.rowGapPx, gaps: bt.idleIconGaps }));
  check('A14 筛选态计数 pill 不与图标簇重叠（短形态 {n}/{m}；老版全称句实测横穿 25.6→67.8px）',
    !!bt.filteredCount && bt.filteredPick !== null
      && bt.filteredCount.clearance >= 2 && bt.filteredCount.clipped === false
      && bt.countTextAfterUnfilter === bt.countTextIdle,
    JSON.stringify({ pick: bt.filteredPick, idle: bt.countTextIdle, filtered: bt.filteredCount,
      afterUnfilter: bt.countTextAfterUnfilter }));
  check('A14 进入批量模式：开关原地变 ✕ 并置按下态，☰ 让位隐藏、⇅ 保留、全选框出现且与组头同列',
    bt.selectBtnIsOn === true && bt.selectBtnAria === 'true'
      && bt.modeBtnIconSelect === false && bt.modeBtnIconExit === true
      && bt.modeMenuBtn === false && bt.modeToggleAllBtn === true && bt.modeTotalCheck === true
      && bt.totalCheckAlignDx !== null && bt.totalCheckAlignDx <= 1
      && bt.totalRowPadLeft === '10px',
    JSON.stringify({ isOn: bt.selectBtnIsOn, aria: bt.selectBtnAria, iconSel: bt.modeBtnIconSelect,
      iconExit: bt.modeBtnIconExit, menu: bt.modeMenuBtn, toggleAll: bt.modeToggleAllBtn,
      totalCheck: bt.modeTotalCheck, alignDx: bt.totalCheckAlignDx, padLeft: bt.totalRowPadLeft }));
  check('A14 「全部接口」全选框：全选=当前可见全部，再点=清空，只勾一张=半选态（原生 indeterminate）',
    bt.totalBoxBefore && bt.totalBoxBefore.checked === false && bt.totalBoxBefore.ind === false
      && bt.totalAllSelected === bt.totalAllVisible && bt.totalAllVisible > 0
      && bt.totalBoxAfterAll && bt.totalBoxAfterAll.checked === true && bt.totalBoxAfterAll.ind === false
      && bt.totalBarVisible === true
      && bt.totalClearedSelected === 0 && bt.totalBarGoneAfterClear === true
      && bt.totalBoxAfterClear && bt.totalBoxAfterClear.checked === false
      && bt.totalHalfAfterOne && bt.totalHalfAfterOne.ind === true && bt.totalHalfAfterOne.checked === false,
    JSON.stringify({ before: bt.totalBoxBefore, allSel: bt.totalAllSelected + '/' + bt.totalAllVisible,
      afterAll: bt.totalBoxAfterAll, cleared: bt.totalClearedSelected,
      barGone: bt.totalBarGoneAfterClear, afterClear: bt.totalBoxAfterClear, half: bt.totalHalfAfterOne }));
  check('A14 退出批量模式后：全选框消失、☰ 回来、勾选清空、折叠结构还原',
    bt.totalCheckAfterExit === false && bt.menuBtnBackAfterExit === true
      && bt.checksAfterExit === 0 && bt.batchBarAfterExit === false
      && bt.collapsedAfterExit === bt.collapsedBefore,
    JSON.stringify({ totalCheck: bt.totalCheckAfterExit, menu: bt.menuBtnBackAfterExit,
      checks: bt.checksAfterExit, bar: bt.batchBarAfterExit,
      collapsed: bt.collapsedAfterExit + '/' + bt.collapsedBefore }));
  check('A14 搜索平铺态仍留有批量入口（`q ? \'\' : …` 那个清空动作不能连开关一起清掉）',
    bt.searchFlat === true && bt.searchBtnExists === true && bt.searchBtnInRow === true
      && bt.searchMenuBtn === false
      && bt.searchInMode === true && bt.searchTotalCheck === true
      && bt.searchAllSelected === bt.searchVisible && bt.searchVisible > 0
      && bt.searchCleared === true,
    JSON.stringify({ flat: bt.searchFlat, btn: bt.searchBtnExists, inRow: bt.searchBtnInRow,
      menu: bt.searchMenuBtn, inMode: bt.searchInMode, totalCheck: bt.searchTotalCheck,
      allSel: bt.searchAllSelected + '/' + bt.searchVisible, cleared: bt.searchCleared }));
  check('A14 只读分享态下开关随其它编辑入口一起消失（data-edit-only）',
    bt.readonlyHidesBtn === true && bt.editableShowsBtn === true,
    JSON.stringify({ hidden: bt.readonlyHidesBtn, shown: bt.editableShowsBtn }));
  check('A14 「全部接口」行宽度：三个图标中英都保住 28×28，标签文字零裁切（平时/模式/搜索/英文四种）',
    [bt.idleRowFit, bt.modeRowFit, bt.searchRowFit, bt.enRowFit].every((f) => f
      && f.nameClipped === false && f.countClipped === false
      && f.iconWs.length > 0 && f.iconWs.every((w) => w === 28)
      && f.iconHs.every((h) => h === 28)),
    JSON.stringify({ idle: bt.idleRowFit, mode: bt.modeRowFit, search: bt.searchRowFit, en: bt.enRowFit }));
  check('A14 开关的文案随语言切换（英文下仍是可读的 title，图标态不变）',
    typeof bt.enSelectTitle === 'string' && bt.enSelectTitle.length > 0
      && !/[一-龥]/.test(bt.enSelectTitle) && bt.enSelectIconSelect === true,
    JSON.stringify({ enTitle: bt.enSelectTitle, iconSel: bt.enSelectIconSelect }));
  check('A14 进入批量模式后分组自动全展开（否则组头勾选框根本看不见）',
    bt.collapsedBefore > 0 && bt.collapsedAfterEnter === 0,
    '进模式前折叠=' + bt.collapsedBefore + ' → 进模式后折叠=' + bt.collapsedAfterEnter
      + '（分组共 ' + bt.groupCount + '）');
  check('A14 组头渲染三态勾选框，且与卡片勾选框同列',
    bt.groupChecks > 0 && bt.cardChecks > 0 && bt.checkAlignDx !== null && bt.checkAlignDx <= 2,
    '组头框=' + bt.groupChecks + ' 卡片框=' + bt.cardChecks + ' 左边缘差=' + bt.checkAlignDx + 'px');
  check('A14 拖拽收窄到 ⋮⋮ 把手：卡片与分组整体都不再是可拖元素（平时态量）',
    bt.cardDraggableAttrIdle === null && bt.groupSectionDraggableIdle === 0
      && bt.cardHandleDraggableIdle > 0 && bt.groupHandleDraggableIdle > 0
      && bt.cardDraggableAttrInMode !== 'true' && bt.groupSectionDraggableInMode === 0,
    JSON.stringify({ 平时卡片attr: bt.cardDraggableAttrIdle, 平时卡片把手: bt.cardHandleDraggableIdle,
      平时分组块: bt.groupSectionDraggableIdle, 平时分组把手: bt.groupHandleDraggableIdle,
      批量态卡片attr: bt.cardDraggableAttrInMode, 批量态分组块: bt.groupSectionDraggableInMode }));
  check('A14 组头恢复「单击即折叠/展开」（光标不再是拖拽光标）',
    bt.groupHeadCursor === 'pointer' && bt.collapsedByHeadClick === true && bt.expandedByHeadClick === true,
    'cursor=' + bt.groupHeadCursor + ' 点击后折叠=' + bt.collapsedByHeadClick
      + ' 再点展开=' + bt.expandedByHeadClick
      + '（取样分组=' + bt.triGroupId + '，组内 ' + bt.triGroupCardCount + ' 条）');
  check('A14 点卡片主体整行即勾选，且不篡改「当前接口」',
    bt.afterCardClickSelected === 1 && bt.activeTitleUnchangedBySelect === true
      && bt.pickedWasActive === false && bt.barFallbackUsed === false,
    '勾选=' + bt.afterCardClickSelected + ' 当前接口未变=' + bt.activeTitleUnchangedBySelect
      + ' 取样卡本来是当前接口=' + bt.pickedWasActive + ' 用了勾选框兜底=' + bt.barFallbackUsed);
  check('A14 平时态点一行 = 切换当前接口，且左栏滚动位置守住（老版会跳回最上方）',
    !!bt.scrollKeep && (bt.scrollKeep.skipped === true
      || (bt.scrollKeep.before === bt.scrollKeep.after
        && bt.scrollKeep.before > 0
        && bt.scrollKeep.pickedIsActive === true
        && bt.scrollKeep.pickedTopBefore === bt.scrollKeep.pickedTopAfter)),
    JSON.stringify(bt.scrollKeep) + ' 可滚上限=' + bt.scrollKeepMax + 'px');
  check('A14 批量条改为两行：第一行计数 + 清空，第二行动作按钮（含移组）',
    bt.batchBarExists && bt.batchBarRows === 2 && bt.hasMoveBtn === true,
    '行数=' + bt.batchBarRows + ' 移组按钮=' + bt.hasMoveBtn
      + ' 启用=「' + bt.enableBtnText + '」 清空=「' + bt.clearBtnText + '」');
  check('A14 批量条不再出横向滚动条、不超容器、不被吸顶裁掉（双层出血回归）',
    bt.noHScroll === true && bt.barFits === true
      && typeof bt.barTopVsScrollTop === 'number' && bt.barTopVsScrollTop >= 0 && bt.barTopVsScrollTop <= 8,
    '滚动区 client/scroll = ' + bt.scrollClient + '/' + bt.scrollWidth + '，条宽=' + bt.barWidth
      + ' 容器宽=' + bt.scrollBoxWidth + ' 条顶距=' + bt.barTopVsScrollTop + 'px'
      + '（勾选框兜底=' + bt.barFallbackUsed + '）');
  check('A14 勾选态不再借用「当前接口」那根左边竖线（拿两张不同的卡比）',
    bt.selIdleCardFound === true
      && bt.selectedBorderLeftWidth === '2px' && bt.activeBorderLeftWidth === '3px',
    '勾选态左描边=' + bt.selectedBorderLeftWidth + ' / 当前接口左描边=' + bt.activeBorderLeftWidth
      + '（找到非当前接口的勾选卡=' + bt.selIdleCardFound + '）');
  check('A14 取消最后一条勾选后批量条自动消失',
    bt.barExistedBeforeDeselect === true
      && bt.afterSecondClickSelected === 0 && bt.batchBarGoneOnEmpty === true,
    '取消前有条=' + bt.barExistedBeforeDeselect + ' 剩余勾选=' + bt.afterSecondClickSelected
      + ' 条已消失=' + bt.batchBarGoneOnEmpty);
  check('A14 组头三态：部分勾选时置为 indeterminate，全选后归位',
    bt.halfIndeterminate === true && bt.halfChecked === false
      && bt.groupAllChecked === true && bt.groupAllIndeterminate === false,
    JSON.stringify({ 取样分组: bt.triGroupId, 组内条数: bt.triGroupCardCount,
      半选indeterminate: bt.halfIndeterminate, 半选checked: bt.halfChecked,
      全选checked: bt.groupAllChecked, 全选indeterminate: bt.groupAllIndeterminate }));
  check('A14 点组头勾选框全选本组可见成员，且不会顺带折叠分组',
    bt.groupVisibleCards > 0 && bt.groupSelectedCards === bt.groupVisibleCards
      && bt.collapseUnchangedByCheckbox === true,
    '本组卡片=' + bt.groupVisibleCards + ' 勾中=' + bt.groupSelectedCards
      + ' 折叠态未变=' + bt.collapseUnchangedByCheckbox);
  check('A14 退出批量模式：勾选框清掉、批量条消失、折叠结构还原成进模式前那份',
    bt.selectModeBeforeEsc === true && bt.selectModeAfterEsc === false
      && bt.checksAfterExit === 0 && bt.batchBarAfterExit === false
      && bt.collapsedAfterExit === bt.collapsedBefore,
    'Esc 前在模式=' + bt.selectModeBeforeEsc + ' → 后=' + bt.selectModeAfterEsc
      + '，残留勾选框=' + bt.checksAfterExit + ' 条=' + bt.batchBarAfterExit
      + ' 折叠还原 ' + bt.collapsedAfterExit + '/' + bt.collapsedBefore);
  check('A14 中栏按钮文案区分开：复制地址 ≠ 复制接口',
    /地址/.test(bt.copyUrlBtnText || '') && /接口/.test(bt.duplicateBtnText || '')
      && bt.copyUrlBtnText !== bt.duplicateBtnText,
    '「' + bt.copyUrlBtnText + '」/「' + bt.duplicateBtnText + '」');
  check('A14 复制接口：点一下只打开抽屉（列表一条都不多），抽屉标题是「复制接口」',
    bt.dupListUnchangedOnClick === true && bt.dupDrawerOpen === true
      && /复制|Duplicate|Copy/i.test(bt.dupDrawerTitle || ''),
    '点击后条数 ' + bt.listCountBefore + '（应不变）抽屉开=' + bt.dupDrawerOpen
      + ' 标题=「' + bt.dupDrawerTitle + '」');
  check('A14 复制预填：名称带后缀、路径换到下一个可用值、默认启用（"什么都不改直接保存"必然得到一条能命中的接口）',
    bt.dupNameSuffixed === true && bt.dupPathChanged === true && bt.dupPathSuffixed === true
      && bt.dupEnabledOn === true
      && bt.dupSaveBtnWarned === false && bt.dupConflictHintVisible === false,
    '名称「' + bt.dupNamePrefill + '」← 原件「' + bt.dupSourceName + '」；路径「'
      + bt.dupSourcePath + '」→「' + bt.dupFullPathPrefill + '」（path 段「' + bt.dupPathPrefill
      + '」= 原件末段 + -copy：' + bt.dupPathSuffixed + '）；启用=' + bt.dupEnabledOn
      + '；按钮已在警示态=' + bt.dupSaveBtnWarned + '（预填可用路径 ⇒ 应为 false）');
  check('A14 复制抽屉取消 = 零残留（本次改造的核心承诺：不点保存就一条数据都不产生）',
    bt.cancelLeftNoTrace === true,
    '取消前 ' + bt.listCountBefore + ' 条 → 取消后 ' + bt.listCountAfterCancel + ' 条');
  check('A14 复制保存：列表 +1、副本紧跟原件、保存后它就是「当前接口」，且副本自身无遮蔽警示',
    bt.dupAddedOne === true && bt.dupInsertedAfterOriginal === true
      && bt.dupActiveIsNew === true && bt.dupNewCardWarned === false,
    '条数 ' + bt.listCountBefore + ' → ' + bt.listCountAfter
      + '，副本「' + bt.dupName + '」紧随「' + bt.dupPrevName + '」'
      + '，副本成为当前接口=' + bt.dupActiveIsNew + '，副本带警示=' + bt.dupNewCardWarned);
  check('A14 路径撞车才改名/提示（条件触发，不是恒真）：撞车→按钮改「保存（不会命中）」+出提示；停用→提示立刻消失、按钮复原',
    bt.dupConflictBtnWarned === true && bt.dupConflictHintShown === true
      && /不会命中|never match|shadow/i.test(bt.dupConflictBtnText || '')
      && bt.dupHintHiddenWhenDisabled === true
      && bt.dupBtnTextWhenDisabled === bt.dupSaveBtnText,
    '撞车时按钮=「' + bt.dupConflictBtnText + '」提示=「' + bt.dupConflictHintText + '」；'
      + '停用后提示隐藏=' + bt.dupHintHiddenWhenDisabled
      + ' 按钮=「' + bt.dupBtnTextWhenDisabled + '」（正常态是「' + bt.dupSaveBtnText + '」）');
  check('A14 冲突探针无副作用（全程只改输入框，收尾走取消，条数不动）',
    bt.conflictProbeNoSideEffect === true,
    '探针前 ' + bt.listCountAfter + ' 条 → 探针后仍应 ' + bt.listCountAfter + ' 条');
  check('A14 「发现 N 条不会命中」提示条存在、带一键停用，且在只读分享态下隐藏（data-edit-only）',
    !!bt.shadowBannerText && bt.shadowBannerHasBtn === true && bt.shadowBtnHiddenInReadonly === true,
    '文案=「' + bt.shadowBannerText + '」有按钮=' + bt.shadowBannerHasBtn
      + ' 只读态隐藏=' + bt.shadowBtnHiddenInReadonly);
  check('A14 中英双语：新增文案在英文下不漏 key',
    bt.langBtnExists === true && !!bt.enDuplicateBtn && !!bt.enCopyUrlBtn
      && (bt.leakedKeys || []).length === 0,
    'en 复制接口=「' + bt.enDuplicateBtn + '」 en 复制地址=「' + bt.enCopyUrlBtn
      + '」 泄漏=' + JSON.stringify(bt.leakedKeys));

const configBefore = await configFingerprint();

  /* ---- 宽屏 1440 ---- */
  const wide = await runAt(1440, 900, WIDE_CHECK);
  if (wide.thrown) check('宽屏脚本执行', false, wide.thrown);
  const w = wide.result || {};

  check('控制台无报错（宽屏）', wide.consoleErrors.length === 0, wide.consoleErrors.join(' | '));
  check('左侧按分组渲染', (w.groups || []).length >= 1, JSON.stringify(w.groups));
  check('侧栏根地址条已从 DOM 移除，搜索工具条正常显示', !w.paneHostExists && w.toolbarTop > 0, `paneHost.exists=${w.paneHostExists} toolbar.top=${w.toolbarTop}`);
  check('全部展开/折叠按钮生效', !!(w.expandCollapseAll && w.expandCollapseAll.allCollapsed && w.expandCollapseAll.allExpanded), JSON.stringify(w.expandCollapseAll));
  check('试打回填判定链路', /跳过|命中/.test(w.trace || ''), w.trace);
  check('试打回填返回内容', /HTTP \d+/.test(w.response || ''), (w.response || '').slice(0, 60));
  check('试打不丢用户输入', w.typedKept, '重渲染后 #tryBody 里应还有 MARKER_XYZ');
  check('命中规则被高亮', w.ruleHighlighted);
  check('试打进入请求日志', w.logCount > 0 && w.logHasTestTag, '日志条数=' + w.logCount);
  check('默认深夜主题', w.themeDeep === 'deepnight', w.bgDeep);
  check('可切白天主题', w.themeLight === 'light', w.bgLight + ' 卡片 ' + w.lightCardBg);
  check('可切夜晚主题', w.themeNight === 'night' && w.bgNight !== w.bgDeep, w.bgNight);
  check('可切回深夜主题', w.themeBack === 'deepnight', w.bgBack);
  check('夜晚与深夜背景可区分', bgDistinct(w.bgNight, w.bgBack),
    '夜晚 ' + w.bgNight + ' / 深夜 ' + w.bgBack);
  check('中间栏够宽时试打面板双列', w.tryitColumns === 2,
    '中间栏 ' + w.paneWidth + 'px / ' + w.tryitColumns + ' 列');

  /* ---- 排版：字阶 / 字重 / 对比度（都取计算值，不看源码）---- */
  const t = w.type || {};
  const sizeOf = (key) => (t[key] ? t[key].size : null);
  check('总分组标题 = 14px + 700 字重（小节标题要立得住）',
    sizeOf('totalGroupTitle') === 14 && t.totalGroupTitle && t.totalGroupTitle.weight === '700',
    JSON.stringify(t.totalGroupTitle));
  check('接口路径 = 14px', sizeOf('apiPath') === 14, JSON.stringify(t.apiPath));
  check('规则名 ≥ 14px', sizeOf('ruleName') >= 14, JSON.stringify(t.ruleName));
  check('抽屉标题 ≥ 20px（展示层）', sizeOf('drawerTitle') >= 20, JSON.stringify(t.drawerTitle));
  check('全页最小字号 ≥ 12px（没有"凑近才能读"的小字）',
    !!w.minFont && w.minFont.size >= 12,
    w.minFont ? '最小 ' + w.minFont.size + 'px @ ' + w.minFont.where : '未取到');
  check('深夜 最弱文字对比度 ≥ 4.5:1（最坏底 surface-3）',
    !!w.deepContrast && w.deepContrast.faint >= 4.5, JSON.stringify(w.deepContrast));
  check('夜晚 最弱文字对比度 ≥ 4.5:1（最坏底 surface-3）',
    !!w.nightContrast && w.nightContrast.faint >= 4.5, JSON.stringify(w.nightContrast));
  check('浅色 最弱文字对比度 ≥ 4.5:1（最坏底 surface-3）',
    !!w.lightContrast && w.lightContrast.faint >= 4.5, JSON.stringify(w.lightContrast));
  check('顶栏根地址按钮存在，点击打开居中弹窗并回填 URL',
    w.hostBtnExists && w.hostModalOpen && /^https?:\/\/.+/.test(w.hostModalValue || ''),
    `btn=${w.hostBtnExists} modalOpen=${w.hostModalOpen} value=${w.hostModalValue || '(空)'}`);
  check('根地址弹窗可一键复制并提示 toast',
    w.hostCopyToastShown, 'toast 有增加=' + w.hostCopyToastShown);
  check('根地址弹窗关闭后隐藏',
    w.hostModalClosed, 'modal.hidden=' + w.hostModalClosed);

  check('顶栏联系方式按钮存在，点击打开居中弹窗并回填邮箱',
    w.contactBtnExists && w.contactModalOpen && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(w.contactModalValue || ''),
    `btn=${w.contactBtnExists} modalOpen=${w.contactModalOpen} value=${w.contactModalValue || '(空)'}`);
  check('联系方式弹窗可一键复制并提示 toast',
    w.contactCopyToastShown, 'toast 有增加=' + w.contactCopyToastShown);
  check('联系方式弹窗关闭后隐藏',
    w.contactModalClosed, 'modal.hidden=' + w.contactModalClosed);

  check('接口停用后右侧详情状态同步变更为"已停用"',
    !!w.apiToggleSync && w.apiToggleSync.tested && w.apiToggleSync.hasWarnTag,
    JSON.stringify(w.apiToggleSync));

  /* ---- v18：顶栏品牌区竖线移除 + 语言切换 + GitHub 占位 ---- */
  check('顶栏品牌区竖线已移除（.brand 无右边框）',
    w.brandBorderRight === '0px' || w.brandBorderRight === 'none',
    'border-right-width=' + w.brandBorderRight);
  check('默认语言为中文（zh-CN）', w.langBefore === 'zh-CN', 'lang=' + w.langBefore);
  check('点击语言按钮切到英文（en）',
    w.langAfterEn === 'en', 'lang=' + w.langAfterEn + ' storage=' + w.langStorageEn);
  check('语言切换持久化到 localStorage',
    w.langStorageEn === 'en', w.langStorageEn);
  check('静态文案随语言切换为英文',
    !!w.statRulesEnText && w.statRulesEnText !== w.statRulesZh,
    'zh=' + w.statRulesZh + ' en=' + w.statRulesEnText);
  check('再点语言按钮切回中文（zh-CN）',
    w.langAfterBack === 'zh-CN', 'lang=' + w.langAfterBack);
  /* GitHub 按钮：配了 meta.repoUrl 就打开它（不弹 toast）；没配才弹「待配置」提示且不跳转。
   * 地址来自 config.json，所以两种结果都算通过，但必须**恰是其中一种**。 */
  const ghOpened = (w.githubOpened || [])[0] || null;
  const ghOk = ghOpened
    ? /^https?:\/\//i.test(ghOpened) && w.githubToasts === 0
    : w.githubToasts > 0;
  check('GitHub 按钮：配了仓库地址就打开、没配才提示（二者必居其一）',
    ghOk, '打开=' + (ghOpened || '未打开') + ' toast=' + w.githubToasts);

  /* ---- 语言切换要覆盖 JS 动态生成的内容（抽屉里的选项/芯片/占位符）---- */
  check('切语言后规则抽屉的运算符与取值位置跟着变（无中文残留）',
    !!w.i18nOpText && !w.i18nCondHasCJK,
    'op=' + w.i18nOpText + ' source=' + w.i18nSourceText + ' pathPh=' + w.i18nPathPh);
  check('切语言后通用变量芯片无中文残留（本接口变量的数据除外）',
    (w.i18nGenericChipCJK || []).length === 0,
    '残留=' + JSON.stringify(w.i18nGenericChipCJK));
  check('切语言后新规则的默认名与占位符跟着变（不再硬编码「新规则」）',
    !!w.i18nRuleName && !/[一-龥]/.test(w.i18nRuleName) && !/[一-龥]/.test(w.i18nRuleNamePh || ''),
    'name=' + w.i18nRuleName + ' placeholder=' + w.i18nRuleNamePh);
  check('粘贴 cURL 弹窗：多行模式只有一个可见输入框（没有多出来的空框）',
    Array.isArray(w.pasteVisibleControls) && w.pasteVisibleControls.length === 1,
    JSON.stringify(w.pasteVisibleControls));
  check('粘贴 cURL 弹窗：说明区给出可照抄的示例（多行渲染，curl + 名称:值 列表）',
    w.pasteHintHasExample === true && w.pasteHintLines >= 4 && w.pasteHintWhiteSpace === 'pre-line',
    '行数=' + w.pasteHintLines + ' white-space=' + w.pasteHintWhiteSpace + ' 示例=' + w.pasteHintHasExample);
  check('粘贴 cURL 弹窗：输入框占位符保持单行（多行会被 Chrome 折叠成一长条）',
    w.pastePhMultiline === false, '占位符含换行=' + w.pastePhMultiline);
  check('单行弹窗用完恢复（粘贴弹窗关闭后输入框重新可见）',
    w.inputRestored === true, '可见=' + w.inputRestored);

  /* ---- v20：用户报的 4 件事固化成断言（2026-09-13）---- */
  check('提示条挂在页面上半部（不再贴底被内容压住）',
    w.toastHostPosition === 'fixed' && typeof w.toastHostTop === 'number'
      && w.toastHostTop > 0 && w.toastHostTop < w.viewportH / 4,
    'position=' + w.toastHostPosition + ' top=' + w.toastHostTop + ' 视口高=' + w.viewportH);
  check('粘贴 cURL 弹窗：多行模式加宽到 ≥ 640px（说明区示例一行放得下，不被折行截断）',
    typeof w.pasteCardWidth === 'number' && w.pasteCardWidth >= 640,
    '卡片宽=' + w.pasteCardWidth + 'px 说明区宽=' + w.pasteHintWidth + 'px');
  check('粘贴 cURL 弹窗：占位符本身就是一条具体示例（含 curl，可直接照抄）',
    w.pastePhHasExample === true, '占位符=' + w.pastePhText);
  check('抽屉标题跟着语言走（开着抽屉切语言也不停在旧语言）',
    !!w.i18nDrawerTitle && !/[一-龥]/.test(w.i18nDrawerTitle) && !!w.i18nDrawerTitleAttr,
    '标题=' + w.i18nDrawerTitle + ' data-i18n=' + w.i18nDrawerTitleAttr);
  check('左栏吸顶条上方不漏内容（::before 补齐滚动容器上内边距）',
    w.stickyCoverHeight === w.panePaddingTop && w.stickyCoverContent !== 'none'
      && !!w.stickyCoverHeight && parseFloat(w.stickyCoverHeight) > 0,
    '::before 高=' + w.stickyCoverHeight + ' 上内边距=' + w.panePaddingTop + ' top=' + w.stickyTop);

  /* ---- 侧栏折叠：展开按钮不能被头部内边距挤出 32px 窄轨（2026-09-13 用户报「右边栏收缩有点叠在一起」）---- */
  const collapseRight = w.collapse && w.collapse.right;
  const collapseLeft = w.collapse && w.collapse.left;
  check('右栏折叠：展开按钮完整落在 32px 窄轨内（不被头部内边距挤出去）',
    !!collapseRight && collapseRight.paneW === 32 && collapseRight.outside === false
      && collapseRight.insetLeft >= 0 && collapseRight.insetRight >= 0,
    collapseRight
      ? '轨道=' + collapseRight.paneW + 'px 按钮=' + collapseRight.btnW + 'px 内缩 左'
        + collapseRight.insetLeft + '/右' + collapseRight.insetRight
        + ' 头部内边距 左' + collapseRight.headPaddingLeft + '/右' + collapseRight.headPaddingRight
      : '未采集到');
  check('右栏折叠：展开按钮不再压住中栏「+ 新增规则」',
    !!collapseRight && typeof collapseRight.gapToAddRule === 'number' && collapseRight.gapToAddRule >= 8,
    collapseRight ? '与新增规则间距=' + collapseRight.gapToAddRule + 'px' : '未采集到');
  check('左栏折叠：展开按钮同样落在窄轨内',
    !!collapseLeft && collapseLeft.paneW === 32 && collapseLeft.outside === false,
    collapseLeft
      ? '轨道=' + collapseLeft.paneW + 'px 内缩 左' + collapseLeft.insetLeft + '/右' + collapseLeft.insetRight
      : '未采集到');

  /* ---- 窄屏：模拟开了 DevTools ---- */
  for (const width of [1350, 1250, 1100]) {
    const narrow = await runAt(width, 800, NARROW_CHECK);
    if (narrow.thrown) check('窄屏脚本执行 @' + width, false, narrow.thrown);
    const n = narrow.result || {};
    const blocked = (n.probes || []).filter((probe) => !probe.clickable || !probe.focusable);
    check('@' + width + ' 输入区不被遮挡', blocked.length === 0,
      blocked.map((probe) => probe.sel + ' 被 ' + probe.coveredBy + ' 盖住').join('；') || 'layout高度 ' + n.layoutHeight);
    check('@' + width + ' 能真的输入', n.typed);
    check('@' + width + ' 控制台无报错', narrow.consoleErrors.length === 0, narrow.consoleErrors.join(' | '));
  }

  /* ---- 回归专项 ---- */
  const fixRun = await runAt(1440, 900, FIX_CHECK);
  if (fixRun.thrown) check('回归专项脚本执行', false, fixRun.thrown);
  check('回归专项：控制台无报错', fixRun.consoleErrors.length === 0, fixRun.consoleErrors.join(' | '));
  const f = fixRun.result || {};
  check('日志点规则：跨接口也能跳到对应接口并高亮该规则',
    !!(f.jump && (f.jump.crossApiWorked || f.jump.skipped)), JSON.stringify(f.jump));
  check('日志「只看当前接口」随切换接口联动',
    !!(f.logOnly && (f.logOnly.works || f.logOnly.skipped)), JSON.stringify(f.logOnly));
  check('响应体可用变量面板：8 个通用变量 + 分组 + 点击插入',
    !!(f.vars && f.vars.chipCount >= 8 && f.vars.insertOk && f.vars.twoOk),
    JSON.stringify(f.vars && { chips: f.vars.chipCount, groups: f.vars.groups, tip: f.vars.tip, inserted: f.vars.inserted }));
  check('响应体变量面板：本接口变量名列为可点芯片，点它插入 {{vars.名字}}',
    !!(f.vars && (f.vars.apiChipOk || f.vars.apiChip === undefined)),
    JSON.stringify({ chip: f.vars && f.vars.apiChip, ok: f.vars && f.vars.apiChipOk }));
  check('响应体变量面板：芯片上同时显示变量的当前值（写规则时不用再猜它是什么数据）',
    !!(f.vars && (f.vars.apiChipValueOk || f.vars.apiChip === undefined)),
    JSON.stringify({ chip: f.vars && f.vars.apiChip, value: f.vars && f.vars.apiChipValue }));
  check('响应体变量面板：本接口无变量时给说明，不会静默消失',
    !!(f.vars && f.vars.apiGroupNeverSilent),
    JSON.stringify({ hasChip: !!(f.vars && f.vars.apiChip), note: f.vars && f.vars.apiEmptyNote }));
  check('弹窗统一：全部弹窗共用同一套骨架（图标 + 标题头区），旧 .prompt-* 已并入',
    !!(f.dialogs && f.dialogs.cardCount >= 6 && f.dialogs.headCount === f.dialogs.cardCount
      && f.dialogs.iconCount === f.dialogs.cardCount && f.dialogs.legacyCount === 0),
    JSON.stringify(f.dialogs && { layers: f.dialogs.layerCount, cards: f.dialogs.cardCount, heads: f.dialogs.headCount, icons: f.dialogs.iconCount, legacy: f.dialogs.legacyCount }));
  check('删除确认改用站内弹窗（原生 confirm 不再被调用）',
    !!(f.dialogs && f.dialogs.open && f.dialogs.nativeCalls === 0),
    JSON.stringify({ delBtn: f.dialogs && f.dialogs.delBtnFound, open: f.dialogs && f.dialogs.open, native: f.dialogs && f.dialogs.nativeCalls, title: f.dialogs && f.dialogs.title, ok: f.dialogs && f.dialogs.okText }));
  check('确认弹窗居中、带品牌图标与危险色（中心偏差 ≤ 2px）',
    !!(f.dialogs && f.dialogs.offsetX <= 2 && f.dialogs.offsetY <= 2
      && f.dialogs.dangerStyle && f.dialogs.iconInConfirm),
    JSON.stringify({ dx: f.dialogs && f.dialogs.offsetX, dy: f.dialogs && f.dialogs.offsetY, danger: f.dialogs && f.dialogs.dangerStyle, icon: f.dialogs && f.dialogs.iconInConfirm }));
  /* 危险动作是删接口：ESC 关掉之后接口数、规则数都不许少。 */
  check('确认弹窗 ESC 可关闭，且不会误删接口/规则',
    !!(f.dialogs && f.dialogs.closedByEsc
      && f.dialogs.apisBefore === f.dialogs.apisAfter
      && f.dialogs.rulesBefore === f.dialogs.rulesAfter),
    JSON.stringify({ closed: f.dialogs && f.dialogs.closedByEsc, apis: (f.dialogs && f.dialogs.apisBefore) + '→' + (f.dialogs && f.dialogs.apisAfter), rules: (f.dialogs && f.dialogs.rulesBefore) + '→' + (f.dialogs && f.dialogs.rulesAfter) }));
  /* 改前是 360px（与输入框弹窗共用 --narrow），正文可用宽 312px，放不下 20 个 16px 全角字。 */
  check('确认弹窗够宽：20 个全角字的删除文案一行放下（不跟输入框弹窗共用 360px 窄档）',
    !!(f.dialogs && f.dialogs.cardWidth >= 480 && f.dialogs.probeLines === 1),
    JSON.stringify({ cardW: f.dialogs && f.dialogs.cardWidth, textW: f.dialogs && f.dialogs.textBoxWidth, probeLines: f.dialogs && f.dialogs.probeLines }));

  /* ---- 左侧接口列表选中态：分组内也必须变底色（2026-09-12 用户报）---- */
  const SH = f.selHighlight || {};
  const CAS = f.cascade || {};
  if (!SH.looseId || !SH.groupedId) {
    check('接口选中态：未分组 / 分组内各有一个接口可测', false,
      JSON.stringify({ looseId: SH.looseId, groupedId: SH.groupedId, hint: '需要至少一个分组内接口 + 一个未分组接口' }));
  } else {
    check('接口选中态：分组内的接口点上去底色也要变（不是只有左边那根竖线）',
      !!(SH.groupedActive && SH.groupedIdle && SH.groupedActive.bg !== SH.groupedIdle.bg),
      JSON.stringify({ active: SH.groupedActive && SH.groupedActive.bg, idle: SH.groupedIdle && SH.groupedIdle.bg, id: SH.groupedId }));
    check('接口选中态：分组内与未分组的选中底色一致（不再一个有一个没有）',
      !!(SH.groupedActive && SH.looseActive && SH.groupedActive.bg === SH.looseActive.bg
        && SH.groupedActive.left === SH.looseActive.left),
      JSON.stringify({ grouped: SH.groupedActive, loose: SH.looseActive }));
    check('接口选中态：未选中时分组内与未分组的底色一致',
      !!(SH.groupedIdle && SH.looseIdle && SH.groupedIdle.bg === SH.looseIdle.bg),
      JSON.stringify({ grouped: SH.groupedIdle && SH.groupedIdle.bg, loose: SH.looseIdle && SH.looseIdle.bg }));
    check('接口选中态：没有任何更高特异度的规则压住状态底色（hover / 勾选同样安全）',
      !!(CAS.grouped && CAS.loose && CAS.grouped.max <= CAS.stateRef && CAS.loose.max <= CAS.stateRef
        && CAS.grouped.max === CAS.loose.max),
      JSON.stringify({ grouped: CAS.grouped, loose: CAS.loose, stateRef: CAS.stateRef }));
  }

  /* ---- 抽屉底部主按钮：文案跟着抽屉用途走（2026-09-12 用户报）---- */
  const DS = f.drawerSave || {};
  check('抽屉主按钮：编辑接口时显示「保存接口」，不再写死「保存规则」',
    !!(DS.api && /接口/.test(DS.api.text) && DS.api.key === 'drawer.saveApi'),
    JSON.stringify(DS.api));
  check('抽屉主按钮：新增接口同样显示「保存接口」',
    !!(DS.newApi && /接口/.test(DS.newApi.text) && DS.newApi.key === 'drawer.saveApi'),
    JSON.stringify(DS.newApi));
  check('抽屉主按钮：编规则仍是「保存规则」、编兜底响应是「保存兜底响应」',
    !!(DS.rule && /规则/.test(DS.rule.text) && DS.rule.key === 'drawer.saveRule'
      && DS.fallback && /兜底/.test(DS.fallback.text) && DS.fallback.key === 'drawer.saveDefault'),
    JSON.stringify({ rule: DS.rule, fallback: DS.fallback }));

  /* ---- 弹窗角色统一（六个弹窗逐个量像素与计算样式） ---- */
  const R = f.modalRoles || {};
  const roles = Object.keys(R).filter((k) => R[k] && !R[k].missing);
  const sameAs = (key) => {
    const vals = roles.map((k) => R[k][key]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return false;
    const ref = JSON.stringify(vals[0]);
    return vals.every((v) => JSON.stringify(v) === ref);
  };
  const solidBg = (s) => !!s && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.bg);
  check('弹窗骨架：六个弹窗都能量到角标 / 标题 / 按钮区',
    roles.length === 6,
    JSON.stringify(Object.keys(R).map((k) => k + ':' + ((R[k] && R[k].missing) ? '缺失' : 'ok'))));
  /* 品牌底板的位置与形状（2026-09-12 用户第三次纠正后定稿，别再来回改）：
   *   ① 在头区里、标题的**左边**，与标题**同一行** —— 既不是「标题上方」，也不是「贴死卡角的角贴」；
   *   ② 与卡片左边缘的距离六处一致（卡片 1px 边框 + 24px 内边距 = 25）；
   *   ③ 是**四角同圆**的 44px 方块。
   * 前两版分别做成了「贴角角贴」和「标题上方的方块」，都被用户当面否掉。 */
  check('弹窗品牌底板在标题左边、与标题同一行（不是标题上方，也不是贴卡角）',
    roles.length > 0 && roles.every((k) => R[k].corner
      && R[k].corner.leftOfTitle && R[k].corner.sameRow
      && R[k].corner.dx >= 20 && R[k].corner.dx <= 30),
    JSON.stringify(roles.map((k) => k + ':' + JSON.stringify(R[k].corner))));
  check('弹窗品牌底板是四角同圆的 44px 方块（不是贴角被裁的角贴）',
    roles.length > 0 && roles.every((k) => R[k].corner && R[k].corner.size === '44px'
      && (function () { const r = R[k].corner.radius.split('/'); return r[0] === r[1] && r[1] === r[2] && r[2] === r[3]; })()),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].corner ? R[k].corner.size + ' 圆角 ' + R[k].corner.radius : '无'))));
  check('弹窗按钮一律胶囊形（主 / 次按钮圆角都是 999px）',
    roles.length === 6 && roles.every((k) => (R[k].main === null || R[k].main.radius === '999px')
      && (R[k].ghost === null || R[k].ghost.radius === '999px')),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].main ? R[k].main.radius : '无主') + '/' + (R[k].ghost ? R[k].ghost.radius : '无次'))));
  check('弹窗卡片顶部有渐隐洗底（六处都有 linear-gradient，危险弹窗换成危险色）',
    roles.length === 6 && roles.every((k) => !!R[k].cardBg && R[k].cardBg.indexOf('linear-gradient') >= 0),
    JSON.stringify(roles.map((k) => k + ':' + String(R[k].cardBg).slice(0, 34))));
  check('弹窗标题排版六处一致（字号 / 字重 / 颜色）',
    roles.length === 6 && sameAs('title'),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].title && R[k].title.size + '/' + R[k].title.weight + '/' + R[k].title.color))));
  check('弹窗说明文字排版一致（字号 / 字重 / 颜色）',
    roles.length === 6 && sameAs('hint'),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].hint ? R[k].hint.size + '/' + R[k].hint.color : '无说明'))));
  check('弹窗主按钮一律实心带底色（危险动作实心红，普通动作实心琥珀）',
    roles.length === 6 && roles.every((k) => R[k].main === null || (solidBg(R[k].main) && R[k].main.weight === '600')),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].main ? R[k].mainKind + ' ' + R[k].main.bg + ' w' + R[k].main.weight : '无主按钮'))));
  check('弹窗次按钮（取消 / 关闭）一律透明底',
    roles.length === 6 && roles.every((k) => R[k].ghost === null || !solidBg(R[k].ghost)),
    JSON.stringify(roles.map((k) => k + ':' + (R[k].ghost ? R[k].ghost.bg : '无次按钮'))));
  check('确认弹窗主体句用正文排版（16px、主文字色、pre-line 断行）',
    !!(R.confirm && R.confirm.text && R.confirm.text.size === '16px'
      && JSON.stringify(R.confirm.text.color) === JSON.stringify((R.host || {}).title ? R.host.title.color : R.confirm.text.color)),
    JSON.stringify(R.confirm && R.confirm.text));
  check('长内容只滚主体区，卡片本身不滚（品牌底板不会被卷走）',
    !!(f.modalScroll && f.modalScroll.bodyScrollable && f.modalScroll.bodyScrolled
      && !f.modalScroll.cardScrolled
      && f.modalScroll.iconDx >= 20 && f.modalScroll.iconDx <= 30
      && f.modalScroll.iconDy > 0),
    JSON.stringify(f.modalScroll));
  check('接口变量：编辑接口时出现「接口变量」区，可增行可删行',
    !!(f.apiVars && f.apiVars.hasAddBtn && f.apiVars.addWorks && f.apiVars.cleanupOk),
    JSON.stringify(f.apiVars));
  check('接口变量：已配置的变量名被列出（省得照响应体猜大小写）',
    !!(f.apiVars && (f.apiVars.skipped || (f.apiVars.rowCount >= 1 && f.apiVars.keys.every((k) => !!k)))),
    JSON.stringify(f.apiVars && f.apiVars.keys));

  /* ---- 只读性：自检不许改目标实例的配置 ---- */
  const configAfter = await configFingerprint();
  check('自检只读：跑前跑后目标实例配置指纹一致',
    !configBefore || configBefore === configAfter,
    configBefore
      ? (configBefore === configAfter ? '一致' : '⚠️ 配置被自检改动了')
      : '（配置接口不可读，跳过）');

  /* ---- 汇总 ---- */
  console.log('');
  let failed = 0;
  results.forEach((row) => {
    if (!row.ok) failed++;
    // 通过时也打印实测值：光看到 PASS 不足以判断"是否真的达标"
    console.log((row.ok ? '  PASS  ' : '  FAIL  ') + row.name + (row.detail ? '   → ' + row.detail : ''));
  });
  console.log('');
  console.log(failed === 0 ? '全部通过（' + results.length + ' 项）' : failed + ' / ' + results.length + ' 项失败');

  if (page) await page.close();
  if (chrome) await chrome.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('自检执行失败：' + err.message);
  if (page) await page.close();
  if (chrome) await chrome.close();
  process.exit(2);
});
