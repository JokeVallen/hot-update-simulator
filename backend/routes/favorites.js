// backend/routes/favorites.js
//
// “收藏”＝ 存下来的请求模板，用于反复触发同一个接口来观察模拟效果。
//
// 除了增删查，还提供了一个 replay：由服务器自己发一个 HTTP 请求到本机，
// 这样请求会完整走一遍模拟器（延迟、限速、故障注入都生效）。
// 这比让浏览器直接发要准——浏览器那边还有自己的超时和重试在干扰。

const express = require('express');
const http = require('http');
const JsonStore = require('../utils/jsonStore');

const store = new JsonStore(JsonStore.storagePath('favorites.json'), { favorites: [] });

/** replay 的等待上限，避免碰上 timeout 故障时这个接口自己挂死。 */
const REPLAY_TIMEOUT_MS = 15_000;
/** 响应体最多回传这么多字符，防止一个巨大的资产把日志接口撑爆。 */
const MAX_BODY_CHARS = 4096;

function readAll() {
  const data = store.read();
  return data && Array.isArray(data.favorites) ? data.favorites : [];
}

function writeAll(list) {
  store.write({ favorites: list });
}

module.exports = function createFavoritesRouter({ configManager }) {
  const router = express.Router();

  /**
   * @openapi
   * /api/favorites:
   *   get:
   *     tags: [收藏]
   *     summary: 列出收藏的请求
   *     responses:
   *       200: { description: 收藏列表 }
   *   post:
   *     tags: [收藏]
   *     summary: 新增收藏
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, url]
   *             properties:
   *               name: { type: string }
   *               method: { type: string, default: GET }
   *               url: { type: string, description: 形如 /api/version?platform=Android }
   *               body: { type: string }
   *     responses:
   *       201: { description: 已创建 }
   *       400: { description: 参数非法 }
   */
  router.get('/', (req, res) => {
    res.json({ favorites: readAll() });
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.url) {
      return res.status(400).json({ error: 'name 和 url 都是必填的' });
    }

    const favorite = {
      id: `fav-${Date.now().toString(36)}`,
      name: String(body.name),
      method: String(body.method || 'GET').toUpperCase(),
      url: String(body.url),
      body: body.body ? String(body.body) : '',
      createdAt: new Date().toISOString(),
      lastResult: null,
    };

    const list = readAll();
    list.push(favorite);
    writeAll(list);
    res.status(201).json({ ok: true, favorite });
  });

  /**
   * @openapi
   * /api/favorites/{id}:
   *   get:
   *     tags: [收藏]
   *     summary: 查看单条收藏
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 收藏 }
   *       404: { description: 不存在 }
   *   delete:
   *     tags: [收藏]
   *     summary: 删除收藏
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 已删除 }
   *       404: { description: 不存在 }
   */
  router.get('/:id', (req, res) => {
    const favorite = readAll().find((f) => f.id === req.params.id);
    if (!favorite) return res.status(404).json({ error: `收藏不存在：${req.params.id}` });
    return res.json(favorite);
  });

  router.delete('/:id', (req, res) => {
    const list = readAll();
    const next = list.filter((f) => f.id !== req.params.id);
    if (next.length === list.length) {
      return res.status(404).json({ error: `收藏不存在：${req.params.id}` });
    }
    writeAll(next);
    return res.json({ ok: true, removed: req.params.id });
  });

  /**
   * @openapi
   * /api/favorites/{id}/replay:
   *   post:
   *     tags: [收藏]
   *     summary: 重放该请求（会完整经过模拟器）
   *     description: 服务器向自己发一次请求，因此延迟、限速、故障注入全部生效。
   *     parameters:
   *       - { in: path, name: id, required: true, schema: { type: string } }
   *     responses:
   *       200: { description: 本次重放的结果 }
   *       404: { description: 收藏不存在 }
   *       504: { description: 重放超时（很可能是命中了 timeout 故障） }
   */
  router.post('/:id/replay', async (req, res) => {
    const list = readAll();
    const index = list.findIndex((f) => f.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: `收藏不存在：${req.params.id}` });
    }

    const favorite = list[index];
    const startedAt = Date.now();

    try {
      const result = await replayLocally(configManager, favorite);
      const record = {
        at: new Date().toISOString(),
        status: result.status,
        durationMs: Date.now() - startedAt,
      };
      // 顺手把最后一次结果存起来，界面上一眼能看到上回成功没有
      list[index] = { ...favorite, lastResult: record };
      writeAll(list);

      return res.json({
        ok: true,
        request: { method: favorite.method, url: favorite.url },
        ...record,
        responseHeaders: result.headers,
        responseBody: result.body,
      });
    } catch (err) {
      const record = {
        at: new Date().toISOString(),
        status: null,
        durationMs: Date.now() - startedAt,
        error: err.message,
      };
      list[index] = { ...favorite, lastResult: record };
      writeAll(list);

      const timedOut = err.code === 'REPLAY_TIMEOUT';
      return res.status(timedOut ? 504 : 502).json({
        ok: false,
        request: { method: favorite.method, url: favorite.url },
        ...record,
      });
    }
  });

  return router;
};

/** 向本机发一次请求。走的是正常的网络栈，所以模拟器会照常生效。 */
function replayLocally(configManager, favorite) {
  return new Promise((resolve, reject) => {
    const port = configManager.get('server.port') || 5500;
    const payload = favorite.body || '';
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: favorite.method || 'GET',
        path: favorite.url,
        headers,
      },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          // 只留前面一段用于展示，但依然把流读完，让连接正常结束
          if (received <= MAX_BODY_CHARS * 4) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_CHARS),
          });
        });
        response.on('error', reject);
      },
    );

    req.setTimeout(REPLAY_TIMEOUT_MS, () => {
      req.destroy();
      const err = new Error(`重放超过 ${REPLAY_TIMEOUT_MS}ms 仍未返回`);
      err.code = 'REPLAY_TIMEOUT';
      reject(err);
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
