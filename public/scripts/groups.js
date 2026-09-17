/* ============================================================================
 * groups.js —— 通用弹窗（输入 / 确认 / 选择）与分组维护
 *
 * 按功能拆分（本项目无模块化、无构建，纯原生 JS）。
 * 这些脚本共享同一个全局作用域：顶层 function / const / let 跨文件互相可见，
 * 可用性靠 index.html 的加载顺序保证 —— **顺序不能随意调整**。
 * 例：state 初始化时就要用到 readLocal，所以 readLocal 必须和 state 在同一个文件里
 * （原先是同一个 script，函数声明会被整体提升，拆开后这个前提就没了）。
 * ========================================================================== */

'use strict';

/* ------------------------------ 分组维护 ------------------------------ */

/* 全站弹窗共用一个品牌标记：只在这里定义一份 SVG，由 applyModalIcons() 填进所有 [data-modal-icon]
 * 占位，免得六个弹窗各抄一遍同样的路径。颜色用 currentColor，跟着主题的 accent 走。 */
const MODAL_MARK_SVG = ''
  + '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true" focusable="false">'
  + '<path d="M9 22V10l7 7 7-7v12" fill="none" stroke="currentColor" stroke-width="3.2"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

function applyModalIcons() {
  document.querySelectorAll('[data-modal-icon]').forEach((node) => {
    if (!node.querySelector('svg')) node.innerHTML = MODAL_MARK_SVG;
  });
}

