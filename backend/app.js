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

// 简单 CORS：浏览器端调试工具从别的源访问时不用再折腾代理
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

app.use(requestPipeline({ networkSimulator, faultInjector }));

app.use('/api', createApiRouter({ configManager, assetServer }));

// 资产下载：把 URL 拆成 { 平台, 剩余路径 } 再交给 AssetServer。
// 这里手动解析而不是用通配路由，是为了避开不同 Express 版本
// 通配符语法（*、*name、{*name}）的差异。
app.use('/assets', (req, res) => {
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
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.log({ error: err.message, stack: err.stack, url: req.originalUrl, method: req.method });
  if (!res.headersSent) {
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  } else {
    res.destroy();
  }
});

module.exports = app;
