#!/usr/bin/env node
// scripts/regression-test.js
//
// 边界情况回归测试。
//
// 为什么单独开一个文件，而不是塞进 smoke-test.js：
// smoke-test 的 74 项断言全部走的是 assetServer 那条「总是带 Content-Length 的
// fs.createReadStream」路径。于是下面这些分支一条都没被触达过：
//   * 无 Content-Length 的 chunked 响应
//   * 单块 res.end(buffer) 的响应（Express 的 res.send/res.json）
//   * 0 字节文件
//   * 多段 Range、溢出数字的 Range
//   * If-None-Match 与 If-Modified-Since 同时出现的优先级
//   * 版本号语义比较（预发布版本、前导零、1.0 vs 1.0.0）
//   * 多条规则各自带 probability 时的复合概率
//   * 配置里出现非法类型（sanitize 是最后一道防线，必须扛住任意形状输入）
//
// 这些正是独立评审找出来的问题所在。每一条都对应一个真实缺陷，
// 修完之后它们就是防止复发的护栏。
//
// 用法：npm run regression

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const CONFIG_PATH = path.resolve(__dirname, '..', 'backend', 'config.json');
const ASSETS_ROOT = path.resolve(__dirname, '..', 'storage', 'assets');

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
        const done = (err) => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          error: err,
        });
        res.on('end', () => done(null));
        res.on('aborted', () => done('ABORTED'));
        res.on('error', (e) => done(e.code || e.message));
      },
    );
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy();
      resolve({ status: null, headers: {}, body: Buffer.alloc(0), error: 'TIMEOUT' });
    });
    req.on('error', (e) => resolve({ status: null, headers: {}, body: Buffer.alloc(0), error: e.code || e.message }));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postJson(port, urlPath, payload, method = 'POST') {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return request(port, urlPath, {
    method,
    body: body || undefined,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
  });
}

/** 清掉全部故障规则并关闭注入。 */
async function clearFaults(port) {
  await postJson(port, '/api/control/reset');
}

// ============================================================ 纯函数测试

