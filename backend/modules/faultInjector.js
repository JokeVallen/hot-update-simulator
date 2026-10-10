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

/**
 * 一条规则在场景时钟的第 elapsed 毫秒处于什么状态。
 *
 * 语义：
 *   * `afterMs` —— 配好之后多久才开始生效（0 = 立刻）
 *   * `forMs`   —— 生效多久之后自动失效（0 = 一直有效）
 *
 * 时钟起点见 FaultInjector.clockStartedAt。
 *
 * @returns {{state:'always'|'pending'|'active'|'expired', activatesInMs?:number, expiresInMs?:number}}
 */
function timeStateOf(rule, elapsed) {
  const afterMs = Number(rule.afterMs) || 0;
  const forMs = Number(rule.forMs) || 0;

  if (afterMs > 0 && elapsed < afterMs) {
    return { state: 'pending', activatesInMs: afterMs - elapsed };
  }
  if (forMs > 0 && elapsed >= afterMs + forMs) {
    return { state: 'expired' };
  }
  if (afterMs === 0 && forMs === 0) return { state: 'always' };
  return {
    state: 'active',
    ...(forMs > 0 ? { expiresInMs: afterMs + forMs - elapsed } : {}),
  };
}

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

    /**
     * 场景时钟的起点。规则的 `afterMs` / `forMs` 都相对它计算。
     *
     * 为什么需要一个显式的时钟，而不是"相对服务器启动"或"相对首个请求"：
     *   * 相对服务器启动 —— 你改完规则往往已经过了很久，`afterMs: 30000`
     *     会立刻就是"已过期"，完全不是你要的
     *   * 相对首个匹配请求 —— 什么时候开始取决于客户端行为，不可预测
     *
     * 所以取**故障相关配置被改动的那一刻**：你点了"应用"，就表示场景从此刻开始。
     * 这与直觉一致，而且可预测。想不改配置重跑，用 restartClock()。
     */
    this.clockStartedAt = Date.now();
    /** 上一次见到的故障配置指纹，用来判断"这次改动是不是故障相关的"。 */
    this._faultFingerprint = null;

    this.configManager.on('change', () => {
      this._compiled = null;
      this._maybeRestartClock();
    });
  }

  /**
   * 故障相关配置变了就重置场景时钟。
   *
   * 只对**故障那部分**的改动敏感：改网络参数不该把故障场景的时间线重置掉，
   * 那会让人在调弱网时莫名其妙地"故障又不触发了"。
   */
  _maybeRestartClock() {
    const fault = this.configManager.get('fault') || {};
    const fingerprint = JSON.stringify({ enabled: fault.enabled, rules: fault.rules });
    if (this._faultFingerprint === null) {
      this._faultFingerprint = fingerprint;
      return;
    }
    if (fingerprint !== this._faultFingerprint) {
      this._faultFingerprint = fingerprint;
      this.clockStartedAt = Date.now();
    }
  }

  /** 手动重置场景时钟（不改配置也能重跑一遍时间线）。 */
  restartClock() {
    this.clockStartedAt = Date.now();
    return this.clockState();
  }

  /** 场景时钟的当前状态。 */
  clockState() {
    const elapsedMs = Date.now() - this.clockStartedAt;
    return { startedAt: this.clockStartedAt, elapsedMs };
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

  /**
   * 清掉某个规则 id 的**全部**命中计数。
   *
   * 删规则时必须用这个，而不是 resetHitCount(id)：key 在 id 唯一时就是 id，
   * 但重复 id 会带上 `#下标` 后缀，只删裸 id 会留下残渣。
   * 残留的计数会让"删掉再重建同 id 的规则"继承旧配额 ——
   * 表现为"配了故障却完全不触发"，而且没有任何报错（清单 H-2）。
   */
  resetHitCountsForId(id) {
    const target = String(id);
    const prefix = `${target}#`;
    for (const key of [...this.hitCounts.keys()]) {
      if (key === target || key.startsWith(prefix)) this.hitCounts.delete(key);
    }
  }

  /**
   * 规则的运行时视图，供接口和界面显示。
   *
   * `effective` 是 false 时，**光看这个布尔量没法知道原因** —— 它至少对应四种
   * 情况，而且每一种的处置方式都不同：总闸没开、规则自己停了、配额用尽、
   * 被前面的规则挡住。所以额外给出 `effectiveReason`。
   *
   * 第 4 种（被挡住）值得单独说：匹配语义是"第一条合格的决定"，所以只要前面
   * 有一条**无条件匹配**的规则，后面所有规则永远不会被看到。这是"配了却不生效"
   * 最常见也最难查的成因之一（典型场景：列表第一条是个 catch-all）。
   * 这里能静态判定，因为无条件规则对任何请求都合格。
   */
  describeRules() {
    const faultEnabled = this.isEnabled();
    const compiled = this.compiled();
    const elapsed = Date.now() - this.clockStartedAt;

    const maxHitsOf = (rule) => Number(rule.maxHits) || 0;
    const exhausted = (entry) => maxHitsOf(entry.rule) > 0
      && this.getHitCount(entry.key) >= maxHitsOf(entry.rule);

    // 找第一条「无条件匹配」且当前会生效的规则的下标 —— 它会挡住后面所有规则。
    // 时间维度也要算进来：还没开始生效的 catch-all 挡不住任何人。
    let shadowFrom = -1;
    for (const entry of compiled) {
      if (entry.rule.enabled === false) continue;
      if (exhausted(entry)) continue;
      if (timeStateOf(entry.rule, elapsed).state !== 'always'
        && timeStateOf(entry.rule, elapsed).state !== 'active') continue;
      const unconditional = (!entry.methods || entry.methods.length === 0)
        && (!entry.prefixes || entry.prefixes.length === 0)
        && (!entry.globs || entry.globs.length === 0)
        && (!entry.platforms || entry.platforms.length === 0);
      if (unconditional) {
        shadowFrom = entry.index;
        break;
      }
    }

    return compiled.map((entry) => {
      const hits = this.getHitCount(entry.key);
      const timing = timeStateOf(entry.rule, elapsed);

      let reason = 'ok';
      if (!faultEnabled) reason = 'master-off';
      else if (entry.rule.enabled === false) reason = 'rule-disabled';
      else if (timing.state === 'pending') reason = 'not-yet-active';
      else if (timing.state === 'expired') reason = 'window-expired';
      else if (exhausted(entry)) reason = 'max-hits-reached';
      else if (shadowFrom >= 0 && entry.index > shadowFrom) reason = 'shadowed';

      return {
        ...entry.rule,
        hits,
        maxHits: maxHitsOf(entry.rule),
        // 直接告诉界面“这条规则现在到底会不会生效”，省得使用者去猜
        // “为什么我建了规则却什么都没发生”（总闸没开是最常见的原因）。
        effective: reason === 'ok',
        effectiveReason: reason,
        // 时间维度的实时状态，供界面倒计时
        timeState: timing.state,
        ...(timing.activatesInMs !== undefined ? { activatesInMs: timing.activatesInMs } : {}),
        ...(timing.expiresInMs !== undefined ? { expiresInMs: timing.expiresInMs } : {}),
        // 被挡住的规则按定义永远不会触发。挡它的那条一并给出，界面可以直接指过去。
        ...(reason === 'shadowed' ? { shadowedBy: compiled[shadowFrom].rule.id } : {}),
      };
    });
  }

  /**
   * 决定这次请求注入什么。纯决策，不产生副作用（除了命中计数）。
   *
   * 规则选取语义（很重要，直接决定了 probability 的含义）：
   *   1. 跳过「不合格」的规则：未启用、不满足匹配、**不在时间窗内**、maxHits 已用完；
   *   2. 第一条「合格」的规则拥有决定权 —— 掷一次骰子：
   *        命中 → 注入它；没命中 → **本次不注入任何故障**（不再往下找）。
   *
   * 第 2 步不能再 `continue`：那样 N 条各 50% 的规则会让总命中率变成
   * 1-(1-0.5)^N ≈ 75%（N=2），probability 就完全不是它字面上的意思了。
   *
   * 时间窗外的规则按「不合格」处理（`continue`），这和"未启用"是同一类：
   * 它此刻确实不该参与决策，而不是掷输了。
   *
   * @returns {{delayMs:number, respond:Function|null, shape:object|null, rule:object|null}}
   */
  plan(req) {
    const empty = { delayMs: 0, respond: null, shape: null, rule: null };
    if (!this.isEnabled()) return empty;

    const url = String(req.originalUrl || req.url || '');
    const method = String(req.method || 'GET').toUpperCase();
    const elapsed = Date.now() - this.clockStartedAt;

    for (const entry of this.compiled()) {
      const rule = entry.rule;
      if (rule.enabled === false) continue;
      if (!entry.test(url, method)) continue;

      // 时间维度：还没到点、或窗口已过 —— 都不合格，看下一条
      const timing = timeStateOf(rule, elapsed);
      if (timing.state === 'pending' || timing.state === 'expired') continue;

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

    // 复合类型：先把响应拖慢，再在传输中途掐断。
    //
    // 为什么单独加这一个而不是做通用编排：真实外网里最常见的一类失败就是
    // "客户端等太久 → 超时重试 → 重试时又在下载中途断掉"，而单条规则
    // 只能表达其中一半。完整的原子化编排要动 responseShaper 的核心
    // （单值 mode 会变成 transform 链），成本 500~800 行且会引入
    // "配得出来但语义无效"的组合。这一个类型精确覆盖了那个真实场景，
    // 代价只有下面这段。
    //
    // 注意它**不需要改 requestPipeline**：plan 本来就同时支持 delayMs 和 shape
    // （delayMs 在 next() 之前 await，shape 随后装到响应上）。
    if (type === 'slowThenAbort') {
      plan.delayMs = Number(action.delayMs) || 0;
      if (!plan.delayMs) plan.delayMs = 3000;
      sim.faultDelayMs = plan.delayMs;
      plan.shape = { mode: 'abort', ratio: Number(action.ratio) || 0.5 };
      // 日志和面板上要看得出这是"先慢后断"，而不是一个普通的 abort
      sim.fault = 'slowThenAbort';
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
