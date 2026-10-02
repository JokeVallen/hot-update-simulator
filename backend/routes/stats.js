// backend/routes/stats.js
//
// 统计接口：把原始日志聚合成界面上能直接画图的数据。
//
// 之所以在服务端算而不是丢给前端：日志可能有几千条，
// 每秒钟把所有原始条目推给浏览器去算，既费流量又费 CPU。

const express = require('express');

/** 计算分位数。传入的数组会被排序，调用方注意别复用。 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

module.exports = function createStatsRouter({ logger }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/stats:
   *   get:
   *     tags: [观测]
   *     summary: 请求统计汇总
   *     parameters:
   *       - { in: query, name: windowMinutes, schema: { type: integer, default: 5 }, description: 时间窗口（分钟） }
   *     responses:
   *       200: { description: 统计数据 }
   */
  router.get('/', (req, res) => {
    // 窗口上限：不加限制的话 `?windowMinutes=100000` 会让时间线分配
    // 上百万个对象（bucketCount 与窗口长度成正比），一个请求就能把内存打满。
    const windowMinutes = Math.min(24 * 60, Math.max(1, Number(req.query.windowMinutes) || 5));
    const now = Date.now();
    const windowStart = now - windowMinutes * 60_000;

    const recent = logger.query({ since: windowStart });
    // 只统计真正的 HTTP 请求；模拟器自己产生的事件没有 method
    const requests = recent.filter((e) => e.method);

    const byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, disconnected: 0 };
    // 窗口内的级别统计，与全局统计分开（见响应体里的说明）
    const byLevel = { info: 0, warn: 0, error: 0 };
    const byPath = new Map();
    const durations = [];
    let totalBytes = 0;

    const simulated = { delayed: 0, throttled: 0, faulted: 0, dropped: 0, ranged: 0 };

    for (const entry of requests) {
      const status = entry.status;
      if (status === null || status === undefined) {
        byStatusClass.disconnected += 1;
      } else {
        const cls = `${Math.floor(status / 100)}xx`;
        if (byStatusClass[cls] === undefined) byStatusClass[cls] = 0;
        byStatusClass[cls] += 1;
      }

      byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;

      // 按“路径去掉参数”聚合，否则每个平台/版本都会算成一条
      const key = entry.path || entry.url || 'unknown';
      const bucket = byPath.get(key) || { path: key, count: 0, totalMs: 0, errors: 0 };
      bucket.count += 1;
      bucket.totalMs += entry.durationMs || 0;
      if (status === null || status >= 400) bucket.errors += 1;
      byPath.set(key, bucket);

      if (typeof entry.durationMs === 'number') durations.push(entry.durationMs);
      if (typeof entry.size === 'number') totalBytes += entry.size;

      const sim = entry.sim || {};
      if (sim.latencyMs) simulated.delayed += 1;
      if (sim.throttled) simulated.throttled += 1;
      if (sim.fault) simulated.faulted += 1;
      if (sim.dropped) simulated.dropped += 1;
      if (sim.range) simulated.ranged += 1;
    }

    const sortedDurations = durations.slice().sort((a, b) => a - b);
    const sum = sortedDurations.reduce((acc, v) => acc + v, 0);

    // 时间线：按 5 秒一格分桶，前端可以直接画折线。
    //
    // 用「相对窗口起点」算下标，而不是「相对现在倒推」。
    // 原来写的是 `bucketCount - 1 - floor(offset / bucketMs)`，
    // 对恰好落在窗口起点的那一条会算出 -1 被丢掉 —— 每一格 5 分钟的窗口
    // 都会稳定丢失最旧的 5 秒数据，而且 timeline[0] 的时间戳就标着那一段。
    const bucketMs = 5000;
    const bucketCount = Math.max(1, Math.ceil((windowMinutes * 60_000) / bucketMs));

    const timeline = Array.from({ length: bucketCount }, (_, i) => {
      const start = windowStart + i * bucketMs;
      return { at: new Date(start).toISOString(), count: 0, errors: 0, avgMs: 0, _sum: 0 };
    });

    for (const entry of requests) {
      const offset = (entry.ts || 0) - windowStart;
      if (offset < 0) continue;
      // 夹到最后一格：恰好等于 now 的那条会算出 bucketCount，越界
      const index = Math.min(bucketCount - 1, Math.floor(offset / bucketMs));
      const slot = timeline[index];
      slot.count += 1;
      slot._sum += entry.durationMs || 0;
      if (entry.status === null || entry.status === undefined || entry.status >= 400) {
        slot.errors += 1;
      }
    }
    for (const slot of timeline) {
      slot.avgMs = slot.count ? Math.round(slot._sum / slot.count) : 0;
      delete slot._sum;
    }

    const topPaths = [...byPath.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((b) => ({
        path: b.path,
        count: b.count,
        errors: b.errors,
        avgMs: b.count ? Math.round(b.totalMs / b.count) : 0,
      }));

    res.json({
      windowMinutes,
      generatedAt: new Date().toISOString(),
      requests: {
        // 注意：这里的 total 是**窗口内**的请求数，byLevel 也是窗口内的。
        // 原来写的是 `{ total: requests.length, byStatusClass, ...logger.counts() }`，
        // 而 logger.counts() 返回的是整个环形缓冲区的统计，展开后会把
        // 窗口内的 total / byLevel 直接覆盖掉 —— 同一个响应里两个字段口径不同，
        // 前端画图必然对不上（timeline 求和是窗口值，total 却是全局值）。
        total: requests.length,
        byStatusClass,
        byLevel,
      },
      // 全局（整个缓冲区）的口径单独放，名字上就区分开
      lifetime: logger.counts(),
      latency: {
        avgMs: sortedDurations.length ? Math.round(sum / sortedDurations.length) : 0,
        p50Ms: percentile(sortedDurations, 50),
        p95Ms: percentile(sortedDurations, 95),
        maxMs: sortedDurations.length ? sortedDurations[sortedDurations.length - 1] : 0,
        minMs: sortedDurations.length ? sortedDurations[0] : 0,
      },
      throughput: {
        totalBytes,
        avgBytesPerRequest: requests.length ? Math.round(totalBytes / requests.length) : 0,
      },
      simulated,
      topPaths,
      timeline,
    });
  });

  return router;
};
