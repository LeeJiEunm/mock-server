#!/usr/bin/env node
'use strict';

// verify-docs.js — guard that paired Chinese/English docs stay in structural
// parity. Every section / subsection heading in either file of a pair must
// carry an HTML marker `<!-- sec:xxx -->`; the SET of markers in both files
// of a pair must be identical. Language-agnostic: we compare section IDs, not
// heading text, so Chinese and English headings can differ freely.
//
// Usage:  node tools/verify-docs.js
// Exit 0 if every pair shares the same section markers, 1 otherwise.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Each pair: [zh file, en file]. Add more pairs here as new bilingual docs appear.
const PAIRS = [
  ['README.md', 'README.en.md'],
  ['docs/操作手册.md', 'docs/操作手册.en.md'],
];

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

let failed = false;

for (const [a, b] of PAIRS) {
  const sa = collect(a);
  const sb = collect(b);
  const onlyA = [...sa].filter((x) => !sb.has(x)).sort();
  const onlyB = [...sb].filter((x) => !sa.has(x)).sort();

  console.log(`Pair ${a}  ⇄  ${b}`);
  console.log(`  ${a}: ${sa.size} markers | ${b}: ${sb.size} markers`);

  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`  ✓ OK — same ${sa.size} section markers`);
  } else {
    failed = true;
    if (onlyA.length) console.error(`  ✗ in ${a} but missing from ${b}:\n    - ${onlyA.join('\n    - ')}`);
    if (onlyB.length) console.error(`  ✗ in ${b} but missing from ${a}:\n    - ${onlyB.join('\n    - ')}`);
  }
}

if (failed) {
  console.error(`\nAdd the missing <!-- sec:xxx --> marker to the heading in the file that lacks it.`);
  process.exit(1);
}

console.log(`\n✓ All ${PAIRS.length} doc pairs are in parity.`);
process.exit(0);
