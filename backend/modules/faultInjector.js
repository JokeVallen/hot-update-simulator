// backend/modules/faultInjector.js
//
// 故障注入器：模拟“服务器/文件本身出问题”。
//
// 规则（config.fault.rules 里的一项）结构：
// {
//   id: "唯一 id",
//   name: "给人看的名字",
//   enabled: true,
//   probability: 0.3,      // 匹配上之后，有多大概率真的触发（0~1）
//   maxHits: 0,            // 最多触发几次，0 = 不限。
//                          // 设成 2 很有用：前两次失败、第三次成功，
//                          // 正好用来验证客户端的重试逻辑。
//   match: {
//     method: "GET",              // 单个值或数组，留空 = 不限
//     pathPrefix: "/assets",      // 单个值或数组，留空 = 不限
//     pathRegex: "^/assets/.*",   // 正则字符串，留空 = 不限
//     platform: "Android"         // 单个值或数组，按 URL 第一段判断，留空 = 不限
//   },
//   action: {
//     type: "abort",        // 见下方 FAULT_TYPES
//     status: 500,          // type=status 时返回的状态码
//     delayMs: 0,           // 附加延迟
//     ratio: 0.5,           // abort/truncate/corrupt 用到的比例
//     body: "..."           // type=status 时的自定义响应体
//   }
// }
//
// 支持的故障类型（都是 U3D 热更客户端必须扛住的场景）：
//   status    服务器返回错误码（500/404/403…）
//   timeout   服务器不响应，客户端只能自己超时
//   slowHeader 响应头很慢才回来
//   abort     数据发到一半直接掐断连接（测试断点续传）
//   truncate  声明了完整长度却少发数据（测试“内容长度不符”）
//   corrupt   数据完整但内容被改坏（测试 hash/MD5 校验）
//   empty     200 但响应体是空的（测试空文件/空 manifest）

const crypto = require('crypto');

const FAULT_TYPES = ['status', 'timeout', 'slowHeader', 'abort', 'truncate', 'corrupt', 'empty'];

