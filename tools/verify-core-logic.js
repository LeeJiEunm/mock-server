#!/usr/bin/env node
'use strict';

// verify-core-logic.js — pure-function unit tests for lib/matching.js and
// lib/render.js. Zero dependencies, no browser, no spawned server.
//
// The server keeps config/logs/sessions inside server.js on purpose, so pure
// logic that only reads its arguments lives in lib/ and can be required here.
// These assertions pin the matching engine, template rendering, the script
// sandbox (length cap + vm timeout), and the fault/malformed helpers.

const assert = require('node:assert');

const {
  tokenizePath, pick, compareOne, evalCondition, matchRules,
} = require('../lib/matching');
const {
  FAULT_TYPES, renderTemplate, renderResponse, malformedBody,
  setAllowScriptMode, isScriptModeAllowed,
} = require('../lib/render');
const {
  normalizeMeta, configRevOf, apiFingerprint, diffConfig, stampAuthors,
} = require('../lib/config-logic');

let checks = 0;
let failures = 0;

function test(name, fn) {
  try {
    fn();
    checks += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failures += 1;
    console.log('  FAIL ' + name + '\n         → ' + (err && err.message ? err.message : err));
  }
}

function note(label) {
  console.log('\n' + label);
}

/* ------------------------------------------------------------- matching */

note('A. JSON 路径取值与条件匹配');

test('tokenizePath splits keys, indices and wildcards', () => {
  const tokens = tokenizePath('a.b[0].c[*]');
  assert.deepStrictEqual(tokens.map((t) => t.kind), ['key', 'key', 'index', 'key', 'wild']);
});

test('pick expands arrays when reading a field directly', () => {
  const src = { list: [{ name: 'a' }, { name: 'b' }] };
  assert.deepStrictEqual(pick(src, 'list[*].name'), ['a', 'b']);
  assert.deepStrictEqual(pick(src, 'list.name'), ['a', 'b']);
});

test('pick on a missing path returns an empty array', () => {
  assert.deepStrictEqual(pick({ a: 1 }, 'b.c'), []);
});

test('compareOne compares numeric strings numerically', () => {
  assert.strictEqual(compareOne('100', 'eq', 100), true);
  assert.strictEqual(compareOne('100', 'ne', 100), false);
  assert.strictEqual(compareOne('100', 'gt', 99), true);
});

test('compareOne supports contains, startsWith and regex', () => {
  assert.strictEqual(compareOne('hello world', 'contains', 'world'), true);
  assert.strictEqual(compareOne('hello world', 'startsWith', 'hello'), true);
  assert.strictEqual(compareOne('abc123', 'regex', '^[a-z]+\\d+$'), true);
});

test('evalCondition maps header source to the headers context', () => {
  const ctx = { body: { code: '404' }, headers: { 'x-token': 'abc' }, query: {}, raw: 'hello' };
  assert.strictEqual(evalCondition({ source: 'header', path: 'x-token', op: 'eq', value: 'abc' }, ctx), true);
  assert.strictEqual(evalCondition({ source: 'body', path: 'code', op: 'eq', value: '404' }, ctx), true);
  assert.strictEqual(evalCondition({ source: 'query', path: 'page', op: 'exists' }, ctx), false);
});

test('matchRules returns the first enabled hit and a trace', () => {
  const api = {
    rules: [
      { id: 'r1', name: 'one', enabled: true, match: 'all', conditions: [{ source: 'body', path: 'code', op: 'eq', value: '500' }], response: { status: 500 } },
      { id: 'r2', name: 'two', enabled: true, match: 'all', conditions: [{ source: 'body', path: 'code', op: 'eq', value: '404' }], response: { status: 404 } },
    ],
  };
  const { rule, trace } = matchRules(api, { body: { code: '404' } });
  assert.strictEqual(rule.id, 'r2');
  assert.strictEqual(trace.length, 2);
  assert.strictEqual(trace[0].hit, false);
  assert.strictEqual(trace[1].hit, true);
});

test('matchRules stops at an unconditional rule', () => {
  const api = {
    rules: [
      { id: 'r1', name: 'catch-all', enabled: true, match: 'all', conditions: [], response: { status: 200 } },
    ],
  };
  const { rule } = matchRules(api, { body: {} });
  assert.strictEqual(rule.id, 'r1');
});

test('matchRules skips disabled rules and respects any/all', () => {
  const api = {
    rules: [
      { id: 'off', name: 'off', enabled: false, match: 'all', conditions: [], response: { status: 200 } },
      { id: 'any', name: 'any', enabled: true, match: 'any', conditions: [
        { source: 'body', path: 'a', op: 'eq', value: '1' },
        { source: 'body', path: 'b', op: 'eq', value: '2' },
      ], response: { status: 201 } },
    ],
  };
  const { rule, trace } = matchRules(api, { body: { b: '2' } });
  assert.strictEqual(rule.id, 'any');
  assert.strictEqual(trace[0].reason.indexOf('已停用') >= 0, true);
});

/* --------------------------------------------------------------- render */

note('B. 模板、响应与脚本沙箱');

test('renderTemplate substitutes body/query/header/vars', () => {
  const ctx = { body: { code: 'ok' }, query: { page: '2' }, headers: { host: 'x' }, vars: { hint: 'hi' } };
  const out = renderTemplate('{{body.code}} {{query.page}} {{header.host}} {{vars.hint}}', ctx);
  assert.strictEqual(out, 'ok 2 x hi');
});

test('renderTemplate leaves unknown placeholders empty', () => {
  assert.strictEqual(renderTemplate('a={{body.missing}}', { body: {} }), 'a=');
});

