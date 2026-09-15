#!/usr/bin/env node
'use strict';

/**
 * import-legacy.js —— 把老 mock 平台（/mock/admin/list）上的接口搬进本挡板
 *
 * 老平台的一条记录是「一个路径 = 一份写死的返回」，本挡板是「一个接口 = 兜底返回 + 若干规则」。
 * 对应关系：
 *
 *   老记录 module + path        →  本挡板 apis[].module + apis[].path（拼出来的完整路径完全一致）
 *   老记录 enableProxy + proxyUrl →  proxy.enable + proxy.url
 *   老记录 response             →  defaultResponse.body（即"兜底返回"，一关代理就按它返回）
 *   老记录的第一段 module        →  一个分组（老平台的"模块"就是分组维度）
 *
 * 之所以把老响应体放「兜底返回」而不是"恒命中的一条规则"：
 * 兜底返回本来就是"没有规则命中时返回什么"，语义正好对应老平台那份写死的响应；
 * 代理开着时它不参与，代理一关立刻生效，再往上面加规则就能升级成动态挡板。
 *
 * 幂等：接口 id 由路径推导（legacy-xxx），重复执行是"更新"而不是"再来一份"。
 *
 * 用法：
 *   node tools/import-legacy.js --dry-run                      # 只看会导入什么
 *   node tools/import-legacy.js                                # 真导入（默认源见下）
 *   node tools/import-legacy.js --from http://<LEGACY_MOCK_HOST>:8084/mock/admin/list
 *   node tools/import-legacy.js --from /tmp/mocklist.json       # 也支持本地 JSON 文件
 *   node tools/import-legacy.js --prune                         # 顺带删掉"老平台已删除"的接口
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SAMPLE_FILE = path.join(ROOT, 'public', 'sample-config.json');
const DEFAULT_SOURCE = 'http://<LEGACY_MOCK_HOST>:8084/mock/admin/list';

const ID_PREFIX = 'legacy-';        // 接口 id 前缀，用于识别"是导入来的"
const GROUP_PREFIX = 'lg-';         // 分组 id 前缀

function argOf(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const hasFlag = (name) => process.argv.indexOf('--' + name) >= 0;

const SOURCE = argOf('from', DEFAULT_SOURCE);
const DRY_RUN = hasFlag('dry-run');
const PRUNE = hasFlag('prune');

/* ------------------------------ 取老数据 ------------------------------ */

async function fetchLegacy() {
  if (SOURCE.startsWith('http://') || SOURCE.startsWith('https://')) {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('拉取老平台失败：HTTP ' + res.status);
    return JSON.parse(await res.text());
  }
  return JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
}

/* ------------------------------ 转换 ------------------------------ */

/** 路径 → id。同一条路径每次算出来都一样，保证重复导入是"更新" */
function idOf(fullPath) {
  const slug = fullPath.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ID_PREFIX + slug;
}

function isHttpUrl(text) {
  return /^https?:\/\//i.test(String(text || '').trim());
}

const COMPUTED_FIELDS = { fields: null };

/** 老平台的时间戳（毫秒）→ 人能读的日期 */
function dayText(ms) {
  if (!ms) return '';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/**
 * 转换一条老记录。返回 { api, groupName, warning }
 */
function convert(row) {
  const module = String(row.module || '').trim().replace(/^\/+|\/+$/g, '');
  const subPath = String(row.path || '').trim().replace(/^\/+|\/+$/g, '');
  const fullPath = [module, subPath].filter(Boolean).join('/');
  const segments = fullPath.split('/').filter(Boolean);

  // 老平台的代理地址里有 "xxx" / "test" 这种占位符，直接开代理只会把请求打飞。
  // 这类一律关掉代理，让它走"兜底返回"（也就是老平台记下的那份响应）。
  const wanted = !!row.enableProxy;
  const proxyUsable = isHttpUrl(row.proxyUrl);
  const proxyOn = wanted && proxyUsable;

  const body = String(row.response == null ? '' : row.response).trim() || '{}';

  const warning = wanted && !proxyUsable
    ? '原记录开着代理但地址是占位符（' + JSON.stringify(row.proxyUrl) + '），已改为不回源、直接返回记录的响应'
    : '';

  const descLines = [
    '从老 mock 平台导入（' + SOURCE + '）。',
    proxyOn
      ? '当前为代理透传 → ' + row.proxyUrl + '（与老平台行为一致）。关掉「代理透传」即改用下方兜底响应。'
      : '按记录的响应直接返回。',
    dayText(row.lastModified) ? '最后修改 ' + dayText(row.lastModified) + '。' : '',
    warning,
  ].filter(Boolean);

  return {
    groupName: segments[0] || '未归类',
    warning: warning,
    api: {
      id: idOf(fullPath),
      name: segments[segments.length - 1] || fullPath,
      module: module,
      path: subPath,
      groupId: GROUP_PREFIX + (segments[0] || 'misc'),
      enabled: true,
      desc: descLines.join(' '),
      proxy: { enable: proxyOn, url: proxyOn || proxyUsable ? String(row.proxyUrl || '') : '' },
      vars: {},
      rules: [],
      defaultResponse: {
        mode: 'static',
        status: 200,
        delayMs: 0,
        contentType: 'application/json;charset=UTF-8',
        body: body,
        script: '',
      },
    },
  };
}

/* ------------------------------ 合并写入 ------------------------------ */

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { server: { host: '0.0.0.0', port: 18080 }, logSize: 200, groups: [], apis: [] };
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  config.groups = config.groups || [];
  config.apis = config.apis || [];
  return config;
}

