/* ============================================================================
 * auth.js —— 登录态、只读分享模式、分享链接与用户菜单
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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

/** 退出登录：清 token、重置登录态、回登录层。
 * 先发 DELETE /session 让服务端令牌失效（配合服务端登出），再清本地态；网络失败也不阻塞。 */
function logout() {
  closeLogStream();
  const token = state.auth.token;
  if (token) {
    fetch('/_admin/session', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  }
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
