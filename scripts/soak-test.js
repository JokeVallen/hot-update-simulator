// scripts/soak-test.js
//
// 浸泡测试：模拟"挂着调试一下午"的用法，回答两个问题：
//   1. 内存稳不稳（限速、断流、大量请求之后会不会一直涨）
//   2. 跑完这么多乱七八糟的操作之后，服务是不是还完全可用
//
// 会依次切换多种场景（理想 / 限速 / 断流 / 延迟），每种 50 个混合请求。
// 每个场景都设定**完整**状态：网络参数和故障规则是两个独立的旋钮，
// 只改一个不会动另一个 —— 这正是正确的产品行为，所以脚本必须两个都设，
// 否则上一轮的规则会漏进下一轮，看着像 bug 其实是脚本的错。
//
// 用法：npm run soak

const http = require('http');

const port = 5641;
process.env.PORT = String(port);
const app = require('../backend/app');
const configManager = app.locals.configManager;
const server = app.listen(port);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function get(urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, err: null }));
      res.on('aborted', () => resolve({ status: res.statusCode, bytes, err: 'ABORTED' }));
      res.on('error', (e) => resolve({ status: res.statusCode, bytes, err: e.code }));
    });
    req.on('error', (e) => resolve({ status: null, bytes: 0, err: e.code }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: null, bytes: 0, err: 'TIMEOUT' }); });
    req.end();
  });
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

async function main() {
  await new Promise((r) => { server.once('listening', r); });
  const logger = app.locals.logger;
  const faultInjector = app.locals.faultInjector;

  const rssStart = process.memoryUsage().rss;
  console.log(`起始 RSS ${mb(rssStart)} MB`);

  const ASSET = '/assets/Android/bundles/android_bundle_01.ab';
  const scenarios = ['idle', 'throttled', 'abort', 'latency', 'faults-off'];

  let total = 0;
  let errors = 0;

  for (let round = 0; round < 8; round += 1) {
    const scenario = scenarios[round % scenarios.length];

    // 每个场景都必须设定**完整**状态。
    // 网络参数和故障规则是两个独立的旋钮，只改一个不会动另一个 ——
    // 这正是正确的产品行为（预置方案才会同时设两者）。
    // 第一版脚本漏了这点，于是上一轮的 abort 规则漏进了下一轮，
    // 表现为"latency 场景下资产下载被砍掉一半"，看着像 bug 其实是脚本的错。
    const cleanNetwork = { enabled: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 };
    const rulesFor = (name) => (name ? [{
      id: `soak-${name}`, name: `soak ${name}`, enabled: true, probability: 1, maxHits: 0,
      match: { pathPrefix: '/assets' },
      action: { type: 'abort', ratio: 0.5 },
    }] : []);

    if (scenario === 'throttled') {
      configManager.patch({
        network: { ...cleanNetwork, enabled: true, bandwidthKbps: 20000 },
        fault: { enabled: false, rules: [] },
      });
    } else if (scenario === 'latency') {
      configManager.patch({
        network: { ...cleanNetwork, enabled: true, latencyMs: 30, jitterMs: 20 },
        fault: { enabled: false, rules: [] },
      });
    } else if (scenario === 'abort') {
      configManager.patch({
        network: { ...cleanNetwork },
        fault: { enabled: true, rules: rulesFor(scenario) },
      });
    } else {
      configManager.patch({ network: { ...cleanNetwork }, fault: { enabled: false, rules: [] } });
    }

    // 每个场景 50 个请求，混合各种端点
    for (let i = 0; i < 50; i += 1) {
      total += 1;
      const pick = i % 5;
      let res;
      if (pick === 0) res = await get(ASSET);
      else if (pick === 1) res = await get('/api/health');
      else if (pick === 2) res = await get('/api/manifest?platform=Android');
      else if (pick === 3) res = await get('/api/control');
      else res = await get(ASSET, { Range: `bytes=${i * 1000}-` });

      // 被注入故障导致的失败是预期结果，只统计"不该失败却失败"的
      const expectedFailure = scenario === 'abort' && (pick === 0 || pick === 4);
      if (res.err && !expectedFailure) {
        errors += 1;
        console.log(`    ✗ 非预期失败: ${scenario} pick=${pick} -> ${res.err} status=${res.status} bytes=${res.bytes}`);
      }
    }

    if (global.gc) global.gc();
    await sleep(120);
    const rss = process.memoryUsage().rss;
    console.log(`  第 ${round + 1} 轮 (${scenario.padEnd(10)}) 累计 ${String(total).padStart(3)} 请求  `
      + `RSS ${mb(rss)} MB  logger ${logger.entries.length} 条  hitCounts ${faultInjector.hitCounts.size} 项`);
  }

  // 收尾：恢复干净状态并确认仍然完全可用
  configManager.patch({
    network: { enabled: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 },
    fault: { enabled: false, rules: [] },
  });
  await sleep(300);

  const rssEnd = process.memoryUsage().rss;
  const health = await get('/api/health');
  const asset = await get(ASSET);

  console.log('');
  console.log('--- 结果 ---');
  console.log(`总请求 ${total}，非预期失败 ${errors}`);
  console.log(`RSS ${mb(rssStart)} MB -> ${mb(rssEnd)} MB  (增长 ${mb(rssEnd - rssStart)} MB)`);
  console.log(`日志缓冲 ${logger.entries.length} 条（上限 ${logger.configManager ? '?' : logger.maxEntries}）`);
  console.log(`结束时健康检查: ${health.status}${health.err ? ' (' + health.err + ')' : ''}`);
  console.log(`结束时完整下载: ${asset.status}, ${asset.bytes} 字节, err=${asset.err}`);

  server.close();
  process.exit(0);
}

main();
