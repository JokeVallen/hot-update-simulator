// backend/modules/faultInjector.js
//
// 故障注入器：模拟“服务器或文件本身出问题”。
//
// 规则的字段、类型表、匹配器编译、校验都收敛在 backend/core/faultRule.js，
// 响应体改写交给 backend/modules/responseShaper.js。
// 本模块只负责一件事：**决定这次请求要不要注入、注入什么**。
//
// ─────────────────────────── 规则结构 ───────────────────────────
// {
//   id: "唯一标识",
//   name: "给人看的名字",
//   enabled: true,
//   probability: 0.3,      // 命中之后有多大概率真的触发（0~1）
//   maxHits: 0,            // 最多触发几次，0 = 不限；设成 2 就是“前两次失败”
//   match: {
//     method: "GET",              // 单个值或数组；留空 = 不限
//     pathPrefix: "/assets",      // 单个值或数组；留空 = 不限
//     pathGlob: "/assets/**/*.ab",// 单个值或数组；线性时间匹配，见下
//     platform: "Android"         // 按 URL 第一段判断；留空 = 不限
//   },
//   action: { type: "abort", status: 500, delayMs: 0, ratio: 0.5, body: "" }
// }
//
// ─────────────────── 为什么是 glob 而不是正则表达式 ───────────────────
// 原来是 match.pathRegex，由使用者提供正则字符串，每个请求现编译一次。
// 那是一个真实的拒绝服务漏洞：实测 `(a|a)*$` 配 30 个字符的输入会让
// Node 单线程挂死 90 秒以上，期间**所有**连接（含控制面板）一起卡住，
// 只能重启进程。而且成熟的静态检测器 safe-regex2 也拦不住 `(a|a)*$`。
//
// 结论：静态分析不可靠，所以干脆不接受任意正则。pathGlob 编译出的正则
// 由我们自己的编译器生成，结构只有 `.*` / `[^/]*` / `[^/]` 和转义字面量，
// 匹配代价与输入长度成正比。
//
// ─────────────────────── 故障类型 ───────────────────────
//   status     服务器返回错误码（500/404/403…）
//   timeout    服务器不响应，客户端只能自己超时
//   slowHeader 响应头很慢才回来
//   abort      数据发到一半直接掐断连接（测断点续传）
//   truncate   声明了完整长度却少发数据（测“内容长度不符”）
//   corrupt    数据完整但内容被改坏（测 hash/MD5 校验）
//   empty      200 但响应体是空的

const faultRule = require('../core/faultRule');

const { FAULT_TYPES, ACTION_FIELDS } = faultRule;

class FaultInjector {
  constructor(configManager) {
    this.configManager = configManager;
    /**
     * 命中计数。键是 core/faultRule 生成的稳定标识（id + 下标），
     * 不是裸 id —— 否则两条同 id 的规则会共用配额。
     * 只存内存，重启即重置，符合直觉。
     */
    this.hitCounts = new Map();
    /** 编译后的规则计划，规则集变化时重建。 */
    this._compiled = null;
    this._compiledFrom = null;

    this.configManager.on('change', () => { this._compiled = null; });
  }

  /** 当前是否启用注入（总开关）。 */
  isEnabled() {
    const fault = this.configManager.get('fault') || {};
    return Boolean(fault.enabled);
  }

  rules() {
    const fault = this.configManager.get('fault') || {};
    return Array.isArray(fault.rules) ? fault.rules : [];
  }

  /**
   * 取得编译好的规则计划。编译只在规则集变化时发生一次——
   * 原实现是每个请求、每条规则都 new RegExp，纯属浪费 CPU。
   */
  compiled() {
    const rules = this.rules();
    // 用一个廉价的指纹判断是否需要重编译
    const fingerprint = `${rules.length}:${JSON.stringify(rules).length}:${rules.map((r) => (r && r.id) || '').join(',')}`;
    if (this._compiled && this._compiledFrom === fingerprint) return this._compiled;

    this._compiled = faultRule.compileRules(rules);
    this._compiledFrom = fingerprint;
    return this._compiled;
  }

  getHitCount(key) {
    return this.hitCounts.get(key) || 0;
  }

  resetHitCounts() {
    this.hitCounts.clear();
  }

  resetHitCount(key) {
    this.hitCounts.delete(key);
  }

  /** 规则的运行时视图，供接口和界面显示。 */
  describeRules() {
    const faultEnabled = this.isEnabled();
    return this.compiled().map((entry) => ({
      ...entry.rule,
      hits: this.getHitCount(entry.key),
      // 直接告诉界面“这条规则现在到底会不会生效”，省得使用者去猜
      // “为什么我建了规则却什么都没发生”（总闸没开是最常见的原因）。
      effective: faultEnabled && entry.rule.enabled !== false
        && (Number(entry.rule.maxHits) === 0 || this.getHitCount(entry.key) < Number(entry.rule.maxHits)),
    }));
  }

