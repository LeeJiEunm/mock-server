#!/usr/bin/env node
'use strict';
/*
 * shot-docs-i18n.js —— 生成「英文版」文档截图
 *
 * 背景：README.en.md / 网页版手册（help.html 切到 EN）原先引用的是中文截图，
 *       英文读者看到的中文界面，与文案对不上。中文那几张保持不动，英文单独出一套。
 *
 * 产物（写入仓库，中文图不动）：
 *   docs/shot-console.en.png        ← 控制台总览（英文界面）
 *   docs/shot-share.en.png          ← 只读分享弹窗（英文界面）
 *   docs/shot-help.en.png           ← 网页版手册英文版首屏（内含英文控制台截图）
 *   public/help/shot-console.en.png ← 与 docs/ 同名文件互为副本（help.html 内嵌用）
 *   public/help/shot-share.en.png   ← 同上
 *
 * 做法：把 server.js + public/ + config.json 复制到临时沙盘，用
 *       MOCK_DEFAULT_LANG=en 起服务（沙盘配置是可丢弃的副本，仓库 config.json 不会被写），
 *       再用 CDP 驱动无头 Chrome 截图。零依赖（Node ≥ 22 自带 WebSocket / fetch）。
 *
 * 用法：
 *   node tools/shot-docs-i18n.js             # 生成并写入仓库
 *   node tools/shot-docs-i18n.js --dry-run   # 只截到临时目录，不覆盖仓库文件
 */

const { spawn } = require('child_process');   // 只用来起沙盘里的服务端，Chrome 由 lib/cdp.js 负责
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { tempDir, seedServer } = require('./lib/sandbox');
const cdp = require('./lib/cdp');
const DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
const W = 1440, H = 900;

/* 沙盘身份标记：截图脚本会往沙盘 config.json 写变更记录（服务端行为），
 * 万一沙盘目录不对，这里能第一时间发现，而不是把仓库配置改了才知道。 */
const SANDBOX_MARK = 'shot-docs-i18n-sandbox';

const sleep = cdp.sleep;

/* --------------------------------------------------------------------------
 * 沙盘：server.js 用 path.join(__dirname, 'config.json') 定位配置，
 *   所以必须把 server.js（以及它 require 的 lib/）复制进沙盘再启动 ——
 *   换 cwd 是没用的（会读到仓库真实配置）。这一串复制统一由 tools/lib/sandbox.js 负责。
 *
 *   配置基线读的是 config.example.json 而不是仓库那份 config.json：
 *   后者是运行数据（不入库），截图本来要的就是「干净示例」的样子。
 * ------------------------------------------------------------------------ */