async function testPureFunctions() {
  section('版本号比较（api.js 的 compareVersions）');
  const { compareVersions } = require('../backend/routes/api');

  // 基本语义
  check('1.10 > 1.9（按数值比较，不是字典序）', compareVersions('1.10', '1.9') === 1,
    `得到 ${compareVersions('1.10', '1.9')}`);
  check('1.0 < 1.0.1', compareVersions('1.0', '1.0.1') === -1);
  check('相同版本返回 0', compareVersions('1.2.3', '1.2.3') === 0);

  // 预发布版本：semver 规定 1.0.0-beta < 1.0.0
  check('1.0.0-beta < 1.0.0（预发布版本更小）', compareVersions('1.0.0-beta', '1.0.0') === -1,
    `得到 ${compareVersions('1.0.0-beta', '1.0.0')}`);
  check('2.0.0-rc1 < 2.0.0', compareVersions('2.0.0-rc1', '2.0.0') === -1,
    `得到 ${compareVersions('2.0.0-rc1', '2.0.0')}`);
  check('1.0.0 < 2.0.0-beta（主版本优先）', compareVersions('1.0.0', '2.0.0-beta') === -1,
    `得到 ${compareVersions('1.0.0', '2.0.0-beta')}`);

  // 构建元数据不参与比较
  check('1.0.0+build == 1.0.0（构建元数据不参与比较）',
    compareVersions('1.0.0+build', '1.0.0') === 0,
    `得到 ${compareVersions('1.0.0+build', '1.0.0')}`);

  // 大数不能溢出
  check('超长数字段不会因双精度溢出而误判相等',
    compareVersions('99999999999999999999', '99999999999999999998') === 1,
    `得到 ${compareVersions('99999999999999999999', '99999999999999999998')}`);

  check('空值与 null 不抛异常', (() => {
    try {
      compareVersions(null, '1.0');
      compareVersions('', '1.0');
      compareVersions(undefined, undefined);
      return true;
    } catch {
      return false;
    }
  })());

  section('故障规则的概率语义（faultInjector.pick）');
  const ConfigManager = require('../backend/core/configManager');
  const FaultInjector = require('../backend/modules/faultInjector');

  // 用临时配置文件，避免污染真实配置
  const tmpConfig = path.join(require('os').tmpdir(), `hus-regression-config-${process.pid}.json`);
  const cm = new ConfigManager(tmpConfig);

  function hitRate(rules, iterations = 20000) {
    cm.patch({ fault: { enabled: true, rules } });
    const fi = new FaultInjector(cm);
    fi.resetHitCounts();
    let hits = 0;
    const req = { method: 'GET', url: '/api/version', originalUrl: '/api/version' };
    for (let i = 0; i < iterations; i += 1) {
      if (fi.plan(req).rule) hits += 1;
    }
    return hits / iterations;
  }

  const one = hitRate([{ id: 'a', name: 'a', enabled: true, probability: 0.5, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 500 } }]);
  check('单条规则 p=0.5 的命中率约 0.5', Math.abs(one - 0.5) < 0.03, `实测 ${one.toFixed(4)}`);

  const two = hitRate([
    { id: 'b1', name: 'b1', enabled: true, probability: 0.5, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 500 } },
    { id: 'b2', name: 'b2', enabled: true, probability: 0.5, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 501 } },
  ]);
  check('两条规则各 p=0.5 时总命中率仍是 0.5（不能复合放大）',
    Math.abs(two - 0.5) < 0.03,
    `实测 ${two.toFixed(4)}，若为 1-(1-0.5)^2≈0.75 说明概率被复合成乘积`);

  const three = hitRate([
    { id: 'c1', name: 'c1', enabled: true, probability: 0.1, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 500 } },
    { id: 'c2', name: 'c2', enabled: true, probability: 0.1, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 501 } },
    { id: 'c3', name: 'c3', enabled: true, probability: 0.1, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 502 } },
  ]);
  check('三条各 p=0.1 时总命中率约 0.1（不是 0.27）',
    Math.abs(three - 0.1) < 0.02, `实测 ${three.toFixed(4)}`);

  // maxHits 用完之后的语义：应当「不再注入」，而不是「换下一条继续注入」
  {
    cm.patch({
      fault: {
        enabled: true,
        rules: [
          { id: 'lim', name: 'lim', enabled: true, probability: 1, maxHits: 2, match: { pathPrefix: '/api' }, action: { type: 'status', status: 500 } },
          { id: 'unlim', name: 'unlim', enabled: true, probability: 1, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 501 } },
        ],
      },
    });
    const fi = new FaultInjector(cm);
    const req = { method: 'GET', url: '/api/x', originalUrl: '/api/x' };
    const seq = [0, 1, 2, 3].map(() => { const r = fi.plan(req).rule; return r ? r.id : '-'; });
    check('maxHits 用完后该规则失效，请求落到下一条规则（顺序可预测）',
      seq[0] === 'lim' && seq[1] === 'lim' && seq[2] === 'unlim',
      `实际序列 ${seq.join(', ')}`);
  }

  // 重复 id 不能共用计数器
  {
    cm.patch({
      fault: {
        enabled: true,
        rules: [
          { id: 'dup', name: 'dup1', enabled: true, probability: 1, maxHits: 1, match: { pathPrefix: '/api' }, action: { type: 'status', status: 500 } },
          { id: 'dup', name: 'dup2', enabled: true, probability: 1, maxHits: 0, match: { pathPrefix: '/api' }, action: { type: 'status', status: 501 } },
        ],
      },
    });
    const fi = new FaultInjector(cm);
    const req = { method: 'GET', url: '/api/x', originalUrl: '/api/x' };
    fi.plan(req); // 用掉第一条的配额
    const second = fi.plan(req).rule;
    check('两条规则 id 相同时不会共用命中计数器',
      second !== null,
      '第二条规则被第一条的计数器拖累而失效');
  }

  section('配置校验的健壮性（ConfigManager.sanitize）');
  {
    const c2 = new ConfigManager(tmpConfig);
    let crashed = null;
    try {
      // 非法类型必须被收敛，而不是抛异常：sanitize 是最后一道防线
      c2.patch({ fault: 'a string' });
      c2.patch({ network: 42 });
      c2.patch({ server: null });
      c2.patch({ hotUpdate: { channels: 'not-an-array' } });
      c2.patch({ logging: [] });
    } catch (err) {
      crashed = err.message;
    }
    check('给配置节传非对象不会抛异常', crashed === null, crashed || '');

    const after = c2.get();
    check('非对象输入被回落成默认值', after.fault && typeof after.fault.enabled === 'boolean',
      JSON.stringify(after.fault));

    // 规则内部字段的校验
    c2.patch({
      fault: {
        rules: [
          { id: 'r1', name: 'r1', probability: 99, maxHits: -1, action: { type: 'not-a-type', status: 99999, ratio: 'NaN', delayMs: -5000 } },
          { id: 'r2', name: 'r2', action: { type: 'abort', ratio: 42 } },
        ],
      },
    });
    const rules = c2.get('fault.rules') || [];
    const illegalType = rules.some((r) => r.action && !['status', 'timeout', 'slowHeader', 'abort', 'truncate', 'corrupt', 'empty'].includes(r.action.type));
    check('非法的故障类型不会原样留在配置里', !illegalType,
      JSON.stringify(rules.map((r) => r.action && r.action.type)));

    const badStatus = rules.some((r) => r.action && r.action.status > 599);
    check('越界的状态码被夹到合法范围', !badStatus,
      JSON.stringify(rules.map((r) => r.action && r.action.status)));

    const badProb = rules.some((r) => Number(r.probability) > 1);
    check('越界的触发概率被夹到 0~1', !badProb,
      JSON.stringify(rules.map((r) => r.probability)));
  }

  try { fs.unlinkSync(tmpConfig); } catch { /* 可能不存在 */ }
}