  /**
   * 决定这次请求注入什么。纯决策，不产生副作用（除了命中计数）。
   *
   * 规则选取语义（很重要，直接决定了 probability 的含义）：
   *   1. 跳过「不合格」的规则：未启用、已知不匹配、maxHits 已用完；
   *   2. 第一条「合格」的规则拥有决定权 —— 掷一次骰子：
   *        命中 → 注入它；没命中 → **本次不注入任何故障**（不再往下找）。
   *
   * 第 2 步不能再 `continue`：那样 N 条各 50% 的规则会让总命中率变成
   * 1-(1-0.5)^N ≈ 75%（N=2），probability 就完全不是它字面上的意思了。
   *
   * @returns {{delayMs:number, respond:Function|null, shape:object|null, rule:object|null}}
   */
  plan(req) {
    const empty = { delayMs: 0, respond: null, shape: null, rule: null };
    if (!this.isEnabled()) return empty;

    const url = String(req.originalUrl || req.url || '');
    const method = String(req.method || 'GET').toUpperCase();

    for (const entry of this.compiled()) {
      const rule = entry.rule;
      if (rule.enabled === false) continue;
      if (!entry.test(url, method)) continue;

      // platform 是单独的维度：它在 URL 里而不是可前缀化的字段
      if (entry.platforms) {
        const current = faultRule.platformFromUrl(url);
        if (!current || !entry.platforms.includes(current)) continue;
      }

      const maxHits = Number(rule.maxHits) || 0;
      if (maxHits > 0 && this.getHitCount(entry.key) >= maxHits) continue;

      // 第一条合格规则说了算
      const probability = rule.probability === undefined ? 1 : Number(rule.probability);
      if (probability < 1 && Math.random() >= probability) {
        return { ...empty, rule: null };
      }

      this.hitCounts.set(entry.key, this.getHitCount(entry.key) + 1);
      return this.buildPlan(rule, req);
    }

    return empty;
  }

  /** 把一条规则翻译成「怎么影响这次响应」。 */
  buildPlan(rule, req) {
    const action = rule.action || {};
    const type = action.type;
    const plan = { delayMs: 0, respond: null, shape: null, rule };

    const sim = req._sim || (req._sim = {});
    sim.fault = type;
    sim.faultRule = rule.name || rule.id;
    sim.faultRuleId = rule.id;

    if (type === 'slowHeader') {
      plan.delayMs = Number(action.delayMs) || 0;
      if (!plan.delayMs) plan.delayMs = 3000; // 没填就给一个能看出效果的默认值
      sim.faultDelayMs = plan.delayMs;
      return plan;
    }

    if (type === 'status') {
      const status = Number(action.status) || 500;
      const body = action.body || `模拟故障注入：服务器返回 ${status}`;
      plan.respond = (req2, res) => {
        res.status(status).type('text/plain; charset=utf-8').send(body);
      };
      return plan;
    }

    if (type === 'timeout') {
      plan.respond = (req2, res) => {
        // 什么都不做，让请求挂着，客户端只能自己超时。
        // 如果客户端一直不放弃，连接会一直留着——这是刻意的，但加一个上限，
        // 免得无人看管的挂起连接把 socket 耗尽。
        const hangMs = Number(action.delayMs) > 0 ? Number(action.delayMs) : 0;
        if (hangMs > 0) {
          setTimeout(() => {
            if (!res.writableEnded && req2.socket && !req2.socket.destroyed) {
              req2.socket.destroy();
            }
          }, hangMs).unref();
        }
      };
      return plan;
    }

    if (type === 'empty') {
      plan.respond = (req2, res) => {
        res.status(200).type('application/octet-stream').send(Buffer.alloc(0));
      };
      return plan;
    }

    if (['abort', 'truncate', 'corrupt'].includes(type)) {
      plan.shape = { mode: type, ratio: Number(action.ratio) || 0.5 };
      return plan;
    }

    return plan;
  }

  /** 规则的默认结构。保留这个静态方法，是因为 routes/control 会用到。 */
  static createRule(input = {}) {
    const result = faultRule.normalizeRule(input, 0);
    if (result.ok) return result.rule;
    // 归一化失败时给一个安全的占位，真正的校验失败应该在写入接口上返回 400
    return faultRule.normalizeRule({ name: input.name, action: { type: 'status' } }, 0).rule;
  }
}

module.exports = FaultInjector;
module.exports.FAULT_TYPES = FAULT_TYPES;
module.exports.ACTION_FIELDS = ACTION_FIELDS;
