#!/usr/bin/env node
'use strict';

/**
 * verify-console-boot.js —— 「控制台能不能正常启动」的真浏览器自检
 *
 * 为什么需要它：
 *   2026-09-17 把原先单文件控制台前端按功能拆成多个文件后，
 *   控制台的正确性不再由「一个文件读得完」保证，而依赖三件 HTTP 层看不见的事：
 *     ① index.html 的 <script> 顺序（state 初始化要用 readLocal，boot() 必须最后跑）；
 *     ② 所有拆出去的文件都被 index.html 真的加载了（漏一个 → 页面上一堆
 *        "xxx is not defined"，而服务端自检全绿）；
 *     ③ 跨文件同名 const/let 不能重复声明（classic script 共享全局词法作用域，
 *        重复声明会让**整页**直接 SyntaxError 白屏）。
 *   这三件事只会在真浏览器里以「页面报错」的形式暴露，所以这里用无头 Chrome
 *   把控制台真跑一遍：断言零页面 JS 错误 + 关键区域真的渲染出内容 + 跨文件调用
 *   真的通（typeof 一批分布在各个拆出文件里的函数）。
 *
 *   顺带钉住两件容易反复出错的史实：
 *     · 未匹配路径回 404（#8），不是 500；
 *     · 「试打 / 日志 / 抽屉」这些交互入口在拆分后仍然可点、可用。
 *
 * 零依赖（Node ≥ 22 自带 WebSocket / fetch），CDP 样板在 tools/lib/cdp.js。
 * 服务端跑在一次性沙盘里（server.js + lib/ + public/ 的副本，配置由
 * config.example.json 生成并带身份标记），**不碰仓库里的 config.json**。
 *
 * 用法：node tools/verify-console-boot.js
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境问题（找不到 Chrome）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { tempDir, seedServer } = require('./lib/sandbox');
const cdp = require('./lib/cdp');

/* 沙盘身份标记：任何「服务端会写 config.json」的用例都必须先验这个标记，
 * 否则一旦沙盘路径算错，被改的就是仓库里的真实配置（2026-09-16 踩过一次）。 */
const SANDBOX_MARK = 'verify-console-boot-sandbox';

let checks = 0;
let failures = 0;

function expect(label, ok, detail) {
  checks++;
  if (ok) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + (detail ? '\n         → ' + detail : ''));
}

function note(label) {
  console.log('\n' + label);
}

/* ------------------------------------------------------------- sandbox */

function buildSandbox() {
  const dir = seedServer(tempDir('verify-boot-'), { public: true });
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  example.meta = Object.assign({}, example.meta, { projectName: SANDBOX_MARK });
  /* 干净基线：没有账号（免密，控制台直接进）、没有分享令牌、没有历史变更记录 */
  example.users = [];
  example.shareTokens = [];
  example.changelog = [];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(example, null, 2), 'utf8');
  assertSandbox(dir);
  return { dir: dir, apis: example.apis || [] };
}

function assertSandbox(dir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  if (!cfg.meta || cfg.meta.projectName !== SANDBOX_MARK) {
    throw new Error('沙盘身份校验失败：config.json 不是本脚本生成的副本，已中止');
  }
}

async function startServer(dir, port) {
  assertSandbox(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      MOCK_DEFAULT_LANG: 'zh-CN',
      MOCK_ADMIN_USER: '',
      MOCK_ADMIN_PASS: '',
      MOCK_SEED: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/_admin/health');
      if (res.ok) return { child: child, log: () => log };
    } catch (e) { /* 还没起来 */ }
    await cdp.sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error('沙盘服务没起来：\n' + log);
}

/* ------------------------------------------------------------- main */

