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
//
// 三个接口的版本判断逻辑共用 buildVersionDecision()，保证它们对同一份
// 数据给出一致的结论 —— 原实现里 /api/check 漏掉了 minVersion 的强制更新
// 判断，于是同一个客户端走不同接口会得到相反的答案。

const express = require('express');
const crypto = require('crypto');

/**
 * 比较两个版本号。
 *
 * 语义遵循 semver 的实用子集：
 *   * 点分数字段逐段比较，缺失的段按 0 补齐（所以 "1.0" 等价于 "1.0.0"，
 *     客户端报 1.0 时不会被无休止地要求更新）
 *   * 数字段用 BigInt 比较，避免超长版本号被双精度截断成"相等"
 *   * 构建元数据（+build）不参与比较
 *   * 预发布版本（-beta / -rc1）小于同号的正式版
 *
 * 原实现直接把段丢给 Number()，于是 '0-beta' 变成 NaN 走了字符串比较，
 * 得出 "1.0.0-beta > 1.0.0" —— 方向完全相反，导致预发布客户端拿不到
 * 本该有的强制更新。
 *
 * @returns {number} a<b 返回 -1，相等 0，a>b 返回 1
 */
function compareVersions(a, b) {
  const normalize = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    const withoutBuild = text.split('+')[0];
    const dashAt = withoutBuild.indexOf('-');
    const core = dashAt === -1 ? withoutBuild : withoutBuild.slice(0, dashAt);
    const pre = dashAt === -1 ? '' : withoutBuild.slice(dashAt + 1);
    return { core: core.split('.'), pre };
  };

  const pa = normalize(a);
  const pb = normalize(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i += 1) {
    const sa = pa.core[i] === undefined ? '0' : pa.core[i];
    const sb = pb.core[i] === undefined ? '0' : pb.core[i];
    if (sa === sb) continue;

    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      // 用 BigInt 而不是 Number：20 位的版本号用双精度会溢出成相等
      const va = BigInt(sa);
      const vb = BigInt(sb);
      if (va !== vb) return va < vb ? -1 : 1;
    } else {
      return sa < sb ? -1 : 1;
    }
  }

  // 主版本相同，比较预发布标识：有预发布的一侧更小
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre === pb.pre) return 0;

  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  const plen = Math.max(ia.length, ib.length);
  for (let i = 0; i < plen; i += 1) {
    const sa = ia[i];
    const sb = ib[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const va = BigInt(sa);
      const vb = BigInt(sb);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (na) {
      return -1; // semver：数字标识符优先级低于字母标识符
    } else if (nb) {
      return 1;
    } else {
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

/**
 * 版本判断的唯一实现。/api/version、/api/check、/api/manifest 都走这里，
 * 保证三条路径对同一份数据给出一致的结论。
 */
function buildVersionDecision({ manifest, query, hotUpdate }) {
  const currentVersion = query.current ? String(query.current) : null;
  const channel = String(query.channel || manifest.channel || hotUpdate.defaultChannel || 'default');

  // 语义比较，不是字符串严格相等：客户端报 "1.0" 而清单是 "1.0.0"
  // 时不应判定为需要更新（原实现会让客户端每次启动都被要求热更）。
  let needUpdate = !currentVersion || compareVersions(currentVersion, manifest.version) !== 0;
  let grayBlocked = false;

  // 灰度：命中灰度组的客户端才看得到新版本，其余维持现状
  if (hotUpdate.gray && hotUpdate.gray.enabled) {
    const selected = inGrayGroup(query.deviceId, Number(hotUpdate.gray.percent) || 0);
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

  return {
    platform: manifest.platform,
    channel,
    version: manifest.version,
    currentVersion,
    needUpdate,
    forceUpdate: Boolean(manifest.forceUpdate) || belowMin,
    belowMinVersion: belowMin,
    minVersion: manifest.minVersion,
    notice: manifest.notice,
    fileCount: manifest.fileCount,
    totalSize: manifest.totalSize,
    manifestUrl: `/api/manifest?platform=${encodeURIComponent(manifest.platform)}&channel=${encodeURIComponent(channel)}`,
    generatedAt: manifest.generatedAt,
    ...(grayBlocked ? { grayBlocked: true, grayPercent: hotUpdate.gray.percent } : {}),
  };
}

module.exports = function createApiRouter({ configManager, assetServer }) {
  const router = express.Router();

  /** 取平台参数，缺失时返回 400。 */
  function requirePlatform(req, res) {
    const platform = req.query.platform;
    if (!platform) {
      res.status(400).json({ error: '缺少 platform 参数，例如 ?platform=Android' });
      return null;
    }
    return String(platform);
  }

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
  router.get('/platforms', async (req, res, next) => {
    try {
      const names = assetServer.listPlatforms();
      const platforms = await Promise.all(names.map(async (name) => {
        const manifest = await assetServer.buildManifest(name);
        return {
          name,
          version: manifest ? manifest.version : null,
          fileCount: manifest ? manifest.fileCount : 0,
          totalSize: manifest ? manifest.totalSize : 0,
        };
      }));
      res.json({ assetRoot: assetServer.root(), platforms });
    } catch (err) {
      next(err);
    }
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
  router.get('/version', async (req, res, next) => {
    const platform = requirePlatform(req, res);
    if (!platform) return undefined;

    try {
      const manifest = await assetServer.buildManifest(platform);
      if (!manifest) {
        return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
      }
      const hotUpdate = configManager.get('hotUpdate') || {};
      return res.json(buildVersionDecision({ manifest, query: req.query, hotUpdate }));
    } catch (err) {
      return next(err);
    }
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
  router.get('/manifest', async (req, res, next) => {
    const platform = requirePlatform(req, res);
    if (!platform) return undefined;

    try {
      const manifest = await assetServer.buildManifest(platform);
      if (!manifest) {
        return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
      }
      return res.json(manifest);
    } catch (err) {
      return next(err);
    }
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
  router.get('/check', async (req, res, next) => {
    const platform = requirePlatform(req, res);
    if (!platform) return undefined;

    try {
      const manifest = await assetServer.buildManifest(platform);
      if (!manifest) {
        return res.status(404).json({ error: `平台不存在或没有资源目录：${platform}` });
      }
      const hotUpdate = configManager.get('hotUpdate') || {};
      // 复用同一个判断函数，保证与 /api/version 结论一致
      const decision = buildVersionDecision({ manifest, query: req.query, hotUpdate });

      return res.json({
        ...decision,
        // 不需要更新时就不必把整份清单发下去，省流量——真实服务端也会这么做
        manifest: decision.needUpdate ? manifest : undefined,
        files: decision.needUpdate ? manifest.files : [],
      });
    } catch (err) {
      return next(err);
    }
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
module.exports.buildVersionDecision = buildVersionDecision;
