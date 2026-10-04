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

// .env 由 core/paths 统一加载，这里只需要保证它**最先**被 require，
// 环境变量才会在后面的模块读 process.env 之前就位。
// 不要在这里再加载一次 dotenv：两处加载会变成"谁先谁后"的隐式依赖。
require('./core/paths');

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

/** 回环地址的各种写法。开发模式下前端在 5173、后端在 5500，属于跨源但可信。 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * 判断一个 Origin 是不是"我们自己"的来源。
 *
 * 放行两种情况：
 *
 *   1. **同源**：Origin 的 host 和请求的 Host 头一致。
 *      同源请求按定义就不是跨站 —— 浏览器只会对"从本站加载的页面"发这个 Origin。
 *
 *      这一条是**跨设备使用的关键**：从另一台设备打开面板时地址是
 *      `http://192.168.1.5:5500`，页面里的 POST 会带
 *      `Origin: http://192.168.1.5:5500`。如果只认回环地址，这些请求会被
 *      当成跨站全部 403 —— 面板在别的设备上就变成了只读的
 *      （急停按钮、网络参数、故障规则全都点不动），而且完全不报错。
 *
 *   2. **回环地址**：开发模式前端 5173 直连后端 5500 时属于跨源但确实是本机。
 *
 * 跨站页面的 Origin 两条都不满足，一律拒。
 *
 * @param {string|undefined} origin
 * @param {string|undefined} hostHeader 请求的 Host 头
 * @returns {string|null} 规范化后的 origin（可直接写进响应头）；不合法返回 null
 */
function normalizeAllowedOrigin(origin, hostHeader) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (hostHeader && url.host.toLowerCase() === String(hostHeader).toLowerCase()) {
      return url.origin;
    }
    if (LOOPBACK_HOSTS.includes(url.hostname)) return url.origin;
    // 返回 url.origin 而不是原始字符串：原始值可能带路径或非 ASCII
    // （`http://localhost/雪` 能通过 hostname 检查），直接写进响应头会抛
    // ERR_INVALID_CHAR。url.origin 已被规范化成「协议://主机[:端口]」，只含 ASCII。
    return null;
  } catch {
    return null;
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
 *   * 只有同源 / 回环来源才会拿到 ACAO（跨站页面读不到响应）
 *   * 带跨站 Origin 的状态变更请求（POST/PUT/PATCH/DELETE）直接 403
 *     （简单请求也能挡住，不依赖 CORS 预检）
 *
 * ⚠️ 判定的关键词是**同源**，不是"是不是回环地址"。绑到 0.0.0.0 给别的设备
 * 用时，面板的地址是 LAN IP，它发出的 POST 属于同源请求 —— 必须放行，
 * 否则面板在别的设备上会静默变成只读的。
 */
app.use((req, res, next) => {
  const rawOrigin = req.get('origin');
  const allowedOrigin = normalizeAllowedOrigin(rawOrigin, req.get('host'));

  if (rawOrigin && !allowedOrigin) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({
        error: '拒绝跨站的状态变更请求：只允许本机或同源页面操作',
        origin: rawOrigin,
        hint: '如果这是从另一台设备打开面板时报的错，说明 Host 和 Origin 对不上'
          + '（常见于反向代理改写了 Host）。用 HOST=0.0.0.0 启动并直接访问'
          + ' http://<本机IP>:5500 即可。',
      });
    }
    // 读请求放行，但不回 ACAO —— 浏览器拿不到响应内容
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  }

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
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

// 使用手册。两个入口，各司其职：
//
//   /manual       → 跳到面板里渲染好的页面（给人读的）
//   /manual.md    → 原始的 markdown 源文件（给 curl / 编辑器 / 下载用）
//
// 但直接在地址栏打开 /manual.md 时，用户期望的是一个能读的页面，
// 而不是满屏的 # 和 |（浏览器对 text/markdown 只会当纯文本显示）。
// 所以这里做内容协商：请求头带 text/html（浏览器顶层导航的特征）就转到面板；
// fetch() 默认发 */*，因此仍然拿到源文件；想强制要源文件就加 ?raw=1。
//
// 手册按语言分成独立文件，和 frontend/src/locales/ 的结构保持一致：
//   manual.zh-CN.md / manual.en.md，用 ?lang=<语言代码> 选。
app.get('/manual', (req, res) => res.redirect('/#/manual'));

/**
 * 语言代码 → 文件名的**白名单**。
 *
 * 这个映射是必须的：`?lang=` 直接决定读磁盘上的哪个文件，如果拿它去拼路径，
 * 就成了一个任意文件读取漏洞（`?lang=../../../../etc/passwd`）。
 * 用查表的方式，用户输入永远只是"键"，取出来的"值"是我们写死的常量。
 */
const MANUAL_FILES = {
  'zh-CN': 'manual.zh-CN.md',
  en: 'manual.en.md',
};
const MANUAL_DEFAULT_LANG = 'zh-CN';

app.get('/manual.md', (req, res) => {
  const wantsRaw = req.query.raw === '1';
  const accept = String(req.get('accept') || '');
  if (!wantsRaw && accept.includes('text/html')) {
    return res.redirect('/#/manual');
  }

  const requested = String(req.query.lang || '');
  const lang = Object.prototype.hasOwnProperty.call(MANUAL_FILES, requested)
    ? requested
    : MANUAL_DEFAULT_LANG;

  const manualPath = path.join(__dirname, 'public', MANUAL_FILES[lang]);
  res.type('text/markdown; charset=utf-8');
  // 方便排查"为什么拿到的是另一种语言"
  res.setHeader('X-Manual-Lang', lang);
  return res.sendFile(manualPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).type('text/plain; charset=utf-8').send(`手册文件不存在：${MANUAL_FILES[lang]}`);
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
    + '<p>接口文档：<a href="/docs">/docs</a>　使用手册：<a href="/manual">/manual</a></p>',
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
