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
const { protocolMeta, negotiate } = require('../core/protocol');

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
 * 判断某个设备是否落在灰度分组里（按 deviceId 百分比）。
 * 用设备标识的 md5 取模，所以同一个设备每次的结果都一样——
 * 灰度必须稳定，否则客户端会一会儿看到新版本一会儿看到旧版本。
 */
function inGrayGroup(deviceId, percent) {
  if (!deviceId) return true; // 没给设备标识就不拦，避免全部被挡
  const bucket = crypto.createHash('md5').update(String(deviceId)).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}

/**
 * 灰度规则求值。
 *
 * 为什么从"只有 deviceId 百分比"扩展成规则列表：
 * 真实灰度不只是按比例分流 —— 还要能指定白名单、限定主包版本区间、
 * 只对某个渠道或地区生效。只有百分比的话，"先给内部同学开"这种事都做不了。
 *
 * 语义（最容易搞混的地方，写清楚）：
 *   * **一条规则内**：写了的条件之间是 **AND**（都满足才算命中）
 *   * **规则之间**：命中**任意一条**即进入灰度组（OR）
 *
 * 所以"白名单无条件进 + 10% 随机分流"要写成**两条**规则；
 * 写成一条会变成"白名单里且在那 10% 里"，不是想要的语义。
 *
 * @returns {{selected:boolean, matchedRule:string|null, reason:string}}
 */
function evaluateGrayRules(gray, ctx) {
  const rules = Array.isArray(gray.rules) ? gray.rules : [];

  // 兼容旧配置：顶层 percent 等价于一条"只看百分比"的规则。
  // 有了 rules 之后它是冗余的，但旧配置不该因为升级就失效。
  const legacy = [];
  if (!rules.length && Number(gray.percent) > 0) {
    legacy.push({ name: 'percent', percent: Number(gray.percent) });
  }

  const all = [...rules, ...legacy];
  if (!all.length) {
    // 开了灰度却没给任何规则：不做筛选。
    // 此时"挡住所有人"比"灰度没生效"更糟 —— 后者至少功能可用。
    return { selected: true, matchedRule: null, reason: 'no-rules' };
  }

  for (const rule of all) {
    if (rule.enabled === false) continue;

    // 白名单命中就直接算这条规则成立，不再看同一条里的其它条件 ——
    // "把某人加进白名单"的意图就是"无条件给他"，再叠加百分比很反直觉。
    if (Array.isArray(rule.devices) && rule.devices.length) {
      const id = ctx.deviceId ? String(ctx.deviceId) : '';
      if (id && rule.devices.map(String).includes(id)) {
        return { selected: true, matchedRule: rule.name || 'devices', reason: 'whitelisted' };
      }
      continue; // 白名单没命中，整条规则不成立
    }

    if (Array.isArray(rule.channels) && rule.channels.length
      && !rule.channels.map(String).includes(String(ctx.channel))) continue;
    if (Array.isArray(rule.platforms) && rule.platforms.length
      && !rule.platforms.map(String).includes(String(ctx.platform))) continue;
    if (Array.isArray(rule.regions) && rule.regions.length) {
      // 地区由客户端 ?region= 声明；没声明就不匹配带地域条件的规则
      if (!ctx.region || !rule.regions.map(String).includes(String(ctx.region))) continue;
    }
    // 版本区间：没报主包版本时**不敢认定满足** ——
    // 乐观放行会让本该挡住的设备拿到新版本
    if (rule.minAppVersion) {
      if (!ctx.appVersion) continue;
      if (compareVersions(String(ctx.appVersion), String(rule.minAppVersion)) < 0) continue;
    }
    if (rule.maxAppVersion) {
      if (!ctx.appVersion) continue;
      if (compareVersions(String(ctx.appVersion), String(rule.maxAppVersion)) > 0) continue;
    }
    if (Number(rule.percent) > 0 && !inGrayGroup(ctx.deviceId, Number(rule.percent))) continue;

    return { selected: true, matchedRule: rule.name || 'rule', reason: 'matched' };
  }

  return { selected: false, matchedRule: null, reason: 'no-rule-matched' };
}

/**
 * 版本判断的唯一实现。/api/version、/api/check、/api/manifest 都走这里，
 * 保证三条路径对同一份数据给出一致的结论。
 */
/**
 * 代码热更轨道的版本判断。
 *
 * 和资源轨道比，它多了**兼容性门禁**。这是 HybridCLR 时代最容易出的事故：
 * 热更 DLL 引用了主包没做 AOT 泛型生成的类型，编译期毫无征兆、运行期才炸，
 * 而且报错信息离根因很远。所以真实管线会声明"这份代码更新要求主包 >= X"。
 *
 * ⚠️ `compatible` / `aotMatch` 在**没拿到判断依据**时返回 null，而不是 true。
 * "没检查"和"检查通过"是两件不同的事 —— 客户端必须能区分，
 * 否则一个没传 appVersion 的旧客户端会被误告知"兼容"。
 */
