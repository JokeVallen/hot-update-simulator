// backend/modules/networkSimulator.js
//
// 网络模拟器：负责“链路层面”的不正常——延迟、抖动、带宽限制、丢包、断网。
//
// 和 faultInjector 的分工：
//   networkSimulator  模拟真实的网络环境有多差（慢、抖、断）
//   faultInjector     模拟服务器本身出问题（返回 500、文件损坏、半路断流）
//
// 两者由 middleware/requestPipeline.js 组合起来施加到请求上。

class NetworkSimulator {
  constructor(configManager) {
    this.configManager = configManager;
  }

  /** 读取当前网络设置（带默认值兜底）。 */
  settings() {
    return this.configManager.get('network') || {};
  }

  /**
   * 判断这次请求要不要被干预，并算出具体参数。
   * 纯粹的“决策”，不产生副作用，方便单独测试。
   *
   * @param {import('express').Request} req
   * @returns {{active:boolean, offline:boolean, drop:boolean, latencyMs:number, bandwidthKbps:number}}
   */
  plan(req) {
    const net = this.settings();
    const plan = {
      active: Boolean(net.enabled),
      offline: false,
      drop: false,
      latencyMs: 0,
      bandwidthKbps: 0,
    };

    if (!net.enabled) return plan;

    // 断网：整个服务不可达，客户端应该看到连接被拒/重置，
    // 所以这里不是返回 503，而是直接掐掉 socket——这才是真实的“服务器没开”。
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

    // 延迟 = 基础延迟 + 随机抖动（±jitter），抖动让每次请求的耗时都不一样，
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 直接掐断连接。用于断网和丢包。
   * 先尝试发一个合法的 HTTP 错误响应会更“礼貌”，但那不符合断网的语义，
   * 所以这里就是硬断，客户端会收到 socket hang up / ERR_CONNECTION_RESET。
   */
  drop(req, res, reason) {
    if (req._sim) req._sim.dropped = reason;
    try {
      if (req.socket && !req.socket.destroyed) {
        req.socket.destroy();
      } else {
        res.destroy();
      }
    } catch {
      /* socket 可能已经被对端关掉了，忽略 */
    }
  }

  /**
   * 给响应限速。
   *
   * 做法是接管 res.write / res.end，把每一次写出放进一条 Promise 串行链里，
   * 每个分片按“分片大小 ÷ 速率”睡一会儿再真正写出。
   *
   * 为什么用串行链：Express 的 res.send() 会紧接着调用 res.end()，
   * 如果只延迟 write，end 会先跑，数据顺序就乱了。串行链保证了
   * 顺序正确，并且总耗时 ≈ 总字节数 ÷ 速率。
   *
   * 已知取舍：不处理背压，所以用极低带宽下载超大文件时，
   * 上游（文件流）会先把数据读进内存排队。作为模拟器可以接受，
   * 但如果以后要支撑上 GB 的测试包，这里需要改成按需暂停数据源。
   *
   * @param {import('express').Response} res
   * @param {number} kbps 千比特每秒；<=0 表示不限速
   */
  throttle(res, kbps) {
    const rate = Number(kbps) || 0;
    if (rate <= 0) return;

    // kbps(千比特/秒) → 字节/毫秒： kbps * 1000 / 8 / 1000 = kbps / 8
    const bytesPerMs = rate / 8;
    if (bytesPerMs <= 0) return;

    const sim = res.req && res.req._sim;
    if (sim) {
      sim.throttled = true;
      sim.bandwidthKbps = rate;
    }

    const originalWrite = res.write;
    const originalEnd = res.end;
    let chain = Promise.resolve();

    const sizeOf = (chunk, encoding) => {
      if (chunk === null || chunk === undefined) return 0;
      if (Buffer.isBuffer(chunk)) return chunk.length;
      if (typeof chunk === 'string') {
        return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      }
      return 0;
    };

    const wait = (bytes) => {
      const ms = bytes / bytesPerMs;
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => setTimeout(resolve, ms));
    };

    res.write = function throttledWrite(chunk, encoding, callback) {
      const bytes = sizeOf(chunk, encoding);
      chain = chain.then(() => wait(bytes)).then(() => originalWrite.call(this, chunk, encoding, callback));
      // 返回 true 表示“可以继续写”。真实的背压信号这里给不出来，
      // 因为数据要排队；给出 false 会让调用方等一个永远不会来的 drain 事件。
      return true;
    };

    res.end = function throttledEnd(chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
        enc = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        enc = undefined;
      }

      const bytes = sizeOf(chunk, enc);
      chain = chain.then(() => wait(bytes)).then(() => originalEnd.call(this, chunk, enc, cb));
      return this;
    };
  }
}

module.exports = NetworkSimulator;