async function main() {
  const port = await cdp.getFreePort();
  const sandbox = buildSandbox();
  const server = await startServer(sandbox.dir, port);
  const base = 'http://127.0.0.1:' + port + '/';
  console.log('沙盘：' + sandbox.dir + '   服务：' + base);

  let chrome = null;
  let page = null;
  try {
    chrome = await cdp.launchChrome({ width: 1440, height: 900, profilePrefix: 'verify-boot-' });
    page = await cdp.connect(chrome.port, { captureErrors: true });

    /* --- A. 静态资源：index.html 的 <script> 清单 == public/scripts 下的实际文件 --- */
    note('A. 脚本装配（拆分后最容易「漏加一个文件」，而服务端自检看不见）');
    const indexHtml = await (await fetch(base + 'index.html')).text();
    const declared = (indexHtml.match(/<script src="scripts\/([^"]+)"><\/script>/g) || [])
      .map((tag) => tag.replace(/.*scripts\//, '').replace(/".*/, ''));
    const onDisk = fs.readdirSync(path.join(ROOT, 'public', 'scripts')).filter((f) => f.endsWith('.js')).sort();
    expect('index.html 引用了 ' + declared.length + ' 个脚本', declared.length >= 11, '实际 ' + declared.length);
    expect('脚本清单与磁盘文件完全一致（不重不漏）',
      JSON.stringify(declared.slice().sort()) === JSON.stringify(onDisk),
      '声明=' + declared.slice().sort().join(',') + ' / 磁盘=' + onDisk.join(','));
    expect('main.js 已不存在（拆分后残留会让整页重复声明而白屏）',
      onDisk.indexOf('main.js') < 0, onDisk.join(','));

    let allScriptsOk = true;
    let badScript = '';
    for (const name of declared) {
      const res = await fetch(base + 'scripts/' + name);
      if (!res.ok) { allScriptsOk = false; badScript = name + ' → HTTP ' + res.status; break; }
      const body = await res.text();
      if (body.trim().length < 100) { allScriptsOk = false; badScript = name + ' 内容过短'; break; }
    }
    expect('每个脚本都能取到且非空', allScriptsOk, badScript);

    /* --- B. 真浏览器启动 --- */
    note('B. 页面启动（真浏览器）');
    await page.goto(base, { waitMs: 0 });
    await page.waitForLoad(15000);
    let rendered = true;
    await page.waitFor('document.querySelectorAll("#apiList .api-item").length > 0'
      + ' && document.querySelector("#workspace").textContent.trim().length > 0', {
      timeoutMs: 15000, label: '控制台渲染出接口列表与工作区',
    }).catch(() => { rendered = false; });
    await cdp.sleep(400);   // 让 boot() 里的 initAuth / loadConfig 收尾
    expect('首屏能等到「接口列表 + 工作区」都渲染出来', rendered === true, '等待超时');

    const errs = page.errors();
    expect('页面零 JS 错误（拆分后最容易在这里炸）', errs.length === 0,
      errs.slice(0, 5).map((e) => e.kind + ': ' + (e.detail || e.text)).join(' | '));

    const boot = await page.evaluate(`
      const ws = document.querySelector('#workspace');
      const topbar = document.querySelector('.topbar');
      return {
        hasConfig: !!(state && state.config),
        apiCount: document.querySelectorAll('#apiList .api-item').length,
        offCount: document.querySelectorAll('#apiList .api-item.is-off').length,
        wsText: ws ? ws.textContent.trim().length : 0,
        logList: !!document.querySelector('#logList'),
        topbarText: topbar ? topbar.textContent.trim().length : 0,
        lang: (typeof I18N === 'object' && I18N.getLang) ? I18N.getLang() : '',
        theme: document.documentElement.getAttribute('data-theme') || '',
        types: {
          readLocal: typeof readLocal, applyTheme: typeof applyTheme, resolveTheme: typeof resolveTheme,
          loadConfig: typeof loadConfig, persist: typeof persist, apiFullPath: typeof apiFullPath,
          renderApiList: typeof renderApiList, bindApiListEvents: typeof bindApiListEvents,
          askConfirm: typeof askConfirm, addGroup: typeof addGroup,
          renderWorkspace: typeof renderWorkspace, renderRuleReadonly: typeof renderRuleReadonly,
          renderLogs: typeof renderLogs, runTryIt: typeof runTryIt,
          openRuleDrawer: typeof openRuleDrawer, saveDrawer: typeof saveDrawer, varsEditorHtml: typeof varsEditorHtml,
          renderAll: typeof renderAll, bindGlobalEvents: typeof bindGlobalEvents, boot: typeof boot,
          t: typeof t, escapeHtml: typeof escapeHtml,
        },
      };
    `);
    expect('boot() 跑完 → state.config 已加载', boot.hasConfig === true, 'hasConfig=' + boot.hasConfig);
    /* 默认筛选是「全部」（state.filterStatus = 'all'），所以停用的接口也照样列出来、只是带 is-off */
    const totalApis = sandbox.apis.length;
    const offApis = sandbox.apis.filter((a) => a.enabled === false).length;
    expect('左侧列表渲染出配置里的全部接口（默认筛选=全部，' + totalApis + ' 条）',
      boot.apiCount === totalApis, '实际渲染 ' + boot.apiCount);
    expect('停用的接口带 is-off 标记（' + offApis + ' 条，没有被漏渲染）',
      boot.offCount === offApis, '实际 is-off ' + boot.offCount);
    expect('工作区渲染出内容（不是空白）', boot.wsText > 0, 'wsText=' + boot.wsText);
    expect('请求日志面板存在', boot.logList === true);
    expect('顶栏渲染出内容', boot.topbarText > 0, 'topbarText=' + boot.topbarText);
    expect('语言与主题已初始化', boot.lang === 'zh-CN' && boot.theme !== '', 'lang=' + boot.lang + ' theme=' + boot.theme);

    const notFn = Object.keys(boot.types).filter((k) => boot.types[k] !== 'function');
    expect('跨文件调用通：' + Object.keys(boot.types).length + ' 个分布在各拆出文件里的函数都可见',
      notFn.length === 0, notFn.map((k) => k + '=' + boot.types[k]).join(', '));

    /* --- C. 交互：点接口 → 打开抽屉 → 关闭 --- */
    note('C. 交互（拆分只搬代码，行为不能变）');
    const click = await page.evaluate(`
      const first = document.querySelector('#apiList .api-item');
      const id = first.getAttribute('data-api-id');
      first.click();
      await new Promise((r) => setTimeout(r, 500));
      return {
        clickedId: id,
        activeId: state.activeApiId,
        anchor: document.querySelector('#workspace').textContent.indexOf(first.querySelector('.api-item__name').textContent.trim()) >= 0,
      };
    `);
    expect('点接口 → state.activeApiId 跟着变', click.activeId === click.clickedId,
      'activeApiId=' + click.activeId + ' 期望 ' + click.clickedId);
    expect('点接口 → 工作区切到该接口', click.anchor === true);

    const drawer = await page.evaluate(`
      openRuleDrawer(0);
      await new Promise((r) => setTimeout(r, 400));
      const opened = document.querySelector('#drawer').classList.contains('is-open')
        && document.querySelector('#drawer').getAttribute('aria-hidden') === 'false';
      const title = (document.querySelector('#drawerTitle') || {}).textContent || '';
      const bodyLen = (document.querySelector('#drawerBody') || {}).textContent.length;
      closeDrawer();
      await new Promise((r) => setTimeout(r, 300));
      return {
        opened: opened, title: title.trim(), bodyLen: bodyLen,
        closed: !document.querySelector('#drawer').classList.contains('is-open'),
      };
    `);
    expect('打开规则抽屉：#drawer 可见且有标题与内容',
      drawer.opened === true && drawer.title.length > 0 && drawer.bodyLen > 0,
      JSON.stringify(drawer));
    expect('关闭抽屉：#drawer 收起', drawer.closed === true);

    /* --- D. 语言切换（跨 state / i18n / 各渲染函数的联动） --- */
    note('D. 语言切换（i18n 与拆出的渲染函数联动）');
    const lang = await page.evaluate(`
      const search = document.querySelector('#apiSearch');
      const placeholderBefore = search ? search.placeholder : '';
      const titleBefore = document.querySelector('#btnLang').getAttribute('title');
      document.querySelector('#btnLang').click();
      await new Promise((r) => setTimeout(r, 600));
      return {
        lang: I18N.getLang(),
        placeholderBefore: placeholderBefore,
        placeholderAfter: search ? search.placeholder : '',
        titleBefore: titleBefore,
        titleAfter: document.querySelector('#btnLang').getAttribute('title'),
      };
    `);
    expect('点语言按钮 → 切到 en', lang.lang === 'en', 'lang=' + lang.lang);
    expect('界面文案真的跟着变了（applyI18n + 重渲染都还在）',
      lang.placeholderAfter !== '' && lang.placeholderAfter !== lang.placeholderBefore,
      JSON.stringify(lang));

    const after = page.errors();
    expect('全程零 JS 错误（含交互与切语言）', after.length === 0,
      after.slice(0, 5).map((e) => e.kind + ': ' + (e.detail || e.text)).join(' | '));

    /* --- E. 未匹配路径 404（#8，顺带钉住） --- */
    note('E. 未匹配路径仍是 404（#8 的行为不能被拆分带回去）');
    const miss = await fetch(base + 'no/such/api', { method: 'POST', body: '{}' });
    expect('POST 未匹配路径 → 404', miss.status === 404, 'HTTP ' + miss.status);
  } finally {
    if (page) await page.close();
    if (chrome) await chrome.close();
    try { server.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }

  console.log('\n' + (failures === 0
    ? '✓ 控制台启动自检全部通过（共 ' + checks + ' 条断言）'
    : '✗ 有 ' + failures + ' 条断言失败（共 ' + checks + ' 条）'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('自检未能跑完：' + (err && err.message ? err.message : err));
  process.exit(2);
});