function buildCodeDecision({ code, query, appVersion, channel, manifestId }) {
  if (!code) return null;

  const codeCurrent = query.codeCurrent ? String(query.codeCurrent) : null;
  const needUpdate = !codeCurrent || compareVersions(codeCurrent, code.version) !== 0;

  const compatible = (code.minAppVersion && appVersion)
    ? compareVersions(appVersion, code.minAppVersion) >= 0
    : null;

  const clientAotHash = query.aotHash ? String(query.aotHash) : null;
  const aotMatch = (code.aotHash && clientAotHash)
    ? code.aotHash === clientAotHash
    : null;

  return {
    version: code.version,
    currentVersion: codeCurrent,
    needUpdate,
    forceUpdate: Boolean(code.forceUpdate),
    minAppVersion: code.minAppVersion,
    appVersion: appVersion || null,
    compatible,
    // 为 true 表示这份代码更新光靠热更换不上去，必须先升级主包。
    // 单列一个字段是为了让客户端不必自己去推导"compatible === false 意味着什么"。
    requiresAppUpdate: compatible === false,
    aotHash: code.aotHash,
    aotMatch,
    notice: code.notice,
    dir: code.dir,
    fileCount: code.fileCount,
    totalSize: code.totalSize,
    manifestUrl: `/api/manifest?platform=${encodeURIComponent(code.platform)}`
      + `&channel=${encodeURIComponent(channel)}&track=code`
      + `&expectId=${encodeURIComponent(manifestId || '')}`,
  };
}

function buildVersionDecision({ manifest, query, hotUpdate }) {
  const currentVersion = query.current ? String(query.current) : null;
  const channel = String(query.channel || manifest.channel || hotUpdate.defaultChannel || 'default');
  const appVersion = query.appVersion ? String(query.appVersion) : null;

  // 语义比较，不是字符串严格相等：客户端报 "1.0" 而清单是 "1.0.0"
  // 时不应判定为需要更新（原实现会让客户端每次启动都被要求热更）。
  let needUpdate = !currentVersion || compareVersions(currentVersion, manifest.version) !== 0;

  // 灰度：命中灰度组的客户端才看得到新版本，其余维持现状。
  // 规则求值见 evaluateGrayRules —— 一条规则内是 AND，规则之间是 OR。
  let gray = null;
  if (hotUpdate.gray && hotUpdate.gray.enabled) {
    gray = evaluateGrayRules(hotUpdate.gray, {
      deviceId: query.deviceId,
      channel,
      platform: manifest.platform,
      region: query.region,
      appVersion,
    });
    if (!gray.selected) needUpdate = false;
  }

  // 低于最低支持版本就强制更新
  const belowMin = Boolean(
    manifest.minVersion
    && currentVersion
    && compareVersions(currentVersion, manifest.minVersion) < 0,
  );

  return {
    ...protocolMeta({ hashAlgorithms: manifest.hashAlgorithms }),
    ...negotiate(query.protocol),
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
    // 清单身份。客户端在第 2 步（取清单）回传它，就能发现
    // "第 1 步和第 2 步之间有人改了配置"，而不是下到一半才发现不对。
    manifestId: manifest.manifestId,
    manifestUrl: `/api/manifest?platform=${encodeURIComponent(manifest.platform)}`
      + `&channel=${encodeURIComponent(channel)}&expectId=${encodeURIComponent(manifest.manifestId || '')}`,
    generatedAt: manifest.generatedAt,
    // 代码热更轨道；平台没配 code 块时为 null（客户端据此知道这个平台没有代码热更）
    code: buildCodeDecision({
      code: manifest.code,
      query,
      appVersion,
      // 渠道必须带上：2.0.0 起渠道决定读哪个目录，漏了会让 beta 用户
      // 照着这个 URL 拿到正式渠道的代码包 —— 而且不报错。
      channel,
      // 清单身份：manifestId 覆盖资源文件、代码文件、代码元信息、渠道与版本，
      // 所以代码轨道复用它是正确的，不需要单独的身份。
      manifestId: manifest.manifestId,
    }),
    // 灰度结果。命中与否都给出，并把命中的是哪条规则一并告知 ——
    // "为什么我没进灰度"是最常见的问题，不给依据就只能靠猜。
    ...(gray
      ? {
        gray: {
          enabled: true,
          selected: gray.selected,
          matchedRule: gray.matchedRule,
          reason: gray.reason,
        },
        ...(gray.selected ? {} : { grayBlocked: true }),
      }
      : {}),
  };
}

