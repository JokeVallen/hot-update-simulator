// backend/modules/logger.js
//
// 内存日志中心。所有请求以及模拟器自己产生的信息都记到这里，
// 前端通过 /api/logs 拉取、通过 /api/logs/stream（SSE）实时接收。
//
// 为什么用环形缓冲而不是直接写文件：
// 这是个“实时观察”工具，重点是把刚刚发生的事立刻显示出来。
// 缓冲有上限（logging.maxEntries），不会把内存吃光。

const { EventEmitter } = require('events');

class Logger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxEntries = options.maxEntries || 2000;
    /** @type {Array<object>} 最新的在最后 */
    this.entries = [];
    this.nextId = 1;
  }

  /** 调整缓冲上限（配置变更时调用）。 */
  setMaxEntries(max) {
    this.maxEntries = Math.max(10, Number(max) || 2000);
    this.trim();
  }

  trim() {
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /**
   * 记录一条日志。
   * @param {object} entry 可以带 method/url/status/durationMs 等业务字段，
   *                       也可以只带 { error, stack } —— app.js 的全局错误处理就是这么用的。
   * @returns {object} 补全后的日志条目
   */
  log(entry = {}) {
    const now = Date.now();
    // 注意 Number(null) === 0。如果写成 Number(entry.status)，
    // “连接被掐断”（status 为 null）会被错记成状态码 0，
    // 于是统计里再也分不出“断连”和“0 号状态码”。必须显式区分。
    const status = entry.status === undefined || entry.status === null
      ? null
      : Number(entry.status);

    const record = {
      id: this.nextId++,
      ts: now,
      time: new Date(now).toISOString(),
      level: entry.level || Logger.levelFromStatus(status, entry.error),
      message: entry.message,
      error: entry.error,
      stack: entry.stack,
      // 请求相关字段（模拟器内部产生的事件没有这些）
      method: entry.method,
      url: entry.url,
      path: entry.path,
      status,
      durationMs: entry.durationMs,
      size: entry.size,
      ip: entry.ip,
      userAgent: entry.userAgent,
      // 本次请求被模拟器做了什么手脚，例如 { latencyMs: 300, fault: 'abort' }
      sim: entry.sim,
    };

    // 清掉 undefined，避免 SSE 序列化出一堆 null 字段
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) delete record[key];
    }

    this.entries.push(record);
    this.trim();
    this.emit('entry', record);
    return record;
  }

  /** 根据 HTTP 状态码推断日志级别。 */
  static levelFromStatus(status, error) {
    if (error) return 'error';
    if (status === null) return 'info';
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return 'info';
  }

  /**
   * 查询日志。
   * @param {object} [filter]
   * @param {string} [filter.level] 只返回该级别
   * @param {number} [filter.limit] 最多返回多少条（从最新往前取）
   * @param {number} [filter.since] 只返回 ts 大于该值的条目
   * @param {string} [filter.q] 在 url / message / error 里做不区分大小写的包含匹配
   * @param {boolean} [filter.onlySimulated] 只看被模拟器干预过的请求
   */
  query(filter = {}) {
    let list = this.entries;

    if (filter.level) {
      list = list.filter((e) => e.level === filter.level);
    }
    if (filter.since) {
      const since = Number(filter.since);
      list = list.filter((e) => e.ts > since);
    }
    if (filter.onlySimulated) {
      list = list.filter((e) => e.sim && (e.sim.latencyMs || e.sim.fault || e.sim.throttled));
    }
    if (filter.q) {
      const needle = String(filter.q).toLowerCase();
      list = list.filter((e) => {
        const haystack = `${e.url || ''} ${e.message || ''} ${e.error || ''} ${e.path || ''}`.toLowerCase();
        return haystack.includes(needle);
      });
    }

    const limit = Number(filter.limit);
    if (Number.isFinite(limit) && limit > 0) {
      list = list.slice(-limit);
    }

    return list.slice();
  }

  /** 总条数与各级别条数。 */
  counts() {
    const byLevel = { info: 0, warn: 0, error: 0 };
    for (const e of this.entries) {
      if (byLevel[e.level] === undefined) byLevel[e.level] = 0;
      byLevel[e.level] += 1;
    }
    return { total: this.entries.length, byLevel };
  }

  clear() {
    const removed = this.entries.length;
    this.entries = [];
    this.emit('clear', { removed });
    return removed;
  }
}

module.exports = Logger;