/* 居中输入弹窗，替代浏览器原生 prompt()（原生弹窗默认在屏幕上方，且样式不可控） */
function askText(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = $('#promptLayer');
    const form = $('#promptForm');
    const titleEl = $('#promptTitle');
    const hintEl = $('#promptHint');
    const inputEl = $('#promptInput');
    const errEl = $('#promptError');
    if (!layer || !form) { resolve(null); return; }
    /* 多行模式：cURL 命令是多行的，单行 input 会把换行吃掉（粘贴进来只剩最后一段）。
     * 这里临时换成一个 textarea，关闭时移除 —— 不去改 index.html 的公共骨架。 */
    let area = null;
    let inputWrap = null;
    if (o.multiline) {
      area = document.createElement('textarea');
      area.className = 'textarea mono';
      area.spellcheck = false;
      area.rows = 6;
      area.style.width = '100%';
      area.value = o.value || '';
      /* 单行 input 所在的 .field 必须一起藏：`hidden` 属性只有 UA 的 `[hidden]{display:none}` 兜着，
       * 被作者样式里的 display 一比就输 —— 结果是多行模式下输入框仍在，下面多一个空框。
       * 内联 display:none 才压得住；textarea 插到 .field 的**外层**，别插进去（插进去会一起被藏掉）。 */
      inputWrap = inputEl.parentNode;
      inputEl.hidden = true;
      if (inputWrap) {
        inputWrap.style.display = 'none';
        inputWrap.parentNode.insertBefore(area, inputWrap.nextSibling);
      } else {
        inputEl.insertAdjacentElement('afterend', area);
      }
    }
    titleEl.textContent = o.title || t('prompt.title');
    hintEl.textContent = o.hint || '';
    hintEl.hidden = !o.hint;
    if (!o.multiline) inputEl.value = o.value || '';
    inputEl.placeholder = o.placeholder || o.hint || '';
    $('#promptOk').textContent = o.confirmText || t('prompt.ok');
    /* multiline 模式：加宽弹窗、换剪贴板图标、给 textarea 加占位 */
    const card = form;
    card.classList.toggle('is-multiline', !!o.multiline);
    card.classList.toggle('modal-card--wide', !!o.wide);
    if (o.multiline && area) {
      area.placeholder = o.placeholder || t('try.pastePh');
      const iconEl = card.querySelector('[data-modal-icon]');
      if (iconEl) iconEl.innerHTML = MODAL_MARK_SVG;
    }
    errEl.textContent = '';
    layer.hidden = false;
    setTimeout(() => (area || inputEl).focus(), 0);
    const onSubmit = (event) => { event.preventDefault(); close(true); };
    const onCancel = () => close(false);
    // 点遮罩 / 按 ESC 都算取消。必须走 close() 收尾：直接 hidden 掉的话 await 会永远挂着
    const onBackdrop = (event) => { if (event.target === layer) close(false); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();   // 捕获阶段拦下，别让全局 ESC 顺手把抽屉、菜单也一起关了
      close(false);
    };
    const close = (ok) => {
      const value = (area || inputEl).value.trim();
      layer.hidden = true;
      if (area) {
        area.remove();
        inputEl.hidden = false;
        if (inputWrap) inputWrap.style.display = '';
      }
      form.classList.remove('is-multiline');
      /* 恢复品牌图标（弹窗复用，下次可能不是 multiline） */
      const iconEl = form.querySelector('[data-modal-icon]');
      if (iconEl && !iconEl.querySelector('svg') || (iconEl && iconEl.innerHTML !== MODAL_MARK_SVG)) {
        iconEl.innerHTML = MODAL_MARK_SVG;
      }
      form.removeEventListener('submit', onSubmit);
      $('#promptCancel').removeEventListener('click', onCancel);
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(ok ? value : null);
    };
    form.addEventListener('submit', onSubmit);
    $('#promptCancel').addEventListener('click', onCancel);
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/* 居中确认弹窗，替代浏览器原生 confirm()。
 * 原生 confirm 固定挂在窗口顶部、字体配色全由浏览器决定，跟站内其他弹窗完全是两个长相；
 * 这里复用同一套弹窗骨架，危险操作再配上危险色的图标底板和主按钮。 */
function askConfirm(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = $('#confirmModal');
    const card = $('#confirmCard');
    const okBtn = $('#confirmOk');
    const cancelBtn = $('#confirmCancel');
    const titleEl = $('#confirmTitle');
    const textEl = $('#confirmText');
    // 弹窗结构缺失时退回原生 confirm：宁可丑，也不能把删除类操作卡死
    if (!layer || !card || !okBtn || !cancelBtn) { resolve(window.confirm(o.message || '')); return; }
    const danger = o.danger !== false;
    titleEl.textContent = o.title || t('confirm.title');
    textEl.textContent = o.message || '';
    textEl.hidden = !o.message;
    okBtn.textContent = o.okText || t('prompt.ok');
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--accent');
    card.classList.toggle('is-danger', danger);
    layer.hidden = false;
    setTimeout(() => okBtn.focus(), 0);
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (event) => { if (event.target === layer) close(false); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(false);
    };
    const close = (ok) => {
      layer.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(!!ok);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * 单选弹窗：给「导入冲突怎么处理」这类必须在几个方案里挑一个的场景用。
 * 结构与静态弹窗完全一致（.modal-layer > .modal-card，头区带品牌角标），
 * 只是选项数量不定，所以动态创建。返回所选 value；取消 / ESC / 点遮罩返回 null。
 */
function askChoice(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'modal-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML = ''
      + '<div class="modal-card__head">'
      + '  <span class="modal-card__icon" data-modal-icon aria-hidden="true"></span>'
      + '  <div class="modal-card__heading">'
      + '    <h2 class="modal-card__title"></h2>'
      + '    <p class="modal-card__hint"></p>'
      + '  </div>'
      + '</div>'
      + '<div class="modal-card__body"><div class="choice-list"></div></div>'
      + '<div class="modal-card__acts"><button class="btn btn--ghost" type="button" data-choice-cancel></button></div>';

    card.querySelector('.modal-card__title').textContent = o.title || t('choice.title');
    const hintEl = card.querySelector('.modal-card__hint');
    hintEl.textContent = o.message || '';
    hintEl.hidden = !o.message;
    card.querySelector('[data-choice-cancel]').textContent = o.cancelText || t('prompt.cancel');

    const list = card.querySelector('.choice-list');
    (o.options || []).forEach((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice' + (option.danger ? ' is-danger' : '');
      btn.setAttribute('data-choice-value', option.value);
      // 文案一律用 textContent：选项里可能带用户数据（接口名之类），不能拼 innerHTML
      const name = document.createElement('span');
      name.className = 'choice__name';
      name.textContent = option.label;
      btn.appendChild(name);
      if (option.desc) {
        const desc = document.createElement('span');
        desc.className = 'choice__desc';
        desc.textContent = option.desc;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => close(option.value));
      list.appendChild(btn);
    });

    layer.appendChild(card);
    document.body.appendChild(layer);
    applyModalIcons();

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      layer.remove();
      layer.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onBackdrop = (event) => { if (event.target === layer) close(null); };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();   // 别让全局 ESC 顺手把抽屉、菜单一起关了
      close(null);
    };
    layer.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    card.querySelector('[data-choice-cancel]').addEventListener('click', () => close(null));
    setTimeout(() => {
      const first = list.querySelector('.choice');
      if (first) first.focus();
    }, 0);
  });
}

