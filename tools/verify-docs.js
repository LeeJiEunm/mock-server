#!/usr/bin/env node
'use strict';

// verify-docs.js — guard that README.md (zh) and README.en.md (en) stay in
// structural parity. Every section / subsection heading in either file must
// carry an HTML marker `<!-- sec:xxx -->`; the SET of markers in both files
// must be identical. Language-agnostic: we compare section IDs, not heading
// text, so Chinese and English headings can differ freely.
//
// Usage:  node tools/verify-docs.js
// Exit 0 if the two files share the same section markers, 1 otherwise.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['README.md', 'README.en.md'];

const MARKER_RE = /<!--\s*sec:([\w-]+)\s*-->/g;

function collect(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`✗ missing file: ${file}`);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const ids = new Set();
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

const sets = {};
for (const f of FILES) sets[f] = collect(f);

const [a, b] = FILES;
const onlyA = [...sets[a]].filter((x) => !sets[b].has(x)).sort();
const onlyB = [...sets[b]].filter((x) => !sets[a].has(x)).sort();

console.log(`README parity check`);
console.log(`  ${a}: ${sets[a].size} section markers`);
console.log(`  ${b}: ${sets[b].size} section markers`);

if (onlyA.length === 0 && onlyB.length === 0) {
  console.log(`✓ OK — both READMEs share the same ${sets[a].size} section markers.`);
  process.exit(0);
}

console.error('');
if (onlyA.length) console.error(`✗ in ${a} but missing from ${b}:\n   - ${onlyA.join('\n   - ')}`);
if (onlyB.length) console.error(`✗ in ${b} but missing from ${a}:\n   - ${onlyB.join('\n   - ')}`);
console.error(`\nAdd the missing <!-- sec:xxx --> marker to the heading in the file that lacks it.`);
process.exit(1);
