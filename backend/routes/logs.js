// backend/routes/logs.js
//
// 日志查询接口。挂在 requestPipeline 之前，所以不会受模拟器影响。
//
// 除了普通的分页拉取，还提供了 SSE 实时推送（/api/logs/stream）——
// 前端要显示“请求正在一个接一个地发生”，用 SSE 比每秒轮询干净得多。

const express = require('express');

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
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关掉 nginx 之类的缓冲（如果有反向代理的话）
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { at: new Date().toISOString(), buffered: logger.counts() });

    const onEntry = (entry) => send('entry', entry);
    const onClear = (info) => send('clear', info);

    logger.on('entry', onEntry);
    logger.on('clear', onClear);

    // 心跳：防止中间设备因为长时间没数据把连接掐掉
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': ping\n\n');
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      logger.off('entry', onEntry);
      logger.off('clear', onClear);
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    return undefined;
  });

  return router;
};
