// backend/routes/control.js
//
// 模拟器的控制面板接口：读取/修改网络参数、增删改故障规则。
//
// 这些接口挂在 requestPipeline 之前（见 app.js），所以它们自身
// 永远不会被模拟器拖慢或打断。这一点是刻意的：如果你把延迟调到 30 秒、
// 或者把服务设成断网，界面必须还能连上，否则就只能去改配置文件了。

const express = require('express');
const faultRule = require('../core/faultRule');
const { DEFAULTS } = require('../core/configManager');

/**
 * 允许通过接口修改的网络字段。
 * 从 DEFAULTS 的键派生，而不是手抄一份清单 —— 否则以后往 DEFAULTS 里
 * 加一个网络参数，接口会静默丢弃它，使用者只会觉得"我调了没反应"。
 */
const NETWORK_FIELDS = Object.keys(DEFAULTS.network);

module.exports = function createControlRouter({ configManager, faultInjector, assetServer }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/control:
   *   get:
   *     tags: [控制]
   *     summary: 读取当前模拟状态
   *     responses:
   *       200: { description: 网络参数 + 故障规则（含命中次数） }
   */
  router.get('/', (req, res) => {
    const cfg = configManager.get();
    res.json({
      network: cfg.network,
      fault: {
        enabled: cfg.fault.enabled,
        rules: faultInjector.describeRules(),
      },
      hotUpdate: cfg.hotUpdate,
      assetRoot: assetServer.root(),
    });
  });

  /**
   * @openapi
   * /api/control/network:
   *   patch:
   *     tags: [控制]
   *     summary: 修改网络模拟参数（局部更新）
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               enabled: { type: boolean }
   *               offline: { type: boolean }
   *               latencyMs: { type: integer }
   *               jitterMs: { type: integer }
   *               bandwidthKbps: { type: integer, description: 0 表示不限速 }
   *               packetLossRate: { type: number, description: 0~1 }
   *     responses:
   *       200: { description: 更新后的网络参数 }
   */
  router.patch('/network', (req, res) => {
    const body = req.body || {};
    const partial = {};
    for (const key of NETWORK_FIELDS) {
      if (body[key] !== undefined) partial[key] = body[key];
    }
    if (!Object.keys(partial).length) {
      return res.status(400).json({ error: `没有可更新的字段，允许的字段：${NETWORK_FIELDS.join(', ')}` });
    }

    const cfg = configManager.patch({ network: partial });
    return res.json({ ok: true, network: cfg.network });
  });

  /**
   * @openapi
   * /api/control/network/reset:
   *   post:
   *     tags: [控制]
   *     summary: 网络参数恢复默认（等于关闭模拟）
   *     responses:
   *       200: { description: 已重置 }
   */
  router.post('/network/reset', (req, res) => {
    const cfg = configManager.reset('network');
    res.json({ ok: true, network: cfg.network });
  });

  /**
   * @openapi
   * /api/control/fault:
   *   patch:
   *     tags: [控制]
   *     summary: 开关故障注入总闸
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               enabled: { type: boolean }
   *     responses:
   *       200: { description: 已更新 }
   */
  router.patch('/fault', (req, res) => {
    const body = req.body || {};
    if (body.enabled === undefined) {
      return res.status(400).json({ error: '需要 enabled 字段' });
    }
    // 规则走独立端点。以前传 rules 到这里会返回 200 但**静默丢弃** ——
    // 调用方以为配上了，实际一条都没写进去，而且没有任何提示。
    // 这类"默默忽略输入"是最难查的一类问题，所以直接报错并指路。
    if (body.rules !== undefined) {
      return res.status(400).json({
        error: '这个端点只改总开关，不接受 rules',
        hint: '新增规则用 POST /api/control/fault/rules，'
          + '改某条用 PUT /api/control/fault/rules/{id}，删用 DELETE。',
      });
    }
    const cfg = configManager.patch({ fault: { enabled: Boolean(body.enabled) } });
    res.json({ ok: true, fault: { enabled: cfg.fault.enabled, rules: faultInjector.describeRules() } });
  });

  /**
   * @openapi
   * /api/control/fault/rules:
   *   get:
   *     tags: [控制]
   *     summary: 列出故障规则（含命中次数）
   *     responses:
   *       200: { description: 规则列表 }
   *   post:
   *     tags: [控制]
   *     summary: 新增一条故障规则
   *     requestBody:
   *       content:
   *         application/json:
   *           schema: { type: object }
   *     responses:
   *       201: { description: 已创建 }
   *       400: { description: 参数非法 }
   */
  router.get('/fault/rules', (req, res) => {
    const rules = faultInjector.describeRules();
    const faultEnabled = faultInjector.isEnabled();
    res.json({
      rules,
      // 总闸状态必须给出来。每条的 effective 都带原因（effectiveReason），
      // 但"总闸没开"是最常见的那一种，放在顶层最省事 —— 也是和 POST 对齐。
      faultEnabled,
      // 顺带把计数摘要给出来，界面/脚本不用自己数
      totalRules: rules.length,
      effectiveRules: rules.filter((r) => r.effective).length,
      ...(faultEnabled ? {} : {
        warning: '故障注入总闸当前是关闭的，所有规则都不会生效。请打开「启用故障注入」。',
      }),
    });
  });

  router.post('/fault/rules', (req, res) => {
    // 归一化 + 校验。非法输入必须**明确报错**，不能静默降级 ——
    // 原实现把未知的 action.type 悄悄当成 'status'，使用者拼错类型之后
    // 看到的是莫名其妙的 500，而不是"你的类型名写错了"。
    const existing = configManager.get('fault.rules') || [];
    const normalized = faultRule.normalizeRule(req.body || {}, existing.length);
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.reason });
    }

    // 重复 id 必须拒绝。允许的话会出现两条同 id 规则，而匹配语义是
    // "第一条合格的决定" —— 于是新加的那条被前面的挡住、静默失效，
    // 而界面和列表里两条看起来都好好的。这是"配了却不生效"的经典成因。
    if (existing.some((r) => r && String(r.id) === String(normalized.rule.id))) {
      return res.status(409).json({
        error: `已存在同 id 的规则：${normalized.rule.id}`,
        hint: `想改它就用 PUT /api/control/fault/rules/${encodeURIComponent(normalized.rule.id)}，`
          + '或者换个 id、先删掉旧的。',
      });
    }

    const rules = [...existing, normalized.rule];
    const cfg = configManager.patch({ fault: { rules } });

    // 建了规则但总闸没开，是使用者最容易踩的坑（"为什么我建了规则什么都没发生"）。
    // 接口直接把这件事说出来，而不是让人自己去比对 fault.enabled。
    const faultEnabled = Boolean(cfg.fault.enabled);
    return res.status(201).json({
      ok: true,
      rule: faultInjector.describeRules().find((r) => r.id === normalized.rule.id) || normalized.rule,
      faultEnabled,
      ...(faultEnabled ? {} : {
        warning: '故障注入总闸当前是关闭的，这条规则不会生效。请打开「启用故障注入」。',
      }),
    });
  });

  /**
   * @openapi
   * /api/control/fault/rules/{id}:
   *   put:
   *     tags: [控制]
   *     summary: 更新一条故障规则
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已更新 }
   *       404: { description: 规则不存在 }
   *   delete:
   *     tags: [控制]
   *     summary: 删除一条故障规则
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已删除 }
   *       404: { description: 规则不存在 }
   */
  router.put('/fault/rules/:id', (req, res) => {
    const rules = configManager.get('fault.rules') || [];
    const index = rules.findIndex((r) => r.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: `规则不存在：${req.params.id}` });
    }

    // 用与新增完全相同的校验路径，保证 PUT 也不能绕过校验往里塞非法值。
    // id 强制沿用原值，避免前端只改一个字段就把 id 换掉。
    const merged = faultRule.normalizeRule(
      { ...rules[index], ...(req.body || {}), id: rules[index].id },
      index,
    );
    if (!merged.ok) {
      return res.status(400).json({ error: merged.reason });
    }

    const next = rules.slice();
    next[index] = merged.rule;
    configManager.patch({ fault: { rules: next } });
    return res.json({
      ok: true,
      rule: faultInjector.describeRules().find((r) => r.id === merged.rule.id) || merged.rule,
    });
  });

  router.delete('/fault/rules/:id', (req, res) => {
    const rules = configManager.get('fault.rules') || [];
    const next = rules.filter((r) => r.id !== req.params.id);
    if (next.length === rules.length) {
      return res.status(404).json({ error: `规则不存在：${req.params.id}` });
    }
    configManager.patch({ fault: { rules: next } });
    // 用「按 id 清全部」而不是 resetHitCount(id)：后者的键是裸 id，
    // 清不掉重复 id 那种带下标的键，残留的计数会让重建的同名规则一出生就失效。
    faultInjector.resetHitCountsForId(req.params.id);
    return res.json({ ok: true, removed: req.params.id });
  });

  /**
   * @openapi
   * /api/control/fault/reset-counters:
   *   post:
   *     tags: [控制]
   *     summary: 清零所有规则的命中次数
   *     description: 配合 maxHits 使用：清零后“前 N 次失败”的场景可以重新跑一遍。
   *     responses:
   *       200: { description: 已清零 }
   */
  router.post('/fault/reset-counters', (req, res) => {
    faultInjector.resetHitCounts();
    res.json({ ok: true, rules: faultInjector.describeRules() });
  });

  /**
   * @openapi
   * /api/control/disable:
   *   post:
   *     tags: [控制]
   *     summary: 一键关闭全部模拟（急停）
   *     description: 网络模拟、故障注入、断网全部关掉。界面卡住时的救命按钮。
   *     responses:
   *       200: { description: 已全部关闭 }
   */
  router.post('/disable', (req, res) => {
    const cfg = configManager.patch({
      network: { enabled: false, offline: false },
      fault: { enabled: false },
    });
    res.json({ ok: true, network: cfg.network, faultEnabled: cfg.fault.enabled });
  });

  /**
   * @openapi
   * /api/control/reset:
   *   post:
   *     tags: [控制]
   *     summary: 恢复全部默认配置（网络 + 故障规则 + 命中计数）
   *     responses:
   *       200: { description: 已恢复 }
   */
  router.post('/reset', (req, res) => {
    configManager.reset('network');
    const cfg = configManager.reset('fault');
    faultInjector.resetHitCounts();
    res.json({
      ok: true,
      network: cfg.network,
      fault: { enabled: cfg.fault.enabled, rules: faultInjector.describeRules() },
    });
  });

  return router;
};
