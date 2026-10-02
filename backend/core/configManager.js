// backend/core/configManager.js
//
// 配置中心：负责 backend/config.json 的读取、校验、深合并、持久化与变更通知。
//
// 设计要点：
// 1. 所有可调参数都收敛到这里，其它模块只通过 get()/patch() 访问，不自己读文件。
// 2. 用 DEFAULTS 兜底，config.json 缺字段也能跑，所以以后加字段不会破坏用户的旧配置文件。
// 3. 任何修改都会“立即落盘 + 抛 change 事件”，前端改完不用重启服务器。
//
// 注意：这里改的是“会持久化的配置”。那些只在内存里生效的临时状态（比如正在跑的
// 一次限速）也走这里，因为对使用者来说“我调了参数”和“参数被记住了”是一回事。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const faultRule = require('./faultRule');

/**
 * 默认配置。config.json 里缺失的字段一律用这里的值补齐。
 */
const DEFAULTS = {
  server: {
    // 默认只监听回环地址。
    //
    // 控制类接口完全没有认证，而它们能读写模拟参数、注入故障规则、读全部
    // 请求日志。绑到 0.0.0.0 就等于把这一切开放给同局域网的任何一台机器。
    // 确实需要给手机/真机联调时，显式改成 0.0.0.0，并意识到这个风险。
    host: '127.0.0.1',
    port: 5500,
    // 以下两个路径都是相对 backend/ 目录的
    publicDir: 'public',
    assetDir: '../storage/assets',
    enableBrowse: true,
    enableDocs: true,
  },
  network: {
    enabled: false,
    offline: false,
    latencyMs: 0,
    jitterMs: 0,
    // 0 表示不限速；单位 Kbps（千比特每秒），和真实带宽单位一致
    bandwidthKbps: 0,
    // 0~1 的整包丢失概率
    packetLossRate: 0,
  },
  fault: {
    enabled: false,
    // 规则结构见 backend/modules/faultInjector.js 顶部的注释
    rules: [],
  },
  hotUpdate: {
    defaultChannel: 'default',
    channels: ['default', 'beta', 'dev'],
    gray: {
      enabled: false,
      percent: 0,
    },
  },
  logging: {
    maxEntries: 2000,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 深合并：把 override 合并进 base 的副本里。
 * 数组不做逐项合并，直接整体替换——对规则列表来说这符合直觉。
 */
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return out;
}

/** 深拷贝，避免外部拿到内部对象后直接改坏状态。 */
function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 结构化比较。用来判断"值到底变没变"，不受键顺序和缩进影响。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => (
    Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
  ));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

