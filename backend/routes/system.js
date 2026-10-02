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
        // 这两个路径是排查“资源找不到”时最需要确认的信息
        configFile: configManager.configPath,
        assetRoot: assetServer.root(),
        assetRootExists: require('fs').existsSync(assetServer.root()),
        storageRoot: require('../utils/jsonStore').STORAGE_ROOT,
      },
      server: configManager.get('server'),
      platforms: assetServer.listPlatforms(),
    });
  });

  return router;
};
