// backend/routes/presets.js
//
// 预置方案（preset）：把“一套网络参数 + 一组故障规则”打包命名，一键切换。
//
// 内置方案写在代码里（BUILTIN_PRESETS），用户自己存的放在 storage/presets.json。
// 两者分开的好处：以后加新的内置方案不会覆盖用户存的东西。
//
// 这里的方案是按“U3D 热更客户端真正会踩的坑”设计的，每个都对应一类
// 必须在真机上扛住的失败场景。

const express = require('express');
const JsonStore = require('../utils/jsonStore');

const store = new JsonStore(JsonStore.storagePath('presets.json'), { custom: [] });

/** 常用故障规则的快捷构造。 */
function rule(id, name, type, match, action = {}) {
  return {
    id,
    name,
    enabled: true,
    probability: 1,
    maxHits: 0,
    match: {
      method: match.method || 'GET',
      pathPrefix: match.pathPrefix || '',
      // 用 glob 而不是正则：任意正则会被用在每个请求的匹配上，
      // 一个灾难性回溯的模式就能把单线程的 Node 挂死（详见 core/faultRule.js）
      pathGlob: match.pathGlob || '',
      platform: match.platform || '',
    },
    action: {
      type,
      status: action.status || 500,
      delayMs: action.delayMs || 0,
      ratio: action.ratio === undefined ? 0.5 : action.ratio,
      body: action.body || '',
    },
  };
}

const NO_NETWORK = {
  enabled: false,
  offline: false,
  latencyMs: 0,
  jitterMs: 0,
  bandwidthKbps: 0,
  packetLossRate: 0,
};

/**
 * 内置方案的英文文案。
 *
 * 为什么单独放一张表，而不是把 nameEn / descriptionEn 塞进每个方案对象里：
 *   1. 中文是这个工具的主语言，定义处保持清爽，改参数时不用在两种语言之间来回跳；
 *   2. 缺翻译时能自然地回退到中文，不用每处都写兜底；
 *   3. 两份文案放在一起对照，比散在 200 行里的成对字段更容易检查。
 *
 * API 会**同时**返回中英两套（name / nameEn），由前端按当前语言挑。
 * 这样切语言不需要重新请求，也不需要后端知道前端选了什么语言。
 */
const BUILTIN_EN = {
  ideal: {
    name: 'Ideal network',
    description: 'All simulation off — use this to confirm the baseline works.',
  },
  'wifi-good': {
    name: 'Good WiFi',
    description: '50ms latency, slight jitter, no bandwidth limit. Reference baseline.',
  },
  '4g-normal': {
    name: 'Typical 4G',
    description: '150ms latency, 60ms jitter, ~2Mbps. What you see on a city mobile network.',
  },
  '3g-weak': {
    name: 'Weak 3G',
    description: '400ms latency, 150ms jitter, ~400Kbps. For testing download progress and chunked loading.',
  },
  'extreme-weak': {
    name: 'Extremely weak',
    description: '1.2s latency, 500ms jitter, ~100Kbps, 5% packet loss. The floor for timeouts and resume.',
  },
  'packet-loss-20': {
    name: '20% packet loss',
    description: 'One in five requests gets its connection killed. For testing automatic retry and backoff.',
  },
  'server-down': {
    name: 'Server down',
    description: 'Every connection is reset (not a 503). Tests telling "cannot connect" apart from "server returned an error".',
  },
  'abort-download': {
    name: 'Abort mid-download',
    description: 'Kills the connection at 50% of an asset. Tests whether resume (Range) really continues where it stopped.',
  },
  'corrupt-asset': {
    name: 'Corrupted asset',
    description: 'Correct length, damaged content. Tests whether md5 is actually verified — without it you load garbage.',
  },
  'truncate-asset': {
    name: 'Length mismatch',
    description: 'Declares a full length, sends less, then closes cleanly. Tests detection of a premature end.',
  },
  'api-500': {
    name: 'Version API 500',
    description: 'Version lookup always returns 500. Tests the client message and fallback for server errors.',
  },
  'retry-then-ok': {
    name: 'Fails twice, then works',
    description: 'The version API returns 500 twice, then succeeds. Verifies retry really happens and respects its limit.',
  },
  'api-timeout': {
    name: 'Version API timeout',
    description: 'The version API never responds. Tests whether the client sets a sane timeout.',
  },
  'empty-manifest': {
    name: 'Empty manifest',
    description: 'The manifest API returns 200 with an empty body. Tests that empty manifests/files do not crash the client.',
  },
  'slow-header': {
    name: 'Slow response headers',
    description: 'Headers arrive after 5 seconds. Tests whether connect and read timeouts are configured separately.',
  },
  'weak-plus-abort': {
    name: 'Weak link + abort (combo)',
    description: 'Weak 3G stacked with a mid-download abort. What the real internet looks like — use it for final robustness sign-off.',
  },
  'slow-then-abort': {
    name: 'Slow response, then abort (composite)',
    description: 'Headers delayed 5s, then the connection is killed mid-download. Reproduces the most common production failure chain: wait too long → retry → the retry dies partway. No single rule can express this combination.',
  },
};