class ConfigManager extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath;
    this.config = deepClone(DEFAULTS);
    this.load();
  }

  /** 从磁盘读取配置并与默认值合并。文件不存在或损坏时退回默认值，不抛异常。 */
  load() {
    let stored = {};
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        stored = JSON.parse(raw);
      }
    } catch (err) {
      // 配置坏了也要能启动，否则用户就没法用界面去修它了
      console.error(`[config] 读取 ${this.configPath} 失败，改用默认配置：${err.message}`);
      stored = {};
    }

    this.config = this.sanitize(deepMerge(DEFAULTS, stored));
    this.emit('loaded', this.get());
    return this.get();
  }

  /**
   * 校正非法值。
   *
   * 这里的定位是**最后一道防线**：无论输入来自手工编辑的 config.json、
   * API 请求体、还是预置方案，都必须收敛成一个合法结构，绝不能抛异常，
   * 也不能把非法值原样放行。
   *
   * 为什么必须先做「节级对象化」：deepMerge 会把 `{fault: 'a string'}`
   * 原样覆盖进去，紧接着 `c.fault.enabled = ...` 就会抛
   * `TypeError: Cannot create property 'enabled' on string`。
   * 实测后果是整个接口 500，而且那条预置方案之后永远无法应用。
   */
  sanitize(config) {
    const input = isPlainObject(config) ? config : {};
    const c = deepMerge(DEFAULTS, input);

    // 每个配置节都必须是对象，否则回落成默认值
    for (const section of Object.keys(DEFAULTS)) {
      if (!isPlainObject(c[section])) {
        c[section] = deepClone(DEFAULTS[section]);
      }
    }
    // 嵌套的节同样要保证
    if (!isPlainObject(c.hotUpdate.gray)) {
      c.hotUpdate.gray = deepClone(DEFAULTS.hotUpdate.gray);
    }

    c.server.port = Math.round(clamp(c.server.port, 1, 65535));
    c.server.host = String(c.server.host || DEFAULTS.server.host);
    c.server.publicDir = String(c.server.publicDir || DEFAULTS.server.publicDir);
    c.server.assetDir = String(c.server.assetDir || DEFAULTS.server.assetDir);

    c.network.enabled = Boolean(c.network.enabled);
    c.network.offline = Boolean(c.network.offline);
    c.network.latencyMs = Math.round(clamp(c.network.latencyMs, 0, 600000));
    c.network.jitterMs = Math.round(clamp(c.network.jitterMs, 0, 600000));
    c.network.bandwidthKbps = Math.round(clamp(c.network.bandwidthKbps, 0, 10000000));
    c.network.packetLossRate = clamp(c.network.packetLossRate, 0, 1);

    c.fault.enabled = Boolean(c.fault.enabled);
    // 规则逐条校验。非法项被丢弃并记一条警告，而不是原样放行——
    // 原实现里 status: 99999 会让 res.status() 抛 RangeError（注入变成真 500），
    // probability: null 会让规则永远不触发（Number(null) === 0），
    // type 拼错会静默降级成 500，使用者还以为规则生效了。
    const normalized = faultRule.normalizeRules(c.fault.rules);
    c.fault.rules = normalized.rules;
    if (normalized.rejected.length) {
      console.warn(
        `[config] 有 ${normalized.rejected.length} 条故障规则不合法，已丢弃：`
        + normalized.rejected.map((r) => `#${r.index} ${r.reason}`).join('；'),
      );
    }

    const channels = Array.isArray(c.hotUpdate.channels) ? c.hotUpdate.channels : [];
    c.hotUpdate.channels = channels.length
      ? channels.map(String).filter(Boolean)
      : DEFAULTS.hotUpdate.channels.slice();
    if (!c.hotUpdate.channels.length) {
      c.hotUpdate.channels = DEFAULTS.hotUpdate.channels.slice();
    }
    if (!c.hotUpdate.channels.includes(c.hotUpdate.defaultChannel)) {
      c.hotUpdate.defaultChannel = c.hotUpdate.channels[0];
    }
    c.hotUpdate.gray.enabled = Boolean(c.hotUpdate.gray.enabled);
    c.hotUpdate.gray.percent = clamp(c.hotUpdate.gray.percent, 0, 100);

    c.logging.maxEntries = Math.round(clamp(c.logging.maxEntries, 10, 100000));

    return c;
  }

  /**
   * 读取配置。
   * @param {string} [keyPath] 形如 'server.port' 的点号路径；不传则返回整份配置副本。
   */
  get(keyPath) {
    if (!keyPath) return deepClone(this.config);

    const value = keyPath.split('.').reduce((acc, key) => {
      return acc === undefined || acc === null ? undefined : acc[key];
    }, this.config);

    return deepClone(value);
  }

  /**
   * 局部更新配置：与现有配置深合并，然后校验 + 落盘 + 广播。
   * @returns {object} 更新后的完整配置副本
   */
  patch(partial) {
    const next = this.sanitize(deepMerge(this.config, partial));
    this.config = next;
    this.save();
    this.emit('change', this.get());
    return this.get();
  }

  /**
   * 按点号路径写单个值，例如 set('network.latencyMs', 300)。
   */
  set(keyPath, value) {
    const keys = keyPath.split('.');
    const last = keys.pop();
    const partial = {};
    let cursor = partial;
    for (const key of keys) {
      cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[last] = value;
    return this.patch(partial);
  }

  /**
   * 恢复默认值。
   * @param {string} [section] 只重置某一节，例如 'network'；不传则全部重置。
   */
  reset(section) {
    if (section) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, section)) {
        throw new Error(`未知的配置节：${section}`);
      }
      return this.patch({ [section]: deepClone(DEFAULTS[section]) });
    }
    this.config = this.sanitize(deepClone(DEFAULTS));
    this.save();
    this.emit('change', this.get());
    return this.get();
  }

  /**
   * 原子写入：先写临时文件再改名，避免进程被中断时留下半截 JSON。
   *
   * 如果磁盘上的值跟当前配置完全一样，就直接跳过不写。这一点很重要：
   * 界面里每点一次开关都会走 patch() → save()，而 JSON.stringify 的
   * 缩进规则跟用户手写的排版不一定一致（比如数组是单行还是多行）。
   * 不做这个判断的话，config.json 会一直显示成"已修改"，
   * 在 git 里看着像改了什么，其实只是被重新格式化了。
   */
  save() {
    try {
      if (fs.existsSync(this.configPath)) {
        const existing = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (deepEqual(existing, this.config)) return;
      }
    } catch {
      // 读不了或者解析不了（文件坏了/被占用），照常往下走去覆盖它
    }

    const dir = path.dirname(this.configPath);
    // 临时文件名唯一：并发写用同一个名字时，先完成的那个 rename 会把
    // 文件移走，后一个的 rename 就会失败（ENOENT），而失败是被吞掉的。
    const tmp = `${this.configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.configPath);
    } catch (err) {
      console.error(`[config] 写入 ${this.configPath} 失败：${err.message}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能压根没建出来，忽略 */
      }
    }
  }

  /** 把配置里的相对路径解析成绝对路径。 */
  resolvePath(keyPath) {
    const value = this.get(keyPath);
    if (!value) return null;
    return path.isAbsolute(value) ? value : path.resolve(__dirname, '..', value);
  }
}

module.exports = ConfigManager;
module.exports.DEFAULTS = DEFAULTS;
module.exports.deepMerge = deepMerge;
