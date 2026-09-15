#!/usr/bin/env node
// 生成控制台用户密码的 SHA-256 哈希，用于 config.json 的 users[].passwordHash。
// 用法: node tools/gen-pass.js <明文密码>
// 输出: sha256:<hex>
'use strict';

const crypto = require('crypto');

const pw = process.argv[2];
if (!pw) {
  console.error('用法: node tools/gen-pass.js <明文密码>');
  process.exit(1);
}

console.log('sha256:' + crypto.createHash('sha256').update(pw).digest('hex'));