/**
 * 内置故障规则的英文名与响应体。
 *
 * 规则名和 action.body 在「应用方案」时会**落盘**成配置里的一条规则，
 * 所以它们不像方案名称那样能随时切换 —— 必须在应用的那一刻就定下语言。
 * 因此 apply 接口接受 ?lang=，在这里取一次。
 */
const RULE_EN = {
  'abort-assets': { name: 'Abort mid-download' },
  'corrupt-assets': { name: 'Corrupted content' },
  'truncate-assets': { name: 'Length mismatch' },
  'version-500': { name: 'Version API 500', body: 'Simulated: version service unavailable' },
  'version-retry': { name: 'Version API fails twice', body: 'Simulated: temporary failure' },
  'version-timeout': { name: 'Version API timeout' },
  'manifest-empty': { name: 'Empty manifest' },
  'slow-version': { name: 'Slow version headers' },
  'combo-abort': { name: 'Abort under a weak link' },
  'slow-then-abort-rule': { name: 'Slow response, then abort' },
};

/**
 * 给方案补上英文文案。
 * 不做深拷贝：这两张表都是常量，不会被改动，直接挂引用的开销更小。
 * @param {object} preset
 * @param {'zh'|'en'} [lang] 应用方案时用它决定规则名和响应体用哪种语言
 */
function localizePreset(preset, lang = 'zh') {
  if (!preset) return preset;
  const en = BUILTIN_EN[preset.id];
  const out = { ...preset };
  if (en) {
    out.nameEn = en.name;
    out.descriptionEn = en.description;
  }

  if (lang === 'en' && out.fault && Array.isArray(out.fault.rules)) {
    out.fault = {
      ...out.fault,
      rules: out.fault.rules.map((r) => {
        const t = RULE_EN[r.id];
        if (!t) return r;
        return {
          ...r,
          name: t.name || r.name,
          action: { ...r.action, ...(t.body ? { body: t.body } : {}) },
        };
      }),
    };
  }

  return out;
}

/**
 * 内置场景方案。
 * 每条 description 说明它到底在测客户端的哪个能力——
 * 这样打开界面就知道该用哪个，不用去猜。
 */
