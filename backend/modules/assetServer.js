// backend/modules/assetServer.js
//
// 热更资产的分发服务。负责把 storage/assets/{平台}/... 下的文件发出去。
//
// 这里刻意实现了几个真实 CDN 必须有的东西，因为 U3D 热更客户端
// 的下载器就是靠它们工作的，模拟器缺了就没法测：
//   * Range 断点续传（206）—— 测“下到一半断了能不能接着下”
//   * ETag / Last-Modified 协商缓存（304）—— 测“资源没变就别重复下载”
//   * Content-Length —— 客户端要靠它算进度条、也可能用来校验完整性
//
// 目录结构约定：
//   storage/assets/
//     Android/
//       manifest.json          ← 可选，用来声明 version / forceUpdate 等元信息
//       bundles/xxx.ab
//     iOS/
//       ...
//
// 目录布局与 manifest 的关系见 buildManifest()。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Unity 常见资源后缀到 MIME 的映射。未知后缀一律当二进制流。 */
const MIME_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  // 各种 AssetBundle 后缀，统一按二进制流发
  '.ab': 'application/octet-stream',
  '.bundle': 'application/octet-stream',
  '.unity3d': 'application/octet-stream',
  '.assetbundle': 'application/octet-stream',
  '.assets': 'application/octet-stream',
  '.bytes': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

/** manifest 扫描结果的缓存时长，避免每次请求都把整个目录的 md5 重算一遍。 */
const MANIFEST_TTL_MS = 10_000;

class AssetServer {
  constructor(configManager) {
    this.configManager = configManager;
    /** @type {Map<string, {at:number, data:object}>} */
    this.manifestCache = new Map();
  }

  /** 资产根目录的绝对路径。 */
  root() {
    return this.configManager.resolvePath('server.assetDir')
      || path.resolve(__dirname, '..', '..', 'storage', 'assets');
  }

  /**
   * 安全拼接路径。
   *
   * 这是整个文件里最需要小心的地方：客户端传来的子路径完全可控，
   * 如果直接拼进去，用 ../../ 就能读到项目里的任何文件
   * （包括 .env 里的密钥）。
   *
   * @returns {string|null} 绝对路径；越界或含非法字符时返回 null
   */
  safeResolve(root, segment) {
    if (!segment) return null;

    // 空字节截断攻击
    if (segment.includes('\0')) return null;

    // Windows 备用数据流（file.txt:secret）和盘符
    if (segment.includes(':')) return null;

    const target = path.resolve(root, segment);

    // 必须真的落在 root 里面。用 relative 判断而不是 startsWith，
    // 因为 startsWith('/a/b') 会把 '/a/bc' 也误判为合法。
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

    return target;
  }

  /** 列出所有可用平台（资产根目录下的一级子目录）。 */
  listPlatforms() {
    const root = this.root();
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 把请求路径解析成磁盘上的文件。
   * @param {string} platform 平台名，例如 Android
   * @param {string} subPath  平台目录下的相对路径
   * @returns {{ok:true, filePath:string, stat:fs.Stats}|{ok:false, status:number, message:string}}
   */
  resolveAsset(platform, subPath) {
    const root = this.root();

    if (!platform) {
      return { ok: false, status: 400, message: '缺少平台参数，正确格式：/assets/{平台}/{文件路径}' };
    }
    if (!subPath) {
      return { ok: false, status: 400, message: '缺少文件路径' };
    }

    if (!fs.existsSync(root)) {
      return {
        ok: false,
        status: 404,
        message: `资产根目录不存在：${root}。请把热更包放到这里，或在配置里修改 server.assetDir。`,
      };
    }

    // 平台名本身也要过一遍安全检查，它同样是客户端可控的
    const platformDir = this.safeResolve(root, platform);
    if (!platformDir) {
      return { ok: false, status: 400, message: '非法的平台名' };
    }

    const filePath = this.safeResolve(platformDir, subPath);
    if (!filePath) {
      // 这个分支就是有人尝试路径穿越了，值得记一笔
      return { ok: false, status: 403, message: '路径越界，已拒绝' };
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, status: 404, message: `资源不存在：${platform}/${subPath}` };
    }

    if (stat.isDirectory()) {
      return { ok: false, status: 404, message: '这是一个目录，不是文件' };
    }

    return { ok: true, filePath, stat };
  }

