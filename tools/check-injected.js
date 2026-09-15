#!/usr/bin/env node
'use strict';
/* 校验 verify-ui.js 里「注入脚本」的可交付性。
 *
 * 为什么要单独做这个：注入脚本整体是包在模板字符串里的，所以会经历 JS 的字符串
 * **cook** 过程。两类事故都真发生过（2026-09-15）：
 *   ① 注释里写了反引号 → 模板字符串被提前截断 → `-copy` 被当成 JS 求值，
 *      报「copy is not defined」；而 node --check 照样通过（成对反引号语法合法）。
 *   ② 正则里写 \/ → 被 cook 成 / → 到页面上成了非法正则 → 整段断言 Uncaught。
 * 所以判据必须是：**按真实 cook 的结果**再做一次语法检查。
 *
 * 用法：node tools/check-injected.js [verify-ui.js 路径]（默认 tools/verify-ui.js）
 */
const fs = require('fs');
const file = process.argv[2] || 'tools/verify-ui.js';
const src = fs.readFileSync(file, 'utf8');

const names = [];
const re = /const\s+([A-Z0-9_]+)\s*=\s*`/g;
let m;
while ((m = re.exec(src))) names.push({ name: m[1], start: m.index, tplStart: m.index + m[0].length - 1 });

function findClose(from) {
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
  }
  return -1;
}

let bad = 0;

/* 第 0 关（最重要，先跑）：整个文件按真实解析器走一遍。
 * 少了这一关会漏掉最阴的一种：注释里出现**裸反引号** → 模板字符串提前闭合 →
 * 文件不过解析器（SyntaxError: Invalid or unexpected token）；而下面的 substring + eval
 * 照样能"通过"，因为被截断出来的那一段本身语法合法。2026-09-15 就是这样白跑一轮。 */
try {
  new (require('vm').Script)(src, { filename: file });
  console.log('  PASS  整文件解析（模板字符串没有被提前闭合）');
} catch (err) {
  console.log('  FAIL  整文件解析 → ' + err.message);
  bad++;
}

names.forEach(({ name, tplStart }) => {
  const end = findClose(tplStart);
  if (end < 0) { console.log('  FAIL  ' + name + '：模板字符串未闭合'); bad++; return; }
  const raw = src.slice(tplStart, end + 1);
  let cooked;
  try {
    // eval 对模板字符串的 cook 规则与运行时完全一致
    cooked = eval(raw);
  } catch (err) {
    console.log('  FAIL  ' + name + '：cook 失败 → ' + err.message); bad++; return;
  }
  const stray = (cooked.match(/\$\{/g) || []).length;
  try {
    // 运行时是包在 (async () => { ... }) 里执行的（见 runAt），所以这里也要包一层，
    // 否则满屏的 await 会被误报成语法错误。
    new Function('return (async () => {\n' + cooked + '\n})');   // 只做语法检查，不执行
  } catch (err) {
    console.log('  FAIL  ' + name + '：cook 后语法错误 → ' + err.message); bad++;
    const at = Number((err.message.match(/position (\d+)/) || [])[1]);
    if (!Number.isNaN(at)) {
      const upto = cooked.slice(0, at);
      const line = upto.split('\n').length;
      console.log('        定位≈注入脚本第 ' + line + ' 行：' +
        cooked.split('\n')[line - 1].trim().slice(0, 120));
    }
    return;
  }
  // 顺带报出 cook 后仍残留的可疑字符（不该有：cook 过之后不该还有裸反斜杠转义）
  const suspicious = [];
  cooked.split('\n').forEach((l, i) => { if (l.indexOf('\\') >= 0) suspicious.push(i + 1); });
  console.log('  PASS  ' + name + '（' + cooked.length + ' 字符，含里层 ${ 占位 ' + stray +
    ' 处）' + (suspicious.length ? '  ⚠️ 仍有反斜杠的行: ' + suspicious.join(',') : ''));
});
console.log(bad === 0 ? '\n全部注入脚本 cook 后语法合法 ✅' : '\n' + bad + ' 个注入脚本有问题 ❌');
process.exit(bad === 0 ? 0 : 1);