const BUILTIN_PRESETS = [
  {
    id: 'ideal',
    name: '理想网络',
    description: '关闭所有模拟，用于确认基线功能正常。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: { enabled: false, rules: [] },
  },
  {
    id: 'wifi-good',
    name: 'WiFi 良好',
    description: '50ms 延迟、轻微抖动、不限速。基准对照组。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, latencyMs: 50, jitterMs: 15, bandwidthKbps: 20000 },
    fault: { enabled: false, rules: [] },
  },
  {
    id: '4g-normal',
    name: '4G 一般',
    description: '150ms 延迟、抖动 60ms、约 2Mbps。城市移动网络常见水平。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, latencyMs: 150, jitterMs: 60, bandwidthKbps: 2000 },
    fault: { enabled: false, rules: [] },
  },
  {
    id: '3g-weak',
    name: '3G 弱网',
    description: '400ms 延迟、抖动 150ms、约 400Kbps。测下载进度条和分段加载。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, latencyMs: 400, jitterMs: 150, bandwidthKbps: 400 },
    fault: { enabled: false, rules: [] },
  },
  {
    id: 'extreme-weak',
    name: '极端弱网',
    description: '1.2s 延迟、抖动 500ms、约 100Kbps、丢包 5%。测超时和断点续传的下限。',
    builtin: true,
    network: {
      ...NO_NETWORK,
      enabled: true,
      latencyMs: 1200,
      jitterMs: 500,
      bandwidthKbps: 100,
      packetLossRate: 0.05,
    },
    fault: { enabled: false, rules: [] },
  },
  {
    id: 'packet-loss-20',
    name: '丢包 20%',
    description: '五分之一的请求直接连接中断。测客户端的自动重试和退避。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, latencyMs: 100, jitterMs: 30, packetLossRate: 0.2 },
    fault: { enabled: false, rules: [] },
  },
  {
    id: 'server-down',
    name: '服务器宕机',
    description: '所有请求连接被重置（不是 503）。测客户端把“连不上”和“服务器报错”区分开。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, offline: true },
    fault: { enabled: false, rules: [] },
  },
  {
    id: 'abort-download',
    name: '资产下载中途断流',
    description: '资产下到 50% 直接掐断连接。测断点续传（Range）是否真的能接着下。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('abort-assets', '资产下到一半断流', 'abort', { pathPrefix: '/assets' }, { ratio: 0.5 }),
      ],
    },
  },
  {
    id: 'corrupt-asset',
    name: '资产内容损坏',
    description: '文件长度完全正确但内容被改坏。测客户端到底有没有做 md5 校验——没有的话会加载出错乱的资源。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('corrupt-assets', '资产内容损坏', 'corrupt', { pathPrefix: '/assets' }, { ratio: 0.1 }),
      ],
    },
  },
  {
    id: 'truncate-asset',
    name: '资产长度不符',
    description: '声明了完整长度却少发数据后正常关闭。测客户端对“提前结束”的检测。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('truncate-assets', '资产长度不符', 'truncate', { pathPrefix: '/assets' }, { ratio: 0.4 }),
      ],
    },
  },
  {
    id: 'api-500',
    name: '版本接口 500',
    description: '版本查询固定返回 500。测客户端遇到服务端错误时的提示与降级。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('version-500', '版本接口 500', 'status', { pathPrefix: '/api/version' }, { status: 500, body: '模拟：版本服务不可用' }),
      ],
    },
  },
  {
    id: 'retry-then-ok',
    name: '前两次失败后成功',
    description: '版本接口前 2 次返回 500，第 3 次正常。专门验证重试逻辑是否真的会重试、以及重试上限。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('version-retry', '版本接口前两次 500', 'status', { pathPrefix: '/api/version' }, { status: 500, body: '模拟：临时故障' }),
      ],
    },
  },
  {
    id: 'api-timeout',
    name: '版本接口超时',
    description: '版本接口完全不响应。测客户端自己的超时时间设置是否合理。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [rule('version-timeout', '版本接口超时', 'timeout', { pathPrefix: '/api/version' }, {})],
    },
  },
  {
    id: 'empty-manifest',
    name: '清单返回空',
    description: '清单接口返回 200 但内容为空。测客户端对空清单/空文件的处理，不能崩。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [rule('manifest-empty', '清单返回空', 'empty', { pathPrefix: '/api/manifest' }, {})],
    },
  },
  {
    id: 'slow-header',
    name: '响应头很慢',
    description: '响应头延迟 5 秒才返回。测客户端连接超时与读取超时是不是分开配置的。',
    builtin: true,
    network: { ...NO_NETWORK },
    fault: {
      enabled: true,
      rules: [
        rule('slow-version', '版本接口响应头很慢', 'slowHeader', { pathPrefix: '/api' }, { delayMs: 5000 }),
      ],
    },
  },
  {
    id: 'weak-plus-abort',
    name: '弱网 + 断流（组合）',
    description: '3G 弱网再叠加上资产断流。真实外网就是这个样子，用来做最终的健壮性验收。',
    builtin: true,
    network: { ...NO_NETWORK, enabled: true, latencyMs: 400, jitterMs: 150, bandwidthKbps: 400 },
    fault: {
      enabled: true,
      rules: [
        rule('combo-abort', '弱网下的资产断流', 'abort', { pathPrefix: '/assets' }, { ratio: 0.5 }),
      ],
    },
  },
  {
    id: 'slow-then-abort',
    name: '慢响应后断流（复合）',
    description: '响应头拖 5 秒，再在下载中途掐断。还原最常见的线上失败链路：等太久 → 超时重试 → 重试时又断。单条规则表达不了这个组合。',
    builtin: true,
    network: NO_NETWORK,
    fault: {
      enabled: true,
      rules: [
        rule('slow-then-abort-rule', '慢响应后断流', 'slowThenAbort',
          { pathPrefix: '/assets' }, { delayMs: 5000, ratio: 0.5 }),
      ],
    },
  },
];

