// backend/app.js
const express = require('express');
const path = require('path');
const serveIndex = require('serve-index');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const ConfigManager = require('./core/configManager');
const NetworkSimulator = require('./modules/networkSimulator');
const FaultInjector = require('./modules/faultInjector');
const requestPipeline = require('./middleware/requestPipeline');
const AssetServer = require('./modules/assetServer');
const createApiRouter = require('./routes/api');
const Logger = require('./modules/logger');
const loggerMiddleware = require('./middleware/loggerMiddleware');
const createLogRouter = require('./routes/logs');
const createControlRouter = require('./routes/control');
const createPresetsRouter = require('./routes/presets');
const createFavoritesRouter = require('./routes/favorites');
const createStatsRouter = require('./routes/stats');
const createSystemRouter = require('./routes/system');

const app = express();

// 同步加载配置
const configPath = path.join(__dirname, 'config.json');
const configManager = new ConfigManager(configPath);
const networkSimulator = new NetworkSimulator(configManager);
const faultInjector = new FaultInjector(configManager);
const assetServer = new AssetServer(configManager);
const logger = new Logger();

app.locals.configManager = configManager;
app.locals.logger = logger;

// 静态托管（旧项目中托管了 web 目录，按需保留或改为 dist）
app.use(express.static(path.join(__dirname, 'web')));

// 中间件
app.use(express.json());
app.use(loggerMiddleware(logger));
app.use('/api/logs', createLogRouter(logger));
app.use('/api/control', createControlRouter(configManager));
app.use('/api/presets', createPresetsRouter(configManager));
app.use('/api/favorites', createFavoritesRouter());
app.use('/api/stats', createStatsRouter(logger));
app.use('/api/system', createSystemRouter(configManager));
app.use(requestPipeline({ networkSimulator, faultInjector }));

// API 路由
app.use('/api', createApiRouter(configManager));

// Swagger
const swaggerSpec = swaggerJsdoc({
    definition: {
        openapi: '3.0.0',
        info: { title: 'Hot Update Simulator API', version: '1.0.0' },
    },
    apis: ['./routes/*.js'],
});
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 资产服务
app.use('/assets', (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (!parts.length) return res.status(404).end();
    req.params.platform = parts.shift();
    req.params.subPath = parts.join('/');
    assetServer.handle(req, res);
});

// 资源目录浏览（仅开发环境）
if (process.env.NODE_ENV !== 'production') {
    const publicDir = path.join(__dirname, configManager.get().server.publicDir || 'public');
    app.use('/browse', express.static(publicDir), serveIndex(publicDir, { icons: true }));
}

// 提供帮助文档 Markdown 文件
app.get('/manual.md', (req, res) => {
    const manualPath = path.join(__dirname, 'public', 'manual.md');
    res.sendFile(manualPath);
});

// 全局错误处理中间件
app.use((err, req, res, next) => {
    logger.log({ error: err.message, stack: err.stack });
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = app;