async function main() {
  const rows = await fetchLegacy();
  if (!Array.isArray(rows)) throw new Error('老平台返回的不是数组，实际是：' + typeof rows);

  const converted = rows.map(convert);
  const groups = new Map();
  converted.forEach((item) => {
    if (!groups.has(item.groupName)) groups.set(item.groupName, []);
    groups.get(item.groupName).push(item.api);
  });

  const config = loadConfig();
  const seenIds = new Set(converted.map((item) => item.api.id));

  /* ---- 分组：按老平台的"模块"建，已存在的更新名字 ---- */
  groups.forEach((apis, groupName) => {
    const id = GROUP_PREFIX + groupName;
    const exist = config.groups.find((group) => group.id === id);
    if (exist) exist.name = groupName;
    else config.groups.push({ id: id, name: groupName });
  });

  /* ---- 接口：按 id 更新，没有就新增 ---- */
  let added = 0;
  let updated = 0;
  converted.forEach((item) => {
    const at = config.apis.findIndex((api) => api.id === item.api.id);
    if (at >= 0) {
      config.apis[at] = Object.assign({}, item.api, { vars: config.apis[at].vars || {} });
      updated++;
    } else {
      config.apis.push(item.api);
      added++;
    }
  });

  /* ---- 可选：清掉老平台上已经不存在的导入项 ---- */
  let pruned = 0;
  if (PRUNE) {
    const before = config.apis.length;
    config.apis = config.apis.filter((api) => api.id.indexOf(ID_PREFIX) !== 0 || seenIds.has(api.id));
    pruned = before - config.apis.length;

    const usedGroups = new Set(config.apis.map((api) => api.groupId));
    const groupBefore = config.groups.length;
    config.groups = config.groups.filter((group) => group.id.indexOf(GROUP_PREFIX) !== 0 || usedGroups.has(group.id));
    pruned += groupBefore - config.groups.length;
  }

  /* ---- 报告 ---- */
  console.log('来源：' + SOURCE);
  console.log('老平台 ' + rows.length + ' 条记录 → 新增 ' + added + ' 个接口，更新 ' + updated + ' 个'
    + (PRUNE ? '，清理 ' + pruned + ' 项' : '') + '。');
  console.log('');
  groups.forEach((apis, groupName) => {
    console.log('  [' + groupName + '] ' + apis.length + ' 个');
    apis.forEach((api) => {
      const via = api.proxy.enable ? '代理 → ' + api.proxy.url : '返回记录的响应';
      console.log('      /' + [api.module, api.path].join('/') + '   ' + via);
    });
  });

  const warnings = converted.filter((item) => item.warning);
  if (warnings.length) {
    console.log('');
    console.log('注意（' + warnings.length + ' 条）：');
    warnings.forEach((item) => console.log('  /' + [item.api.module, item.api.path].join('/') + ' —— ' + item.warning));
  }

  if (DRY_RUN) {
    console.log('');
    console.log('（--dry-run，没有写文件。去掉该参数即真导入。）');
    return;
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(SAMPLE_FILE, JSON.stringify(config, null, 2), 'utf8');
  console.log('');
  console.log('已写入 ' + path.relative(ROOT, CONFIG_FILE) + ' 与 ' + path.relative(ROOT, SAMPLE_FILE) + '。');
  console.log('正在运行的服务请点界面上的「重新读取配置」，或重启进程。');
}

main().catch((err) => {
  console.error('导入失败：' + err.message);
  process.exit(1);
});
