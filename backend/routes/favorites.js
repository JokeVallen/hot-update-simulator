// backend/routes/favorites.js
//
// “收藏”＝ 存下来的请求模板，用于反复触发同一个接口来观察模拟效果。
//
// 除了增删查，还提供 replay：由服务器自己发一个 HTTP 请求到本机，
// 这样请求会完整走一遍模拟器（延迟、限速、故障注入都生效）。
// 这比让浏览器直接发要准 —— 浏览器那边还有自己的超时和重试在干扰观察。
//
// 重放有三个必须守住的边界（原实现一个都没有）：
//   1. **回环防护**：收藏的 url 可以指向重放接口自己。实测一次触发会在
//      5 秒内放大到 1.6 万个在途请求（每个占一个 socket + 一个定时器），
//      直接把临时端口耗尽。现在用 X-Sim-Replay-Depth 头阻断递归。
//   2. **目标校验**：url 必须是站内绝对路径。绝对 URL（http://…）会被
//      Node 放进请求行，等于给这个无认证接口加了一个任意地址发起能力。
//   3. **端口来源**：必须用 req.socket.localPort（实际监听端口），
//      而不是 config.json 里的 port。实测 PORT=5601 启动时，回放会去连
//      5500 然后 502 —— 现在能用只是因为 .env 恰好把两者写成了同一个值。

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const JsonStore = require('../utils/jsonStore');

const store = new JsonStore(JsonStore.storagePath('favorites.json'), { favorites: [] });

/** replay 的等待上限，避免碰上 timeout 故障时这个接口自己挂死。 */
const REPLAY_TIMEOUT_MS = 15_000;
/** 响应体最多回传这么多字符，防止一个巨大的资产把响应撑爆。 */
const MAX_BODY_BYTES = 16 * 1024;
/** 同时进行的重放数量上限。重放会真的占用 socket 和定时器。 */
const MAX_CONCURRENT_REPLAYS = 4;
/** 收藏条数上限，避免 storage 文件无限增长。 */
const MAX_FAVORITES = 500;
/** 递归标记头：带这个头进来的请求说明它本身就是一次重放。 */
const REPLAY_DEPTH_HEADER = 'x-sim-replay-depth';

let activeReplays = 0;

function readAll() {
  const data = store.read();
  return data && Array.isArray(data.favorites) ? data.favorites : [];
}

function writeAll(list) {
  store.write({ favorites: list });
}

/**
 * 校验并规范化收藏的 url。
 * 只接受站内绝对路径：必须以 `/` 开头、不能有 `//` 开头（协议相对）、
 * 不能含 `://`（绝对 URL）。同时挡掉 CRLF（虽然 Node 自己也会拦）。
 * @returns {{ok:true,url:string}|{ok:false,reason:string}}
 */
function normalizeUrl(raw) {
  const url = String(raw == null ? '' : raw).trim();
  if (!url) return { ok: false, reason: 'url 不能为空' };
  if (url.length > 2048) return { ok: false, reason: 'url 过长' };
  if (/[\r\n]/.test(url)) return { ok: false, reason: 'url 不能包含换行符' };
  if (url.includes('://')) {
    return { ok: false, reason: 'url 必须是站内路径（以 / 开头），不支持绝对地址' };
  }
  if (!url.startsWith('/') || url.startsWith('//')) {
    return { ok: false, reason: 'url 必须以单个 / 开头' };
  }
  return { ok: true, url };
}

/** 这个路径是不是我们明确不允许重放的目标（控制类接口 + 重放接口自身）。 */
function isBlockedReplayTarget(urlPath) {
  const pathOnly = urlPath.split('?')[0];
  return pathOnly.startsWith('/api/favorites')
    || pathOnly.startsWith('/api/control')
    || pathOnly.startsWith('/api/presets')
    || pathOnly.startsWith('/api/logs');
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

    const normalized = normalizeUrl(body.url);
    if (!normalized.ok) {
      return res.status(400).json({ error: normalized.reason });
    }

    const list = readAll();
    if (list.length >= MAX_FAVORITES) {
      return res.status(400).json({ error: `收藏数量已达上限（${MAX_FAVORITES} 条）` });
    }

    const favorite = {
      // 原来是 fav-${Date.now().toString(36)}：同一毫秒内创建两条会拿到相同 id，
      // 删除时就会一次删掉两条。
      id: `fav-${crypto.randomUUID()}`,
      name: String(body.name).slice(0, 200),
      method: String(body.method || 'GET').toUpperCase().slice(0, 10),
      url: normalized.url,
      body: body.body ? String(body.body).slice(0, 8192) : '',
      createdAt: new Date().toISOString(),
      lastResult: null,
    };

    list.push(favorite);
    writeAll(list);
    return res.status(201).json({ ok: true, favorite });
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
   *       400: { description: 目标路径不被允许 }
   *       404: { description: 收藏不存在 }
   *       429: { description: 并发重放过多 }
   *       504: { description: 重放超时（很可能是命中了 timeout 故障） }
   */
  router.post('/:id/replay', async (req, res) => {
    // 回环防护：重放发出的请求带了这个头，如果它又打回重放接口，直接拒绝。
    // 没有这一层，一次调用就能自我放大到上万个请求。
    const depth = Number(req.get(REPLAY_DEPTH_HEADER) || 0);
    if (depth > 0) {
      return res.status(400).json({
        error: '不允许重放重放接口（会造成无限递归）',
        depth,
      });
    }

    const list = readAll();
    const index = list.findIndex((f) => f.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: `收藏不存在：${req.params.id}` });
    }

    const favorite = list[index];
    if (isBlockedReplayTarget(favorite.url)) {
      return res.status(400).json({
        error: `不允许重放控制类接口：${favorite.url}（请直接在界面上操作，或改用 curl）`,
      });
    }

    if (activeReplays >= MAX_CONCURRENT_REPLAYS) {
      return res.status(429).json({ error: `并发重放过多（上限 ${MAX_CONCURRENT_REPLAYS}）` });
    }

    // 端口取实际监听端口，而不是配置里的值 —— 两者可能不一致
    // （PORT=5601 node backend/server.js 时配置里仍是 5500）。
    const port = (req.socket && req.socket.localPort) || configManager.get('server.port') || 5500;

    const startedAt = Date.now();
    activeReplays += 1;

    try {
      const result = await replayLocally({ port, favorite });
      const record = {
        at: new Date().toISOString(),
        status: result.status,
        durationMs: Date.now() - startedAt,
      };
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
    } finally {
      activeReplays -= 1;
    }
  });

  return router;
};

/** 向本机发一次请求。走的是正常的网络栈，所以模拟器会照常生效。 */
function replayLocally({ port, favorite }) {
  return new Promise((resolve, reject) => {
    const payload = favorite.body || '';
    const headers = {
      // 标记这是一次重放，用于阻断自我递归
      [REPLAY_DEPTH_HEADER]: '1',
    };
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
          if (received <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES),
          });
        });
        response.on('error', reject);
      },
    );

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners();
      fn(value);
    };

    req.setTimeout(REPLAY_TIMEOUT_MS, () => {
      req.destroy();
      const err = new Error(`重放超过 ${REPLAY_TIMEOUT_MS}ms 仍未返回`);
      err.code = 'REPLAY_TIMEOUT';
      settle(reject, err);
    });

    // 超时之后 'error' 还会再触发一次，用 settled 挡住（原来的写法会重复 reject）
    req.on('error', (err) => settle(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}
