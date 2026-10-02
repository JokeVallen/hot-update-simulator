// backend/core/faultRule.js
//
// 故障规则的「单一事实来源」：类型表、字段表、匹配器编译、规范化与校验。
//
// 为什么要单独抽一个 core 模块：
//   规则结构同时被三处使用 —— configManager 校验配置、faultInjector 执行、
//   routes/control 接收输入。放在任何一边都会造成反向依赖
//   （core 不能 require modules，那会让分层倒过来）。
//   core 不依赖任何其它层，所以两边都能安全地 require 它。

const { performance } = require('perf_hooks');

/** 全部故障类型。单一事实来源，别处一律从这里派生。 */
const FAULT_TYPES = ['status', 'timeout', 'slowHeader', 'abort', 'truncate', 'corrupt', 'empty'];

/**
 * 每种故障类型会用到哪些 action 字段。
 * 前端用它决定显示哪些输入框（并且会把不相关字段 disabled，避免
 * "看不见的值被静默提交"），后端用它做校验和归一化。
 */
const ACTION_FIELDS = {
  status: ['status', 'body'],
  timeout: [],
  slowHeader: ['delayMs'],
  abort: ['ratio'],
  truncate: ['ratio'],
  corrupt: ['ratio'],
  empty: [],
};

/** 故障类型的默认 action 值。 */
const ACTION_DEFAULTS = {
  status: 500,
  delayMs: 0,
  ratio: 0.5,
  body: '',
};

/** 允许出现的 match 字段。 */
const MATCH_FIELDS = ['method', 'pathPrefix', 'pathGlob', 'platform'];

