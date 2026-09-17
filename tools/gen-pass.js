#!/usr/bin/env node
// 生成控制台用户密码的哈希，用于 config.json 的 users[].passwordHash。
// 用法: node tools/gen-pass.js <明文密码>
// 输出: scrypt:<saltB64>:<derivedB64>（每用户随机 salt，格式与 server.js 一致）
'use strict';

const { hashPassword } = require('./lib/password');

const pw = process.argv[2];
if (!pw) {
  console.error('用法: node tools/gen-pass.js <明文密码>');
  process.exit(1);
}

console.log(hashPassword(pw));
