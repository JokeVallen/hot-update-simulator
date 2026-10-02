// backend/modules/networkSimulator.js
//
// 网络模拟器：负责“链路层面”的不正常——延迟、抖动、带宽限制、丢包、断网。
//
// 和 faultInjector 的分工：
//   networkSimulator  模拟真实的网络环境有多差（慢、抖、断）
//   faultInjector     模拟服务器本身出问题（500、文件损坏、半路断流）
//
// 本模块只做「决策」和「链路层动作」。所有对 res.write / res.end 的改写
// 都收敛在 modules/responseShaper.js 里统一处理——原来限速逻辑长在这里，
// 和 faultInjector 各自包一层，顺序一错就静默走偏，而且没有背压。
// 现在请求管线只调用一次 shaper，把限速和截断作为同一份策略传进去。

class NetworkSimulator {
  constructor(configManager) {
    this.configManager = configManager;
  }

  /** 读取当前网络设置。 */
  settings() {
    return this.configManager.get('network') || {};
  }

  /**
   * 判断这次请求要不要被干预，并算出具体参数。
   * 纯粹的决策，不产生副作用，方便单独测试。
   */
  plan() {
    const net = this.settings();
    const plan = {
      active: Boolean(net.enabled),
      offline: false,
      drop: false,
      latencyMs: 0,
      bandwidthKbps: 0,
    };

    if (!net.enabled) return plan;

    // 断网：整个服务不可达。这里刻意不返回 503，而是直接掐掉 socket ——
    // 真实世界里服务器没开，客户端收到的是连接被拒/重置，不是一条 HTTP 错误。
    // 这两者对客户端代码的要求完全不同，模拟器必须还原这一点。
    if (net.offline) {
      plan.offline = true;
      return plan;
    }

    // 丢包：整包丢失，表现为连接直接断掉
    const lossRate = Number(net.packetLossRate) || 0;
    if (lossRate > 0 && Math.random() < lossRate) {
      plan.drop = true;
      return plan;
    }

    // 延迟 = 基础延迟 + 随机抖动（±jitter）。抖动让每次请求耗时都不一样，
    // 这正是真实网络的样子，客户端的重试/超时逻辑要能扛住这种不确定性。
    const base = Number(net.latencyMs) || 0;
    const jitter = Number(net.jitterMs) || 0;
    const offset = jitter > 0 ? Math.round((Math.random() * 2 - 1) * jitter) : 0;
    plan.latencyMs = Math.max(0, base + offset);

    plan.bandwidthKbps = Number(net.bandwidthKbps) || 0;

    return plan;
  }

  /** 按毫秒延迟。返回 Promise，让 requestPipeline 能 await。 */
  delay(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 直接掐断连接。用于断网和丢包。
   * 这里就是硬断，客户端会收到 socket hang up / ERR_CONNECTION_RESET。
   */
  drop(req, res, reason) {
    if (req._sim) req._sim.dropped = reason;
    try {
      if (req.socket && !req.socket.destroyed) {
        req.socket.destroy();
      } else if (res && !res.destroyed) {
        res.destroy();
      }
    } catch {
      /* socket 可能已经被对端关掉了，忽略 */
    }
  }
}

module.exports = NetworkSimulator;
