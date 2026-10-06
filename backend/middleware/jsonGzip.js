// backend/middleware/jsonGzip.js
//
// 给 JSON 响应加 gzip。
//
// 为什么需要：
//   清单是最大的响应体。实测每个文件条目约 300 字节，1000 个文件就是 295 KB
//   **未压缩**。而 JSON 的压缩比大约 10 倍 —— 加 gzip 之后降到 ~25 KB，
//   客户端每次更新少下 270 KB。
//
// 为什么不用 compression 这个包：
//   它要新增一个依赖（发行包的 npm install 也得能装上），而且它的默认行为是
//   按 Content-Type 压缩**所有**可压缩响应 —— 包括 /assets 下的 .json 资源。
//   那会引入一个麻烦：资产响应带的是内容摘要型 ETag，压缩后同一个 URL 会有
//   两种表示（gzip / 原样），强 ETag 就不成立了。
//   这里只包 res.json，作用面精确得多，也就不存在那个问题。
//
// 只压 JSON：SSE（/api/logs/stream）用的是 res.write，不经过这里；
// 资产下载走 res.sendFile / 流，也不经过这里。

const zlib = require('zlib');

/**
 * 小于这个长度连试都不试。
 * 但这不是唯一的判据 —— 见下面"压完比大小"那一段：
 * 小响应压完反而更大是常态（gzip 头尾约 20 字节，加字典开销），
 * 所以最终一定会拿两者比一次。
 */
const MIN_BYTES = 1024;

module.exports = function jsonGzip(req, res, next) {
  // 无条件先声明 Vary。
  //
  // 两个理由：
  //   1. 即使这次发的是未压缩版本，响应**可能**的形态也取决于 Accept-Encoding，
  //      缓存必须按它分键 —— 否则缓存可能把 gzip 版本发给不支持的客户端。
  //   2. 用 res.vary() 而不是 setHeader：CORS 中间件已经设过 `Vary: Origin`，
  //      直接 setHeader('Vary', ...) 会把它**覆盖掉**。res.vary() 是追加语义。
  res.vary('Accept-Encoding');

  // 客户端不接受 gzip 就到此为止（Vary 已经在上面声明过了）
  const accept = String(req.get('accept-encoding') || '');
  if (!/\bgzip\b/i.test(accept)) return next();

  const originalJson = res.json.bind(res);

  /** 走未压缩路径。Vary 已在入口设置，这里不再重复。 */
  const sendRaw = (body) => originalJson(body);

  res.json = (body) => {
    let text;
    try {
      text = JSON.stringify(body);
    } catch {
      // 循环引用之类，交给原来的实现去报错
      return originalJson(body);
    }
    if (text === undefined) return originalJson(body);

    const buf = Buffer.from(text, 'utf8');
    if (buf.length < MIN_BYTES) return sendRaw(body);

    return zlib.gzip(buf, (err, gzipped) => {
      // 压缩失败不能让请求失败，退回未压缩的响应
      if (err) {
        sendRaw(body);
        return;
      }
      // 关键：压完**比一次大小**。清单只有几个文件时压完反而更大，
      // 这时候必须发未压缩版本 —— 无条件发 gzip 会让小响应变胖。
      // （实测 3 个文件的清单：1357 字节 → 压缩后 1385 字节。）
      if (gzipped.length >= buf.length) {
        sendRaw(body);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gzipped.length));
      res.end(gzipped);
    });
  };

  return next();
};
