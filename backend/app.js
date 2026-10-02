// backend/app.js
//
// 服务器装配文件。只做“接线”，不放业务逻辑。
//
// 中间件顺序是有讲究的，改动前请先看清楚：
//
//   1. express.json()          解析请求体
//   2. loggerMiddleware        挂在最前面，才能观察到所有请求的最终结果
//   3. 控制类路由              日志/控制/方案/收藏/统计/系统
//   4. requestPipeline         网络模拟 + 故障注入
//   5. 业务路由 /api           热更接口（受模拟影响）
//   6. /assets                 资产下载（受模拟影响）
//   7. /docs /browse           文档与目录浏览
//   8. 错误处理                必须最后
//
// 第 3 步在第 4 步之前是刻意的：控制面板自己不能被模拟器拖慢或打断，
// 否则你把延迟调到 30 秒之后就再也改不回来了。

const path = require('path');
const fs = require('fs');
const express = require('express');
const serveIndex = require('serve-index');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

// .env 在仓库根目录，不在 backend/ 下
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ConfigManager = require('./core/configManager');
const NetworkSimulator = require('./modules/networkSimulator');
const FaultInjector = require('./modules/faultInjector');
const AssetServer = require('./modules/assetServer');
const Logger = require('./modules/logger');

const requestPipeline = require('./middleware/requestPipeline');
const loggerMiddleware = require('./middleware/loggerMiddleware');

const createApiRouter = require('./routes/api');
const createLogRouter = require('./routes/logs');
const createControlRouter = require('./routes/control');
const createPresetsRouter = require('./routes/presets');
const createFavoritesRouter = require('./routes/favorites');
const createStatsRouter = require('./routes/stats');
const createSystemRouter = require('./routes/system');

const app = express();

// 关掉 Express 自动生成的 ETag。
//
// 两个理由：
//   1. assetServer 自己按「大小 + 修改时间」算 ETag，那才是热更客户端需要
//      的语义；Express 默认的 `W/"<长度>-<body 的 sha1>"` 会混在 304/416 这些
//      不该带验证器的响应上（416 带着资源的 ETag 会让客户端误以为"这就是内容"）。
//   2. 默认实现要对每个响应体算一次 SHA1，而这些响应本来就是一次性的。
// express.static 用的是 serve-static 自己的 etag 选项，不受这里影响。
app.set('etag', false);

// ---------------------------------------------------------------- 核心实例

const configPath = path.join(__dirname, 'config.json');
const configManager = new ConfigManager(configPath);
const networkSimulator = new NetworkSimulator(configManager);
const faultInjector = new FaultInjector(configManager);
const assetServer = new AssetServer(configManager);
const logger = new Logger({ maxEntries: configManager.get('logging.maxEntries') });

// 配置改了就同步日志缓冲上限，免得配置里改了却没生效
configManager.on('change', (cfg) => {
  logger.setMaxEntries(cfg.logging.maxEntries);
});

// 供 server.js 使用，也方便在测试里直接拿到实例
app.locals.configManager = configManager;
app.locals.networkSimulator = networkSimulator;
app.locals.faultInjector = faultInjector;
app.locals.assetServer = assetServer;
app.locals.logger = logger;

// ---------------------------------------------------------------- 基础中间件

const serverCfg = configManager.get('server');

/**
 * 判断一个 Origin 是不是本机来源。
 *
 * 这是个只在本机跑的开发工具，唯一合法的跨源来源就是本机的另一个端口
 * （开发模式下前端在 5173，通过代理或直连访问后端）。所以只要 hostname
 * 是回环地址就放行，其余一律按跨站处理。
 */
