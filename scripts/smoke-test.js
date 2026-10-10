#!/usr/bin/env node
// scripts/smoke-test.js
//
// 端到端冒烟测试：把每一种故障类型都真的触发一遍，确认模拟器确实在起作用。
//
// 为什么需要它：这个项目的核心价值是"模拟得准不准"，
// 如果故障注入其实没生效，或者限速算错了，看代码是看不出来的——
// 必须真的发请求、真的比对字节。
//
// 重要：测试会修改 backend/config.json，所以启动前先备份、结束后恢复。
// 它在本进程内启动服务器（不占 5500 端口），不会影响你正在跑的实例。
//
// 用法：
//   npm run sample      # 先生成测试资产
//   npm run smoke

const fs = require('fs');
const { finish, isExitSignal } = require('./lib/exit');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const CONFIG_PATH = path.resolve(__dirname, '..', 'backend', 'config.json');
// 和服务器、示例生成脚本共用同一个存储根（见 backend/core/paths.js），
// 这样设了 HOT_UPDATE_STORAGE 之后测试仍然找得到资产。
const ASSETS_ROOT = require('../backend/core/paths').assetsDir();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 发一个请求。连接被掐断时不抛异常，而是返回 { error }，因为那本身就是要测的行为。 */
function request(port, urlPath, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method || 'GET',
        path: urlPath,
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }));
        res.on('error', (err) => resolve({ error: err }));
      },
    );
    req.setTimeout(options.timeout || 20000, () => {
      req.destroy();
      resolve({ error: new Error('TIMEOUT'), timedOut: true });
    });
    req.on('error', (err) => resolve({ error: err }));
    if (options.body) req.write(options.body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function main() {
  if (!fs.existsSync(ASSETS_ROOT)) {
    console.error('找不到测试资产。请先执行：npm run sample\n');
    finish(1);
  }

  // 备份配置，测试改坏了也能还原
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');

  // 在本进程内起服务，用一个不常见的端口避免冲突
  const port = 5599;
  process.env.PORT = String(port);
  const app = require('../backend/app');
  app.locals.configManager.patch({
    server: { port },
    network: { enabled: false, offline: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 },
    fault: { enabled: false, rules: [] },
  });

  const server = app.listen(port);
  await new Promise((resolve) => { server.once('listening', resolve); });
  console.log(`测试服务器已启动：http://127.0.0.1:${port}`);

  try {
    // ------------------------------------------------------------ 基础接口
    section('基础接口');

    const health = await request(port, '/api/health');
    check('GET /api/health 返回 200', health.status === 200, `实际 ${health.status}`);

    const system = await request(port, '/api/system');
    const systemJson = system.status === 200 ? JSON.parse(system.body.toString()) : {};
    check('GET /api/system 返回 200', system.status === 200, `实际 ${system.status}`);
    check('资产目录存在', systemJson.paths && systemJson.paths.assetRootExists === true);

    const platforms = await request(port, '/api/platforms');
    const platformsJson = JSON.parse(platforms.body.toString());
    const names = platformsJson.platforms.map((p) => p.name);
    check('GET /api/platforms 列出 Android 和 iOS', names.includes('Android') && names.includes('iOS'), names.join(','));

    const missing = await request(port, '/api/nope');
    check('未知路径返回 404 JSON', missing.status === 404, `实际 ${missing.status}`);

    // ------------------------------------------------------------ 版本与清单
    section('版本判断与清单');

    const sameVersion = await request(port, '/api/version?platform=Android&current=1.0.0');
    const sameJson = JSON.parse(sameVersion.body.toString());
    check('版本相同时 needUpdate=false', sameJson.needUpdate === false, JSON.stringify(sameJson.needUpdate));

    const oldVersion = await request(port, '/api/version?platform=Android&current=0.0.1');
    const oldJson = JSON.parse(oldVersion.body.toString());
    check('版本落后时 needUpdate=true', oldJson.needUpdate === true);
    check(
      '低于 minVersion 时强制更新',
      oldJson.forceUpdate === true,
      `minVersion=${oldJson.minVersion} forceUpdate=${oldJson.forceUpdate}`,
    );

    const noPlatform = await request(port, '/api/version');
    check('缺少 platform 返回 400', noPlatform.status === 400, `实际 ${noPlatform.status}`);

    const badPlatform = await request(port, '/api/version?platform=NoSuchPlatform');
    check('平台不存在返回 404', badPlatform.status === 404, `实际 ${badPlatform.status}`);

    const manifest = await request(port, '/api/manifest?platform=Android');
    const manifestJson = JSON.parse(manifest.body.toString());
    check('清单包含 3 个文件', manifestJson.files.length === 3, `实际 ${manifestJson.files.length}`);
    check('清单每项都有 md5', manifestJson.files.every((f) => typeof f.hash === 'string' && f.hash.length === 32));
    check('清单每项都有下载地址', manifestJson.files.every((f) => f.url.startsWith('/assets/Android/')));

    const checkApi = await request(port, '/api/check?platform=Android&current=0.0.1');
    const checkJson = JSON.parse(checkApi.body.toString());
    check('GET /api/check 同时返回判断与清单', checkJson.needUpdate === true && Array.isArray(checkJson.files));

    const noUpdateCheck = await request(port, '/api/check?platform=Android&current=1.0.0');
    const noUpdateJson = JSON.parse(noUpdateCheck.body.toString());
    check('无需更新时不返回完整清单（省流量）', noUpdateJson.files.length === 0);

    // ------------------------------------------------------------ 资产下载
    section('资产下载');

    const targetPath = '/assets/Android/bundles/android_bundle_01.ab';
    const expected = manifestJson.files.find((f) => f.path === 'bundles/android_bundle_01.ab');
    const download = await request(port, targetPath);

    check('下载返回 200', download.status === 200, `实际 ${download.status}`);
    check(
      'Content-Length 与实际字节数一致',
      Number(download.headers['content-length']) === download.body.length,
      `${download.headers['content-length']} vs ${download.body.length}`,
    );
    check('下载内容 md5 与清单一致', md5(download.body) === expected.hash);
    check('声明了 Accept-Ranges', download.headers['accept-ranges'] === 'bytes');
    check('返回了 ETag', typeof download.headers.etag === 'string');

    // 协商缓存
    const cached = await request(port, targetPath, { headers: { 'If-None-Match': download.headers.etag } });
    check('带 If-None-Match 命中时返回 304', cached.status === 304, `实际 ${cached.status}`);
    check('304 不返回响应体', cached.body.length === 0);

    // 断点续传
    const rangeStart = 1000;
    const ranged = await request(port, targetPath, { headers: { Range: `bytes=${rangeStart}-` } });
    check('Range 请求返回 206', ranged.status === 206, `实际 ${ranged.status}`);
    check(
      'Content-Range 正确',
      ranged.headers['content-range'] === `bytes ${rangeStart}-${download.body.length - 1}/${download.body.length}`,
      ranged.headers['content-range'],
    );
    check(
      '续传片段内容与原文件对应位置一致',
      ranged.body.equals(download.body.subarray(rangeStart)),
      `长度 ${ranged.body.length}`,
    );

    const badRange = await request(port, targetPath, { headers: { Range: `bytes=${download.body.length + 10}-` } });
    check('不可满足的 Range 返回 416', badRange.status === 416, `实际 ${badRange.status}`);

    const notFound = await request(port, '/assets/Android/bundles/nope.ab');
    check('不存在的资产返回 404', notFound.status === 404, `实际 ${notFound.status}`);

    // ------------------------------------------------------------ 路径穿越
    section('路径穿越防护');

    const traversals = [
      '/assets/Android/../../../.env',
      '/assets/Android/..%2f..%2f..%2f.env',
      '/assets/Android/%2e%2e%2f%2e%2e%2f.env',
      '/assets/Android/bundles/../../../../package.json',
    ];
    for (const attack of traversals) {
      const res = await request(port, attack);
      // 关键是不能返回 200 并真的把文件内容吐出来
      const leaked = res.status === 200 && res.body.length > 0;
      check(`拦截 ${attack}`, !leaked, `状态 ${res.status}，返回 ${res.body.length} 字节`);
    }

    // ------------------------------------------------------------ 网络模拟
    section('网络模拟');

    await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, latencyMs: 300, jitterMs: 0 }),
    });

    const before = Date.now();
    await request(port, '/api/health');
    const latencyElapsed = Date.now() - before;
    check('基础延迟生效（约 300ms）', latencyElapsed >= 280, `实际 ${latencyElapsed}ms`);

    // 控制接口本身不应该被延迟，否则界面就救不回来了
    const controlBefore = Date.now();
    await request(port, '/api/control');
    const controlElapsed = Date.now() - controlBefore;
    check('控制接口不受延迟影响', controlElapsed < 200, `实际 ${controlElapsed}ms`);

    // 限速：1MB 文件限制到 800Kbps ≈ 100KB/s，理论上约 10 秒。
    // 用一个有明显区分度但不会拖太久的档位来验证"确实变慢了"。
    await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, latencyMs: 0, jitterMs: 0, bandwidthKbps: 8000 }),
    });

    const throttleStart = Date.now();
    const throttled = await request(port, targetPath);
    const throttleElapsed = Date.now() - throttleStart;
    // 2MB @ 8000Kbps = 1MB/s → 约 2 秒。不被限速的话是几十毫秒。
    check('限速生效（2MB 至少花 1.5 秒）', throttleElapsed >= 1500, `实际 ${throttleElapsed}ms`);
    check('限速下内容仍然完整', md5(throttled.body) === expected.hash);

    // 丢包 100%：必定断连
    await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, latencyMs: 0, bandwidthKbps: 0, packetLossRate: 1 }),
    });
    const dropped = await request(port, '/api/health');
    check('100% 丢包时连接被掐断', Boolean(dropped.error) || dropped.status === undefined, `状态 ${dropped.status}`);

    // 断网：同样是连接层失败，不是 HTTP 错误
    await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, packetLossRate: 0, offline: true }),
    });
    const offline = await request(port, '/api/health');
    check('断网时连接被掐断', Boolean(offline.error) || offline.status === undefined, `状态 ${offline.status}`);

    const controlStillWorks = await request(port, '/api/control');
    check('断网期间控制接口依然可用', controlStillWorks.status === 200, `实际 ${controlStillWorks.status}`);

    // ------------------------------------------------------------ 故障注入
    section('故障注入');

    const disable = await request(port, '/api/control/disable', { method: 'POST' });
    check('急停接口可用', disable.status === 200, `实际 ${disable.status}`);

    // status 故障
    const ruleRes = await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：版本接口 503',
        match: { pathPrefix: '/api/version' },
        action: { type: 'status', status: 503, body: '模拟维护中' },
      }),
    });
    const createdRule = JSON.parse(ruleRes.body.toString()).rule;
    check('新增故障规则返回 201', ruleRes.status === 201, `实际 ${ruleRes.status}`);

    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    const faulted = await request(port, '/api/version?platform=Android');
    check('status 故障返回指定状态码 503', faulted.status === 503, `实际 ${faulted.status}`);
    check('status 故障返回自定义响应体', faulted.body.toString() === '模拟维护中', faulted.body.toString());

    const unaffected = await request(port, '/api/manifest?platform=Android');
    check('不匹配规则的请求不受影响', unaffected.status === 200, `实际 ${unaffected.status}`);

    // 删除规则
    const delRes = await request(port, `/api/control/fault/rules/${createdRule.id}`, { method: 'DELETE' });
    check('删除故障规则成功', delRes.status === 200, `实际 ${delRes.status}`);

    // corrupt 故障：下载"成功"但内容被改坏
    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：内容损坏',
        match: { pathPrefix: '/assets' },
        action: { type: 'corrupt', ratio: 0.05 },
      }),
    });

    const corrupted = await request(port, targetPath);
    check('corrupt 故障下状态码仍是 200', corrupted.status === 200, `实际 ${corrupted.status}`);
    check(
      'corrupt 故障下长度不变',
      corrupted.body.length === download.body.length,
      `${corrupted.body.length} vs ${download.body.length}`,
    );
    check(
      'corrupt 故障下 md5 校验确实能发现问题',
      md5(corrupted.body) !== expected.hash,
      '内容竟然没被改坏',
    );

    // abort 故障：下到一半断流
    //
    // 必须先清掉上一条 corrupt 规则：pick() 的语义是"第一条匹配的规则生效"，
    // 不清掉的话请求会被 corrupt 吃掉，abort 规则永远轮不到。
    // 这个语义本身也要确认一下，不然用户会以为规则可以叠加。
    await request(port, '/api/control/reset', { method: 'POST' });

    const firstMatchWins = await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：优先级高的规则',
        match: { pathPrefix: '/api/health' },
        action: { type: 'status', status: 418 },
      }),
    });
    const firstRule = JSON.parse(firstMatchWins.body.toString()).rule;
    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：优先级低的规则',
        match: { pathPrefix: '/api/health' },
        action: { type: 'status', status: 503 },
      }),
    });
    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const ordered = await request(port, '/api/health');
    check('多条规则匹配时只有第一条生效', ordered.status === 418, `实际 ${ordered.status}`);
    await request(port, `/api/control/fault/rules/${firstRule.id}`, { method: 'DELETE' });
    await request(port, '/api/control/reset', { method: 'POST' });

    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：下载断流',
        match: { pathPrefix: '/assets' },
        action: { type: 'abort', ratio: 0.5 },
      }),
    });
    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    const aborted = await request(port, targetPath);
    const abortedBytes = aborted.body ? aborted.body.length : 0;
    check(
      'abort 故障下未能拿到完整文件',
      Boolean(aborted.error) || abortedBytes < download.body.length,
      `收到 ${abortedBytes} / ${download.body.length} 字节，error=${aborted.error && aborted.error.code}`,
    );

    // empty 故障
    const clearRules = await request(port, '/api/control/reset', { method: 'POST' });
    check('全部重置接口可用', clearRules.status === 200, `实际 ${clearRules.status}`);

    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：空清单',
        match: { pathPrefix: '/api/manifest' },
        action: { type: 'empty' },
      }),
    });
    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const emptyRes = await request(port, '/api/manifest?platform=Android');
    check('empty 故障返回 200 且响应体为空', emptyRes.status === 200 && emptyRes.body.length === 0,
      `状态 ${emptyRes.status}，${emptyRes.body.length} 字节`);

    // maxHits：前两次失败，第三次成功
    await request(port, '/api/control/reset', { method: 'POST' });
    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：前两次失败',
        maxHits: 2,
        match: { pathPrefix: '/api/health' },
        action: { type: 'status', status: 500 },
      }),
    });
    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    const attempt1 = await request(port, '/api/health');
    const attempt2 = await request(port, '/api/health');
    const attempt3 = await request(port, '/api/health');
    check(
      'maxHits 生效：前两次 500、第三次 200',
      attempt1.status === 500 && attempt2.status === 500 && attempt3.status === 200,
      `${attempt1.status}, ${attempt2.status}, ${attempt3.status}`,
    );

    // timeout 故障（用较短的自定义客户端超时验证"服务端不响应"）
    await request(port, '/api/control/reset', { method: 'POST' });
    await request(port, '/api/control/fault/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '测试：接口超时',
        match: { pathPrefix: '/api/health' },
        action: { type: 'timeout' },
      }),
    });
    await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const timedOut = await request(port, '/api/health', { timeout: 1500 });
    check('timeout 故障下客户端只能自己超时', timedOut.timedOut === true, `状态 ${timedOut.status}`);

    // ------------------------------------------------------------ 预置方案
    section('预置方案');

    const presets = await request(port, '/api/presets');
    const presetsJson = JSON.parse(presets.body.toString());
    check('内置方案已就绪', presetsJson.presets.length >= 15, `实际 ${presetsJson.presets.length} 个`);

    const applyRes = await request(port, '/api/presets/abort-download/apply', { method: 'POST' });
    check('应用 abort-download 方案成功', applyRes.status === 200, `实际 ${applyRes.status}`);
    const applyJson = JSON.parse(applyRes.body.toString());
    check('应用后故障注入处于开启状态', applyJson.fault.enabled === true);

    const afterApply = await request(port, targetPath);
    check(
      '应用后下载确实会中断',
      Boolean(afterApply.error) || (afterApply.body && afterApply.body.length < download.body.length),
      `${afterApply.body ? afterApply.body.length : 0} 字节`,
    );

    const idealRes = await request(port, '/api/presets/ideal/apply', { method: 'POST' });
    check('切回理想网络成功', idealRes.status === 200);
    const backToNormal = await request(port, targetPath);
    check('切回后下载恢复正常', backToNormal.status === 200 && md5(backToNormal.body) === expected.hash);

    const builtinDelete = await request(port, '/api/presets/ideal', { method: 'DELETE' });
    check('内置方案不允许删除', builtinDelete.status === 403, `实际 ${builtinDelete.status}`);

    const captureRes = await request(port, '/api/presets/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '冒烟测试存下来的方案' }),
    });
    const captured = JSON.parse(captureRes.body.toString()).preset;
    check('保存当前配置为自定义方案成功', captureRes.status === 201, `实际 ${captureRes.status}`);

    const delPreset = await request(port, `/api/presets/${captured.id}`, { method: 'DELETE' });
    check('自定义方案可以删除', delPreset.status === 200, `实际 ${delPreset.status}`);

    // ------------------------------------------------------------ 收藏与重放
    section('收藏与重放');

    const favRes = await request(port, '/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '查 Android 版本', url: '/api/version?platform=Android&current=0.0.1' }),
    });
    const favorite = JSON.parse(favRes.body.toString()).favorite;
    check('新增收藏返回 201', favRes.status === 201, `实际 ${favRes.status}`);

    const replayRes = await request(port, `/api/favorites/${favorite.id}/replay`, { method: 'POST' });
    const replayJson = JSON.parse(replayRes.body.toString());
    check('重放成功返回 200', replayRes.status === 200, `实际 ${replayRes.status}`);
    check('重放结果里带上了状态码', typeof replayJson.status === 'number', JSON.stringify(replayJson.status));

    await request(port, `/api/favorites/${favorite.id}`, { method: 'DELETE' });

    // ------------------------------------------------------------ 日志与统计
    section('日志与统计');

    const logs = await request(port, '/api/logs?limit=500');
    const logsJson = JSON.parse(logs.body.toString());
    check('日志里有记录', logsJson.entries.length > 0, `${logsJson.entries.length} 条`);

    const simulatedLogs = logsJson.entries.filter((e) => e.sim && (e.sim.fault || e.sim.latencyMs || e.sim.dropped));
    check('日志里记录了模拟器做过的干预', simulatedLogs.length > 0, `${simulatedLogs.length} 条带 sim 信息`);

    const disconnected = logsJson.entries.filter((e) => e.status === null);
    check('被掐断的请求也被记录下来了', disconnected.length > 0, `${disconnected.length} 条`);

    const stats = await request(port, '/api/stats');
    const statsJson = JSON.parse(stats.body.toString());
    check('GET /api/stats 返回 200', stats.status === 200);
    check('统计里有延迟分位数', typeof statsJson.latency.p95Ms === 'number');
    check('统计里统计了被模拟的请求数', statsJson.simulated.faulted > 0, JSON.stringify(statsJson.simulated));
    check('时间线有数据桶', Array.isArray(statsJson.timeline) && statsJson.timeline.length > 0);

    // ------------------------------------------------------------ 配置持久化
    section('配置持久化');

    await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latencyMs: 1234 }),
    });
    const cfgAfter = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    check(
      '通过接口改的参数立即写回了 config.json',
      cfgAfter.network.latencyMs === 1234,
      `文件里是 ${cfgAfter.network.latencyMs}`,
    );

    const badValue = await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latencyMs: -9999, packetLossRate: 88 }),
    });
    const badJson = JSON.parse(badValue.body.toString());
    check('越界参数被夹到合法范围', badJson.network.latencyMs === 0 && badJson.network.packetLossRate === 1,
      JSON.stringify(badJson.network));
  } finally {
    // 还原配置，别把测试状态留给用户
    fs.writeFileSync(CONFIG_PATH, originalConfig, 'utf8');
    server.close();
    await sleep(100);
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(56));

  finish(failed ? 1 : 0);
}

main().catch((err) => {
  // 正常路径的 finish() 也是靠抛信号中断的，不能把它当成"测试自身出错"
  if (isExitSignal(err)) throw err;
  console.error('\n冒烟测试自身出错了：');
  console.error(err);
  try {
    fs.writeFileSync(CONFIG_PATH, fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    /* 还原失败就算了，不要掩盖原始错误 */
  }
  finish(1);
});