// 'retry-then-ok' 需要 maxHits=2，单独补一下，避免上面构造时写得过长
const retryPreset = BUILTIN_PRESETS.find((p) => p.id === 'retry-then-ok');
if (retryPreset) retryPreset.fault.rules[0].maxHits = 2;

function readCustom() {
  const data = store.read();
  return data && Array.isArray(data.custom) ? data.custom : [];
}

function writeCustom(list) {
  store.write({ custom: list });
}

/**
 * 全部方案（内置的补上英文文案）。
 * @param {'zh'|'en'} [lang] 只有"应用方案"需要它 —— 规则名和响应体会落盘
 */
function allPresets(lang = 'zh') {
  return [...BUILTIN_PRESETS.map((p) => localizePreset(p, lang)), ...readCustom()];
}

/** 从查询串里取语言，只认 en，其余一律回退中文。 */
function langOf(req) {
  return String(req.query.lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

module.exports = function createPresetsRouter({ configManager, faultInjector }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/presets:
   *   get:
   *     tags: [预置方案]
   *     summary: 列出全部方案（内置 + 自定义）
   *     responses:
   *       200: { description: 方案列表 }
   *   post:
   *     tags: [预置方案]
   *     summary: 新建自定义方案
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               description: { type: string }
   *               network: { type: object }
   *               fault: { type: object }
   *     responses:
   *       201: { description: 已创建 }
   *       400: { description: 参数非法 }
   */
  router.get('/', (req, res) => {
    res.json({ presets: allPresets() });
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (!body.name) {
      return res.status(400).json({ error: '缺少 name' });
    }

    const preset = {
      id: `custom-${Date.now().toString(36)}`,
      name: String(body.name),
      description: String(body.description || ''),
      builtin: false,
      createdAt: new Date().toISOString(),
      network: body.network || configManager.get('network'),
      fault: body.fault || { enabled: false, rules: [] },
    };

    const list = readCustom();
    list.push(preset);
    writeCustom(list);
    res.status(201).json({ ok: true, preset });
  });

  /**
   * @openapi
   * /api/presets/capture:
   *   post:
   *     tags: [预置方案]
   *     summary: 把当前配置存成一个新方案
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               description: { type: string }
   *     responses:
   *       201: { description: 已保存 }
   *       400: { description: 缺少 name }
   */
  router.post('/capture', (req, res) => {
    const body = req.body || {};
    if (!body.name) {
      return res.status(400).json({ error: '缺少 name' });
    }

    const preset = {
      id: `custom-${Date.now().toString(36)}`,
      name: String(body.name),
      description: String(body.description || '由当前配置保存'),
      builtin: false,
      createdAt: new Date().toISOString(),
      network: configManager.get('network'),
      fault: {
        enabled: configManager.get('fault.enabled'),
        rules: configManager.get('fault.rules') || [],
      },
    };

    const list = readCustom();
    list.push(preset);
    writeCustom(list);
    res.status(201).json({ ok: true, preset });
  });

  /**
   * @openapi
   * /api/presets/{id}:
   *   get:
   *     tags: [预置方案]
   *     summary: 查看单个方案
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 方案 }
   *       404: { description: 不存在 }
   *   put:
   *     tags: [预置方案]
   *     summary: 修改自定义方案（内置方案不可改）
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已更新 }
   *       403: { description: 内置方案不可修改 }
   *       404: { description: 不存在 }
   *   delete:
   *     tags: [预置方案]
   *     summary: 删除自定义方案（内置方案不可删）
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已删除 }
   *       403: { description: 内置方案不可删除 }
   *       404: { description: 不存在 }
   */
  router.get('/:id', (req, res) => {
    const all = allPresets();
    const preset = all.find((p) => p.id === req.params.id);
    if (!preset) return res.status(404).json({ error: `方案不存在：${req.params.id}` });
    return res.json(preset);
  });

  router.put('/:id', (req, res) => {
    const list = readCustom();
    const index = list.findIndex((p) => p.id === req.params.id);
    if (index === -1) {
      if (BUILTIN_PRESETS.some((p) => p.id === req.params.id)) {
        return res.status(403).json({ error: '内置方案不可修改，请先另存为自定义方案' });
      }
      return res.status(404).json({ error: `方案不存在：${req.params.id}` });
    }

    const updated = {
      ...list[index],
      ...(req.body || {}),
      id: list[index].id,
      builtin: false,
      updatedAt: new Date().toISOString(),
    };
    list[index] = updated;
    writeCustom(list);
    return res.json({ ok: true, preset: updated });
  });

  router.delete('/:id', (req, res) => {
    if (BUILTIN_PRESETS.some((p) => p.id === req.params.id)) {
      return res.status(403).json({ error: '内置方案不可删除' });
    }
    const list = readCustom();
    const next = list.filter((p) => p.id !== req.params.id);
    if (next.length === list.length) {
      return res.status(404).json({ error: `方案不存在：${req.params.id}` });
    }
    writeCustom(next);
    return res.json({ ok: true, removed: req.params.id });
  });

  /**
   * @openapi
   * /api/presets/{id}/apply:
   *   post:
   *     tags: [预置方案]
   *     summary: 应用方案（立即生效并写回配置文件）
   *     description: 同时会清零故障命中计数，保证方案能重新完整跑一遍。
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已应用 }
   *       404: { description: 方案不存在 }
   */
  router.post('/:id/apply', (req, res) => {
    // 应用方案会把规则写进配置，而规则名和 action.body 是**落盘**的字符串，
    // 不能像方案名那样随界面语言实时切换 —— 所以在应用这一刻就按请求的语言定下来。
    const lang = langOf(req);
    const all = allPresets(lang);
    const preset = all.find((p) => p.id === req.params.id);
    if (!preset) return res.status(404).json({ error: `方案不存在：${req.params.id}` });

    const cfg = configManager.patch({
      network: preset.network,
      fault: preset.fault,
    });
    // 方案里的 maxHits 规则要求从零开始计数，否则第二次应用就不生效了
    faultInjector.resetHitCounts();

    return res.json({
      ok: true,
      applied: preset.id,
      network: cfg.network,
      fault: { enabled: cfg.fault.enabled, rules: faultInjector.describeRules() },
    });
  });

  return router;
};

module.exports.BUILTIN_PRESETS = BUILTIN_PRESETS;