async function addGroup() {
  const name = (await askText({ title: t('group.newTitle'), hint: t('group.newHint'), value: '', confirmText: t('group.confirm'), wide: true }) || '').trim();
  if (!name) return;
  const groups = state.config.groups || (state.config.groups = []);
  if (groups.some((group) => group.name === name)) {
    toast(t('group.dupe'), 'bad');
    return;
  }
  groups.push({ id: 'g' + Date.now().toString(36), name: name });
  await persist(t('group.created'));
  renderAll();
}

async function renameGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const name = (await askText({ title: t('group.renameTitle'), hint: '', value: group.name, confirmText: t('group.renameConfirm') }) || '').trim();
  if (!name || name === group.name) return;
  group.name = name;
  await persist(t('group.renamed'));
  renderApiList();
}

/* 复制分组：新分组（名字由用户确认）+ 组内每个接口深拷贝一份、归入新分组。
 *
 * 定位是「整套场景副本」（见 docs/接口复制改造设计.md §4 决策 9）：组内接口的路径
 * **原样保留**。这套用法的前提是"调用方代码不改、只换挡板返回的数据"—— 路径一改，
 * 前端就得跟着改，那就不叫换一套数据了。代价是副本组整组都会被标成「被「XX」遮蔽」，
 * 这是**符合预期的**：它本来就是备用的那一套。
 * 切换方式：把原件组批量停用，副本组自动接管（副本组本来就启用着），不需要分组级开关。
 *
 * 加一次改名前确认：分组复制一次产生 **N 条**持久数据，比单个接口复制后果更大，
 * 而原来点一下就直接生成「XX（副本）」—— 与"点一下就产生数据"的抱怨是同一件事。 */
async function copyGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const groups = state.config.groups || (state.config.groups = []);
  const name = (await askText({
    title: t('group.copyTitle'),
    hint: t('group.copyHint'),
    value: group.name + t('group.copySuffix'),
    confirmText: t('group.copyConfirm'),
  }) || '').trim();
  if (!name) return;
  // 重名直接拒绝（与 addGroup 同一个约定）：分组在别处是按名字映射的（resolveGroupId）
  if (groups.some((row) => row.name === name)) { toast(t('group.dupe'), 'bad'); return; }

  const newId = 'g' + Date.now().toString(36);
  groups.push({ id: newId, name: name });
  const src = state.config.apis.filter((api) => api.groupId === groupId);
  src.forEach((api) => {
    const copy = JSON.parse(JSON.stringify(api));
    copy.id = 'api-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    copy.groupId = newId;
    copy.name = (copy.name || '') + t('group.copySuffix');
    state.config.apis.push(copy);
  });
  shadowCache = null;
  // 原来这里是硬编码中文（'分组已复制（N 个接口）'），英文界面下会漏出中文 —— 一并收进 i18n
  await persist(t('group.copied', { n: src.length }));
  renderAll();
}

