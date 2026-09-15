#!/usr/bin/env node
// 管理控制台登录用户（写入 config.json 的 users 数组，密码以 SHA-256 哈希存储，不落明文）。
//
// 用法:
//   node tools/add-user.js <用户名> <密码>      # 新增用户；用户已存在则改密码
//   node tools/add-user.js --list               # 列出当前所有用户
//   node tools/add-user.js --remove <用户名>     # 删除用户
//
// 说明:
//   - 改完即生效（服务端检测到 config.json 变更会自动重载），无需重启。
//   - 用环境变量 MOCK_ADMIN_USER / MOCK_ADMIN_PASS 部署时，可以不配这里的 users。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function sha256Hash(pw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function usage(msg) {
  if (msg) console.error('错误: ' + msg + '\n');
  console.error([
    '用法:',
    '  node tools/add-user.js <用户名> <密码>   新增用户 / 修改密码',
    '  node tools/add-user.js --list            列出所有用户',
    '  node tools/add-user.js --remove <用户名>  删除用户',
  ].join('\n'));
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('找不到配置文件: ' + CONFIG_FILE);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('config.json 解析失败: ' + e.message);
    process.exit(1);
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

const args = process.argv.slice(2);

if (!args.length) usage();

const config = loadConfig();
if (!Array.isArray(config.users)) config.users = [];

// --list
if (args[0] === '--list' || args[0] === '-l') {
  if (!config.users.length) {
    console.log('当前没有配置任何登录用户（面板保持开放，或改用 MOCK_ADMIN_PASS 部署）。');
  } else {
    console.log('当前登录用户（共 ' + config.users.length + ' 个）:');
    config.users.forEach((u) => console.log('  - ' + u.username + '  ' + u.passwordHash));
  }
  process.exit(0);
}

// --remove <用户名>
if (args[0] === '--remove' || args[0] === '-r') {
  const username = args[1];
  if (!username) usage('请指定要删除的用户名');
  const before = config.users.length;
  config.users = config.users.filter((u) => u && u.username !== username);
  if (config.users.length === before) {
    console.error('没有找到用户: ' + username);
    process.exit(1);
  }
  saveConfig(config);
  console.log('已删除用户: ' + username + '（剩余 ' + config.users.length + ' 个）');
  process.exit(0);
}

// 新增 / 改密
const username = args[0];
const password = args[1];
if (!username || password == null) usage('需要同时提供用户名和密码');
const name = String(username).trim();
if (!name) usage('用户名不能为空');
if (String(password) === '') usage('密码不能为空');
if (name.length > 64) usage('用户名过长（建议 <= 64 字符）');

const item = { username: name, passwordHash: sha256Hash(password) };
const index = config.users.findIndex((u) => u && u.username === name);
if (index >= 0) {
  config.users[index] = item;
  saveConfig(config);
  console.log('已更新用户密码: ' + name);
} else {
  config.users.push(item);
  saveConfig(config);
  console.log('已新增用户: ' + name + '（当前共 ' + config.users.length + ' 个）');
}
console.log('已写入 ' + path.relative(path.join(__dirname, '..'), CONFIG_FILE) + '，服务端会自动重载配置，无需重启。');