/**
 * 清单身份校验，用于消除「版本接口」和「清单接口」之间的竞态。
 *
 * 客户端典型流程是两步：先问版本、再取清单。两步之间如果有人改了配置，
 * 客户端会拿到新版本的文件列表，却以为自己在做旧版本的更新 ——
 * 而且**不报错**，只是下到一半发现对不上。
 *
 * 支持两种固定方式：
 *   ?expectId=<manifestId>   —— 精确匹配清单身份（推荐）
 *   ?expectVersion=<version> —— 只比对版本号（客户端实现更简单）
 *
 * 对不上就返回 409，并把当前的真实身份带上，客户端可以直接重来。
 *
 * @returns {boolean} 校验通过返回 true；已响应 409 则返回 false
 */
function checkManifestPin(manifest, query, res) {
  const expectId = query.expectId ? String(query.expectId) : null;
  const expectVersion = query.expectVersion ? String(query.expectVersion) : null;
  if (!expectId && !expectVersion) return true;

  const idOk = !expectId || expectId === manifest.manifestId;
  const versionOk = !expectVersion || compareVersions(expectVersion, manifest.version) === 0;
  if (idOk && versionOk) return true;

  res.status(409).json({
    error: '清单已经变了：你请求的这一版已经不在服务器上',
    hint: '重新调一次 /api/version 再走一遍流程。'
      + '竞态只会在"取版本"和"取清单"之间有人改配置时发生，'
      + '这也是真实热更服务端会遇到的问题。',
    ...protocolMeta({ hashAlgorithms: manifest.hashAlgorithms }),
    expected: { manifestId: expectId, version: expectVersion },
    actual: {
      platform: manifest.platform,
      version: manifest.version,
      manifestId: manifest.manifestId,
      generatedAt: manifest.generatedAt,
    },
  });
  return false;
}

/** 资源清单里只带代码轨道的摘要，不重复整份文件列表。要下代码就 ?track=code。 */
function withCodeSummary(manifest) {
  if (!manifest.code) return manifest;
  const code = { ...manifest.code };
  delete code.files;
  return { ...manifest, code };
}