// ==================================== 响应改写：合成管线（chunked / 单块）

/**
 * 单独搭一个只挂 requestPipeline 的小应用，用来精确构造两种响应形态：
 *   /chunked  —— 分多次 res.write，不设 Content-Length
 *   /single   —— 一次性 res.end(大 buffer)，带 Content-Length
 * 真实接口里拿不到 chunked 响应（Express 的 res.send 总会设 Content-Length），
 * 而 chunked 正是原来完全没被测到的分支。
 */
async function testResponseRewriting() {
  section('响应改写：chunked 与单块路径');

  const app = require('../backend/app');
  const requestPipeline = require('../backend/middleware/requestPipeline');
  const configManager = app.locals.configManager;
  const networkSimulator = app.locals.networkSimulator;
  const faultInjector = app.locals.faultInjector;

  const CHUNK = 64 * 1024;
  const CHUNKS = 16; // 共 1 MB

  const synthetic = express();
  synthetic.use(requestPipeline({ networkSimulator, faultInjector }));
  synthetic.get('/chunked', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    // 故意不设 Content-Length，让 Node 走 chunked 编码
    for (let i = 0; i < CHUNKS; i += 1) {
      res.write(Buffer.alloc(CHUNK, i % 251));
    }
    res.end();
  });
  synthetic.get('/single', (req, res) => {
    res.send(Buffer.alloc(CHUNK * CHUNKS, 7));
  });

  const port = 5621;
  const server = synthetic.listen(port);
  await new Promise((r) => { server.once('listening', r); });

  /**
   * 直接操作 configManager 来配置故障与限速。
   *
   * 不能在合成应用上打 /api/control/*：那个应用只挂了 requestPipeline
   * 和两个测试路由，没有控制类接口，请求会落到 404 —— 于是规则根本没配上，
   * 测出来"什么都没生效"，看着像代码有问题，其实是测试自己的错。
   * 两个应用共享同一个 configManager 实例，所以直接改配置即可。
   */
  const configure = (patch) => { configManager.patch(patch); };
  const clearFaults = () => configure({ fault: { enabled: false, rules: [] } });
  const setNetwork = (patch) => configure({ network: patch });
  const addRule = (rule) => {
    const rules = configManager.get('fault.rules') || [];
    configManager.patch({ fault: { enabled: true, rules: [...rules, rule] } });
  };
  void postJson;

  try {
    // 基线
    clearFaults();
    setNetwork({ enabled: false, offline: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 });
    const baseChunked = await request(port, '/chunked');
    const FULL = CHUNK * CHUNKS;
    check('chunked 基线：完整收到 1MB 且无 Content-Length',
      baseChunked.body.length === FULL && !baseChunked.headers['content-length'],
      `${baseChunked.body.length} 字节, cl=${baseChunked.headers['content-length']}`);

    const baseSingle = await request(port, '/single');
    check('单块基线：完整收到 1MB 且有 Content-Length',
      baseSingle.body.length === FULL && Number(baseSingle.headers['content-length']) === FULL,
      `${baseSingle.body.length} 字节, cl=${baseSingle.headers['content-length']}`);

    // ---------------- chunked + truncate ----------------
    clearFaults();
    addRule({ id: 'r1', name: 'chunked-truncate', match: { pathPrefix: '/chunked' }, action: { type: 'truncate', ratio: 0.5 } });
    const chTrunc = await request(port, '/chunked');
    check('chunked + truncate：确实被截断到约 50%',
      chTrunc.body.length > 0 && chTrunc.body.length < FULL * 0.6,
      `收到 ${chTrunc.body.length} / ${FULL} 字节（若等于 ${FULL} 说明 ratio 被忽略，truncate 完全是空操作）`);

    // ---------------- chunked + abort ----------------
    clearFaults();
    addRule({ id: 'r2', name: 'chunked-abort', match: { pathPrefix: '/chunked' }, action: { type: 'abort', ratio: 0.5 } });
    const chAbort = await request(port, '/chunked');
    check('chunked + abort：断在约 50%，不是"发完再断"',
      chAbort.body.length > 0 && chAbort.body.length < FULL * 0.7,
      `收到 ${chAbort.body.length} / ${FULL} 字节`);

    // ---------------- 单块 + abort ----------------
    clearFaults();
    addRule({ id: 'r3', name: 'single-abort', match: { pathPrefix: '/single' }, action: { type: 'abort', ratio: 0.5 } });
    const sgAbort = await request(port, '/single');
    check('单块 + abort：客户端确实收到了约 50% 的数据（不能是 0 字节）',
      sgAbort.body.length >= FULL * 0.3 && sgAbort.body.length < FULL * 0.7,
      `收到 ${sgAbort.body.length} / ${FULL} 字节（0 表示 write 后立刻 destroy，数据被丢弃）`);

    // ---------------- 单块 + truncate 精度 ----------------
    clearFaults();
    addRule({ id: 'r4', name: 'single-truncate', match: { pathPrefix: '/single' }, action: { type: 'truncate', ratio: 0.4 } });
    const sgTrunc = await request(port, '/single');
    const target = Math.floor(FULL * 0.4);
    check('单块 + truncate：截断长度精确等于 floor(size × ratio)',
      sgTrunc.body.length === target,
      `收到 ${sgTrunc.body.length}，期望 ${target}`);

    // ---------------- 流式 + truncate 精度（不能超发一个 chunk） ----------------
    clearFaults();
    addRule({ id: 'r5', name: 'chunked-truncate-exact', match: { pathPrefix: '/chunked' }, action: { type: 'truncate', ratio: 0.4 } });
    const chTruncExact = await request(port, '/chunked');
    check('流式 + truncate：不会整块越过切点（不超发）',
      chTruncExact.body.length === Math.floor(FULL * 0.4),
      `收到 ${chTruncExact.body.length}，期望 ${Math.floor(FULL * 0.4)}（多出来说明按 chunk 粒度越过了切点）`);

    // ---------------- 限速：单块响应也要分片流出 ----------------
    section('限速的行为');
    clearFaults();
    setNetwork({ enabled: true, latencyMs: 0, jitterMs: 0, bandwidthKbps: 8000, packetLossRate: 0 });

    // 记录首字节到达时间：限速如果是"整体延迟后一次性灌出"，
    // 首字节会在接近总时长的地方才到达，客户端看不到任何进度。
    const firstByteAt = await new Promise((resolve) => {
      const started = Date.now();
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/single' }, (res) => {
        res.once('data', () => resolve(Date.now() - started));
        res.on('end', () => resolve(Date.now() - started));
      });
      req.end();
    });

    const totalStarted = Date.now();
    const slow = await request(port, '/single');
    const totalMs = Date.now() - totalStarted;
    void slow;

    check('限速确实拉长了总时长（1MB @ 8000Kbps ≈ 1s）', totalMs > 800, `实际 ${totalMs}ms`);
    check('限速时首字节早早到达，而不是最后一次性灌出',
      firstByteAt < totalMs * 0.5,
      `首字节在 ${firstByteAt}ms 到达，总时长 ${totalMs}ms（若两者接近说明没有真正分片流出）`);

    // ---------------- 限速 + abort 叠加 ----------------
    clearFaults();
    setNetwork({ enabled: true, latencyMs: 0, jitterMs: 0, bandwidthKbps: 8000, packetLossRate: 0 });
    addRule({ id: 'r6', name: 'combo', match: { pathPrefix: '/single' }, action: { type: 'abort', ratio: 0.5 } });
    const comboStart = Date.now();
    const combo = await request(port, '/single');
    const comboMs = Date.now() - comboStart;
    check('限速 + abort 可叠加：断在约 50% 且耗时明显长于不限速',
      combo.body.length >= FULL * 0.3 && combo.body.length < FULL * 0.7 && comboMs > 300,
      `${combo.body.length} 字节，${comboMs}ms（顺序错的话会在第一个分片就断）`);

    clearFaults();
    setNetwork({ enabled: false, offline: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 });
    void configManager;
  } finally {
    clearFaults();
    setNetwork({ enabled: false, offline: false, latencyMs: 0, jitterMs: 0, bandwidthKbps: 0, packetLossRate: 0 });
    server.close();
  }
}

