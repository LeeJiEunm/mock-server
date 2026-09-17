'use strict';

/**
 * lib/render.js —— 响应渲染（纯函数）
 *
 *   static 模式：正文按 {{}} 模板替换（renderTemplate）
 *   script 模式：正文由一小段 JS 生成（vm 沙箱 + 编译缓存 + 超时 + 长度上限，仅内网工具用途）
 *   malformedBody：把正文截半，用于「上游返回半截 JSON」的故障注入
 *
 * FAULT_TYPES 放在这里而不是 server.js：它只被渲染（校验）与配置归一化用到，
 * 谁校验谁持有，避免常量散在两处。
 */

const crypto = require('crypto');
const vm = require('vm');

const { pick } = require('./matching');

/* 故障注入类型：none 正常 / timeout 挂起不返回 / malformed 截断响应体 / abort 直接断开连接。
 * 三种故障分别对应客户端三种可观测现象：请求超时、JSON 解析失败、连接被重置。
 * 放这里是因为「谁校验谁持有」：renderResponse 按它校验 interface 里填的值，
 * server.js 的配置归一化也用同一份（从本模块 import），避免同一个常量两处定义。 */
const FAULT_TYPES = ['none', 'timeout', 'malformed', 'abort'];

/* ==========================================================================
 * 脚本模式开关与编译缓存（Codex 审查点⑦：同进程执行任意 JS + 每请求重编译）
 * ==========================================================================
 * 默认开启以兼容既有配置（示例接口 demo-sample 的 r4 就是 script 响应）。
 * 显式把 config.scriptMode 设为 false 即可关闭——关闭后任何 script 响应直接返回 403，
 * 等效于「禁止在服务端进程内执行用户脚本」。
 *
 * 安全提示：script 响应在 vm 沙箱里同步执行，但仍是进程内的动态代码（内网测试工具用途），
 * 不应把管理端口暴露到公网；如环境不需要脚本能力，把它关掉即可。 */
let allowScriptMode = true;
function setAllowScriptMode(v) { allowScriptMode = !!v; }
function isScriptModeAllowed() { return allowScriptMode; }

/* 脚本防护上限：死循环 / 超大脚本会把事件循环卡住，连管理界面一起停。
 * 超时与长度都留了环境变量入口，默认值对"按请求数组生成响应"的小脚本足够。 */
const SCRIPT_MAX_LEN = Math.max(1, Number(process.env.MOCK_SCRIPT_MAX_LEN) || 64 * 1024);
const SCRIPT_TIMEOUT_MS = Math.max(1, Number(process.env.MOCK_SCRIPT_TIMEOUT_MS) || 1000);

/* 编译缓存：同一段脚本文本只编译一次 vm.Script，避免每个请求都重新 parse。
 * 上限 256 条，超限整体清空重建，防止长期运行内存只增不减。 */
const scriptCache = new Map();
const SCRIPT_CACHE_MAX = 256;
function compileScript(text) {
  const cached = scriptCache.get(text);
  if (cached !== undefined) return cached;
  /* 用 IIFE 包一层：脚本正文语义与旧版 new Function('ctx','helpers', body) 一致，
   * return 可以直接用；超时在 runInNewContext 时按次生效，编译只发生一次。 */
  const code = '(function(ctx, helpers) {\n' + (text || 'return {};') + '\n})(ctx, helpers);';
  const script = new vm.Script(code);
  if (scriptCache.size >= SCRIPT_CACHE_MAX) scriptCache.clear();
  scriptCache.set(text, script);
  return script;
}

/* ==========================================================================
 * 五、响应渲染
 * ========================================================================== */

/** 模板变量：{{body.x}} {{query.x}} {{header.host}} {{vars.x}} {{now}} {{ts}} {{uuid}} {{random}} */
function renderTemplate(text, ctx) {
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const key = expr.trim();
    try {
      if (key === 'now') return new Date().toLocaleString('zh-CN', { hour12: false });
      if (key === 'ts') return String(Date.now());
      if (key === 'uuid') return crypto.randomUUID();
      if (key === 'random') return String(Math.floor(Math.random() * 1000000));

      const dot = key.indexOf('.');
      if (dot > 0) {
        const head = key.slice(0, dot);
        const rest = key.slice(dot + 1);
        let node = null;
        if (head === 'body') node = ctx.body;
        else if (head === 'query') node = ctx.query;
        else if (head === 'header') node = ctx.headers;
        else if (head === 'vars') node = ctx.vars;
        if (node !== null) {
          const values = pick(node, rest);
          const value = values[0];
          if (value === undefined || value === null) return '';
          return typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
      }
      return '';
    } catch (e) {
      return whole;
    }
  });
}