/* 复制单个接口 —— **打开编辑抽屉，不再直接落盘**。
 *
 * 这是相对前序版本最大的行为改动（前序设计稿 §4.1 的 duplicateApi 规格已被推翻，
 * 背景与实测证据见 docs/接口复制改造设计.md）。原来是"深拷贝 → 直接入库 → 落盘"，
 * 三个问题叠在一起：
 *   ① 点了就产生持久化数据，没有确认与修改的机会（用户的原始抱怨）；
 *   ② 副本保持原路径 ⇒ 排在原件后面 ⇒ **每次复制都必然打出「不会命中」** ——
 *      功能自己否定自己的结果；
 *   ③ 落盘后不切 activeApiId，中栏纹丝不动 + 唯一的反馈是否定性的 ⇒ 用户以为失败 ⇒
 *      **再点一次** ⇒ n 份。实测用户实例里正是这个循环留下的 14 条副本，且内容指纹
 *      两两全等（0 条被改成过变体）。
 *
 * 现在改成：预填一条新接口 → 走**已经存在**的 openApiDrawer（它本来就支持 templateItem），
 * **保存才落盘**，取消 = 零副作用。路径预填"下一个可用值"，所以最省力的做法
 * （什么都不改直接保存）会直接得到一条能命中请求的接口。名字加「（副本）」后缀。
 *
 * 为什么 enabled 不再"跟随原件"：那条理由（副本启用而原件停用会"悄悄接管"）**已经被
 * 插入位置否掉了** —— 副本排在原件正下方，原件启用时它抢不到路由（第一条匹配是原件）；
 * 原件停用时它接管，而"接管"正是备份想要的回滚能力。反过来，"跟随原件"会让副本
 * **在任何情况下都不可能生效**（原件停 ⇒ 副本也停），只能靠用户事后手动去开它的开关。
 *
 * 保存时的插入位置、落盘后的定位都在 saveDrawer 里 —— 那里才知道原件当前的下标。 */
function duplicateApi(apiId) {
  const src = ((state.config && state.config.apis) || []).find((row) => row.id === apiId);
  if (!src) return;
  openApiDrawer(null, src, { duplicateOf: src.id });
}

async function removeGroup(groupId) {
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  if (!group) return;
  const count = state.config.apis.filter((api) => api.groupId === groupId).length;
  if (!(await askConfirm({
    title: t('group.deleteTitle'),
    message: t('group.deleteConfirm', { name: group.name, count: count }),
    okText: t('btn.delete'),
  }))) return;

  state.config.groups = state.config.groups.filter((row) => row.id !== groupId);
  state.config.apis.forEach((api) => {
    if (api.groupId === groupId) api.groupId = '';
  });
  // 分组没了，折叠记录一并清掉（两份折叠集都清 —— 批量模式读的是 batchCollapsed）
  state.collapsedGroups.delete(groupId);
  state.batchCollapsed.delete(groupId);
  await persist(t('group.deleted'));
  renderAll();
}

/* 上移 / 下移：直接在 config.groups 数组里交换位置，顺序即渲染顺序 */
async function moveGroup(groupId, dir) {
  const groups = state.config.groups || [];
  const idx = groups.findIndex((group) => group.id === groupId);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= groups.length) return;
  const moved = groups[idx];
  groups[idx] = groups[target];
  groups[target] = moved;
  await persist(t('group.moved'));
  renderAll();
}

