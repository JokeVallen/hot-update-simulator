// backend/middleware/loggerMiddleware.js
//
// 请求日志中间件。挂在最前面，这样它能观察到每一个请求的最终结果，
// 包括被 requestPipeline 拖慢、打断、伪造状态码的那些。
//
// 它只在响应结束时记一条日志，而不是在进入时记——因为耗时和状态码
// 只有到那时才知道。开始处理的那一刻会打一个时间戳挂在 req 上。

const { performance } = require('perf_hooks');

module.exports = function loggerMiddleware(logger) {
  return function logRequest(req, res, next) {
    req._startAt = performance.now();
    // 预置一个空对象，requestPipeline 会往里写它做了什么
    req._sim = req._sim || {};

    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;

      // 状态码 0 / null 表示连接被直接掐断，客户端只会看到网络错误
      const status = res.headersSent ? res.statusCode : null;
      const durationMs = Math.round(performance.now() - req._startAt);

      // res.getHeader 返回 undefined 表示没设置，chunked 编码时拿不到内容长度
      const lengthHeader = res.getHeader && res.getHeader('content-length');
      const size = Number(res.getHeader && res.getHeader('x-sent-bytes'))
        || (lengthHeader === undefined ? undefined : Number(lengthHeader))
        || undefined;

      const sim = req._sim && Object.keys(req._sim).length ? { ...req._sim } : undefined;

      logger.log({
        method: req.method,
        url: req.originalUrl || req.url,
        path: req.path,
        status,
        // 连接被掐断（断网/丢包/断流）不是正常结果，标成 warn 才容易在
        // 日志列表里一眼看见。其它情况交给 logger 按状态码推断。
        level: status === null ? 'warn' : undefined,
        durationMs,
        size,
        ip: req.ip || (req.socket && req.socket.remoteAddress),
        userAgent: req.get && req.get('user-agent'),
        sim,
      });
    };

    res.on('finish', finish);
    // 连接被掐断时 'finish' 不会触发，只有 'close'
    res.on('close', finish);

    next();
  };
};