test('renderResponse static keeps delay within the configured range', () => {
  const out = renderResponse({ mode: 'static', status: 200, delayMs: 100, delayMaxMs: 200, fault: 'nope', body: '{}' }, {});
  assert.strictEqual(out.status, 200);
  assert.ok(out.delayMs >= 100 && out.delayMs <= 200);
  assert.strictEqual(out.fault, 'none');
});

test('renderResponse script can read ctx and helpers', () => {
  const out = renderResponse({
    mode: 'script',
    script: 'return { n: ctx.body.n + 1, u: helpers.uuid().length };',
  }, { body: { n: 2 } });
  assert.strictEqual(out.status, 200);
  const parsed = JSON.parse(out.body);
  assert.strictEqual(parsed.n, 3);
  assert.strictEqual(parsed.u, 36);
});

test('renderResponse script returns strings as-is', () => {
  const out = renderResponse({ mode: 'script', script: 'if (ctx.body.ok) return "yes"; return "no";' }, { body: { ok: true } });
  assert.strictEqual(out.body, 'yes');
});

test('renderResponse script syntax errors return 500', () => {
  const out = renderResponse({ mode: 'script', script: 'return {' }, {});
  assert.strictEqual(out.status, 500);
  assert.ok(out.body.indexOf('mockError') >= 0);
});

test('renderResponse script timeouts return 500 instead of hanging', () => {
  const out = renderResponse({ mode: 'script', script: 'while (true) {}' }, {}, { scriptTimeoutMs: 30 });
  assert.strictEqual(out.status, 500);
  assert.ok(out.body.indexOf('mockError') >= 0);
  assert.ok((out.error || '').toLowerCase().indexOf('time') >= 0);
});

test('renderResponse enforces the script length cap', () => {
  const out = renderResponse({ mode: 'script', script: 'return "x";' }, {}, { scriptMaxLen: 10 });
  assert.strictEqual(out.status, 500);
  assert.ok(out.error.indexOf('长度上限') >= 0);
});

test('renderResponse returns 403 when script mode is disabled', () => {
  assert.strictEqual(isScriptModeAllowed(), true);
  setAllowScriptMode(false);
  try {
    const out = renderResponse({ mode: 'script', script: 'return 1;' }, {});
    assert.strictEqual(out.status, 403);
  } finally {
    setAllowScriptMode(true);
  }
});

test('malformedBody cuts the response so JSON parsing fails', () => {
  const broken = malformedBody('{"ok":true}');
  assert.strictEqual(broken.length < '{"ok":true}'.length, true);
  assert.throws(() => JSON.parse(broken));
});

test('FAULT_TYPES covers the four documented faults', () => {
  assert.deepStrictEqual(FAULT_TYPES, ['none', 'timeout', 'malformed', 'abort']);
});

/* ------------------------------------------------------------ config-logic */

note('C. 配置版本、指纹与 diff');

test('normalizeMeta defaults rev to 0 and clamps bad values', () => {
  assert.deepStrictEqual(normalizeMeta({}), { rev: 0 });
  assert.deepStrictEqual(normalizeMeta({ projectName: 'x', rev: -3 }), { projectName: 'x', rev: 0 });
  assert.deepStrictEqual(normalizeMeta({ rev: 2.9 }), { rev: 2 });
});

test('configRevOf reads the normalized version', () => {
  assert.strictEqual(configRevOf({}), 0);
  assert.strictEqual(configRevOf({ meta: { rev: 5 } }), 5);
});

test('apiFingerprint includes method and rule details', () => {
  const fp = apiFingerprint({ id: 'x', name: 'n', method: 'GET', rules: [{ id: 'r', name: 'one' }] });
  assert.strictEqual(typeof fp, 'string');
  assert.strictEqual(fp.indexOf('"method":"GET"') >= 0, true);
});

test('diffConfig detects add/remove/update and method change', () => {
  const before = { apis: [
    { id: 'a1', name: 'old', path: 'same', method: 'GET', enabled: true, rules: [] },
    { id: 'a2', name: 'gone', path: 'gone', method: 'ALL', enabled: true, rules: [] },
  ] };
  const after = { apis: [
    { id: 'a1', name: 'old', path: 'same', method: 'POST', enabled: true, rules: [] },
    { id: 'a3', name: 'newapi', path: 'new', method: 'GET', enabled: true, rules: [] },
  ] };
  const entries = diffConfig(before, after);
  assert.strictEqual(entries.some((e) => e.action === 'api.add' && e.apiId === 'a3'), true);
  assert.strictEqual(entries.some((e) => e.action === 'api.remove' && e.apiId === 'a2'), true);
  assert.strictEqual(entries.some((e) => e.action === 'api.update' && e.apiId === 'a1'), true);
});

test('stampAuthors stamps only the touched api/rule entities', () => {
  const apis = [{ id: 'a1', name: 'n', rules: [{ id: 'r1' }, { id: 'r2' }] }, { id: 'a2', rules: [] }];
  stampAuthors([{ apiId: 'a1', ruleId: 'r1' }], 'alice', 123, apis);
  assert.strictEqual(apis[0].updatedBy, 'alice');
  assert.strictEqual(apis[0].rules[0].updatedAt, 123);
  assert.strictEqual(apis[0].rules[1].updatedAt, undefined);
  assert.strictEqual(apis[1].updatedAt, undefined);
});

/* -------------------------------------------------------------- summary */

if (failures) {
  console.error('\n✗ ' + failures + ' of ' + checks + ' assertions failed');
  process.exit(1);
}
console.log('\n✓ All ' + checks + ' core-logic assertions passed.');
