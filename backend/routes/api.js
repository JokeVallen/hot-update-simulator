// backend/routes/api.js
//
// 热更业务接口。这一组是给 U3D 客户端调的，也是受网络模拟/故障注入
// 影响的那部分（在 app.js 里它的挂载位置在 requestPipeline 之后）。
//
// 典型客户端流程：
//   1. GET /api/version?platform=Android&channel=default&current=1.0.0
//      → 判断要不要更新，拿 manifestUrl
//   2. GET /api/manifest?platform=Android&channel=default
//      → 拿到文件清单（路径/大小/md5/下载地址）
//   3. GET /assets/Android/xxx.ab
//      → 逐个下载，支持 Range 续传
//
// 也可以直接调 /api/check 一步拿到 1+2 的结果。

const express = require('express');
const crypto = require('crypto');

/**
 * 比较两个版本号。
 * 支持 "1.2.3" 这种点分数字，数字段按数值比、非数字段按字符串比。
 * 支持不了的格式退回字符串比较，不会抛异常。
 * @returns {number} a<b 返回 -1，相等 0，a>b 返回 1
 */
function compareVersions(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i += 1) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;

    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 判断某个设备是否落在灰度分组里。
 * 用设备标识的 md5 取模，所以同一个设备每次的结果都一样——
 * 灰度必须稳定，否则客户端会一会儿看到新版本一会儿看到旧版本。
 */
function inGrayGroup(deviceId, percent) {
  if (!deviceId) return true; // 没给设备标识就不拦，避免全部被挡
  const bucket = crypto.createHash('md5').update(String(deviceId)).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}

module.exports = function createApiRouter({ configManager, assetServer }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/health:
   *   get:
   *     tags: [热更接口]
   *     summary: 健康检查
   *     responses:
   *       200: { description: 服务正常 }
   */
  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * @openapi
   * /api/platforms:
   *   get:
   *     tags: [热更接口]
   *     summary: 列出所有可用平台
   *     responses:
   *       200: { description: 平台列表 }
   */
  router.get('/platforms', (req, res) => {
    const platforms = assetServer.listPlatforms().map((name) => {
      const manifest = assetServer.buildManifest(name);
      return {
        name,
        version: manifest ? manifest.version : null,
        fileCount: manifest ? manifest.fileCount : 0,
        totalSize: manifest ? manifest.totalSize : 0,
      };
    });
    res.json({ assetRoot: assetServer.root(), platforms });
  });

  /**
   * @openapi
   * /api/version:
   *   get:
   *     tags: [热更接口]
   *     summary: 查询版本，判断是否需要更新
   *     parameters:
   *       - { in: query, name: platform, required: true, schema: { type: string }, description: 平台，如 Android }
   *       - { in: query, name: channel, schema: { type: string }, description: 渠道，默认取配置里的 defaultChannel }
   *       - { in: query, name: current, schema: { type: string }, description: 客户端当前版本 }
   *       - { in: query, name: deviceId, schema: { type: string }, description: 设备唯一标识，用于灰度分组 }
   *     responses:
   *       200: { description: 版本信息 }
   *       400: { description: 缺少 platform }
   *       404: { description: 平台不存在 }
   */
  router.get('/version', (req, res) => {
    const platform = req.query.platform;
    if (!platform) {
      return res.status(400).json({ error: '缺少 platform 参数，例如 ?platform=Android' });
    }

    const manifest = assetServer.buildManifest(String(platform));
    if (!manifest) {
      return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
    }

    const hotUpdate = configManager.get('hotUpdate') || {};
    const channel = String(req.query.channel || manifest.channel || hotUpdate.defaultChannel || 'default');
    const currentVersion = req.query.current ? String(req.query.current) : null;

    let needUpdate = currentVersion !== manifest.version;
    let grayBlocked = false;

    // 灰度：命中灰度组的客户端才看得到新版本，其余维持现状
    if (hotUpdate.gray && hotUpdate.gray.enabled) {
      const selected = inGrayGroup(req.query.deviceId, Number(hotUpdate.gray.percent) || 0);
      if (!selected) {
        grayBlocked = true;
        needUpdate = false;
      }
    }

    // 低于最低支持版本就强制更新
    const belowMin = Boolean(
      manifest.minVersion
      && currentVersion
      && compareVersions(currentVersion, manifest.minVersion) < 0,
    );

    res.json({
      platform,
      channel,
      version: manifest.version,
      currentVersion,
      needUpdate,
      forceUpdate: Boolean(manifest.forceUpdate) || belowMin,
      minVersion: manifest.minVersion,
      notice: manifest.notice,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
      manifestUrl: `/api/manifest?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`,
      generatedAt: manifest.generatedAt,
      ...(grayBlocked ? { grayBlocked: true, grayPercent: hotUpdate.gray.percent } : {}),
    });
  });

  /**
   * @openapi
   * /api/manifest:
   *   get:
   *     tags: [热更接口]
   *     summary: 获取文件清单
   *     parameters:
   *       - { in: query, name: platform, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 清单 }
   *       400: { description: 缺少 platform }
   *       404: { description: 平台不存在 }
   */
  router.get('/manifest', (req, res) => {
    const platform = req.query.platform;
    if (!platform) {
      return res.status(400).json({ error: '缺少 platform 参数，例如 ?platform=Android' });
    }

    const manifest = assetServer.buildManifest(String(platform));
    if (!manifest) {
      return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
    }

    res.json(manifest);
  });

  /**
   * @openapi
   * /api/check:
   *   get:
   *     tags: [热更接口]
   *     summary: 一步拿到版本判断和完整清单（省一次往返）
   *     parameters:
   *       - { in: query, name: platform, required: true, schema: { type: string } }
   *       - { in: query, name: current, schema: { type: string } }
   *       - { in: query, name: deviceId, schema: { type: string } }
   *     responses:
   *       200: { description: 版本信息 + 清单 }
   */
  router.get('/check', (req, res) => {
    const platform = req.query.platform;
    if (!platform) {
      return res.status(400).json({ error: '缺少 platform 参数，例如 ?platform=Android' });
    }

    const manifest = assetServer.buildManifest(String(platform));
    if (!manifest) {
      return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
    }

    const hotUpdate = configManager.get('hotUpdate') || {};
    const currentVersion = req.query.current ? String(req.query.current) : null;
    let needUpdate = currentVersion !== manifest.version;

    if (hotUpdate.gray && hotUpdate.gray.enabled) {
      if (!inGrayGroup(req.query.deviceId, Number(hotUpdate.gray.percent) || 0)) {
        needUpdate = false;
      }
    }

    res.json({
      version: manifest.version,
      currentVersion,
      needUpdate,
      forceUpdate: Boolean(manifest.forceUpdate),
      notice: manifest.notice,
      // 不需要更新时就不必把整份清单发下去，省流量——真实服务端也会这么做
      manifest: needUpdate ? manifest : undefined,
      files: needUpdate ? manifest.files : [],
    });
  });

  /**
   * @openapi
   * /api/manifest/refresh:
   *   post:
   *     tags: [热更接口]
   *     summary: 清掉清单缓存，让新上传的包立刻生效
   *     parameters:
   *       - { in: query, name: platform, schema: { type: string }, description: 不传则清全部 }
   *     responses:
   *       200: { description: 已刷新 }
   */
  router.post('/manifest/refresh', (req, res) => {
    const platform = req.query.platform ? String(req.query.platform) : null;
    assetServer.invalidateManifest(platform);
    res.json({ ok: true, refreshed: platform || 'all' });
  });

  return router;
};

module.exports.compareVersions = compareVersions;
module.exports.inGrayGroup = inGrayGroup;
