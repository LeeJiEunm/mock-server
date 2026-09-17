#!/usr/bin/env node
'use strict';

// verify-globals.js — guard the classic-script global scope.
//
// The console uses plain <script> files with a shared global lexical scope.
// If two files declare the same top-level `const`/`let`/`class`/`function`,
// the page dies with a SyntaxError before any UI can render. This checker
// scans public/scripts and fails when a top-level name appears more than once.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'public', 'scripts');
const FILES = [
  'i18n.js', 'state.js', 'core.js', 'theme.js', 'auth.js', 'api-list.js',
  'groups.js', 'workspace.js', 'try-logs.js', 'drawer.js', 'app.js',
].filter((name) => fs.existsSync(path.join(SCRIPTS, name)));

const TOP_LEVEL_DECL_RE = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)|^\s*function\s+([A-Za-z_$][\w$]*)/;

const seen = new Map();
let failures = 0;

for (const file of FILES) {
  const text = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  text.split('\n').forEach((line, index) => {
    const hit = TOP_LEVEL_DECL_RE.exec(line);
    if (!hit) return;
    const name = hit[1] || hit[2];
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(`${file}:${index + 1}`);
  });
}

for (const [name, locations] of seen) {
  if (locations.length > 1) {
    failures += 1;
    console.log(`  FAIL 顶层声明重名 ${name}`);
    locations.forEach((loc) => console.log(`         ${loc}`));
  }
}

if (failures) {
  console.error(`\n✗ 发现 ${failures} 个跨文件顶层声明重名。`);
  process.exit(1);
}
console.log(`\n✓ 未发现跨文件顶层声明重名（共扫描 ${FILES.length} 个 script 文件）。`);