  /** 生成弱 ETag：文件大小 + 修改时间。够用且不用读文件内容。 */
  static etagFor(stat) {
    return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  }

  /**
   * 处理 /assets/{platform}/{subPath} 请求。
   * app.js 会把 URL 拆分后塞进 req.params.platform / req.params.subPath。
   */
  handle(req, res) {
    const platform = req.params.platform;
    const subPath = req.params.subPath;

    const resolved = this.resolveAsset(platform, subPath);
    if (!resolved.ok) {
      return res.status(resolved.status)
        .type('text/plain; charset=utf-8')
        .send(resolved.message);
    }

    const { filePath, stat } = resolved;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const etag = AssetServer.etagFor(stat);
    const lastModified = stat.mtime.toUTCString();

    // ── 协商缓存 ──
    //
    // RFC 9110 §13.1.3：**只要请求带了 If-None-Match，就必须忽略
    // If-Modified-Since**。原实现是「INM 不匹配就继续看 IMS」，
    // 于是"过期 ETag + 同一秒的 IMS"会拿到 304 —— 客户端认为资源没变，
    // 继续用旧的 AssetBundle；续传请求（Range）更会被 304 直接卡死。
    const ifNoneMatch = req.headers['if-none-match'];
    const hasINM = Boolean(ifNoneMatch);

    if (hasINM) {
      const candidates = String(ifNoneMatch).split(',').map((s) => s.trim());
      // "*" 表示"只要资源存在就别回 body"
      if (candidates.includes('*') || candidates.includes(etag)) {
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        res.status(304).end();
        return undefined;
      }
      // 不匹配：按规范忽略 IMS，继续往下走
    } else {
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince) {
        const since = Date.parse(ifModifiedSince);
        // Last-Modified 只有秒级精度，比较前先把 mtime 截到秒，否则
        // 同一秒内的文件会因为毫秒部分而被判定成"已修改"
        if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
          res.setHeader('ETag', etag);
          res.setHeader('Last-Modified', lastModified);
          res.status(304).end();
          return undefined;
        }
      }
    }

    // ── Range ──
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let partial = false;

    if (range) {
      const parsed = AssetServer.parseRange(range, stat.size);
      if (parsed === null) {
        // 语法合法但不可满足，或有我们明确拒绝的形式（多段、溢出数字）。
        // 416 不应携带该资源的验证器 —— 否则客户端会以为"这就是资源内容"。
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.status(416).type('text/plain; charset=utf-8').send('请求的字节范围不可满足');
        return undefined;
      }
      if (parsed) {
        start = parsed.start;
        end = parsed.end;
        partial = true;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Accept-Ranges', 'bytes');
    // 便于在浏览器/抓包工具里确认到底下的是哪个版本
    res.setHeader('X-Asset-Platform', String(platform));
    res.setHeader('X-Asset-Size', String(stat.size));

    // 0 字节文件是合法的空资源（上传中断留下的空包就长这样）。
    // 原实现会算出 end = size - 1 = -1，createReadStream 同步抛
    // ERR_OUT_OF_RANGE，冒泡到全局错误处理器变成 500 并把磁盘绝对路径
    // 回给客户端。而"空包"恰恰是模拟器最该支持的一类畸形资源。
    if (stat.size === 0) {
      res.setHeader('Content-Length', '0');
      res.end();
      return undefined;
    }

    const length = end - start + 1;
    res.setHeader('Content-Length', String(length));
    if (req._sim) req._sim.range = partial ? `${start}-${end}` : undefined;

    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }

    let stream;
    try {
      stream = fs.createReadStream(filePath, { start, end });
    } catch (err) {
      // statSync 和 createReadStream 之间文件可能被删掉（TOCTOU）
      if (!res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send(`资源已不可读：${err.code || err.message}`);
      } else {
        res.destroy();
      }
      return undefined;
    }

    stream.on('error', (err) => {
      // 文件读到一半被删/被占用，头已经发出去了就只能断开
      if (!res.headersSent) {
        res.status(500).type('text/plain; charset=utf-8').send('读取资源失败');
      } else {
        res.destroy();
      }
      if (req._sim) req._sim.streamError = err.code || err.message;
    });
    stream.pipe(res);
    return undefined;
  }

  /**
   * 解析 Range 头。
   *
   * @returns {{start:number,end:number}|null|undefined}
   *   对象 = 有效范围；null = 明确拒绝（回 416）；undefined = 语法非法，忽略该头
   *
   * 返回值里同时夹紧了 end，避免把超范围的值写进 Content-Range
   * （实测 `bytes=0-9e99` 会把 9000000000000000000 原样写进响应头）。
   */
  static parseRange(header, size) {
    const raw = String(header).trim();
    if (!raw.toLowerCase().startsWith('bytes=')) return undefined;

    const spec = raw.slice(6).trim();

    // 多段 Range（bytes=0-10,20-30）本服务不支持。必须**明确拒绝**，
    // 不能像原来那样走"忽略"分支——那会让客户端收到整份文件，
    // 于是"断点续传"看起来成功了，其实下的是全量。
    if (spec.includes(',')) return null;

    const match = /^(\d*)-(\d*)$/.exec(spec);
    if (!match) return undefined; // 语法非法，按 RFC 允许直接忽略
    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return undefined;

    /** 只接受非负安全整数；超出安全范围的数字一律拒绝。 */
    const parseSafe = (value) => {
      if (value === '') return undefined;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      return n;
    };

    let start;
    let end;

    if (rawStart === '') {
      // bytes=-500 表示最后 500 字节
      const suffix = parseSafe(rawEnd);
      if (suffix === null) return null;
      if (suffix === undefined || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      const parsedStart = parseSafe(rawStart);
      if (parsedStart === null) return null;
      start = parsedStart;

      const parsedEnd = parseSafe(rawEnd);
      if (parsedEnd === null) return null;
      end = parsedEnd === undefined ? size - 1 : parsedEnd;
    }

    if (start > end || start >= size) return null;

    // 在返回前就夹紧，保证调用方拿到的 end 永远是合法上界
    return { start, end: Math.min(end, size - 1) };
  }

  /**
   * 扫描平台目录，生成 manifest（异步）。
   *
   * 为什么是异步：原实现用 `fs.readFileSync` 把**整个文件**读进内存算 md5，
   * 并对整个目录递归调用。两个后果都很严重：
   *   1. 几个 GB 的热更包在缓存过期后的第一次请求里直接 OOM；
   *   2. 全程同步，事件循环被完全堵住 —— 连本应"永不被拖慢"的控制面板
   *      都会一起卡死，恰好破坏了 app.js 里那条刻意的设计保证。
   * 现在改成流式分块计算，并限制并发打开的流数量。
   *
   * 两个数据来源：
   *   1. 如果 {平台}/manifest.json 存在，读取它拿 version / forceUpdate / notice；
   *      如果它同时提供了 files 数组，就直接用那份清单。
   *   2. 否则递归扫描目录，现算每个文件的大小和 md5。
   *
   * @param {string} platform
   * @param {object} [options]
   * @param {boolean} [options.useCache=true]
   * @returns {Promise<object|null>}
   */
  async buildManifest(platform, options = {}) {
    const useCache = options.useCache !== false;

    const cached = this.manifestCache.get(platform);
    if (useCache && cached) {
      // 缓存里既可能是已经算好的结果，也可能是"正在算"的 Promise。
      // 后者用于合并并发请求，避免同一个平台被同时扫描好几遍——
      // 这种在途状态无视 TTL，必须等它出结果。
      const inFlight = typeof cached.data === 'object' && cached.data !== null
        && typeof cached.data.then === 'function';
      if (inFlight || Date.now() - cached.at < MANIFEST_TTL_MS) {
        return cached.data;
      }
    }

    const pending = this._buildManifestUncached(platform);
    this.manifestCache.set(platform, { at: Date.now(), data: pending });

    let manifest;
    try {
      manifest = await pending;
    } catch (err) {
      this.manifestCache.delete(platform);
      throw err;
    }

    if (!manifest) {
      this.manifestCache.delete(platform);
      return null;
    }
    this.manifestCache.set(platform, { at: Date.now(), data: manifest });
    return manifest;
  }

  async _buildManifestUncached(platform) {
    const root = this.root();
    const platformDir = this.safeResolve(root, platform);
    if (!platformDir || !fs.existsSync(platformDir)) {
      return null;
    }

    // 平台自带的元信息文件
    let meta = {};
    const metaPath = path.join(platformDir, 'manifest.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
      } catch (err) {
        meta = { _warning: `manifest.json 解析失败：${err.message}` };
      }
    }

    let files;
    if (Array.isArray(meta.files) && meta.files.length) {
      files = meta.files.map((f) => ({
        path: String(f.path || '').replace(/\\/g, '/'),
        size: Number(f.size) || 0,
        hash: f.hash || f.md5 || null,
        url: f.url || `/assets/${encodeURIComponent(platform)}/${String(f.path || '').replace(/\\/g, '/')}`,
      }));
    } else {
      files = await AssetServer.scanDirectory(platformDir);
      files = files.map((f) => ({
        ...f,
        url: `/assets/${encodeURIComponent(platform)}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      }));
      // manifest.json 自己不该出现在下载清单里
      files = files.filter((f) => f.path !== 'manifest.json');
    }

    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    const manifest = {
      platform,
      version: meta.version || AssetServer.deriveVersion(files),
      minVersion: meta.minVersion || null,
      forceUpdate: Boolean(meta.forceUpdate),
      notice: meta.notice || '',
      channel: meta.channel || null,
      fileCount: files.length,
      totalSize,
      generatedAt: new Date().toISOString(),
      files,
    };
    if (meta._warning) manifest.warning = meta._warning;
    return manifest;
  }

  /** 清掉 manifest 缓存（上传新包后调用，让客户端立刻看到新版本）。 */
  invalidateManifest(platform) {
    if (platform) this.manifestCache.delete(platform);
    else this.manifestCache.clear();
  }

  /**
   * 递归扫描目录（异步），返回 [{path, size, hash}]，path 用正斜杠且相对平台目录。
   *
   * 用并发上限而不是 Promise.all 全放出去：一个平台目录下可能有上万个文件，
   * 同时打开上万个读流会把文件句柄耗尽。
   */
  static async scanDirectory(dir, base = dir, concurrency = 4) {
    const out = [];

    const walk = async (current) => {
      let entries;
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }

      const subdirs = [];
      const files = [];
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) subdirs.push(full);
        else if (entry.isFile()) files.push(full);
      }

      // 文件按并发上限分批处理
      for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (full) => {
          try {
            const stat = await fs.promises.stat(full);
            return {
              path: path.relative(base, full).split(path.sep).join('/'),
              size: stat.size,
              hash: await AssetServer.md5File(full),
            };
          } catch {
            // 单个文件读不了就跳过，不让整个 manifest 挂掉
            return null;
          }
        }));
        for (const item of results) if (item) out.push(item);
      }

      for (const sub of subdirs) {
        await walk(sub);
      }
    };

    await walk(dir);
    return out;
  }

  /**
   * 流式计算文件 md5。
   * 绝不 readFileSync —— 那会把整个文件读进内存，并同步阻塞事件循环。
   */
  static md5File(filePath) {
    return new Promise((resolve) => {
      const hash = crypto.createHash('md5');
      let stream;
      try {
        stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      } catch {
        resolve(null);
        return;
      }
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', () => resolve(null));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /**
   * 目录里没有 manifest.json 时，用文件清单推导一个版本号。
   * 同样的内容得到同样的版本号，所以客户端不会因为重扫而误判“有新版本”。
   */
  static deriveVersion(files) {
    const hash = crypto.createHash('md5');
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`${f.path}:${f.size}:${f.hash || ''};`);
    }
    return hash.digest('hex').slice(0, 12);
  }
}

module.exports = AssetServer;
module.exports.MIME_TYPES = MIME_TYPES;
