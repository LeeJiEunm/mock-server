'use strict';

/**
 * tools/lib/config.js —— 工具脚本共用的「定位配置文件 + 首次自动生成」
 *
 * 背景（#16）：config.json 是运行数据、不入库；入库的是 config.example.json。
 * 于是仓库里可能压根没有 config.json（刚 clone、还没启动过服务），
 * 工具脚本这时不该直接甩一句「找不到配置文件」，而应和 server.js 一样先拿示例顶一份。
 *
 * ⚠️ 这里的逻辑与 server.js 的 ensureConfigFile 是**有意重复**的，不是遗漏：
 *    server.js 必须保持「单文件零依赖」—— deploy.sh 只把 server.js + public/ +
 *    config.example.json 丢到远端，不会带 tools/。反过来让 server.js require 本文件
 *    会把「单文件」这个卖点弄丢。两边规则须一致，改一边记得同步另一边。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

/** 最小骨架：连示例文件都没有时的最后兜底，保证任何环境下工具都能跑 */
function builtinConfig() {
  return {
    server: { host: '0.0.0.0', port: 18080, readonlyPort: 0 },
    logSize: 200,
    groups: [],
    apis: [],
    meta: {},
    users: [],
    changelog: [],
    shareTokens: [],
  };
}

/** 缺 config.json 就用示例（或内置骨架）生成一份；已存在则原地不动。返回配置文件路径。 */
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;
  if (fs.existsSync(EXAMPLE_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
    console.log('[config] 未找到 config.json，已从 config.example.json 复制一份（示例数据）');
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(builtinConfig(), null, 2), 'utf8');
    console.log('[config] 未找到 config.json / config.example.json，已生成一份最小配置');
  }
  return CONFIG_FILE;
}

function readConfig() {
  ensureConfigFile();
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/** 写回配置（普通覆盖写；服务端那边走的是「临时文件 + rename」的原子写） */
function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return CONFIG_FILE;
}

module.exports = { ROOT, CONFIG_FILE, EXAMPLE_FILE, builtinConfig, ensureConfigFile, readConfig, writeConfig };
