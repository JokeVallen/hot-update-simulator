// backend/routes/control.js
//
// 模拟器的控制面板接口：读取/修改网络参数、增删改故障规则。
//
// 这些接口挂在 requestPipeline 之前（见 app.js），所以它们自身
// 永远不会被模拟器拖慢或打断。这一点是刻意的：如果你把延迟调到 30 秒、
// 或者把服务设成断网，界面必须还能连上，否则就只能去改配置文件了。

const express = require('express');
const FaultInjector = require('../modules/faultInjector');

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
    const allowed = ['enabled', 'offline', 'latencyMs', 'jitterMs', 'bandwidthKbps', 'packetLossRate'];
    const partial = {};
    for (const key of allowed) {
      if (body[key] !== undefined) partial[key] = body[key];
    }
    if (!Object.keys(partial).length) {
      return res.status(400).json({ error: `没有可更新的字段，允许的字段：${allowed.join(', ')}` });
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
    res.json({ rules: faultInjector.describeRules() });
  });

  router.post('/fault/rules', (req, res) => {
    const rule = FaultInjector.createRule(req.body || {});
    const rules = configManager.get('fault.rules') || [];
    rules.push(rule);
    configManager.patch({ fault: { rules } });
    res.status(201).json({ ok: true, rule, hits: 0 });
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

    // 用 createRule 归一化一遍，保证字段类型和默认值是一致的，
    // 但保留原来的 id，避免前端只改一个字段就把 id 换掉了
    const merged = FaultInjector.createRule({ ...rules[index], ...(req.body || {}), id: rules[index].id });
    rules[index] = merged;
    configManager.patch({ fault: { rules } });
    return res.json({ ok: true, rule: merged });
  });

  router.delete('/fault/rules/:id', (req, res) => {
    const rules = configManager.get('fault.rules') || [];
    const next = rules.filter((r) => r.id !== req.params.id);
    if (next.length === rules.length) {
      return res.status(404).json({ error: `规则不存在：${req.params.id}` });
    }
    configManager.patch({ fault: { rules: next } });
    faultInjector.resetHitCount(req.params.id);
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