function isLoopbackOrigin(origin) {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * CORS + 跨站请求防护。
 *
 * 原实现无条件回 `Access-Control-Allow-Origin: *`，而控制类接口又完全没有
 * 认证 —— 结果是任何网页只要在用户浏览器里跑起来，就能
 * `fetch('http://127.0.0.1:5500/api/logs')` **读到全部请求日志**，
 * 也能 PATCH 掉模拟参数、甚至写入故障规则。
 *
 * 现在：
 *   * 只有本机来源才会拿到 ACAO（跨站页面读不到响应）
 *   * 带非本机 Origin 的状态变更请求（POST/PUT/PATCH/DELETE）直接 403
 *     （简单请求也能挡住，不依赖 CORS 预检）
 */
app.use((req, res, next) => {
  const origin = req.get('origin');

  if (origin && !isLoopbackOrigin(origin)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({
        error: '拒绝跨站的状态变更请求：这个工具只允许本机来源操作',
        origin,
      });
    }
    // 读请求放行，但不回 ACAO —— 浏览器拿不到响应内容
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range,If-None-Match,If-Modified-Since');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length,Content-Range,ETag,X-Asset-Size,X-Asset-Platform',
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

app.use(express.json({ limit: '2mb' }));
app.use(loggerMiddleware(logger));

// ------------------------------------------------- 控制类路由（不受模拟影响）

app.use('/api/logs', createLogRouter({ logger }));
app.use('/api/control', createControlRouter({ configManager, faultInjector, assetServer }));
app.use('/api/presets', createPresetsRouter({ configManager, faultInjector }));
app.use('/api/favorites', createFavoritesRouter({ configManager }));
app.use('/api/stats', createStatsRouter({ logger }));
app.use('/api/system', createSystemRouter({ configManager, assetServer }));

// --------------------------------------- 以下开始受网络模拟 / 故障注入影响
//
// 关键：模拟管线**只挂在「游戏客户端会请求的那两类路径」上**，不是全局挂载。
//
// 原来写的是 app.use(requestPipeline(...))，全局生效。但面板自己的静态资源
// （/web/*.js、/）也在 Express 的路由表里，于是它们会被一起延迟、截断、损坏：
// 用户建一条不填匹配条件的规则（意思是"全都坏"，很容易这么写），刷新页面后
// 面板再也加载不出来 —— 而"关掉故障注入"的按钮恰好就在那个面板里。
// 实测：catch-all 的 abort 规则把 /web/index-*.js 从 347KB 砍到 173KB 并中断连接。
//
// 这是本文件开头那条设计原则的延伸：控制面板不能被自己模拟坏。
// 所以模拟范围就等于「客户端会拉的东西」：热更业务接口 + 资产下载。

const simulationPipeline = requestPipeline({ networkSimulator, faultInjector });

app.use('/api', simulationPipeline, createApiRouter({ configManager, assetServer }));

// 资产下载：把 URL 拆成 { 平台, 剩余路径 } 再交给 AssetServer。
// 这里手动解析而不是用通配路由，是为了避开不同 Express 版本
// 通配符语法（*、*name、{*name}）的差异。
app.use('/assets', simulationPipeline, (req, res) => {
  const parts = req.path.split('/').filter(Boolean);
  if (!parts.length) {
    return res.status(400).type('text/plain; charset=utf-8')
      .send('用法：/assets/{平台}/{文件路径}，例如 /assets/Android/bundles/role.ab');
  }

  // 这里必须解码：文件名里可能有空格或中文，客户端会做百分号编码。
  // 解码后交给 AssetServer.safeResolve 做越界检查，顺序不能反——
  // 先检查再解码的话，%2e%2e%2f 就能绕过拦截。
  let platform;
  let subPath;
  try {
    platform = decodeURIComponent(parts[0]);
    subPath = parts.slice(1).map(decodeURIComponent).join('/');
  } catch {
    return res.status(400).type('text/plain; charset=utf-8').send('路径编码不合法');
  }

  req.params.platform = platform;
  req.params.subPath = subPath;
  return assetServer.handle(req, res);
});

// ---------------------------------------------------------- 文档与目录浏览

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: '热更新模拟器 API',
      version: '1.0.0',
      description:
        '模拟真实游戏热更新服务端的接口。\n\n'
        + '注意：`/api/version`、`/api/manifest`、`/api/check`、`/assets/*` 会经过网络模拟与故障注入；'
        + '`/api/control`、`/api/logs`、`/api/presets`、`/api/favorites`、`/api/stats`、`/api/system` 不会，'
        + '所以哪怕把服务调成断网，控制面板依然可用。',
    },
    tags: [
      { name: '热更接口', description: '给游戏客户端调用，受模拟影响' },
      { name: '控制', description: '调整模拟参数，不受影响' },
      { name: '观测', description: '日志与统计，不受影响' },
      { name: '预置方案', description: '保存/切换模拟场景' },
      { name: '收藏', description: '保存并重放常用请求' },
    ],
  },
  // 必须用绝对路径：相对路径是相对“启动时的工作目录”解析的，
  // 从别的目录启动就扫不到注解了。
  //
  // 还必须把反斜杠换成正斜杠：swagger-jsdoc 内部用 glob 匹配文件名，
  // 而 glob 把 \ 当成转义符，Windows 下用 path.join 拼出来的
  // "backend\routes\*.js" 一个文件都匹配不到（表现是文档里 0 个接口）。
  apis: [path.join(__dirname, 'routes', '*.js').split(path.sep).join('/')],
});

