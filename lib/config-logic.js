'use strict';

/**
 * lib/config-logic.js —— 配置层纯逻辑（不依赖全局 config / sessions / logs）
 *
 * server.js 只负责持有状态和路由；配置的「归一化、版本号、指纹、diff、stamp」这些
 * 只吃参数的函数放这里，方便用 node:assert 直接单测。
 */

const crypto = require('crypto');
const { FAULT_TYPES } = require('./render');

/** meta 兜底：保证存在对象和整数版本号（老配置没有 rev 时从 0 开始） */
function normalizeMeta(meta) {
  const out = Object.assign({}, meta && typeof meta === 'object' ? meta : {});
  const rev = Number(out.rev);
  out.rev = Number.isFinite(rev) ? Math.max(0, Math.floor(rev)) : 0;
  return out;
}

/** 从配置对象读取当前版本号 */
function configRevOf(config) {
  const meta = config && config.meta && typeof config.meta === 'object' ? config.meta : {};
  return Number.isFinite(Number(meta.rev)) ? Math.max(0, Math.floor(Number(meta.rev))) : 0;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** method 归一化：老配置没有/空/ALL 都按 ALL（匹配所有方法）；其余只在明确 HTTP 方法时保留 */
function normalizeMethod(value) {
  const m = String(value == null ? '' : value).trim().toUpperCase();
  return m === 'ALL' || HTTP_METHODS.indexOf(m) >= 0 ? (m || 'ALL') : 'ALL';
}

/** method 是否命中当前请求 */
function apiMethodMatches(api, method) {
  const m = String(api.method || '').trim().toUpperCase();
  if (!m || m === 'ALL' || m === '*') return true;
  return m === String(method || '').trim().toUpperCase();
}

/** 摘要一条规则的关键信息，用来做「改了哪条」的对比 */
function ruleFingerprint(rule) {
  return JSON.stringify({
    name: rule.name || '',
    enabled: rule.enabled !== false,
    match: rule.match || 'all',
    conditions: rule.conditions || [],
    response: rule.response || null,
  });
}

function apiFingerprint(api) {
  return JSON.stringify({
    name: api.name || '',
    enabled: api.enabled !== false,
    module: api.module || '',
    path: api.path || '',
    method: api.method || 'ALL',
    desc: api.desc || '',
    groupId: api.groupId || '',
    proxy: api.proxy || null,
    vars: api.vars || null,
    defaultResponse: api.defaultResponse || null,
    rules: (api.rules || []).map(ruleFingerprint),
  });
}

/**
 * 对比新旧配置，列出这次保存到底改了什么。
 * 返回 entries —— entries 直接进变更流水，summary 给保存提示用。
 */
function diffConfig(before, after) {
  const entries = [];
  const oldApis = new Map(((before && before.apis) || []).map((api) => [api.id, api]));
  const newApis = new Map(((after && after.apis) || []).map((api) => [api.id, api]));

  newApis.forEach((api, id) => {
    const old = oldApis.get(id);
    if (!old) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.add', detail: '新增接口（含 ' + (api.rules || []).length + ' 条规则）' });
      return;
    }
    const oldRules = new Map((old.rules || []).map((rule) => [rule.id, rule]));
    const newRules = new Map((api.rules || []).map((rule) => [rule.id, rule]));
    newRules.forEach((rule, ruleId) => {
      const oldRule = oldRules.get(ruleId);
      if (!oldRule) {
        entries.push({ apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.add', detail: '新增规则「' + (rule.name || ruleId) + '」' });
      } else if (ruleFingerprint(oldRule) !== ruleFingerprint(rule)) {
        const changed = [];
        if ((oldRule.name || '') !== (rule.name || '')) changed.push('名称');
        if ((oldRule.enabled !== false) !== (rule.enabled !== false)) changed.push(rule.enabled === false ? '停用' : '启用');
        if (JSON.stringify(oldRule.conditions || []) !== JSON.stringify(rule.conditions || [])) changed.push('条件');
        if (oldRule.match !== rule.match) changed.push('匹配方式');
        if (JSON.stringify(oldRule.response || null) !== JSON.stringify(rule.response || null)) changed.push('响应');
        entries.push({
          apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.update',
          detail: '修改规则「' + (rule.name || ruleId) + '」：' + (changed.join(' / ') || '内容'),
        });
      }
    });
    oldRules.forEach((rule, ruleId) => {
      if (!newRules.has(ruleId)) {
        entries.push({ apiId: id, apiName: api.name || '', ruleId: ruleId, action: 'rule.remove', detail: '删除规则「' + (rule.name || ruleId) + '」' });
      }
    });
    const orderBefore = (old.rules || []).map((rule) => rule.id).join(',');
    const orderAfter = (api.rules || []).map((rule) => rule.id).join(',');
    if (orderBefore !== orderAfter && (old.rules || []).length === (api.rules || []).length) {
      const sameMembers = (old.rules || []).every((rule) => newRules.has(rule.id));
      if (sameMembers) {
        entries.push({ apiId: id, apiName: api.name || '', action: 'rule.order', detail: '调整规则顺序' });
      }
    }
    if (apiFingerprint(old) === apiFingerprint(api)) return;
    if ((old.name || '') !== (api.name || '') || (old.path || '') !== (api.path || '') ||
        (old.method || 'ALL') !== (api.method || 'ALL') ||
        (old.module || '') !== (api.module || '') || (old.desc || '') !== (api.desc || '') ||
        JSON.stringify(old.proxy || null) !== JSON.stringify(api.proxy || null) ||
        JSON.stringify(old.vars || null) !== JSON.stringify(api.vars || null) ||
        JSON.stringify(old.defaultResponse || null) !== JSON.stringify(api.defaultResponse || null) ||
        (old.groupId || '') !== (api.groupId || '') ||
        (old.enabled !== false) !== (api.enabled !== false)) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.update', detail: '修改接口设置' });
    }
  });

  oldApis.forEach((api, id) => {
    if (!newApis.has(id)) {
      entries.push({ apiId: id, apiName: api.name || '', action: 'api.remove', detail: '删除接口（连带 ' + (api.rules || []).length + ' 条规则）' });
    }
  });

  return entries;
}

/** 给这次改动过的接口 / 规则盖上「谁、什么时候」的戳 */
function stampAuthors(entries, user, ts, apis) {
  const apiList = Array.isArray(apis) ? apis : [];
  const byApi = new Map();
  entries.forEach((entry) => {
    if (!byApi.has(entry.apiId)) byApi.set(entry.apiId, new Set());
    if (entry.ruleId) byApi.get(entry.apiId).add(entry.ruleId);
  });
  byApi.forEach((ruleIds, apiId) => {
    const api = apiList.find((row) => row.id === apiId);
    if (!api) return;
    api.updatedBy = user || '';
    api.updatedAt = ts;
    (api.rules || []).forEach((rule) => {
      if (ruleIds.has(rule.id)) {
        rule.updatedBy = user || '';
        rule.updatedAt = ts;
      }
    });
  });
}

module.exports = {
  normalizeMeta,
  configRevOf,
  HTTP_METHODS,
  normalizeMethod,
  apiMethodMatches,
  ruleFingerprint,
  apiFingerprint,
  diffConfig,
  stampAuthors,
};