module.exports = function createApiRouter({ configManager, assetServer }) {
  const router = express.Router();

  /**
   * 构建清单，并把渠道带进去。
   *
   * 渠道必须一路传到 assetServer：它决定读哪个目录，所以也决定缓存键。
   * 漏传的表现是"请求 beta 却拿到 default 的内容"，而且不报错。
   */
  function manifestFor(platform, req) {
    return assetServer.buildManifest(platform, {
      channel: req.query.channel ? String(req.query.channel) : '',
    });
  }

  /** 平台或渠道不存在时，给出能自助排查的错误（而不是一句"404"）。 */
  function notFoundBody(platform, req) {
    const wanted = req.query.channel ? String(req.query.channel) : null;
    const channels = assetServer.listChannels(platform);
    if (channels.length) {
      return {
        error: wanted
          ? `平台 ${platform} 下没有渠道 "${wanted}"`
          : `平台 ${platform} 不存在或没有资源目录`,
        availableChannels: channels,
        hint: wanted
          ? `把 ?channel= 改成 ${channels.join(' / ')} 之一，或建一个名为 "${wanted}" 的目录`
          : '检查资产目录，或在配置里改 server.assetDir',
      };
    }
    return {
      error: `平台不存在或没有资源目录：${platform}`,
      availablePlatforms: assetServer.listPlatforms(),
    };
  }

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
        const channels = assetServer.listChannels(name);
        const manifest = await assetServer.buildManifest(name, { channel: '' });
        return {
          name,
          // 实际有内容的渠道。分渠道布局下会有多个；平铺布局下只有默认渠道。
          channels,
          version: manifest ? manifest.version : null,
          fileCount: manifest ? manifest.fileCount : 0,
          totalSize: manifest ? manifest.totalSize : 0,
          // 代码热更轨道的版本是独立的，分开列出来
          codeVersion: manifest && manifest.code ? manifest.code.version : null,
          codeFileCount: manifest && manifest.code ? manifest.code.fileCount : 0,
        };
      }));
      res.json({
        assetRoot: assetServer.root(),
        // 配置里声明了哪些渠道名。**只有出现在这里的名字才会被当成渠道目录**，
        // 所以平铺布局下的 bundles/、dll/ 不会被误认。
        configuredChannels: assetServer.channels(),
        defaultChannel: assetServer.defaultChannel(),
        platforms,
      });
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
   *       - { in: query, name: current, schema: { type: string }, description: 客户端当前的资源版本 }
   *       - { in: query, name: deviceId, schema: { type: string }, description: 设备唯一标识，用于灰度分组 }
   *       - { in: query, name: codeCurrent, schema: { type: string }, description: 客户端当前的代码版本（独立于资源版本） }
   *       - { in: query, name: appVersion, schema: { type: string }, description: 已安装主包的版本，用于判断代码更新是否兼容（AOT 元数据门禁） }
   *       - { in: query, name: aotHash, schema: { type: string }, description: 客户端算出的 AOT 元数据指纹，与服务器声明的不一致说明不兼容 }
   *     responses:
   *       200: { description: 版本信息 }
   *       400: { description: 缺少 platform }
   *       404: { description: 平台不存在 }
   */
  router.get('/version', async (req, res, next) => {
    const platform = requirePlatform(req, res);
    if (!platform) return undefined;

    try {
      const manifest = await manifestFor(platform, req);
      if (!manifest) {
        return res.status(404).json(notFoundBody(platform, req));
      }
      const hotUpdate = configManager.get('hotUpdate') || {};
      return res.json(buildVersionDecision({ manifest, query: req.query, hotUpdate }));
    } catch (err) {
      return next(err);
    }
  });

  /**
   * @openapi
   * /api/protocol:
   *   get:
   *     tags: [热更接口]
   *     summary: 协议版本与能力声明（不需要 platform，客户端启动时先问这个）
   *     responses:
   *       200: { description: protocolVersion / capabilities / hashAlgorithms }
   */
  router.get('/protocol', async (req, res, next) => {
    try {
      const manifest = null; // 不依赖任何平台
      void manifest;
      const hotUpdate = configManager.get('hotUpdate') || {};
      return res.json({
        ...protocolMeta({
          hashAlgorithms: assetServer.hashAlgorithms(),
          // 配置里声明的渠道，供客户端校验自己传的 channel 是否被认识
          channels: hotUpdate.channels || [],
          defaultChannel: hotUpdate.defaultChannel || 'default',
        }),
        ...negotiate(req.query.protocol),
        serverVersion: require('../../package.json').version,
        assetRoot: assetServer.root(),
      });
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
   *       - { in: query, name: track, schema: { type: string, enum: [resource, code] }, description: 取哪条轨道，默认 resource。code 需要平台在 manifest.json 里配了 code 块 }
   *       - { in: query, name: expectId, schema: { type: string }, description: 期望的 manifestId。对不上返回 409，用于消除与 /api/version 之间的竞态 }
   *       - { in: query, name: expectVersion, schema: { type: string }, description: 期望的版本号，比 expectId 宽松，客户端实现更简单 }
   *     responses:
   *       200: { description: 清单 }
   *       400: { description: 缺少 platform }
   *       404: { description: 平台不存在，或该平台没有代码热更轨道 }
   *       409: { description: 清单已变（expectId / expectVersion 对不上） }
   */
  router.get('/manifest', async (req, res, next) => {
    const platform = requirePlatform(req, res);
    if (!platform) return undefined;

    try {
      const manifest = await manifestFor(platform, req);
      if (!manifest) {
        return res.status(404).json(notFoundBody(platform, req));
      }

      // 竞态校验放在取轨道之前：身份不对的话，无论是资源还是代码轨道都不该给。
      if (!checkManifestPin(manifest, req.query, res)) return undefined;

      const track = String(req.query.track || 'resource').toLowerCase();
      if (track === 'code') {
        if (!manifest.code) {
          return res.status(404).json({
            error: `平台 ${platform} 没有代码热更轨道：manifest.json 里缺少 code 块，或代码目录不存在`,
          });
        }
        const { files, ...code } = manifest.code;
        return res.json({
          ...protocolMeta({ hashAlgorithms: manifest.hashAlgorithms }),
          ...code,
          track: 'code',
          manifestId: manifest.manifestId,
          generatedAt: manifest.generatedAt,
          files,
        });
      }

      // 资源轨道：只带代码轨道的摘要，不重复整份文件列表
      return res.json({
        ...protocolMeta({ hashAlgorithms: manifest.hashAlgorithms }),
        ...withCodeSummary(manifest),
        track: 'resource',
      });
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
      const manifest = await manifestFor(platform, req);
      if (!manifest) {
        return res.status(404).json(notFoundBody(platform, req));
      }
      const hotUpdate = configManager.get('hotUpdate') || {};
      // 复用同一个判断函数，保证与 /api/version 结论一致
      const decision = buildVersionDecision({ manifest, query: req.query, hotUpdate });

      return res.json({
        ...decision,
        // 不需要更新时就不必把整份清单发下去，省流量——真实服务端也会这么做
        manifest: decision.needUpdate ? withCodeSummary(manifest) : undefined,
        files: decision.needUpdate ? manifest.files : [],
        // 代码轨道要更的话也一并给出，保持"一次往返"的初衷
        codeManifest: decision.code && decision.code.needUpdate ? manifest.code : undefined,
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
