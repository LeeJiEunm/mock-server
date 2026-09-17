'use strict';

/**
 * tools/lib/password.js —— 与 server.js 内联的密码哈希逻辑保持一致的唯一来源。
 *
 * server.js 因单文件可部署约束不能 require('tools/lib/*')，所以它内部有一份等价的
 * 内联实现；这里是给 CLI / 自检脚本用的副本。两者必须保持 SCRYPT 参数一致，否则
 * server.js 生成的哈希与工具生成的哈希无法互相校验。
 *
 * 新格式： "scrypt:<saltB64>:<derivedB64>"（每用户随机 16 字节 salt）
 * 兼容旧格式："sha256:<hex>"（迁移期仍接受，建议改密转成 scrypt）
 */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N=2^14，约 16MB/次

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { cost: SCRYPT_COST, blockSize: 8, parallelization: 1 });
  return 'scrypt:' + salt.toString('base64') + ':' + derived.toString('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const derived = crypto.scryptSync(String(pw), salt, expected.length, { cost: SCRYPT_COST, blockSize: 8, parallelization: 1 });
    return safeEqual(derived, expected);
  }
  if (stored.startsWith('sha256:')) {
    const hex = crypto.createHash('sha256').update(String(pw)).digest('hex');
    return safeEqual(Buffer.from(stored.slice(7)), Buffer.from(hex));
  }
  return false;
}

module.exports = { hashPassword, verifyPassword, safeEqual, SCRYPT_KEYLEN, SCRYPT_COST };
