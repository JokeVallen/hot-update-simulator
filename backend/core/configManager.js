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
const { EventEmitter } = require('events');

/**
 * 默认配置。config.json 里缺失的字段一律用这里的值补齐。
 */
const DEFAULTS = {
  server: {
    host: '0.0.0.0',
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
    logResponseBody: false,
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
   * 校正非法值。AI 生成或手工编辑的配置很容易写出越界数字，
   * 与其等运行时出现诡异行为，不如在这里统一夹到合法区间。
   */
  sanitize(config) {
    const c = deepMerge(DEFAULTS, config);

    c.server.port = Math.round(clamp(c.server.port, 1, 65535));
    c.server.host = String(c.server.host || DEFAULTS.server.host);

    c.network.enabled = Boolean(c.network.enabled);
    c.network.offline = Boolean(c.network.offline);
    c.network.latencyMs = Math.round(clamp(c.network.latencyMs, 0, 600000));
    c.network.jitterMs = Math.round(clamp(c.network.jitterMs, 0, 600000));
    c.network.bandwidthKbps = Math.round(clamp(c.network.bandwidthKbps, 0, 10000000));
    c.network.packetLossRate = clamp(c.network.packetLossRate, 0, 1);

    c.fault.enabled = Boolean(c.fault.enabled);
    c.fault.rules = Array.isArray(c.fault.rules) ? c.fault.rules : [];

    const channels = Array.isArray(c.hotUpdate.channels) ? c.hotUpdate.channels : [];
    c.hotUpdate.channels = channels.length ? channels.map(String) : DEFAULTS.hotUpdate.channels.slice();
    if (!c.hotUpdate.channels.includes(c.hotUpdate.defaultChannel)) {
      c.hotUpdate.defaultChannel = c.hotUpdate.channels[0];
    }
    c.hotUpdate.gray.enabled = Boolean(c.hotUpdate.gray.enabled);
    c.hotUpdate.gray.percent = clamp(c.hotUpdate.gray.percent, 0, 100);

    c.logging.maxEntries = Math.round(clamp(c.logging.maxEntries, 10, 100000));
    c.logging.logResponseBody = Boolean(c.logging.logResponseBody);

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

  /** 原子写入：先写临时文件再改名，避免进程被中断时留下半截 JSON。 */
  save() {
    const dir = path.dirname(this.configPath);
    const tmp = `${this.configPath}.tmp`;
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
