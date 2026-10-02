// backend/middleware/requestPipeline.js
//
// 把“网络模拟”和“故障注入”组合成一道中间件，施加到业务请求上。
//
// 在 app.js 里它挂在控制类接口（/api/logs、/api/control、/api/presets…）之后，
// 所以那些接口永远不会被自己的模拟拖慢——否则你一旦把延迟调到 10 秒，
// 就再也没法从界面上把它调回来了。
// 受影响的只有 /api（热更业务接口）和 /assets（资产下载）。
//
// 施加顺序很重要：
//   1. 延迟（链路往返时间）
//   2. 故障注入
//   3. 限速（包在故障改写的外层）
// 这样“限速 100Kbps”和“下到一半断流”才能叠加成同一个真实场景。

module.exports = function requestPipeline({ networkSimulator, faultInjector }) {
  return async function pipeline(req, res, next) {
    try {
      // req._sim 由 loggerMiddleware 预置，这里往里写“我对这个请求做了什么”
      if (!req._sim) req._sim = {};

      const plan = networkSimulator.plan(req);

      // 断网 / 丢包：直接掐断连接。
      // 不返回 503 是刻意的——真实世界里服务器没开，客户端收到的是
      // 连接被拒或连接重置，不是一条 HTTP 错误响应。两者对客户端
      // 代码的要求完全不同，模拟器必须还原这一点。
      if (plan.offline || plan.drop) {
        networkSimulator.drop(req, res, plan.offline ? 'offline' : 'packet-loss');
        return;
      }

      if (plan.latencyMs > 0) {
        req._sim.latencyMs = plan.latencyMs;
        await networkSimulator.delay(plan.latencyMs);
      }

      const fault = faultInjector.pick(req);
      const outcome = await faultInjector.apply(req, res, fault);

      // 故障自己产生了响应（500、超时、空 body），后面不用再跑了
      if (outcome === 'responded') return;

      // 限速放在最后包：它包住的是“已经被故障改写过的”响应，
      // 所以断流位置仍然按真实数据量计算，只是发得慢一点。
      if (plan.bandwidthKbps > 0) {
        networkSimulator.throttle(res, plan.bandwidthKbps);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
