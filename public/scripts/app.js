/* ============================================================================
 * app.js —— 渲染总入口、全局事件绑定、批量选择模式、启动
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

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
  // 带上当前界面语言：帮助页虽然也能从 localStorage 读到，但显式传参在
  // 「localStorage 不可用（隐私模式）」时同样正确，且意图一目了然。
  const btnHelp = $('#btnHelp');
  if (btnHelp) btnHelp.addEventListener('click', () => {
    const lang = (typeof I18N !== 'undefined' && I18N.getLang() === 'en') ? 'en' : 'zh';
    window.open('help.html?lang=' + lang, '_blank');
  });
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
  connectLogStream();
}

boot();
