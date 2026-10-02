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

    res.setHeader('Content-Type', contentType);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    // 让客户端和中间的调试工具知道缓存该怎么处理
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    // 便于在浏览器/抓包工具里确认到底下的是哪个版本
    res.setHeader('X-Asset-Platform', String(platform));
    res.setHeader('X-Asset-Size', String(stat.size));

    // 协商缓存：内容没变就回 304，不传 body。
    // 客户端如果能正确处理 304，就不会白下已经有的资源。
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').map((s) => s.trim()).includes(etag)) {
      res.status(304).end();
      return undefined;
    }
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince);
      if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
        res.status(304).end();
        return undefined;
      }
    }

    // Range 断点续传
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let partial = false;

    if (range) {
      const parsed = AssetServer.parseRange(range, stat.size);
      if (parsed === null) {
        // 语法对但范围不可满足，按 HTTP 规范回 416
        res.setHeader('Content-Range', `bytes */${stat.size}`);
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

    const length = end - start + 1;
    res.setHeader('Content-Length', String(length));
    res.setHeader('Accept-Ranges', 'bytes');
    if (req._sim) req._sim.range = partial ? `${start}-${end}` : undefined;

    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => {
      // 文件在读到一半时被删/被占用，头已经发出去了就只能断开了
      if (!res.headersSent) {
        res.status(500).type('text/plain; charset=utf-8').send(`读取资源失败：${err.message}`);
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
    return undefined;
  }

  /**
   * 解析 Range 头。
   * @returns {{start:number,end:number}|null|undefined}
   *   对象 = 有效的范围；null = 语法合法但不可满足（回 416）；undefined = 不支持/忽略
   */
  static parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match) return undefined;

    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return undefined;

    let start;
    let end;

    if (rawStart === '') {
      // bytes=-500 表示最后 500 字节
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? size - 1 : Number(rawEnd);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start >= size) return null;

    return { start, end: Math.min(end, size - 1) };
  }

  /**
   * 扫描平台目录，生成 manifest。
   *
   * 两个来源：
   *   1. 如果 {平台}/manifest.json 存在，读取它拿 version / forceUpdate / notice 等元信息；
   *      如果它同时提供了 files 数组，就直接用那份清单（适合手工精确控制）。
   *   2. 否则递归扫描目录，现算每个文件的大小和 md5。
   *
   * 这样“直接把打好的包丢进目录”和“用脚本生成精确 manifest”两种用法都支持。
   *
   * @param {string} platform
   * @param {object} [options]
   * @param {boolean} [options.useCache=true]
   */
  buildManifest(platform, options = {}) {
    const useCache = options.useCache !== false;
    const cached = this.manifestCache.get(platform);
    if (useCache && cached && Date.now() - cached.at < MANIFEST_TTL_MS) {
      return cached.data;
    }

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
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (err) {
        meta = { _warning: `manifest.json 解析失败：${err.message}` };
      }
    }

    // 如果 manifest.json 里写死了文件清单，就尊重它
    let files;
    if (Array.isArray(meta.files) && meta.files.length) {
      files = meta.files.map((f) => ({
        path: String(f.path || '').replace(/\\/g, '/'),
        size: Number(f.size) || 0,
        hash: f.hash || f.md5 || null,
        url: f.url || `/assets/${encodeURIComponent(platform)}/${String(f.path || '').replace(/\\/g, '/')}`,
      }));
    } else {
      files = AssetServer.scanDirectory(platformDir).map((f) => ({
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

    this.manifestCache.set(platform, { at: Date.now(), data: manifest });
    return manifest;
  }

  /** 清掉 manifest 缓存（上传新包后调用，让客户端立刻看到新版本）。 */
  invalidateManifest(platform) {
    if (platform) this.manifestCache.delete(platform);
    else this.manifestCache.clear();
  }

  /** 递归扫描目录，返回 [{path, size, hash}]，path 用正斜杠且相对平台目录。 */
  static scanDirectory(dir, base = dir) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...AssetServer.scanDirectory(full, base));
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          out.push({
            path: path.relative(base, full).split(path.sep).join('/'),
            size: stat.size,
            hash: AssetServer.md5File(full),
          });
        } catch {
          // 单个文件读不了就跳过，不让整个 manifest 挂掉
        }
      }
    }
    return out;
  }

  static md5File(filePath) {
    try {
      const hash = crypto.createHash('md5');
      hash.update(fs.readFileSync(filePath));
      return hash.digest('hex');
    } catch {
      return null;
    }
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