/** 把规则里的 match 字段统一成数组，方便判断。 */
function toList(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((v) => String(v)).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

/** 从 URL 里取平台名。约定 /assets/{platform}/... 的第一段就是平台。 */
function platformFromUrl(url) {
  const path = String(url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  // /assets/Android/xxx → 跳过 'assets'
  if (parts[0] === 'assets') return parts[1] || null;
  return null;
}

class FaultInjector {
  constructor(configManager) {
    this.configManager = configManager;
    /** 规则命中计数，只存内存，不写进配置——重启服务器就重置，符合直觉。 */
    this.hitCounts = new Map();
  }

  /** 当前是否启用注入（总开关 + 至少一条规则）。 */
  isEnabled() {
    const fault = this.configManager.get('fault') || {};
    return Boolean(fault.enabled);
  }

  rules() {
    const fault = this.configManager.get('fault') || {};
    return Array.isArray(fault.rules) ? fault.rules : [];
  }

  getHitCount(ruleId) {
    return this.hitCounts.get(ruleId) || 0;
  }

  resetHitCounts() {
    this.hitCounts.clear();
  }

  /** 清零单条规则的命中次数。 */
  resetHitCount(ruleId) {
    this.hitCounts.delete(ruleId);
  }

  /** 给规则补上运行时字段，供前端显示。 */
  describeRules() {
    return this.rules().map((rule) => ({
      ...rule,
      hits: this.getHitCount(rule.id),
    }));
  }

  /**
   * 判断单条规则是否匹配这个请求（只看 match 部分，不掷骰子）。
   */
  matches(rule, req) {
    const match = rule.match || {};

    const methods = toList(match.method);
    if (methods && !methods.map((m) => m.toUpperCase()).includes(String(req.method).toUpperCase())) {
      return false;
    }

    const url = String(req.originalUrl || req.url || '');
    const pathOnly = url.split('?')[0];

    const prefixes = toList(match.pathPrefix);
    if (prefixes && !prefixes.some((p) => pathOnly.startsWith(p))) {
      return false;
    }

    if (match.pathRegex) {
      try {
        if (!new RegExp(match.pathRegex).test(pathOnly)) return false;
      } catch {
        // 用户写错正则不该让整个请求挂掉，当作不匹配
        return false;
      }
    }

    const platforms = toList(match.platform);
    if (platforms) {
      const current = platformFromUrl(url);
      if (!current || !platforms.includes(current)) return false;
    }

    return true;
  }

  /**
   * 决定这次请求注入哪个故障。
   * @returns {object|null} 命中的规则副本，或 null
   */
  pick(req) {
    if (!this.isEnabled()) return null;

    for (const rule of this.rules()) {
      if (rule.enabled === false) continue;
      if (!this.matches(rule, req)) continue;

      // maxHits：达到上限后这条规则自动失效。用来构造
      // “前 N 次失败、之后成功”这种序列，验证重试与续传。
      const maxHits = Number(rule.maxHits) || 0;
      if (maxHits > 0 && this.getHitCount(rule.id) >= maxHits) continue;

      const probability = rule.probability === undefined ? 1 : Number(rule.probability);
      if (probability < 1 && Math.random() >= probability) continue;

      this.hitCounts.set(rule.id, this.getHitCount(rule.id) + 1);
      return rule;
    }

    return null;
  }

  /**
   * 施加故障。必须在 networkSimulator.throttle() 之前调用，
   * 这样限速会包在故障改写之外，两者能叠加：
   * 例如“限速 100Kbps + 下载到一半断流”。
   *
   * @returns {'responded'|'wrapped'|'passthrough'}
   *   responded   故障自己产生了响应，后面的业务路由不能再跑
   *   wrapped     只在响应上包了一层改写/截断，业务路由必须照常跑
   *   passthrough 什么都没做
   */
  apply(req, res, fault) {
    if (!fault) return 'passthrough';

    const action = fault.action || {};
    const type = FAULT_TYPES.includes(action.type) ? action.type : 'status';
    const delayMs = Number(action.delayMs) || 0;

    if (req._sim) {
      req._sim.fault = type;
      req._sim.faultRule = fault.name || fault.id;
      if (delayMs > 0) req._sim.faultDelayMs = delayMs;
    }

    const run = () => {
      switch (type) {
        case 'status':
          return this._applyStatus(res, action);
        case 'timeout':
          return this._applyTimeout(req, res, action);
        case 'slowHeader':
          return 'passthrough'; // 延迟已经在上面 await 掉了
        case 'empty':
          return this._applyEmpty(res);
        case 'abort':
          return this._applyAbort(req, res, action);
        case 'truncate':
          return this._applyTruncate(req, res, action);
        case 'corrupt':
          return this._applyCorrupt(req, res, action);
        default:
          return 'passthrough';
      }
    };
    if (delayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(run()), delayMs));
    }
    return run();
  }

  _applyStatus(res, action) {
    const status = Number(action.status) || 500;
    const body = action.body || `模拟故障注入：服务器返回 ${status}`;
    res.status(status).type('text/plain; charset=utf-8').send(body);
    return 'responded';
  }

  /**
   * timeout：就是不响应。客户端会一直等到自己的超时时间。
   * 如果 delayMs>0，等情况拖够之后再掐断连接——比永远挂着更容易清理。
   */
  _applyTimeout(req, res, action) {
    const hangMs = Number(action.delayMs) || 0;
    if (hangMs > 0) {
      setTimeout(() => {
        if (!res.writableEnded && req.socket && !req.socket.destroyed) {
          req.socket.destroy();
        }
      }, hangMs);
    }
    // 什么都不做，让请求就这么挂着
    return 'responded';
  }

  _applyEmpty(res) {
    res.status(200).type('application/octet-stream').send(Buffer.alloc(0));
    return 'responded';
  }

  /** 发一部分数据后掐断连接——测试客户端断点续传的关键场景。 */
  _applyAbort(req, res, action) {
    const ratio = Math.min(0.99, Math.max(0.01, Number(action.ratio) || 0.5));
    const originalWrite = res.write;
    let sent = 0;
    let limit = null;

    const sizeOf = (chunk) => (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''), 'utf8'));

    res.write = function abortingWrite(chunk, encoding, callback) {
      const declared = Number(res.getHeader('content-length'));
      if (limit === null) {
        // 内容长度已知就按比例算阈值；未知（chunked）就先放行，
        // 等第一次拿到数据再说，避免一上来就断。
        limit = Number.isFinite(declared) && declared > 0 ? Math.floor(declared * ratio) : Infinity;
        if (req._sim) req._sim.abortAfterBytes = Number.isFinite(limit) ? limit : undefined;
      }
      const size = sizeOf(chunk);
      if (sent >= limit) {
        // 到点了：不再往下写，直接掐断
        try {
          req.socket.destroy();
        } catch {
          /* 已断开 */
        }
        if (typeof callback === 'function') callback();
        return false;
      }
      sent += size;
      return originalWrite.call(this, chunk, encoding, callback);
    };

    // 对于 res.send(单块 buffer) 这种一次性写完的情况，write 只被调用一次，
    // 所以还要在 end 里再截一刀。
    const originalEnd = res.end;
    res.end = function abortingEnd(chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      let body = chunk;
      if (typeof body === 'function') {
        cb = body;
        body = undefined;
        enc = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        enc = undefined;
      }

      if (body !== undefined) {
        const declared = Number(res.getHeader('content-length'));
        const cut = Number.isFinite(declared) && declared > 0
          ? Math.floor(declared * ratio)
          : Math.floor(sizeOf(body) * ratio);
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        const partial = buf.subarray(0, Math.max(0, cut));
        try {
          originalWrite.call(this, partial);
          req.socket.destroy();
        } catch {
          /* 已断开 */
        }
        if (typeof cb === 'function') cb();
        return this;
      }

      try {
        req.socket.destroy();
      } catch {
        /* 已断开 */
      }
      if (typeof cb === 'function') cb();
      return this;
    };

    return 'wrapped';
  }

  /**
   * truncate：Content-Length 声明完整大小，但实际只发一部分就正常结束。
   * 客户端会看到“内容长度不符 / 提前结束”，和 abort 的区别是
   * 这里连接是正常关闭的，报错形式不同。
   */
  _applyTruncate(req, res, action) {
    const ratio = Math.min(0.99, Math.max(0.01, Number(action.ratio) || 0.5));
    const originalWrite = res.write;
    const originalEnd = res.end;
    let sent = 0;
    let limit = null;

    const sizeOf = (chunk) => (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''), 'utf8'));

    res.write = function truncatingWrite(chunk, encoding, callback) {
      const declared = Number(res.getHeader('content-length'));
      if (limit === null) {
        limit = Number.isFinite(declared) && declared > 0 ? Math.floor(declared * ratio) : Infinity;
      }
      const size = sizeOf(chunk);
      if (sent >= limit) {
        // 吞掉多余的数据，不再往下发
        if (typeof callback === 'function') callback();
        return false;
      }
      sent += size;
      return originalWrite.call(this, chunk, encoding, callback);
    };

    res.end = function truncatingEnd(chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      let body = chunk;
      if (typeof body === 'function') {
        cb = body;
        body = undefined;
        enc = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        enc = undefined;
      }

      if (body !== undefined) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        const declared = Number(res.getHeader('content-length'));
        const cut = Number.isFinite(declared) && declared > 0
          ? Math.min(buf.length, Math.floor(declared * ratio))
          : Math.floor(buf.length * ratio);
        return originalEnd.call(this, buf.subarray(0, Math.max(0, cut)), enc, cb);
      }

      return originalEnd.call(this, body, enc, cb);
    };

    return 'wrapped';
  }

  /**
   * corrupt：长度完全正确，但内容被改坏了。
   * 这是唯一一种“下载看起来成功了、解包/校验才失败”的故障，
   * 专门用来验证客户端的 hash 校验有没有真的在做。
   */
  _applyCorrupt(req, res, action) {
    const ratio = Math.min(1, Math.max(0.01, Number(action.ratio) || 0.2));
    const originalWrite = res.write;
    const originalEnd = res.end;

    const damage = (buf) => {
      if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
      const out = Buffer.from(buf); // 不破坏原 buffer
      const bytesToDamage = Math.max(1, Math.floor(out.length * ratio));
      // 从中间开始改，避免改到文件头导致错误类型变成“格式不对”，
      // 我们要的是“校验失败”而不是“读不出来”
      const start = Math.floor((out.length - bytesToDamage) / 2);
      for (let i = 0; i < bytesToDamage; i += 1) {
        const idx = start + i;
        if (idx >= 0 && idx < out.length) {
          out[idx] = out[idx] ^ 0xff;
        }
      }
      return out;
    };

    res.write = function corruptingWrite(chunk, encoding, callback) {
      return originalWrite.call(this, damage(chunk), encoding, callback);
    };

    res.end = function corruptingEnd(chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      let body = chunk;
      if (typeof body === 'function') {
        cb = body;
        body = undefined;
        enc = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        enc = undefined;
      }
      if (body !== undefined) {
        return originalEnd.call(this, damage(body), enc, cb);
      }
      return originalEnd.call(this, body, enc, cb);
    };

    return 'wrapped';
  }

  /** 生成一条新规则，补全 id 和默认值。 */
  static createRule(input = {}) {
    const type = FAULT_TYPES.includes(input.action && input.action.type)
      ? input.action.type
      : 'status';
    return {
      id: input.id || crypto.randomUUID(),
      name: input.name || '未命名故障',
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      probability: input.probability === undefined ? 1 : Number(input.probability),
      maxHits: Number(input.maxHits) || 0,
      match: {
        method: input.match && input.match.method ? input.match.method : '',
        pathPrefix: input.match && input.match.pathPrefix ? input.match.pathPrefix : '',
        pathRegex: input.match && input.match.pathRegex ? input.match.pathRegex : '',
        platform: input.match && input.match.platform ? input.match.platform : '',
      },
      action: {
        type,
        status: Number(input.action && input.action.status) || 500,
        delayMs: Number(input.action && input.action.delayMs) || 0,
        ratio: input.action && input.action.ratio !== undefined ? Number(input.action.ratio) : 0.5,
        body: (input.action && input.action.body) || '',
      },
    };
  }
}

module.exports = FaultInjector;
module.exports.FAULT_TYPES = FAULT_TYPES;