// ==================================== 资产服务的边界情况（真实接口）

async function testAssetEdgeCases() {
  section('资产服务的边界情况');

  const port = 5622;
  process.env.PORT = String(port);
  const app = require('../backend/app');
  const server = app.listen(port);
  await new Promise((r) => { server.once('listening', r); });

  const probeDir = path.join(ASSETS_ROOT, 'RegressionProbe');
  const emptyFile = path.join(probeDir, 'empty.bin');
  const normalFile = path.join(probeDir, 'normal.bin');

  try {
    await clearFaults(port);

    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    fs.writeFileSync(normalFile, Buffer.alloc(100000, 3));

    // ---------------- 0 字节文件 ----------------
    const empty = await request(port, '/assets/RegressionProbe/empty.bin');
    check('0 字节文件返回 200 而不是 500',
      empty.status === 200,
      `实际 ${empty.status}，body=${empty.body.toString().slice(0, 160)}`);
    check('0 字节文件的 Content-Length 是 0',
      empty.headers['content-length'] === '0',
      `实际 ${empty.headers['content-length']}`);

    // ---------------- Range 边界 ----------------
    const normal = await request(port, '/assets/RegressionProbe/normal.bin');
    const SIZE = normal.body.length;
    check('常规文件下载正常（100000 字节）', SIZE === 100000, `实际 ${SIZE}`);

    const multi = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: 'bytes=0-10,20-30' } });
    check('多段 Range 返回 416（而不是静默返回整份文件）',
      multi.status === 416,
      `实际 ${multi.status}，${multi.body.length} 字节（200 会让客户端把全量下载当成续传成功）`);

    const overflow = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: 'bytes=0-99999999999999999999' } });
    check('超出安全整数范围的 Range 返回 416',
      overflow.status === 416,
      `实际 ${overflow.status}`);

    const backwards = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: 'bytes=5-2' } });
    check('起止倒置的 Range 返回 416', backwards.status === 416, `实际 ${backwards.status}`);

    const suffix = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: 'bytes=-500' } });
    check('suffix Range 返回最后 500 字节',
      suffix.status === 206 && suffix.body.length === 500,
      `状态 ${suffix.status}，${suffix.body.length} 字节`);

    const malformed = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: 'bytes=abc' } });
    check('语法非法的 Range 被忽略并返回 200 全量',
      malformed.status === 200 && malformed.body.length === SIZE,
      `状态 ${malformed.status}，${malformed.body.length} 字节`);

    // ---------------- 缓存协商优先级 ----------------
    const etag = normal.headers.etag;
    const lastModified = normal.headers['last-modified'];

    const inmFresh = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { 'If-None-Match': etag } });
    check('If-None-Match 命中返回 304', inmFresh.status === 304, `实际 ${inmFresh.status}`);

    const inmStale = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { 'If-None-Match': 'W/"deadbeef-1"' } });
    check('If-None-Match 不匹配返回 200', inmStale.status === 200, `实际 ${inmStale.status}`);

    // RFC 9110 §13.1.3：只要带了 If-None-Match，就必须忽略 If-Modified-Since
    const both = await request(port, '/assets/RegressionProbe/normal.bin', {
      headers: { 'If-None-Match': 'W/"deadbeef-1"', 'If-Modified-Since': lastModified },
    });
    check('带过期的 If-None-Match 时忽略 If-Modified-Since，返回 200（RFC 9110）',
      both.status === 200,
      `实际 ${both.status}（返回 304 会让客户端一直用旧资源）`);

    const rangeWithBoth = await request(port, '/assets/RegressionProbe/normal.bin', {
      headers: { Range: 'bytes=1000-', 'If-None-Match': 'W/"deadbeef-1"', 'If-Modified-Since': lastModified },
    });
    check('续传请求不会被 If-Modified-Since 误判成 304',
      rangeWithBoth.status === 206,
      `实际 ${rangeWithBoth.status}（304 会让断点续传直接卡死）`);

    // ---------------- 416 不应带资源的验证器 ----------------
    const notSatisfiable = await request(port, '/assets/RegressionProbe/normal.bin', { headers: { Range: `bytes=${SIZE + 100}-` } });
    check('不可满足的 Range 返回 416', notSatisfiable.status === 416, `实际 ${notSatisfiable.status}`);
    check('416 响应不携带该资源的 ETag（避免被误认为资源内容）',
      !notSatisfiable.headers.etag,
      `携带了 ETag=${notSatisfiable.headers.etag}`);

    // ---------------- 版本语义 ----------------
    section('版本判断语义（真实接口）');
    const manifest = await request(port, '/api/manifest?platform=Android');
    const manifestJson = JSON.parse(manifest.body.toString());

    const eqVersion = await request(port, `/api/version?platform=Android&current=${manifestJson.version}`);
    const eqJson = JSON.parse(eqVersion.body.toString());
    check('当前版本与清单相同 → needUpdate=false', eqJson.needUpdate === false);

    // 1.0 与 1.0.0 语义相同
    const shortVersion = await request(port, '/api/version?platform=Android&current=1.0');
    const shortJson = JSON.parse(shortVersion.body.toString());
    check('current=1.0 与清单 1.0.0 视为同版本（用语义比较而非字符串相等）',
      shortJson.needUpdate === false,
      `needUpdate=${shortJson.needUpdate}，说明用了字符串严格相等`);

    // 预发布版本低于正式版，应触发强制更新
    if (manifestJson.minVersion) {
      const pre = await request(port, `/api/version?platform=Android&current=${manifestJson.minVersion}-beta`);
      const preJson = JSON.parse(pre.body.toString());
      check('低于 minVersion 的预发布版本应被判定为需要强制更新',
        preJson.forceUpdate === true,
        `minVersion=${manifestJson.minVersion}, current=${manifestJson.minVersion}-beta, forceUpdate=${preJson.forceUpdate}`);
    }

    // /api/check 与 /api/version 对同一输入必须给出一致结论
    const checkRes = await request(port, `/api/version?platform=Android&current=0.0.1`);
    const checkRes2 = await request(port, `/api/check?platform=Android&current=0.0.1`);
    const vJson = JSON.parse(checkRes.body.toString());
    const cJson = JSON.parse(checkRes2.body.toString());
    check('/api/version 与 /api/check 的 forceUpdate 结论一致',
      vJson.forceUpdate === cJson.forceUpdate,
      `version=${vJson.forceUpdate}, check=${cJson.forceUpdate}（check 漏掉了 minVersion 判断）`);

    // ---------------- 统计口径 ----------------
    section('统计口径一致性');
    await request(port, '/api/health');
    await request(port, '/api/manifest?platform=Android');
    const stats = JSON.parse((await request(port, '/api/stats?windowMinutes=5')).body.toString());
    const timelineSum = stats.timeline.reduce((n, slot) => n + slot.count, 0);
    check('requests.total 与 timeline 各格之和口径一致',
      Math.abs(stats.requests.total - timelineSum) <= Math.max(3, stats.requests.total * 0.2),
      `total=${stats.requests.total}, timeline 求和=${timelineSum}（total 被 logger.counts() 覆盖成全局值）`);

    // ---------------- 故障规则校验 ----------------
    section('故障规则输入的校验');
    const badType = await postJson(port, '/api/control/fault/rules', {
      name: 'bad-type', match: { prefix: '/x' }, action: { type: 'no-such-type' },
    });
    check('非法故障类型被拒绝（400）或已被规范化，而不是静默降级成 500',
      badType.status === 400 || (badType.status === 201 && JSON.parse(badType.body.toString()).rule.action.type === 'status'),
      `实际状态 ${badType.status}`);
    await clearFaults(port);
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    await clearFaults(port).catch(() => {});
    server.close();
  }
}

// ============================================================ 主流程

async function main() {
  if (!fs.existsSync(ASSETS_ROOT)) {
    console.error('找不到测试资产。请先执行：npm run sample\n');
    process.exit(1);
  }

  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');

  try {
    await testPureFunctions();
    await testResponseRewriting();
    await testAssetEdgeCases();
  } finally {
    fs.writeFileSync(CONFIG_PATH, originalConfig, 'utf8');
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`回归测试：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(56));

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n回归测试自身出错了：');
  console.error(err);
  try { fs.writeFileSync(CONFIG_PATH, fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 忽略 */ }
  process.exit(1);
});