const helpers = {
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  base64: (text) => Buffer.from(String(text), 'utf8').toString('base64'),
  pick,
};

/**
 * 生成响应。两种模式：
 *   static —— 响应体按 {{}} 模板替换
 *   script —— 响应体由一小段 JS 生成，可访问 ctx.body / ctx.query / ctx.headers / ctx.vars
 *             （vm 沙箱内同步执行；allowScriptMode=false 时禁用，返回 403）
 * @param {object} opts 可选：{ scriptTimeoutMs, scriptMaxLen }，供自检传小值
 */
function renderResponse(response, ctx, opts) {
  const o = opts || {};
  const scriptTimeoutMs = Math.max(1, Number(o.scriptTimeoutMs) || SCRIPT_TIMEOUT_MS);
  const scriptMaxLen = Math.max(1, Number(o.scriptMaxLen) || SCRIPT_MAX_LEN);
  /* 延迟：delayMaxMs > delayMs 时按区间随机（如 800~1200 模拟真实抖动），否则就是固定值。
   * 这里算出来的延迟是「本次实际等待」，试打结果与请求日志展示的也是它。 */
  const minDelay = Math.max(0, Number(response.delayMs) || 0);
  const maxDelay = Math.max(minDelay, Number(response.delayMaxMs) || 0);
  const result = {
    status: Number(response.status) || 200,
    contentType: response.contentType || 'application/json;charset=UTF-8',
    delayMs: maxDelay > minDelay ? minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1)) : minDelay,
    delayMinMs: minDelay,
    delayMaxMs: maxDelay,
    fault: FAULT_TYPES.indexOf(response.fault) >= 0 ? response.fault : 'none',
    body: '',
    error: null,
  };

  if (response.mode === 'script') {
    if (!allowScriptMode) {
      result.status = 403;
      result.error = '脚本模式未开启（allowScriptMode=false）';
      result.body = JSON.stringify({ mockError: '脚本模式已禁用', detail: result.error });
    } else {
      const source = response.script || 'return {};';
      if (Buffer.byteLength(source, 'utf8') > scriptMaxLen) {
        result.status = 500;
        result.error = '脚本超过长度上限 ' + scriptMaxLen + ' 字节（当前 ' + Buffer.byteLength(source, 'utf8') + ' 字节）';
        result.body = JSON.stringify({ mockError: '脚本执行失败', detail: result.error });
        return result;
      }
      try {
        const script = compileScript(source);
        const out = script.runInNewContext({ ctx: ctx, helpers: helpers }, { timeout: scriptTimeoutMs });
        result.body = typeof out === 'string' ? out : JSON.stringify(out);
      } catch (err) {
        result.status = 500;
        result.error = String(err && err.message ? err.message : err);
        result.body = JSON.stringify({ mockError: '脚本执行失败', detail: result.error });
      }
    }
  } else {
    result.body = renderTemplate(response.body || '', ctx);
  }
  return result;
}

/**
 * 畸形响应体：截掉一半并去掉尾部的闭合符，让客户端 JSON.parse 必然失败。
 * 用来模拟「上游返回了半截 JSON」这种真实故障，客户端应当表现为解析错误而不是拿到空对象。
 */
function malformedBody(body) {
  const text = String(body === undefined || body === null ? '' : body);
  const cut = Math.max(1, Math.floor(text.length / 2));
  return text.slice(0, cut).replace(/[\s}\]]+$/, '');
}

module.exports = {
  FAULT_TYPES: FAULT_TYPES,
  helpers: helpers,
  renderTemplate: renderTemplate,
  renderResponse: renderResponse,
  malformedBody: malformedBody,
  setAllowScriptMode: setAllowScriptMode,
  isScriptModeAllowed: isScriptModeAllowed,
};
