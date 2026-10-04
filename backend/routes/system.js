// backend/routes/system.js
//
// 系统信息接口。目的是让使用者在界面上就能确认“我连的是哪份配置、
// 资产目录到底指到哪去了”——路径类问题在调试时最常见，
// 与其让人去翻代码，不如直接显示出来。

const express = require('express');
const os = require('os');

module.exports = function createSystemRouter({ configManager, assetServer }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/system:
   *   get:
   *     tags: [观测]
   *     summary: 运行时与路径信息
   *     responses:
   *       200: { description: 系统信息 }
   */
  router.get('/', (req, res) => {
    res.json({
      // 面板页脚会显示它，用来确认"我现在跑的到底是哪个版本"
      app: {
        name: require('../../package.json').name,
        version: require('../../package.json').version,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        env: process.env.NODE_ENV || 'development',
      },
      host: {
        hostname: os.hostname(),
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        osRelease: os.release(),
      },
      process: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
      },
      paths: {
        // 这几个路径是排查"资源找不到"时最需要确认的信息
        configFile: configManager.configPath,
        assetRoot: assetServer.root(),
        assetRootExists: require('fs').existsSync(assetServer.root()),
        storageRoot: require('../core/paths').storageRoot(),
        // 存储根是不是被环境变量挪走了。排查"我明明设了 HOT_UPDATE_STORAGE
        // 怎么没生效"时，一眼就能看出来。
        storageRootOverridden: Boolean(String(process.env.HOT_UPDATE_STORAGE || '').trim()),
      },
      server: configManager.get('server'),
      platforms: assetServer.listPlatforms(),
    });
  });

  return router;
};
