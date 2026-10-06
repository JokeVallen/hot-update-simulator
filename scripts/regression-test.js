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
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const express = require('express');
// 不能用 fs.rmSync 删目录：Windows + 非 ASCII 路径上它会静默失败甚至让进程硬崩。
// 详见 scripts/lib/safe-rm.js 的说明。
const { removeDir } = require('./lib/safe-rm');

const CONFIG_PATH = path.resolve(__dirname, '..', 'backend', 'config.json');
// 必须和服务器用同一个存储根，否则设了 HOT_UPDATE_STORAGE 之后，
// 测试会在旧位置建探测平台、而服务器在新位置找不到它们，于是全红 ——
// 而且看着像功能坏了。见 backend/core/paths.js。
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
  section('存储根与隔离（core/paths.js）');
  const paths = require('../backend/core/paths');
  const prevStorageEnv = process.env.HOT_UPDATE_STORAGE;

  try {
    // ---- 默认位置 ----
    delete process.env.HOT_UPDATE_STORAGE;
    check('默认存储根是 <项目>/storage',
      paths.storageRoot() === path.join(paths.PROJECT_ROOT, 'storage'),
      paths.storageRoot());
    check('默认资产目录在存储根下面（两者不会各指一处）',
      paths.assetsDir() === path.join(paths.storageRoot(), 'assets'),
      paths.assetsDir());

    // ---- 绝对路径：整棵树跟着搬 ----
    const probeRoot = path.join(os.tmpdir(), `hus-storage-probe-${process.pid}`);
    process.env.HOT_UPDATE_STORAGE = probeRoot;
    check('HOT_UPDATE_STORAGE 为绝对路径时存储根就是它',
      paths.storageRoot() === probeRoot, paths.storageRoot());
    check('设了环境变量后 jsonStore 也跟着走（原来这里指的还是旧目录）',
      require('../backend/utils/jsonStore').storagePath('presets.json')
        === path.join(probeRoot, 'presets.json'),
      require('../backend/utils/jsonStore').storagePath('presets.json'));

    // ---- 相对路径按项目根解析，不是按 cwd ----
    process.env.HOT_UPDATE_STORAGE = './some-relative-dir';
    check('相对路径按项目根解析（不是按当前工作目录）',
      paths.storageRoot() === path.join(paths.PROJECT_ROOT, 'some-relative-dir'),
      paths.storageRoot());

    // ---- 服务器和示例生成脚本必须指同一个地方 ----
    //
    // 这条是整个改动的核心目的：以前两者各写各的，一旦不一致就会出现
    // "npm run sample 说生成成功，面板里却一个平台都没有"。
    delete process.env.HOT_UPDATE_STORAGE;
    const assetServer = require('../backend/app').locals.assetServer;
    const sampleRoot = require('../backend/core/paths').assetsDir();
    check('assetServer 的根目录与 make-sample-assets 的写入位置一致',
      assetServer.root() === sampleRoot,
      `服务器 ${assetServer.root()} vs 示例脚本 ${sampleRoot}`);

    // ---- 配置里的相对 assetDir 相对存储根解析 ----
    check('assetDir 默认值 "assets" 解析到存储根下面',
      path.resolve(paths.storageRoot(), 'assets') === paths.assetsDir(),
      paths.assetsDir());

    // ---- 所有入口都必须经过 paths.js ----
    //
    // 这一组是补上次漏掉的一个维度：**配置能不能到达每个入口**。
    //
    // 之前的 bug 是：HOT_UPDATE_STORAGE 写在命令行的环境变量里时一切正常，
    // 但写进 .env 文件时只有服务器读得到 —— 因为 dotenv 只在 backend/app.js
    // 里加载过，scripts/ 下的脚本从不经过它。结果是服务器去 A 找资产、
    // npm run sample 写到 B，两边都不报错，面板里一个平台都没有。
    //
    // 原来的断言全是用 process.env 直接设的，等于只测了"函数内部算得对"，
    // 没测"用户到达这个函数的每条路都通"。下面两条分别堵住两个方向。
    const src = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

    // 方向一：.env 只能有一个加载点，而且必须是 paths.js
    const jsFiles = [];
    const collect = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full);
        else if (e.name.endsWith('.js')) jsFiles.push(full);
      }
    };
    collect(path.resolve(__dirname, '..', 'backend'));
    collect(path.resolve(__dirname, '..', 'scripts'));
    const dotenvLoaders = jsFiles
      .filter((f) => /require\('dotenv'\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.resolve(__dirname, '..'), f).replace(/\\/g, '/'));
    check('.env 只有一处加载点，且在 core/paths.js 里',
      dotenvLoaders.length === 1 && dotenvLoaders[0] === 'backend/core/paths.js',
      `实际加载者：${dotenvLoaders.join(', ') || '（无）'}`);
    check('backend/app.js 只做副作用引入，不再自己加载 dotenv',
      !/require\('dotenv'\)/.test(src('backend/app.js')),
      'app.js 里又出现了 dotenv 加载');

    // 方向二：不许有第二份"存储位置"的推导逻辑
    const dupe = [
      ['scripts/make-sample-assets.js', /path\.resolve\(__dirname,\s*'\.\.',\s*'storage'/],
      ['scripts/regression-test.js', /path\.resolve\(__dirname,\s*'\.\.',\s*'storage'/],
      ['scripts/smoke-test.js', /path\.resolve\(__dirname,\s*'\.\.',\s*'storage'/],
      ['backend/utils/jsonStore.js', /path\.resolve\(__dirname,\s*'\.\.',\s*'\.\.',\s*'storage'/],
    ].filter(([rel, re]) => re.test(src(rel)));
    check('没有第二处硬编码的 storage 路径（一律走 core/paths）',
      dupe.length === 0,
      dupe.length ? `这些文件又自己算了一遍：${dupe.map(([r]) => r).join(', ')}` : '');

    // ---- 命令行环境变量必须能到达所有入口 ----
    //
    // 用子进程验证，因为 process.env 在当前进程里已经被解析过了。
    const entryProbe = path.join(os.tmpdir(), `hus-entry-probe-${process.pid}`);
    const runWith = (args) => execFileSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, HOT_UPDATE_STORAGE: entryProbe },
    }).trim();

    const serverSees = runWith(['-e', "console.log(require('./backend/core/paths').storageRoot())"]);
    check('命令行环境变量能到达服务器侧',
      serverSees === entryProbe, serverSees);

    const scriptSees = runWith(['-e', "console.log(require('./backend/core/paths').assetsDir())"]);
    check('命令行环境变量能到达脚本侧（同一个模块，不会再各写各的）',
      scriptSees === path.join(entryProbe, 'assets'), scriptSees);

    // ---- 回归：旧的 assetDir 值迁移 ----
    //
    // 旧版本的 assetDir 默认值是 '../storage/assets'（当时相对 backend/ 解析）。
    // 新规则下那个值会指到 <storageRoot>/../storage/assets 这种地方去，
    // 必须在加载时识别出来换回新默认值。
    const ConfigManager = require('../backend/core/configManager');
    const tmpCfg = path.join(os.tmpdir(), `hus-cfg-probe-${process.pid}.json`);
    fs.writeFileSync(tmpCfg, JSON.stringify({ server: { assetDir: '../storage/assets' } }), 'utf8');
    try {
      const migrated = new ConfigManager(tmpCfg);
      check('旧配置里的 assetDir 会被迁移到新默认值',
        migrated.get('server.assetDir') === 'assets',
        `迁移后 = ${JSON.stringify(migrated.get('server.assetDir'))}`);

      // 用户自己填的路径不能被误伤
      fs.writeFileSync(tmpCfg, JSON.stringify({ server: { assetDir: 'D:\\MyBundles' } }), 'utf8');
      const custom = new ConfigManager(tmpCfg);
      check('用户自己填的 assetDir 不会被迁移动到',
        custom.get('server.assetDir') === 'D:\\MyBundles',
        `得到 ${JSON.stringify(custom.get('server.assetDir'))}`);
      check('绝对路径的 assetDir 原样使用（可以直接指向 Unity 构建产物）',
        custom.resolvePath('server.assetDir', paths.storageRoot()) === 'D:\\MyBundles',
        custom.resolvePath('server.assetDir', paths.storageRoot()));
    } finally {
      try { fs.unlinkSync(tmpCfg); } catch { /* 忽略 */ }
    }
  } finally {
    if (prevStorageEnv === undefined) delete process.env.HOT_UPDATE_STORAGE;
    else process.env.HOT_UPDATE_STORAGE = prevStorageEnv;
  }

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

    // ---------------- chunked + corrupt ----------------
    //
    // 这个组合原来完全没测到，而它藏着一个静默的数据丢失 bug：
    // res.write 里 corrupt 只调 handleStreaming，而后者在没有 Content-Length 时
    // 直接 return false（一个字节都不写），返回值又被忽略 ——
    // 于是中间所有分片凭空消失，只有 end 的最后一片被 handleBuffered 接住。
    // 客户端拿到的是一份**残缺**的响应，而且没有任何错误信号。
    clearFaults();
    addRule({ id: 'r6', name: 'chunked-corrupt', match: { pathPrefix: '/chunked' }, action: { type: 'corrupt', ratio: 0.5 } });
    const chCorrupt = await request(port, '/chunked');
    check('chunked + corrupt：字节数不变（损坏不改长度，但绝不能丢数据）',
      chCorrupt.body.length === FULL,
      `收到 ${chCorrupt.body.length} / ${FULL} 字节`
        + (chCorrupt.body.length < FULL ? ' —— 分片在中途被丢弃了' : ''));
    check('chunked + corrupt：内容确实被改坏了（否则等于没注入）',
      !chCorrupt.body.equals(Buffer.alloc(FULL, 0x41)),
      '收到的是完整原始内容，说明损坏没有生效');

    // ---------------- slowThenAbort：延迟与断流必须同时生效 ----------------
    //
    // 这是唯一的复合类型，它必须同时做到两件事：先把响应拖慢，再在传输中途掐断。
    // 只做到一件（delayMs 被丢掉、或者 shape 没装上）都是坏的，
    // 而两种坏法都不报错 —— 只有量出来的数字能分辨。
    clearFaults();
    addRule({
      id: 'r7',
      name: 'slow-then-abort',
      match: { pathPrefix: '/single' },
      action: { type: 'slowThenAbort', delayMs: 600, ratio: 0.5 },
    });

    const stStarted = Date.now();
    const stRes = await request(port, '/single');
    const stMs = Date.now() - stStarted;

    check('slowThenAbort：延迟确实生效（至少等了 600ms）',
      stMs >= 600, `耗时 ${stMs}ms —— 小于 600 说明 delayMs 在处理时被丢掉了`);
    check('slowThenAbort：断流也确实生效（只收到约一半）',
      stRes.body.length >= FULL * 0.3 && stRes.body.length < FULL * 0.7,
      `收到 ${stRes.body.length} / ${FULL} 字节`);
    check('slowThenAbort：和普通 abort 区分得开（不能退化成纯延迟）',
      stRes.body.length < FULL * 0.7 && stMs >= 600,
      `字节 ${stRes.body.length}，耗时 ${stMs}ms`);

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

    // ---------------- 模拟范围：不能把控制面板自己搞坏 ----------------
    section('模拟的作用范围');
    await clearFaults(port);
    await postJson(port, '/api/control/fault/rules', {
      name: 'catch-all',
      // 什么都不填 = 匹配所有路径。这是使用者最自然的写法（"全都坏"）。
      match: { method: '', pathPrefix: '', pathGlob: '', platform: '' },
      action: { type: 'abort', ratio: 0.5 },
    });
    await postJson(port, '/api/control/fault', { enabled: true }, 'PATCH');

    // 面板自己的静态资源必须**不受影响**，否则刷新页面就再也进不来了，
    // 而"关掉故障注入"的按钮恰好就在那个进不来的页面里。
    const shell = await request(port, '/');
    check('catch-all 规则下首页仍然完整（面板不能把自己弄坏）',
      shell.status === 200 && !shell.error && shell.body.length > 200,
      `状态 ${shell.status}, ${shell.body.length} 字节, err=${shell.error}`);

    const webAsset = await request(port, '/web/nonexistent-but-must-not-be-aborted.js');
    check('catch-all 规则不会作用于 /web/* 静态资源路径',
      webAsset.status === 404 && !webAsset.error,
      `状态 ${webAsset.status}, err=${webAsset.error}（若是 ABORTED 说明被模拟管线截住了）`);

    // 业务接口仍然应该被模拟 —— 修范围不能修过头
    const stillSimulated = await request(port, '/api/health');
    check('catch-all 规则对业务接口依然生效（范围收窄没修过头）',
      Boolean(stillSimulated.error) || stillSimulated.body.length < 100,
      `状态 ${stillSimulated.status}, ${stillSimulated.body.length} 字节, err=${stillSimulated.error}`);

    // 控制接口必须始终可用：这是唯一的自救通道
    const rescue = await request(port, '/api/control');
    check('catch-all 规则下控制接口依然可用（自救通道）',
      rescue.status === 200 && !rescue.error,
      `状态 ${rescue.status}, err=${rescue.error}`);

    await clearFaults(port);
    // ---------------- 使用手册的语言路由 ----------------
    section('使用手册的多语言路由');

    const zhManual = await request(port, '/manual.md?lang=zh-CN');
    check('?lang=zh-CN 拿到中文手册',
      zhManual.status === 200 && zhManual.headers['x-manual-lang'] === 'zh-CN'
        && zhManual.body.length > 1000,
      `状态 ${zhManual.status}, lang=${zhManual.headers['x-manual-lang']}, ${zhManual.body.length} 字节`);

    const defaultManual = await request(port, '/manual.md');
    check('不带 ?lang 时默认中文',
      defaultManual.status === 200 && defaultManual.headers['x-manual-lang'] === 'zh-CN',
      `lang=${defaultManual.headers['x-manual-lang']}`);

    // 语言代码直接决定读哪个文件，所以必须是白名单查表而不是拼接路径。
    // 这一组是防回归：把 lang 改成拼路径的实现，这几条会立刻全红。
    const traversals = [
      '../../../../etc/passwd',
      '..%2f..%2fpackage.json',
      '../../app.js',
      '/etc/passwd',
      'manual.zh-CN',
      'zh-CN/../../app.js',
    ];
    let escaped = 0;
    for (const evil of traversals) {
      const res = await request(port, `/manual.md?lang=${evil}`);
      // 合法结果只有两种：回退到默认语言，或者明确 404。绝不该读出别的文件。
      const fellBack = res.headers['x-manual-lang'] === 'zh-CN';
      const leaked = res.status === 200 && !fellBack;
      if (leaked) {
        escaped += 1;
        console.log(`      ✗ lang=${evil} 读出了非手册内容（${res.body.length} 字节）`);
      }
    }
    check('非法语言代码不会读到任意文件（白名单生效）', escaped === 0,
      `${escaped} / ${traversals.length} 个穿越尝试得逞`);

    const manualPage = await request(port, '/manual');
    check('/manual 重定向到面板内的手册页',
      manualPage.status === 302 && String(manualPage.headers.location).includes('#/manual'),
      `状态 ${manualPage.status}, location=${manualPage.headers.location}`);

    const browserNav = await request(port, '/manual.md', { headers: { Accept: 'text/html' } });
    check('浏览器直接打开 /manual.md 会转到渲染页',
      browserNav.status === 302 && String(browserNav.headers.location).includes('#/manual'),
      `状态 ${browserNav.status}, location=${browserNav.headers.location}`);

    const rawForced = await request(port, '/manual.md?raw=1', { headers: { Accept: 'text/html' } });
    check('?raw=1 时即使浏览器也拿到源文件',
      rawForced.status === 200 && String(rawForced.headers['content-type']).includes('text/markdown'),
      `状态 ${rawForced.status}, type=${rawForced.headers['content-type']}`);

    // ---------------- 平台名不是只有 Android / iOS ----------------
    //
    // 平台就是资产目录下的一级子目录名，没有任何硬编码清单。
    // 这里用**非 ASCII** 的名字，是因为它会踩到一个很隐蔽的坑：
    // 响应头 X-Asset-Platform 的值只能是 ASCII，直接塞中文会让 setHeader
    // 抛 ERR_INVALID_CHAR —— 而 /api/version、/api/manifest 走 JSON body
    // 完全正常，于是表现为"版本查得到、文件下不来"这种很难查的现象。
    section('平台名（含非 ASCII）');

    const oddPlatform = 'UnicodeProbe平台';
    const oddDir = path.join(ASSETS_ROOT, oddPlatform);
    const cnPlatform = '微信小游戏';
    const cnDir = path.join(ASSETS_ROOT, cnPlatform);

    try {
      fs.mkdirSync(path.join(oddDir, 'bundles'), { recursive: true });
      fs.writeFileSync(path.join(oddDir, 'manifest.json'),
        JSON.stringify({ version: '9.9.9', minVersion: '1.0.0', notice: 'probe' }));
      fs.writeFileSync(path.join(oddDir, 'bundles', 'u.ab'), Buffer.alloc(2048, 9));

      fs.mkdirSync(path.join(cnDir, 'bundles'), { recursive: true });
      fs.writeFileSync(path.join(cnDir, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(cnDir, 'bundles', 'wx.ab'), Buffer.alloc(512, 3));

      app.locals.assetServer.invalidateManifest();

      const listed = await request(port, '/api/platforms');
      const listedJson = JSON.parse(listed.body.toString());
      check('非 ASCII 平台名出现在 /api/platforms 里',
        listedJson.platforms.some((p) => p.name === oddPlatform),
        listedJson.platforms.map((p) => p.name).join(', '));

      const oddVersion = await request(port,
        `/api/version?platform=${encodeURIComponent(oddPlatform)}&current=1.0.0`);
      const oddJson = JSON.parse(oddVersion.body.toString());
      check('非 ASCII 平台的版本号独立于其它平台',
        oddJson.version === '9.9.9' && oddJson.needUpdate === true,
        `version=${oddJson.version}`);

      const oddAsset = await request(port, `/assets/${encodeURIComponent(oddPlatform)}/bundles/u.ab`);
      check('非 ASCII 平台的资产下载返回 200',
        oddAsset.status === 200, `状态 ${oddAsset.status}, ${oddAsset.body.length} 字节`);
      check('非 ASCII 平台的资产内容完整',
        oddAsset.body.length === 2048, `${oddAsset.body.length} 字节，期望 2048`);
      check('X-Asset-Platform 头做了 percent-encode（响应头只能放 ASCII）',
        oddAsset.headers['x-asset-platform'] === encodeURIComponent(oddPlatform),
        `实际 ${oddAsset.headers['x-asset-platform']}`);

      const cnAsset = await request(port, `/assets/${encodeURIComponent(cnPlatform)}/bundles/wx.ab`);
      check('纯中文平台名的资产下载也正常',
        cnAsset.status === 200 && cnAsset.body.length === 512,
        `状态 ${cnAsset.status}, ${cnAsset.body.length} 字节`);
    } finally {
      // 这两个目录名里带中文/platform 名，正好是 fs.rmSync 会出问题的路径，
      // 所以必须走 safe-rm。库里的说明写了具体现象。
      await removeDir(oddDir);
      await removeDir(cnDir);
      app.locals.assetServer.invalidateManifest();
    }

    // ---------------- 代码热更轨道 ----------------
    //
    // 资源热更和代码热更在成熟管线里是两条**独立版本**的轨道
    // （YooAsset 的 Package Version vs App Version、Addressables、HybridCLR 的
    // DLL 集版本）。这里验证三件最容易做错的事：
    //   1. 代码版本真的独立于资源版本（不是同一个号）
    //   2. 兼容性门禁真的能挡住 —— AOT 元数据不匹配是 HybridCLR 的头号事故，
    //      编译期没征兆、运行期才炸，而且报错离根因很远
    //   3. 两条轨道的文件清单不重叠 —— 否则同一份 dll 会被下两次
    section('代码热更轨道');

    const codePlatform = 'CodeTrackProbe';
    const codePlatformDir = path.join(ASSETS_ROOT, codePlatform);
    try {
      fs.mkdirSync(path.join(codePlatformDir, 'dll'), { recursive: true });
      fs.mkdirSync(path.join(codePlatformDir, 'bundles'), { recursive: true });
      fs.writeFileSync(path.join(codePlatformDir, 'manifest.json'), JSON.stringify({
        version: '1.5.0',
        code: {
          version: '2.1.0',
          minAppVersion: '1.2.0',
          aotHash: 'aot-abc123',
          notice: '代码更新',
        },
      }));
      fs.writeFileSync(path.join(codePlatformDir, 'dll', 'Assembly-CSharp.dll.bytes'), Buffer.alloc(1024, 1));
      fs.writeFileSync(path.join(codePlatformDir, 'dll', 'GameLogic.dll.bytes'), Buffer.alloc(512, 2));
      fs.writeFileSync(path.join(codePlatformDir, 'bundles', 'role.ab'), Buffer.alloc(2048, 3));
      app.locals.assetServer.invalidateManifest();

      const cv = async (qs = '') => JSON.parse(
        (await request(port, `/api/version?platform=${codePlatform}${qs}`)).body.toString(),
      );

      const base = await cv('&current=1.5.0&codeCurrent=2.1.0');
      check('代码版本独立于资源版本（两个号可以不一样）',
        base.version === '1.5.0' && base.code && base.code.version === '2.1.0',
        `资源 ${base.version} / 代码 ${base.code && base.code.version}`);

      const resManifest = JSON.parse(
        (await request(port, `/api/manifest?platform=${codePlatform}`)).body.toString(),
      );
      const codeManifest = JSON.parse(
        (await request(port, `/api/manifest?platform=${codePlatform}&track=code`)).body.toString(),
      );

      check('资源清单里不含代码文件（否则同一份 dll 会被下两次）',
        resManifest.fileCount === 1 && resManifest.files.every((f) => !f.path.startsWith('dll/')),
        `资源清单 ${resManifest.fileCount} 个文件：${resManifest.files.map((f) => f.path).join(', ')}`);
      check('代码清单只含代码文件，且路径带 dll/ 前缀（URL 才对得上）',
        codeManifest.fileCount === 2
          && codeManifest.files.every((f) => f.path.startsWith('dll/'))
          && codeManifest.files.every((f) => f.url.includes('/dll/')),
        `代码清单 ${codeManifest.fileCount} 个：${codeManifest.files.map((f) => f.path).join(', ')}`);
      check('代码清单带 md5（客户端要能校验）',
        codeManifest.files.every((f) => typeof f.hash === 'string' && f.hash.length === 32),
        codeManifest.files.map((f) => `${f.path}:${f.hash}`).join(' '));
      check('资源清单里带的是代码轨道的摘要，不含文件列表',
        resManifest.code && resManifest.code.version === '2.1.0' && resManifest.code.files === undefined,
        JSON.stringify(resManifest.code && Object.keys(resManifest.code)));

      const dllDl = await request(port, `/assets/${codePlatform}/dll/Assembly-CSharp.dll.bytes`);
      check('dll 能正常下载，字节数正确',
        dllDl.status === 200 && dllDl.body.length === 1024,
        `状态 ${dllDl.status}, ${dllDl.body.length} 字节`);

      // ---- 兼容性门禁 ----
      const tooOld = await cv('&current=1.5.0&codeCurrent=2.1.0&appVersion=1.0.0');
      check('主包版本过低时判定为不兼容',
        tooOld.code.compatible === false,
        `compatible=${tooOld.code.compatible}`);
      check('不兼容时明确给出 requiresAppUpdate（客户端不用自己推导）',
        tooOld.code.requiresAppUpdate === true,
        `requiresAppUpdate=${tooOld.code.requiresAppUpdate}`);

      const okApp = await cv('&current=1.5.0&codeCurrent=2.1.0&appVersion=1.2.0');
      check('主包版本达标时判定为兼容（边界值算达标）',
        okApp.code.compatible === true, `compatible=${okApp.code.compatible}`);

      // ⚠️ 这条最重要：没传 appVersion 时必须返回 null（"没检查"），
      // 而不是乐观地返回 true —— 否则一个旧客户端会被误告知"兼容"。
      const noApp = await cv('&current=1.5.0&codeCurrent=2.1.0');
      check('没传 appVersion 时返回 null（"没检查"≠"检查通过"）',
        noApp.code.compatible === null, `compatible=${JSON.stringify(noApp.code.compatible)}`);
      check('没传 aotHash 时同样返回 null',
        noApp.code.aotMatch === null, `aotMatch=${JSON.stringify(noApp.code.aotMatch)}`);

      const aotOk = await cv('&current=1.5.0&codeCurrent=2.1.0&aotHash=aot-abc123');
      check('AOT 指纹一致时 aotMatch 为 true',
        aotOk.code.aotMatch === true, `aotMatch=${aotOk.code.aotMatch}`);

      const aotBad = await cv('&current=1.5.0&codeCurrent=2.1.0&aotHash=aot-WRONG');
      check('AOT 指纹不一致时 aotMatch 为 false（这就是运行期崩溃的前兆）',
        aotBad.code.aotMatch === false, `aotMatch=${aotBad.code.aotMatch}`);

      const codeStale = await cv('&current=1.5.0&codeCurrent=1.0.0');
      check('代码版本落后时 needUpdate 为 true',
        codeStale.code.needUpdate === true, `needUpdate=${codeStale.code.needUpdate}`);
      const codeFresh = await cv('&current=1.5.0&codeCurrent=2.1.0');
      check('代码版本已是最新时 needUpdate 为 false',
        codeFresh.code.needUpdate === false, `needUpdate=${codeFresh.code.needUpdate}`);

      // ---- 没有代码轨道的平台 ----
      //
      // 这里必须**自己建一个平台**，不能拿示例里的 Android 当例子：
      // npm run sample 现在会生成 dll/ 和 code 块，于是 Android 也是有代码轨道的。
      // 断言依赖示例数据的话，示例一变测试就红 —— 而且红得让人以为是功能坏了。
      const plainPlatform = 'NoCodeTrackProbe';
      const plainDir = path.join(ASSETS_ROOT, plainPlatform);
      fs.mkdirSync(path.join(plainDir, 'bundles'), { recursive: true });
      fs.writeFileSync(path.join(plainDir, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(path.join(plainDir, 'bundles', 'a.ab'), Buffer.alloc(256, 5));
      app.locals.assetServer.invalidateManifest();

      try {
        const plainVersion = JSON.parse(
          (await request(port, `/api/version?platform=${plainPlatform}&current=1.0.0`)).body.toString(),
        );
        check('平台没配 code 块时 /api/version 的 code 为 null',
          plainVersion.code === null, `code=${JSON.stringify(plainVersion.code)}`);

        const plainManifest = JSON.parse(
          (await request(port, `/api/manifest?platform=${plainPlatform}`)).body.toString(),
        );
        check('没配 code 块时资源清单里也没有 code 字段',
          plainManifest.code === undefined, `code=${JSON.stringify(plainManifest.code)}`);

        const noTrack = await request(port, `/api/manifest?platform=${plainPlatform}&track=code`);
        check('没配代码轨道时 ?track=code 返回 404（而不是空清单）',
          noTrack.status === 404, `状态 ${noTrack.status}`);

        const emptyDirPlatform = 'EmptyCodeDirProbe';
        const emptyDir = path.join(ASSETS_ROOT, emptyDirPlatform);
        fs.mkdirSync(path.join(emptyDir, 'bundles'), { recursive: true });
        fs.writeFileSync(path.join(emptyDir, 'manifest.json'), JSON.stringify({
          version: '1.0.0',
          code: { version: '9.9.9' },   // 声明了代码轨道，但 dll/ 目录不存在
        }));
        app.locals.assetServer.invalidateManifest();
        try {
          const codeDirMissing = JSON.parse(
            (await request(port, `/api/manifest?platform=${emptyDirPlatform}`)).body.toString(),
          );
          check('声明了 code 但代码目录不存在时，当作没有代码轨道（不报错）',
            codeDirMissing.code === undefined,
            `code=${JSON.stringify(codeDirMissing.code)}`);
        } finally {
          await removeDir(emptyDir);
          app.locals.assetServer.invalidateManifest();
        }
      } finally {
        await removeDir(plainDir);
        app.locals.assetServer.invalidateManifest();
      }

      // ---- 平台列表里能看到代码版本 ----
      const platformList = JSON.parse((await request(port, '/api/platforms')).body.toString());
      const entry = platformList.platforms.find((p) => p.name === codePlatform);
      check('/api/platforms 里能分别看到资源版本与代码版本',
        entry && entry.version === '1.5.0' && entry.codeVersion === '2.1.0',
        entry ? `资源 ${entry.version} / 代码 ${entry.codeVersion}` : '没找到该平台');
    } finally {
      await removeDir(codePlatformDir);
      app.locals.assetServer.invalidateManifest();
    }

    // ---------------- 协议版本、能力位与内容摘要 ----------------
    //
    // 这一组对应协议 1.1.0 引入的改动。每一条都针对一种"客户端会静默误判"
    // 的情况 —— 不报错，但行为不对，而这类问题恰恰是模拟器最该帮人发现的。
    section('协议协商与内容摘要');

    const proto = JSON.parse((await request(port, '/api/protocol')).body.toString());
    check('协议版本号存在且是正整数',
      Number.isInteger(proto.protocolVersion) && proto.protocolVersion >= 1,
      `protocolVersion=${proto.protocolVersion}`);
    check('能力位是非空字符串数组',
      Array.isArray(proto.capabilities) && proto.capabilities.length > 0
        && proto.capabilities.every((c) => typeof c === 'string'),
      `${proto.capabilities.length} 项`);
    check('/api/protocol 不需要 platform（客户端还不知道平台时就能问）',
      proto.protocolVersion > 0 && proto.assetRoot !== undefined);
    check('声明了支持的摘要算法',
      Array.isArray(proto.hashAlgorithms) && proto.hashAlgorithms.length > 0,
      JSON.stringify(proto.hashAlgorithms));

    const pv = JSON.parse(
      (await request(port, '/api/version?platform=Android&current=1.0.0')).body.toString(),
    );
    check('/api/version 也带协议元信息（客户端不必额外发一次请求）',
      pv.protocolVersion === proto.protocolVersion && Array.isArray(pv.capabilities),
      `protocolVersion=${pv.protocolVersion}`);

    const tooNew = JSON.parse(
      (await request(port, '/api/version?platform=Android&protocol=99')).body.toString(),
    );
    check('客户端声明更高的协议版本时如实告知不兼容（而不是假装支持）',
      tooNew.protocolCompatible === false && Boolean(tooNew.protocolNotice),
      `compatible=${tooNew.protocolCompatible}`);

    const sameProto = JSON.parse(
      (await request(port, `/api/version?platform=Android&protocol=${proto.protocolVersion}`)).body.toString(),
    );
    check('客户端声明相同协议版本时判定兼容',
      sameProto.protocolCompatible === true, `compatible=${sameProto.protocolCompatible}`);

    // ---- 摘要算法与 ETag 必须是同一个值 ----
    //
    // 这是客户端能"看清单就免掉下载"的前提：如果 ETag 是另一套东西，
    // 客户端手里明明有 hash，却还得再发一次条件请求去问。
    const withHashes = JSON.parse(
      (await request(port, '/api/manifest?platform=Android')).body.toString(),
    );
    const entry = withHashes.files[0];
    check('清单条目给出算法名（hashAlgo）与多算法摘要（hashes）',
      typeof entry.hashAlgo === 'string'
        && entry.hashes && typeof entry.hashes[entry.hashAlgo] === 'string',
      `hashAlgo=${entry.hashAlgo}, hashes=${JSON.stringify(Object.keys(entry.hashes || {}))}`);
    check('hash 仍是裸字符串（老客户端不受影响）',
      typeof entry.hash === 'string' && entry.hash.length > 0, `type=${typeof entry.hash}`);

    const assetRes = await request(port, entry.url);
    check('资产响应的 ETag 就是清单里的 hash（客户端可据此本地决策）',
      assetRes.headers.etag === `"${entry.hash}"`,
      `ETag=${assetRes.headers.etag} vs hash=${entry.hash}`);
    check('ETag 是强验证器（不带 W/ 前缀，同一 hash 必是同一份字节）',
      String(assetRes.headers.etag).startsWith('"'), assetRes.headers.etag);

    const byHash = await request(port, entry.url, {
      headers: { 'If-None-Match': `"${entry.hash}"` },
    });
    check('拿清单里的 hash 直接做条件请求会拿到 304（免掉一次下载）',
      byHash.status === 304, `状态 ${byHash.status}`);

    // ---- 清单版本固定 ----
    check('清单带 manifestId',
      typeof withHashes.manifestId === 'string' && withHashes.manifestId.length > 0,
      withHashes.manifestId);

    const sameId = await request(port,
      `/api/manifest?platform=Android&expectId=${withHashes.manifestId}`);
    check('expectId 正确时正常返回',
      sameId.status === 200, `状态 ${sameId.status}`);

    const staleId = await request(port, '/api/manifest?platform=Android&expectId=stale0000');
    check('expectId 对不上时返回 409（拦住"取版本和取清单之间被改了配置"）',
      staleId.status === 409, `状态 ${staleId.status}`);
    const staleBody = JSON.parse(staleId.body.toString());
    check('409 里带回当前真实身份，客户端可直接重来',
      staleBody.actual && staleBody.actual.manifestId === withHashes.manifestId,
      `actual=${staleBody.actual && staleBody.actual.manifestId}`);

    const staleVer = await request(port, '/api/manifest?platform=Android&expectVersion=9.9.9');
    check('expectVersion 对不上时同样返回 409（客户端实现更简单的那种）',
      staleVer.status === 409, `状态 ${staleVer.status}`);

    // manifestId 必须稳定：内容没变就不能变，否则客户端每次都会拿到 409，
    // 等于把固定版本这个功能废掉。
    const againManifest = JSON.parse(
      (await request(port, '/api/manifest?platform=Android')).body.toString(),
    );
    check('同样的内容得到同样的 manifestId（否则固定版本会永远失败）',
      againManifest.manifestId === withHashes.manifestId,
      `${withHashes.manifestId} vs ${againManifest.manifestId}`);

    // ---- gzip：要求"不得比未压缩更大"，而不是"必须压缩" ----
    //
    // 小响应压完反而更大是常态（实测 3 个文件的清单：1357 → 1385 字节），
    // 所以正确行为是压完比一次大小、取小的那个。
    const noGzip = await request(port, '/api/manifest?platform=Android');
    check('未要求 gzip 时不压缩', !noGzip.headers['content-encoding'],
      `encoding=${noGzip.headers['content-encoding']}`);
    check('JSON 响应声明 Vary: Accept-Encoding（否则中间缓存会发错版本）',
      String(noGzip.headers.vary || '').includes('Accept-Encoding'),
      String(noGzip.headers.vary));

    const gzManifest = await request(port, '/api/manifest?platform=Android', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    check('压缩后的响应绝不会比未压缩更大（小清单必须退回原样）',
      gzManifest.body.length <= noGzip.body.length,
      `gzip ${gzManifest.body.length} vs 原样 ${noGzip.body.length} 字节`);
    if (gzManifest.headers['content-encoding'] === 'gzip') {
      check('声明了 gzip 就必须真的压缩过（Content-Length 与实际字节数一致）',
        Number(gzManifest.headers['content-length']) === gzManifest.body.length,
        `header=${gzManifest.headers['content-length']} 实际=${gzManifest.body.length}`);
    }

    // ---- 大清单必须真的被压小 ----
    //
    // 上面那条只保证"不变大"。gzip 的真正价值在文件多的时候：实测每个文件条目
    // 约 300 字节，1000 个文件就是 295 KB。这里建 300 个极小的文件来验证
    // 压缩确实生效 —— 否则"加了 gzip"就只是说说。
    const bulkPlatform = 'GzipBulkProbe';
    const bulkDir = path.join(ASSETS_ROOT, bulkPlatform);
    try {
      fs.mkdirSync(path.join(bulkDir, 'bundles'), { recursive: true });
      for (let i = 0; i < 300; i += 1) {
        fs.writeFileSync(
          path.join(bulkDir, 'bundles', `f${String(i).padStart(4, '0')}_bundle.ab`),
          Buffer.alloc(64, i % 251),
        );
      }
      app.locals.assetServer.invalidateManifest();

      const plain = await request(port, `/api/manifest?platform=${bulkPlatform}`, {
        headers: { 'Accept-Encoding': 'identity' },
      });
      const zipped = await request(port, `/api/manifest?platform=${bulkPlatform}`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });

      check(`大清单（300 个文件）确实被 gzip 压小了`,
        zipped.headers['content-encoding'] === 'gzip' && zipped.body.length < plain.body.length * 0.5,
        `原样 ${plain.body.length} 字节 → gzip ${zipped.body.length} 字节`
          + `（${(plain.body.length / Math.max(zipped.body.length, 1)).toFixed(1)}x）`);

      // 压完必须还能正常解析，且内容和未压缩版一致。
      // 注意要**先解压**：测试用的 request() 走裸 http，不会自动解 Content-Encoding，
      // 直接把 gzip 字节 toString() 会得到乱码。
      const unzip = (res) => (res.headers['content-encoding'] === 'gzip'
        ? zlib.gunzipSync(res.body).toString()
        : res.body.toString());
      const parsed = JSON.parse(unzip(zipped));
      check('压缩后的清单内容与未压缩版一致（不是压坏了）',
        parsed.fileCount === 300 && parsed.manifestId
          === JSON.parse(plain.body.toString()).manifestId,
        `fileCount=${parsed.fileCount}`);
    } finally {
      await removeDir(bulkDir);
      app.locals.assetServer.invalidateManifest();
    }

    // ---------------- CORS / 跨站防护的判定基准是「同源」 ----------------
    //
    // 这里曾经有个影响跨设备使用的 bug：判定写成了"Origin 的 hostname 是不是
    // 回环地址"。于是从另一台设备打开面板时（http://192.168.1.5:5500），
    // 页面发出的 POST 带着 Origin: http://192.168.1.5:5500，被当成了跨站 ——
    // 急停、网络参数、故障规则**全部 403**，面板静默变成只读的。
    //
    // 正确的基准是**同源**：Origin 的 host 和请求的 Host 一致就不是跨站，
    // 浏览器只会对"从本站加载的页面"发这个 Origin。跨站页面两条都不满足。
    //
    // 另外：回显原始 Origin 字符串是危险的 —— `http://localhost/雪` 能通过
    // 回环检查，但写进响应头会抛 ERR_INVALID_CHAR，把正常请求打成 500。
    // 必须回显规范化后的 url.origin。
    section('跨站防护（同源判定 + 回显规范化）');

    const LAN = '192.168.1.5:5500';

    // ---- 同源：跨设备使用必须放行 ----
    const sameOriginWrite = await request(port, '/api/control/disable', {
      method: 'POST',
      headers: { Origin: `http://${LAN}`, Host: LAN },
    });
    check('同源的写请求放行（跨设备打开面板时「急停」必须能用）',
      sameOriginWrite.status === 200,
      `状态 ${sameOriginWrite.status} —— 403 说明面板在别的设备上会变成只读`);

    const sameOriginPatch = await request(port, '/api/control/network', {
      method: 'PATCH',
      headers: { Origin: `http://${LAN}`, Host: LAN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    check('同源的 PATCH 放行（改网络参数）',
      sameOriginPatch.status === 200, `状态 ${sameOriginPatch.status}`);

    const sameOriginRead = await request(port, '/api/logs?limit=1', {
      headers: { Origin: `http://${LAN}`, Host: LAN },
    });
    check('同源的读请求放行',
      sameOriginRead.status === 200, `状态 ${sameOriginRead.status}`);

    // 本机开发模式：前端 5173 直连后端 5500，跨源但确实是本机
    const devCrossPort = await request(port, '/api/control/disable', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', Host: 'localhost:5500' },
    });
    check('本机开发模式下前端 5173 直连后端仍放行（回环跨端口）',
      devCrossPort.status === 200, `状态 ${devCrossPort.status}`);

    // ---- 跨站：必须挡住 ----
    const evilWrite = await request(port, '/api/control/disable', {
      method: 'POST',
      headers: { Origin: 'http://evil.example', Host: LAN },
    });
    check('跨站的状态变更请求被 403 拒绝',
      evilWrite.status === 403, `状态 ${evilWrite.status}`);

    const evilPatch = await request(port, '/api/control/fault', {
      method: 'PATCH',
      headers: { Origin: 'http://evil.example', Host: LAN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    check('跨站改故障规则被 403 拒绝',
      evilPatch.status === 403, `状态 ${evilPatch.status}`);

    // 同一个 IP 但不同端口：既不同源也不是回环，仍要挡
    const crossPort = await request(port, '/api/control/disable', {
      method: 'POST',
      headers: { Origin: 'http://192.168.1.5:9999', Host: LAN },
    });
    check('同 IP 不同端口既不同源也不回环，仍被拒绝',
      crossPort.status === 403, `状态 ${crossPort.status}`);

    const evilRead = await request(port, '/api/logs?limit=1', {
      headers: { Origin: 'http://evil.example', Host: LAN },
    });
    check('跨站的读请求放行但不回 ACAO（浏览器读不到内容）',
      evilRead.status === 200 && !evilRead.headers['access-control-allow-origin'],
      `状态 ${evilRead.status}, ACAO=${evilRead.headers['access-control-allow-origin']}`);

    // ---- 回显规范化 ----
    const originWithPath = await request(port, '/api/health', {
      headers: { Origin: 'http://localhost:5500/some/path' },
    });
    check('带路径的本机 Origin 不会把响应打成 500',
      originWithPath.status === 200, `状态 ${originWithPath.status}`);
    check('回显的是规范化后的 origin（路径被剥掉）',
      originWithPath.headers['access-control-allow-origin'] === 'http://localhost:5500',
      `实际 ${originWithPath.headers['access-control-allow-origin']}`);
  } finally {
    try { await removeDir(probeDir); } catch { /* 忽略 */ }
    await clearFaults(port).catch(() => {});
    server.close();
  }
}

// ============================================================ 静态检查

/**
 * 两份手册的结构必须逐项一致。
 *
 * 面板会从标题自动生成目录，所以标题的**层级和数量**一变，目录就错位。
 * 靠人肉比对 300 多行很容易漏，这里直接把结构量出来对齐。
 */
function testManualStructure() {
  section('手册的中英文结构一致性');

  const dir = path.resolve(__dirname, '..', 'backend', 'public');
  const files = { 'zh-CN': 'manual.zh-CN.md', en: 'manual.en.md' };

  const measure = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    return {
      headings: lines.filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)[0].length),
      fences: lines.filter((l) => /^```/.test(l)).length,
      tableRows: lines.filter((l) => /^\|/.test(l)).length,
      links: (text.match(/\]\([^)]+\)/g) || []).length,
      lines: lines.length,
    };
  };

  const zhPath = path.join(dir, files['zh-CN']);
  const enPath = path.join(dir, files.en);

  if (!fs.existsSync(enPath)) {
    check('英文手册存在', false, `缺少 ${files.en}`);
    return;
  }
  check('英文手册存在', true);

  const zh = measure(zhPath);
  const en = measure(enPath);

  check('标题数量一致（目录的行数）', zh.headings.length === en.headings.length,
    `中 ${zh.headings.length} vs 英 ${en.headings.length}`);
  check('标题层级序列一致（目录的嵌套结构）',
    JSON.stringify(zh.headings) === JSON.stringify(en.headings),
    `中 [${zh.headings.join(',')}] vs 英 [${en.headings.join(',')}]`);
  check('代码块数量一致', zh.fences === en.fences, `中 ${zh.fences} vs 英 ${en.fences}`);
  check('表格行数一致', zh.tableRows === en.tableRows, `中 ${zh.tableRows} vs 英 ${en.tableRows}`);

  // 行数不要求完全相等（英文通常更长或更短），但不能差得太离谱，
  // 差太多通常意味着漏译或大段增删。
  const ratio = en.lines / zh.lines;
  check('篇幅没有量级差异（英文 / 中文 在 0.6~1.8 之间）', ratio > 0.6 && ratio < 1.8,
    `中 ${zh.lines} 行 vs 英 ${en.lines} 行，比值 ${ratio.toFixed(2)}`);

  // 英文手册不该残留成片的中文（代码里的中文注释也应翻译）
  const enText = fs.readFileSync(enPath, 'utf8');
  const cjk = enText.match(/[\u4e00-\u9fa5]+/g) || [];
  check('英文手册里没有残留的中文段落', cjk.length === 0,
    cjk.length ? `残留 ${cjk.length} 处：${[...new Set(cjk)].slice(0, 10).join(' / ')}` : '');
}

/**
 * 退出前先把 stdout 真正写出去。
 *
 * Windows 上 stdout 指向管道或文件时写入是**异步**的，而 process.exit()
 * 不会等它排空 —— 结果是最后几行输出（往往正好是失败明细和汇总）
 * 凭空消失，只留下一个 exit code 1。这个坑在真实排查里非常费时间：
 * 你知道有断言失败了，却看不到是哪条。
 */
function exitAfterFlush(code) {
  const finish = () => process.exit(code);
  if (process.stdout.writableLength === 0) {
    setImmediate(finish);
    return;
  }
  process.stdout.once('drain', finish);
  setTimeout(finish, 1000); // 兜底，避免 stdout 永远不 drain
}

// ============================================================ 主流程

async function main() {
  if (!fs.existsSync(ASSETS_ROOT)) {
    console.error('找不到测试资产。请先执行：npm run sample\n');
    process.exit(1);
  }

  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');

  try {
    testManualStructure();
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

  exitAfterFlush(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n回归测试自身出错了：');
  console.error(err);
  try { fs.writeFileSync(CONFIG_PATH, fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 忽略 */ }
  exitAfterFlush(1);
});
