'use strict';

/**
 * tools/lib/sandbox.js —— 「起一个一次性挡板实例」的公共件
 *
 * 为什么要有它：server.js 现在会 require('./lib/*')（拆分后纯逻辑都在 lib/ 里），
 * 所以任何「把 server.js 复制到临时目录再启动」的脚本都必须把 lib/ 一起复制过去，
 * 否则沙盘里 require 找不到模块、服务根本起不来。
 *
 * 以前每个自检脚本各写一份复制逻辑，拆模块时就四处同时坏掉；现在只有这一处
 * 需要知道「跑起来到底依赖哪些文件」——以后再加 lib 下的文件也不用逐个脚本改。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** 不依赖 fs.cpSync（Node 16.7 才有），递归复制目录 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach((entry) => {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  });
}

/** 建一个临时目录（沙盘根） */
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 把「服务跑起来所需的文件」复制进 dir：
 *   server.js        —— 必带
 *   lib/             —— 必带（server.js require 它）
 *   config.example.json —— opts.example 为真时带（用于「首次启动自动生成 config.json」的用例）
 *   public/          —— opts.public 为真时整份带；opts.publicMinimal 为真时只放最小的两份
 *
 * 返回 dir，便于链式使用。
 */
function seedServer(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  assertInsideRepo();
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  copyDir(path.join(ROOT, 'lib'), path.join(dir, 'lib'));

  if (o.example) {
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(dir, 'config.example.json'));
  }
  if (o.public) {
    copyDir(path.join(ROOT, 'public'), path.join(dir, 'public'));
  } else if (o.publicMinimal) {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><title>sandbox</title>', 'utf8');
  }
  return dir;
}

/** 护栏：确认我们是在「仓库里的 tools/lib」下，避免被复制到别处后按错误路径取源文件 */
function assertInsideRepo() {
  if (!fs.existsSync(path.join(ROOT, 'server.js')) || !fs.existsSync(path.join(ROOT, 'lib'))) {
    throw new Error('sandbox.js 必须位于 <仓库>/tools/lib/ 下，当前解析出的仓库根是：' + ROOT);
  }
}

module.exports = { ROOT: ROOT, tempDir: tempDir, seedServer: seedServer, copyDir: copyDir };