if (serverCfg.enableDocs !== false) {
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, { customSiteTitle: '热更新模拟器 API' }),
  );
  app.get('/openapi.json', (req, res) => res.json(swaggerSpec));
}

// 资源目录浏览（仅开发环境）
if (serverCfg.enableBrowse !== false && process.env.NODE_ENV !== 'production') {
  const publicDir = configManager.resolvePath('server.publicDir') || path.join(__dirname, 'public');
  app.use('/browse', express.static(publicDir), serveIndex(publicDir, { icons: true }));
}

// 使用手册
app.get('/manual.md', (req, res) => {
  const manualPath = path.join(__dirname, 'public', 'manual.md');
  res.type('text/markdown; charset=utf-8');
  res.sendFile(manualPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).type('text/plain; charset=utf-8').send('手册文件不存在');
    }
  });
});

// ------------------------------------------------------------ 前端静态资源

// Vite 的构建产物在仓库根的 dist/ 下（见 frontend/vite.config.js 的 outDir）
const webRoot = path.resolve(__dirname, '..', 'dist');
const hasBuiltFrontend = fs.existsSync(path.join(webRoot, 'index.html'));

if (hasBuiltFrontend) {
  app.use(express.static(webRoot));
}

app.get('/', (req, res) => {
  if (hasBuiltFrontend) return res.sendFile(path.join(webRoot, 'index.html'));
  return res.type('text/html; charset=utf-8').send(
    '<meta charset="utf-8"><h3>后端已启动</h3>'
    + '<p>前端还没构建。执行 <code>npm run build</code>，'
    + '或另开一个终端跑 <code>cd frontend &amp;&amp; npm run dev</code>。</p>'
    + '<p>接口文档：<a href="/docs">/docs</a>　使用手册：<a href="/manual.md">/manual.md</a></p>',
  );
});

// ---------------------------------------------------------------- 错误处理

// 兜底 404，方便一眼看出是不是路径写错了
app.use((req, res) => {
  res.status(404).json({ error: `没有这个接口：${req.method} ${req.originalUrl}` });
});

// 全局错误处理必须放在最后，且必须是四个参数
app.use((err, req, res, next) => {
  logger.log({
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
  });

  if (res.headersSent) {
    res.destroy();
    return;
  }

  // 请求体解析失败是客户端的问题，不该报 500。
  // 原来所有异常都被统一成 500 + "服务器内部错误"，客户端根本分不清
  // 是自己发错了还是服务端崩了。
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求体不是合法的 JSON' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: '请求体过大（上限 2MB）' });
    return;
  }

  // 绝不把 err.message 回给客户端：Node 的 fs 错误消息长这样
  //   `ENOENT: no such file or directory, stat 'E:\...\storage\assets\...'`
  // 等于把资产根目录、项目路径、磁盘结构一起告诉对方。
  // 详细信息只进日志，客户端只拿到一个可关联的 id。
  const detail = process.env.NODE_ENV === 'production' ? undefined : err.code;
  res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({
    error: '服务器内部错误',
    ...(detail ? { code: detail } : {}),
  });
});

module.exports = app;
