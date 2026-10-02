// backend/middleware/requestPipeline.js
//
// 把“网络模拟”和“故障注入”组合成一道中间件，施加到业务请求上。
//
// 在 app.js 里它挂在控制类接口（/api/logs、/api/control、/api/presets…）之后，
// 所以那些接口永远不会被自己的模拟拖慢——否则你一旦把延迟调到 10 秒，
// 就再也没法从界面上把它调回来了。受影响的只有 /api（热更业务接口）
// 和 /assets（资产下载）。
//
// ────────────── 施加顺序（改动前请先看清楚） ──────────────
//   1. 延迟（链路往返时间）
//   2. 断网 / 丢包 → 直接掐断，结束
//   3. 故障里“自己产生响应”的那些（status / timeout / empty）→ 结束
//   4. 剩下的（限速 + abort/truncate/corrupt）合成**一次**
//      responseShaper.install()，然后继续走业务路由
//
// 第 4 步是关键：限速和截断必须在同一次安装里完成。
// 原来是 faultInjector 先包一层、networkSimulator 再包一层，
// 两层嵌套顺序反过来就会让 abort 的切点在第一个分片就触发，
// 「限速下的断流」静默变成「延迟一下然后立刻断」，而且不报任何错。

const responseShaper = require('../modules/responseShaper');

module.exports = function requestPipeline({ networkSimulator, faultInjector }) {
  return async function pipeline(req, res, next) {
    try {
      // req._sim 由 loggerMiddleware 预置，这里往里写“我对这个请求做了什么”
      if (!req._sim) req._sim = {};

      const netPlan = networkSimulator.plan();

      // 断网 / 丢包：直接掐断连接
      if (netPlan.offline || netPlan.drop) {
        networkSimulator.drop(req, res, netPlan.offline ? 'offline' : 'packet-loss');
        return;
      }

      if (netPlan.latencyMs > 0) {
        req._sim.latencyMs = netPlan.latencyMs;
        await networkSimulator.delay(netPlan.latencyMs);
      }

      const faultPlan = faultInjector.plan(req);

      // 故障里的 slowHeader：延迟已经在 plan 里给出，这里施加
      if (faultPlan.delayMs > 0) {
        req._sim.faultDelayMs = faultPlan.delayMs;
        await networkSimulator.delay(faultPlan.delayMs);
      }

      // 自己产生响应的故障，后面不用再跑了
      if (faultPlan.respond) {
        faultPlan.respond(req, res);
        return;
      }

      // 唯一一次响应体干预安装点：限速与截断在这里合成同一条队列
      responseShaper.install(req, res, {
        shape: faultPlan.shape,
        throttleKbps: netPlan.bandwidthKbps,
      });

      next();
    } catch (err) {
      next(err);
    }
  };
};