function buildSandbox() {
  const dir = seedServer(tempDir('shot-docs-'), { public: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  cfg.meta = Object.assign({}, cfg.meta, { projectName: SANDBOX_MARK });
  // 截图的干净基线：没有历史日志、没有账号、没有分享令牌（与仓库示例配置一致）
  cfg.changelog = [];
  cfg.shareTokens = [];
  cfg.users = [];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  return dir;
}

function assertSandbox(dir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  if (!cfg.meta || cfg.meta.projectName !== SANDBOX_MARK) {
    throw new Error('沙盘身份校验失败：config.json 不是本脚本生成的副本，已中止（避免改到真实配置）');
  }
}

async function startServer(dir, port, roPort) {
  assertSandbox(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      /* 必须给只读隔离端口：免密模式没配它时，点顶栏分享图标只会弹一句
       * 「未启用只读端口，分享链接不可用」，分享弹窗根本不打开，截出来是控制台而不是弹窗。 */
      READONLY_PORT: String(roPort),
      MOCK_DEFAULT_LANG: 'en',      // 英文界面：这是本脚本存在的理由
      MOCK_ADMIN_USER: '',
      MOCK_ADMIN_PASS: '',
      MOCK_SEED: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/_admin/health');
      if (r.ok) return { child, log: () => out };
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error('沙盘服务没起来：\n' + out);
}

/* ---------------------------------- CDP ---------------------------------- */
/* 起 Chrome / 连接 / 截图统一走 tools/lib/cdp.js；这里只保留 send / evaluate / capture
 * 这几个旧名字（转发给 page），免得动下面的主流程。 */
let chrome = null;
let page = null;

function send(method, params) { return page.send(method, params); }

/* 表达式求值（不是函数体）：调用点写的是 'document.documentElement.lang' 这种表达式，
 * 用 evalExpr 才不会「把表达式当函数体、结果静默变成 undefined」。 */
function evaluate(expression) { return page.evalExpr(expression); }

async function capture(file) {
  await page.shot(file, { fromSurface: true, captureBeyondViewport: false });
  const bytes = fs.statSync(file).size;
  // 空截图（全白/全黑纯色）会让文档里出现一张看不见的图，尺寸太小也说明没渲染出来
  if (bytes < 20000) throw new Error('截图疑似空白（' + bytes + ' 字节）：' + file);
  return { file: file, bytes: bytes };
}

/* --------------------------------- 主流程 --------------------------------- */
async function main() {
  cdp.findChrome();   // 找不到会抛出带候选路径的明确错误

  const sandbox = buildSandbox();
  const port = await cdp.getFreePort();
  const roPort = await cdp.getFreePort();
  /* dry-run 时产物留在固定目录，方便逐张肉眼核对；正式运行时用临时目录并清掉 */
  const outDir = DRY_RUN
    ? path.join(os.tmpdir(), 'shot-docs-out')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'shot-docs-out-'));
  if (DRY_RUN) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
  }
  let server = null;
  const results = [];

  try {
    server = await startServer(sandbox, port, roPort);
    console.log('沙盘服务已启动：http://127.0.0.1:' + port + '（MOCK_DEFAULT_LANG=en，只读端口 ' + roPort + '）');

    chrome = await cdp.launchChrome({
      width: W, height: H, profilePrefix: 'shot-docs-',
      args: ['--hide-scrollbars'],
    });
    page = await cdp.connect(chrome.port);
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    /* ① 控制台总览 --------------------------------------------------------- */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/?t=' + Date.now() });
    await sleep(2800);   // 等 boot()：鉴权 → 拉配置 → 渲染三栏
    const langNow = await evaluate('document.documentElement.lang');
    if (String(langNow).indexOf('en') !== 0) {
      throw new Error('界面语言不是英文（documentElement.lang=' + langNow + '），截图会串成中文');
    }
    // 选中「示例：条件响应」那条接口，与中文截图保持同一个视图
    const picked = await evaluate(`(function () {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-api-id]'));
      var hit = nodes.filter(function (n) { return n.textContent.indexOf('/demo/sample') >= 0; })[0];
      if (!hit) return '未找到 /demo/sample 卡片';
      hit.click();
      return 'ok';
    })()`);
    if (picked !== 'ok') throw new Error('选中接口失败：' + picked);
    await sleep(800);
    const consoleShot = await capture(path.join(outDir, 'shot-console.en.png'));
    console.log('✓ 控制台总览（英文）：' + consoleShot.bytes + ' 字节');
    results.push({ from: consoleShot.file, to: ['docs/shot-console.en.png', 'public/help/shot-console.en.png'] });

    // 手册页里嵌的正是这张图：先放进沙盘 public/help/，等下手册截图才是英文版
    fs.copyFileSync(consoleShot.file, path.join(sandbox, 'public', 'help', 'shot-console.en.png'));

    /* ② 只读分享弹窗 ------------------------------------------------------- */
    await evaluate("document.getElementById('btnShare').click()");
    await sleep(900);
    /* 弹窗必须真的可见：免密 + 未配只读端口时点分享只会弹一句 toast，弹窗不打开，
     * 截出来就是一张普通控制台（上次就是这么骗过自己的），所以这里显式断言。 */
    const shareOpen = await evaluate(`(function () {
      var m = document.getElementById('shareModal');
      if (!m || m.hidden) return false;
      if (getComputedStyle(m).display === 'none') return false;
      // 注意：.modal-layer 是 position: fixed，offsetParent 恒为 null，只能用 rect 量
      var r = m.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
    if (!shareOpen) throw new Error('分享弹窗没有打开（免密部署需配置 READONLY_PORT 才允许生成分享链接）');
    const shareShot = await capture(path.join(outDir, 'shot-share.en.png'));
    console.log('✓ 分享弹窗（英文）：' + shareShot.bytes + ' 字节');
    results.push({ from: shareShot.file, to: ['docs/shot-share.en.png', 'public/help/shot-share.en.png'] });
    fs.copyFileSync(shareShot.file, path.join(sandbox, 'public', 'help', 'shot-share.en.png'));

    /* ③ 网页版手册（英文）------------------------------------------------- */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/help.html?lang=en&t=' + Date.now() });
    await sleep(1800);
    const helpState = await evaluate(`(function () {
      var html = document.documentElement;
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img.shot'));
      var visible = imgs.filter(function (i) { return i.offsetParent !== null; });
      return {
        lang: html.lang,
        zhHidden: imgs.filter(function (i) { return i.className.indexOf('zh') >= 0 && i.offsetParent === null; }).length,
        visibleEn: visible.filter(function (i) { return i.src.indexOf('.en.png') >= 0; }).length,
        broken: visible.filter(function (i) { return i.complete && i.naturalWidth === 0; }).length
      };
    })()`);
    if (String(helpState.lang).indexOf('en') !== 0) throw new Error('手册页没切到英文：' + JSON.stringify(helpState));
    if (!helpState.visibleEn) throw new Error('手册页可见的仍是中文截图：' + JSON.stringify(helpState));
    if (helpState.broken) throw new Error('手册页有图片加载失败（缺英文版截图？）：' + JSON.stringify(helpState));
    const helpShot = await capture(path.join(outDir, 'shot-help.en.png'));
    console.log('✓ 网页版手册（英文）：' + helpShot.bytes + ' 字节');
    results.push({ from: helpShot.file, to: ['docs/shot-help.en.png'] });

    /* ④ 手册页的语言入口（这就是「控制台切英文后点 ❓ 进来还是中文」那条的修复点）
     *    三种入口都要成立，缺一个都会退回中文：?lang= / 控制台的语言键 / 显式参数覆盖存储值。 */
    const helpLang = async (search, preset) => {
      await evaluate('try { localStorage.removeItem("mockServer.lang"); localStorage.removeItem("mock-help-lang"); } catch (e) {}');
      if (preset) await evaluate('try { localStorage.setItem("mockServer.lang", ' + JSON.stringify(preset) + '); } catch (e) {}');
      await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/help.html' + search + '&t=' + Date.now() });
      await sleep(700);
      const state = await evaluate(`(function () {
        var imgs = Array.prototype.slice.call(document.querySelectorAll('img.shot'));
        var shown = function (cls) {
          return imgs.filter(function (i) {
            return i.className.indexOf(cls) >= 0 && i.offsetWidth > 0 && i.offsetHeight > 0;
          }).length;
        };
        return { lang: document.documentElement.lang, zh: shown('zh'), en: shown('en') };
      })()`);
      return state;
    };
    const byQueryEn = await helpLang('?lang=en');
    const byQueryZh = await helpLang('?lang=zh');
    const byStoreEn = await helpLang('?', 'en');
    const byQueryBeatsStore = await helpLang('?lang=en', 'zh-CN');
    const byStoreZh = await helpLang('?', 'zh-CN');
    /* 语言对了、图没跟着换（或两张同时出现）同样是坏的：
     * 每张 figure 里放了 zh / en 两个 <img>，靠 html:lang() 的 CSS 规则二选一显示。 */
    const bad = [
      ['?lang=en → en 且只显示英文图', byQueryEn.lang.indexOf('en') === 0 && byQueryEn.en === 2 && byQueryEn.zh === 0],
      ['?lang=zh → zh-CN 且只显示中文图', byQueryZh.lang.indexOf('zh') === 0 && byQueryZh.zh === 2 && byQueryZh.en === 0],
      ['控制台语言键为 en、不带参数 → en', byStoreEn.lang.indexOf('en') === 0 && byStoreEn.en === 2],
      ['控制台语言键为 zh-CN、不带参数 → zh-CN', byStoreZh.lang.indexOf('zh') === 0 && byStoreZh.zh === 2],
      ['显式 ?lang=en 能盖过存储里的 zh-CN', byQueryBeatsStore.lang.indexOf('en') === 0],
    ].filter((row) => !row[1]);
    if (bad.length) {
      throw new Error('手册页语言入口不对：' + bad.map((row) => row[0]).join('；')
        + '（实测 ' + [byQueryEn, byQueryZh, byStoreEn, byStoreZh, byQueryBeatsStore]
          .map((s) => s.lang + '[zh:' + s.zh + ' en:' + s.en + ']').join(' / ') + '）');
    }
    console.log('✓ 手册页语言入口：?lang= / 跟随控制台语言键 / 覆盖关系 5 项成立，且截图随语言二选一');

    /* ④ 落盘 --------------------------------------------------------------- */
    if (DRY_RUN) {
      console.log('\n--dry-run：只截未写，产物在 ' + outDir);
    } else {
      const repoConfig = path.join(ROOT, 'config.json');
      const before = crypto.createHash('sha256').update(fs.readFileSync(repoConfig)).digest('hex');
      results.forEach((item) => {
        item.to.forEach((rel) => {
          fs.copyFileSync(item.from, path.join(ROOT, rel));
          console.log('  写入 ' + rel);
        });
      });
      const after = crypto.createHash('sha256').update(fs.readFileSync(repoConfig)).digest('hex');
      if (before !== after) throw new Error('仓库 config.json 竟然被改动了，请检查！');
      console.log('   仓库 config.json 未被改动 ✔');
    }
  } finally {
    if (page) await page.close();
    if (chrome) await chrome.close();      // 杀 Chrome + 清临时 profile
    if (server && server.child) server.child.kill('SIGKILL');
    await sleep(150);
    fs.rmSync(sandbox, { recursive: true, force: true });
    if (!DRY_RUN) fs.rmSync(outDir, { recursive: true, force: true });
    console.log('沙盘与临时产物已清理' + (DRY_RUN ? '（dry-run 产物保留在 ' + outDir + '）' : ''));
  }
  console.log('\n完成。英文截图共 ' + results.length + ' 张（docs/ 与 public/help/ 各一份）。');
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
