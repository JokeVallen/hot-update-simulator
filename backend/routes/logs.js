// backend/routes/logs.js
//
// 日志查询接口。挂在 requestPipeline 之前，所以不会受模拟器影响。
//
// 除了普通的分页拉取，还提供了 SSE 实时推送（/api/logs/stream）——
// 前端要显示“请求正在一个接一个地发生”，用 SSE 比每秒轮询干净得多。

const express = require('express');

/**
 * 同时允许的 SSE 连接数上限。
 *
 * 每条连接都会常驻一个定时器、两个 logger 监听器和一个 socket，
 * 而且原实现完全忽略 `res.write()` 的返回值 —— 客户端不读数据（TCP 零窗口）时，
 * 服务端 socket 缓冲区会无上限堆积，这就是一个不需要认证的稳定内存耗尽手段。
 */
const MAX_STREAMS = 8;
/** 反馈持续阻塞多久之后主动断开这条连接（毫秒）。 */
const STALL_TIMEOUT_MS = 60_000;

let activeStreams = 0;

module.exports = function createLogRouter({ logger }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/logs:
   *   get:
   *     tags: [观测]
   *     summary: 查询请求日志
   *     parameters:
   *       - { in: query, name: limit, schema: { type: integer }, description: 最多返回条数（从最新往前取） }
   *       - { in: query, name: level, schema: { type: string, enum: [info, warn, error] } }
   *       - { in: query, name: q, schema: { type: string }, description: 在 url/message/error 里做包含匹配 }
   *       - { in: query, name: since, schema: { type: integer }, description: 只返回时间戳大于该值的条目 }
   *       - { in: query, name: onlySimulated, schema: { type: boolean }, description: 只看被模拟器干预过的请求 }
   *     responses:
   *       200: { description: 日志列表 }
   *   delete:
   *     tags: [观测]
   *     summary: 清空日志
   *     responses:
   *       200: { description: 已清空 }
   */
  router.get('/', (req, res) => {
    const entries = logger.query({
      limit: req.query.limit ? Number(req.query.limit) : 200,
      level: req.query.level ? String(req.query.level) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      since: req.query.since ? Number(req.query.since) : undefined,
      onlySimulated: req.query.onlySimulated === 'true' || req.query.onlySimulated === '1',
    });

    res.json({ ...logger.counts(), entries });
  });

  router.delete('/', (req, res) => {
    const removed = logger.clear();
    res.json({ ok: true, removed });
  });

  /**
   * @openapi
   * /api/logs/stream:
   *   get:
   *     tags: [观测]
   *     summary: 实时日志流（Server-Sent Events）
   *     description: 用 EventSource 订阅，事件名 entry 表示一条新日志，clear 表示日志被清空。
   *     responses:
   *       200: { description: text/event-stream 流 }
   */
  router.get('/stream', (req, res) => {
    if (activeStreams >= MAX_STREAMS) {
      return res.status(503).json({
        error: `实时日志连接数已达上限（${MAX_STREAMS}），请先关闭其它标签页`,
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关掉 nginx 之类的缓冲（如果有反向代理的话）
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    activeStreams += 1;

    /** 上次写出是否反馈了背压（false 表示下游跟不上）。 */
    let backedUp = false;
    let backedUpSince = 0;

    const send = (event, data) => {
      if (res.writableEnded) return;
      try {
        // 保留写的返回值：false 说明 socket 缓冲区满了，客户端没在读
        const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (ok) {
          backedUp = false;
          backedUpSince = 0;
        } else if (!backedUp) {
          backedUp = true;
          backedUpSince = Date.now();
        }
      } catch {
        /* 连接已断 */
      }
    };

    send('hello', { at: new Date().toISOString(), buffered: logger.counts() });

    const onEntry = (entry) => {
      // 已经堵住了就别继续往里塞，直接丢掉这条更新；
      // 实时日志丢几条远好过把服务端内存吃光。
      if (backedUp) return;
      send('entry', entry);
    };
    const onClear = (info) => send('clear', info);

    logger.on('entry', onEntry);
    logger.on('clear', onClear);

    res.on('drain', () => {
      backedUp = false;
      backedUpSince = 0;
    });

    // 心跳：防止中间设备因为长时间没数据把连接掐掉。
    // 同时兼作"卡死连接"的看门狗。
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      if (backedUp && Date.now() - backedUpSince > STALL_TIMEOUT_MS) {
        // 反馈阻塞超过一分钟，说明客户端根本没在读，主动断开
        clearInterval(heartbeat);
        res.destroy();
        return;
      }
      try {
        res.write(': ping\n\n');
      } catch {
        /* 连接已断 */
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      logger.off('entry', onEntry);
      logger.off('clear', onClear);
      activeStreams = Math.max(0, activeStreams - 1);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    return undefined;
  });

  return router;
};