/* 拖拽落点：把被拖的分组插到目标分组的位置 */
async function reorderGroup(fromId, toId) {
  const groups = state.config.groups || [];
  const fromIdx = groups.findIndex((group) => group.id === fromId);
  const toIdx = groups.findIndex((group) => group.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = groups.splice(fromIdx, 1);
  groups.splice(toIdx, 0, moved);
  await persist(t('group.moved'));
  renderAll();
}

/* 把接口移动到某个分组：groupId 为 UNGROUPED 时归入「未分组」（groupId 置空） */
async function moveApiToGroup(apiId, groupId) {
  const api = state.config.apis.find((row) => row.id === apiId);
  if (!api) return;
  const target = groupId === UNGROUPED ? '' : groupId;
  if (api.groupId === target) return;
  api.groupId = target;
  await persist('接口已移动到「' + groupName(groupId) + '」');
  renderAll();
}

function groupName(groupId) {
  if (groupId === UNGROUPED) return t('group.ungrouped');
  const group = (state.config.groups || []).find((row) => row.id === groupId);
  return group ? group.name : t('group.ungrouped');
}

/* 抽屉里输入的「分组名」→ groupId：留空=未分组；已存在取 id；否则新建分组 */
function resolveGroupId(name) {
  const groups = (state.config && state.config.groups) || (state.config.groups = []);
  name = (name || '').trim();
  if (!name) return '';
  const found = groups.find((group) => group.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const created = { id: 'g' + Date.now().toString(36), name: name };
  groups.push(created);
  return created.id;
}

/* 批量工具条：勾选接口后出现。三个动作 + 「清空」。
 *
 * 「清空」只清空勾选、**不退出**批量模式（退出统一交给左栏常驻的「完成」按钮 / Esc）——
 * 批量操作天然是连续动作，想接着停下一组不该被踢出模式。
 * 三个动作做完同样是「清空 + 留在模式」：工具条会随之消失（它只在有勾选时存在），
 * 但左栏头部那个「完成」按钮一直亮着（.is-on），所以「我还在模式里」始终可见 ——
 * 不会再出现「工具条突然没了、不知道自己在哪」的困惑。 */
function bindBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;
  $('#btnBatchDisable').addEventListener('click', () => batchSetEnabled(false));
  $('#btnBatchEnable').addEventListener('click', () => batchSetEnabled(true));
  $('#btnBatchMove').addEventListener('click', (event) => {
    // 必须拦掉冒泡：document 上那个「点菜单以外区域关菜单」的处理器会把刚打开的菜单立刻收起来
    event.stopPropagation();
    openBatchMoveMenu(event.currentTarget);
  });
  $('#btnBatchClear').addEventListener('click', () => {
    state.selectedApiIds.clear();
    renderApiList();
  });
}

/* 批量移组的目标列表 = 所有分组 + 「未分组」。复用浮层菜单，与分组菜单同一套长相，零新 UI 语言。 */
function openBatchMoveMenu(anchor) {
  const groups = (state.config && state.config.groups) || [];
  const items = groups.map((group) => ({
    label: group.name, icon: '▸', onClick: () => batchMoveToGroup(group.id),
  }));
  items.push({ label: t('group.ungrouped'), icon: '▸', onClick: () => batchMoveToGroup(UNGROUPED) });
  openCtxMenu(anchor, items);
}

/* 批量移组。**不能循环调用 moveApiToGroup** —— 那里面每条都自带 persist + renderAll，
 * 一批 10 条就是 10 次落盘 + 10 次全量重渲染。这里统一「改完一批 → 一次 persist → 一次 render」。 */
async function batchMoveToGroup(groupId) {
  const ids = state.selectedApiIds;
  if (!ids.size) return;
  const target = groupId === UNGROUPED ? '' : groupId;
  let moved = 0;
  state.config.apis.forEach((api) => {
    if (!ids.has(api.id) || api.groupId === target) return;
    api.groupId = target;
    moved += 1;
  });
  // 全都在目标分组里：不动数据也不落盘，但要说清楚，别让用户以为按钮坏了
  if (!moved) { toast(t('batch.moveNoop'), 'ok'); return; }
  await persist(t('batch.moved', { n: moved, name: groupName(groupId) }));
  ids.clear();
  renderAll();
}

async function batchSetEnabled(enabled) {
  const ids = state.selectedApiIds;
  if (!ids.size) return;
  state.config.apis.forEach((api) => { if (ids.has(api.id)) api.enabled = enabled; });
  await persist('已' + (enabled ? '启用' : '停用') + ' ' + ids.size + ' 个接口');
  ids.clear();
  renderAll();
}
