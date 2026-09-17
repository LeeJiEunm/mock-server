'use strict';

/**
 * lib/matching.js —— 接口匹配引擎（纯函数，不碰任何全局状态）
 *
 * 两块内容：
 *   1. JSON 路径取值：a.b.c / a[0].b / a[*].b，统一返回数组（无匹配 = 空数组）
 *   2. 条件匹配：evalCondition（单条件）与 matchRules（按规则顺序取第一条命中）
 *
 * 之所以能整块搬出来：这里没有一个函数读 config / logs / sessions ——
 * 所有输入都来自参数（api、ctx），所以搬完 server.js 只需换调用点，不需要改状态归属。
 */
/* ==========================================================================
 * 三、JSON 路径取值
 *   支持 a.b.c、a[0].b、a[*].b（数组通配，收集全部匹配值）
 *   取值统一返回数组：无匹配为空数组，条件判断里"任一命中即为真"
 * ========================================================================== */

const PATH_TOKEN_RE = /([^.[\]]+)|\[(\*|\d+)\]/g;

/* 路径解析结果按表达式字符串缓存（Codex 审查点⑩：避免 pick() 每次都重新正则解析）。
 * 上限 1024 条，超限整体清空重建，防止长期运行内存只增不减。 */
const tokenCache = new Map();
const TOKEN_CACHE_MAX = 1024;

function tokenizePath(expr) {
  const cached = tokenCache.get(expr);
  if (cached !== undefined) return cached;
  const text = String(expr || '').trim().replace(/^\$\.?/, '');
  const tokens = [];
  let matched;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((matched = PATH_TOKEN_RE.exec(text)) !== null) {
    if (matched[1] !== undefined) {
      tokens.push({ kind: 'key', value: matched[1] });
    } else if (matched[2] === '*') {
      tokens.push({ kind: 'wild' });
    } else {
      tokens.push({ kind: 'index', value: Number(matched[2]) });
    }
  }
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(expr, tokens);
  return tokens;
}

/** 从 node 上按 tokens 递归收集取值；i 为当前 token 游标（不再每次 slice 出新数组，Codex 审查点⑩） */
function collectValues(node, tokens, out, i) {
  i = i || 0;
  if (i >= tokens.length) {
    out.push(node);
    return;
  }
  if (node === null || node === undefined) return;

  const head = tokens[i];

  if (head.kind === 'key') {
    if (Array.isArray(node)) {
      // 数组上直接取字段：自动逐元素展开（写 list.name 也能拿到所有 name）；
      // 注意：展平元素时仍停留在同一 token（head），不前进游标
      node.forEach((item) => collectValues(item, tokens, out, i));
    } else if (typeof node === 'object') {
      collectValues(node[head.value], tokens, out, i + 1);
    }
    return;
  }

  if (head.kind === 'index') {
    if (Array.isArray(node)) collectValues(node[head.value], tokens, out, i + 1);
    return;
  }

  // wild：数组逐元素 / 对象逐值
  if (Array.isArray(node)) {
    node.forEach((item) => collectValues(item, tokens, out, i + 1));
  } else if (typeof node === 'object') {
    Object.keys(node).forEach((key) => collectValues(node[key], tokens, out, i + 1));
  }
}

function pick(source, expr) {
  if (source === null || source === undefined) return [];
  if (typeof source !== 'object') {
    // 原始字符串（如 raw 请求体）只能整体比较，表达式无意义
    return [source];
  }
  const out = [];
  collectValues(source, tokenizePath(expr), out, 0);
  return out.filter((value) => value !== undefined);
}

/* ==========================================================================
 * 四、条件匹配
 * ========================================================================== */

function compareOne(actual, op, expected) {
  const text = actual === null || actual === undefined ? '' : String(actual);
  const expectText = expected === null || expected === undefined ? '' : String(expected);

  switch (op) {
    case 'eq':
    case 'ne': {
      // 数字优先：双方都能转成数字时按数值比较（避免 "100" != 100）
      const a = Number(text), b = Number(expectText);
      const equal = (text !== '' && expectText !== '' && !Number.isNaN(a) && !Number.isNaN(b))
        ? a === b
        : text.trim() === expectText.trim();
      return op === 'eq' ? equal : !equal;
    }
    case 'contains': return text.includes(expectText);
    case 'notContains': return !text.includes(expectText);
    case 'startsWith': return text.startsWith(expectText);
    case 'endsWith': return text.endsWith(expectText);
    case 'regex':
      try { return new RegExp(expectText).test(text); } catch (e) { return false; }
    case 'in': return expectText.split(',').map((s) => s.trim()).some((s) => s === text.trim());
    case 'notIn': return !expectText.split(',').map((s) => s.trim()).some((s) => s === text.trim());
    case 'gt': return Number(text) > Number(expectText);
    case 'gte': return Number(text) >= Number(expectText);
    case 'lt': return Number(text) < Number(expectText);
    case 'lte': return Number(text) <= Number(expectText);
    default: return false;
  }
}

function evalCondition(condition, ctx) {
  const op = condition.op || 'eq';
  // 前端把"请求头"来源写作 header，上下文里存的是 headers，这里做一次映射
  const sourceKey = condition.source === 'header' ? 'headers' : condition.source;
  const values = condition.source === 'raw'
    ? [ctx.raw]
    : pick(ctx[sourceKey] || {}, condition.path);

  if (op === 'exists') {
    return values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  if (op === 'notExists') {
    return !values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  if (op === 'empty') {
    return values.length === 0 || values.every((v) => v === null || v === undefined || String(v) === '');
  }
  if (op === 'notEmpty') {
    return values.some((v) => v !== null && v !== undefined && String(v) !== '');
  }
  return values.some((value) => compareOne(value, op, condition.value));
}

/** 生成判定说明，供"试打一枪"的链路展示 */
function describeMatch(rule, hit) {
  if (rule.conditions.length === 0) return '无条件 · 恒命中';
  const joiner = rule.match === 'any' ? '任一条件' : '全部条件';
  if (hit) return joiner + '满足';
  return rule.match === 'any' ? '条件均不满足' : '存在条件不满足';
}

/** 返回 { rule, trace } —— trace 记录每条规则的判定结果，供"试打一枪"展示 */
function matchRules(api, ctx) {
  const trace = [];
  for (const rule of api.rules) {
    if (!rule.enabled) {
      trace.push({ ruleId: rule.id, ruleName: rule.name, hit: false, reason: '规则已停用' });
      continue;
    }
    const results = rule.conditions.map((condition) => evalCondition(condition, ctx));
    const hit = rule.conditions.length === 0
      ? true
      : (rule.match === 'any' ? results.some(Boolean) : results.every(Boolean));
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      hit,
      reason: describeMatch(rule, hit),
    });
    if (hit) return { rule, trace };
  }
  return { rule: null, trace };
}

module.exports = {
  tokenizePath: tokenizePath,
  collectValues: collectValues,
  pick: pick,
  compareOne: compareOne,
  evalCondition: evalCondition,
  describeMatch: describeMatch,
  matchRules: matchRules,
};