const MAX_PATTERN_LENGTH = 256;
/** 参与匹配的 URL 最长长度。再长也只是浪费 CPU，没有实际意义。 */
const MAX_SUBJECT_LENGTH = 512;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把值规整成字符串数组；空值返回 null 表示"不限制"。 */
function toList(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((v) => String(v)).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

/**
 * 把 glob 编译成**线性时间**的正则。
 *
 * 这是本项目里唯一允许存在的动态正则来源，之所以用它而不是让使用者直接写
 * 正则表达式，是因为后者会造成 ReDoS：
 *
 *   实测 `(a|a)*$` 这类模式在 30 个字符的输入上就让 Node 单线程挂死了 90 秒，
 *   而 `safe-regex2` 这种成熟的静态检测器**也拦不住** `(a|a)*$`。
 *   静态分析本质上不可靠，所以最稳的做法是根本不接受任意正则。
 *
 * 由本函数生成的正则结构完全可控：只有 `.*` / `[^/]*` / `[^/]` 和转义后的
 * 字面量，不存在嵌套量词或分支重复，匹配代价与输入长度成正比。
 *
 * 支持的语法（刻意保持最小）：
 *   *   匹配除 / 以外的任意字符（含空）
 *   **  匹配任意字符（含 /），用于跨目录
 *   ?   匹配单个非 / 字符
 *   其余字符按字面量处理
 *
 * @param {string} glob
 * @returns {RegExp|null} 编译失败或过长时返回 null
 */
function compileGlob(glob) {
  if (typeof glob !== 'string') return null;
  const pattern = glob.trim();
  if (!pattern) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;

  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      // 转义所有正则元字符，保证它们只作为字面量参与匹配
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';

  try {
    return new RegExp(out);
  } catch {
    return null;
  }
}

/**
 * 编译一条规则的匹配器，并附上匹配函数。
 *
 * 关键点：**编译只发生一次**。原实现在每次请求、每条规则上都
 * `new RegExp(match.pathRegex)`，即使正则本身无害，也是持续的 CPU 浪费。
 *
 * @returns {{test:(url:string)=>boolean, errors:string[]}}
 */
function compileMatcher(match = {}) {
  const errors = [];
  const methods = toList(match.method);
  const prefixes = toList(match.pathPrefix);
  const platforms = toList(match.platform);
  const globs = toList(match.pathGlob);

  let globRegexes = [];
  if (globs) {
    globRegexes = globs.map((g) => compileGlob(g)).filter(Boolean);
    if (globRegexes.length !== globs.length) {
      errors.push(`pathGlob 里有无法编译的模式（长度上限 ${MAX_PATTERN_LENGTH}）：${globs.join(', ')}`);
    }
  }

  const test = (rawUrl, rawMethod) => {
    const url = String(rawUrl || '');
    // 截断：匹配只需要看路径前缀，长 URL 只会平白增加匹配代价
    const subject = url.length > MAX_SUBJECT_LENGTH ? url.slice(0, MAX_SUBJECT_LENGTH) : url;
    const pathOnly = subject.split('?')[0];

    if (methods && !methods.includes(String(rawMethod || '').toUpperCase())) return false;
    if (prefixes && !prefixes.some((p) => pathOnly.startsWith(p))) return false;
    if (globRegexes.length && !globRegexes.some((re) => re.test(pathOnly))) return false;
    return true;
  };

  return { test, errors, methods, platforms };
}

/** 从 URL 里取平台名。约定 /assets/{平台}/... 的第一段就是平台。 */
function platformFromUrl(url) {
  const pathOnly = String(url || '').split('?')[0];
  const parts = pathOnly.split('/').filter(Boolean);
  if (parts[0] === 'assets') return parts[1] || null;
  return null;
}

/**
 * 生成一条规则的稳定标识，用于命中计数。
 *
 * 为什么不用 `rule.id`：id 由调用方提供，可以重复。两条不同规则共用
 * 一个 id 时，它们的 maxHits 配额会被互相消耗（实测：第一条用掉配额后，
 * 第二条本应无限触发的规则也跟着失效）。加上下标就能区分。
 */
function ruleKey(rule, index) {
  const id = rule && rule.id ? String(rule.id) : 'rule';
  return `${id}#${index}`;
}

/**
 * 校验并规范化一条故障规则。
 *
 * 这里的定位是「最后一道防线」：无论输入来自 config.json 的手工编辑、
 * API 请求体，还是预置方案，都必须收敛成一个合法结构，绝不能抛异常
 * 或者把非法值原样放行（原实现里 `status: 99999` 会让注入变成真正的 500，
 * `probability: null` 会让规则永远不触发，`type` 拼错会静默降级成 500）。
 *
 * @param {object} input
 * @param {number} [index] 在规则数组里的下标，用于生成稳定标识
 * @returns {{ok:true, rule:object}|{ok:false, reason:string}}
 */
function normalizeRule(input, index = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: '规则必须是一个对象' };
  }

  const rawAction = input.action && typeof input.action === 'object' ? input.action : {};
  const type = FAULT_TYPES.includes(rawAction.type) ? rawAction.type : null;
  if (!type) {
    return {
      ok: false,
      reason: `未知的故障类型 ${JSON.stringify(rawAction.type)}，可用类型：${FAULT_TYPES.join(', ')}`,
    };
  }

  const rawMatch = input.match && typeof input.match === 'object' ? input.match : {};
  const match = {
    method: '',
    pathPrefix: '',
    pathGlob: '',
    platform: '',
  };
  for (const field of MATCH_FIELDS) {
    const value = rawMatch[field];
    if (value === undefined || value === null) continue;
    match[field] = Array.isArray(value) ? value.map(String) : String(value);
  }

  // glob 必须能编译，否则这条规则永远不会匹配，而使用者不会收到任何提示
  if (match.pathGlob) {
    const globs = toList(match.pathGlob) || [];
    const bad = globs.filter((g) => !compileGlob(g));
    if (bad.length) {
      return { ok: false, reason: `pathGlob 无法编译：${bad.join(', ')}` };
    }
  }

  const allowed = ACTION_FIELDS[type];
  const action = { type };
  if (allowed.includes('status')) {
    action.status = Math.round(clampNumber(rawAction.status, 100, 599, ACTION_DEFAULTS.status));
  }
  if (allowed.includes('ratio')) {
    action.ratio = clampNumber(rawAction.ratio, 0.01, 1, ACTION_DEFAULTS.ratio);
  }
  if (allowed.includes('delayMs')) {
    action.delayMs = Math.round(clampNumber(rawAction.delayMs, 0, 600000, ACTION_DEFAULTS.delayMs));
  }
  if (allowed.includes('body')) {
    action.body = String(rawAction.body == null ? '' : rawAction.body).slice(0, 4096);
  }

  const rule = {
    id: input.id ? String(input.id).slice(0, 128) : `rule-${index}`,
    name: String(input.name || `规则 ${index + 1}`).slice(0, 200),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    probability: clampNumber(input.probability, 0, 1, 1),
    maxHits: Math.max(0, Math.round(clampNumber(input.maxHits, 0, 1000000, 0))),
    match,
    action,
  };

  return { ok: true, rule };
}

/**
 * 规范化整个规则数组：丢弃非法项，并为每项补上稳定的运行时标识。
 * @returns {{rules:object[], rejected:Array<{index:number,reason:string}>}}
 */
function normalizeRules(input) {
  const list = Array.isArray(input) ? input : [];
  const rules = [];
  const rejected = [];

  list.forEach((item, index) => {
    const result = normalizeRule(item, index);
    if (result.ok) {
      rules.push(result.rule);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  });

  return { rules, rejected };
}

/**
 * 把故障规则列表烘成可执行的匹配计划。
 * 只在规则集合变化时调用一次，之后匹配就是纯函数调用。
 */
function compileRules(rules) {
  return (rules || []).map((rule, index) => {
    const { test, methods, platforms } = compileMatcher(rule.match || {});
    return {
      rule,
      index,
      key: ruleKey(rule, index),
      methods,
      platforms,
      globs: toList((rule.match || {}).pathGlob),
      prefixes: toList((rule.match || {}).pathPrefix),
      test,
    };
  });
}

/** 测量一段同步代码的耗时（毫秒）。用于匹配耗时告警。 */
function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

module.exports = {
  FAULT_TYPES,
  ACTION_FIELDS,
  ACTION_DEFAULTS,
  MATCH_FIELDS,
  MAX_PATTERN_LENGTH,
  MAX_SUBJECT_LENGTH,
  compileGlob,
  compileMatcher,
  compileRules,
  normalizeRule,
  normalizeRules,
  ruleKey,
  platformFromUrl,
  toList,
  clampNumber,
  timed,
};
