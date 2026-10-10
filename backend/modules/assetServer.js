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
const { storageRoot, assetsDir } = require('../core/paths');

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
  // 代码热更：HybridCLR / ILRuntime 的程序集，Lua 与 JS 脚本。
  // 这几个后缀没列进表里也能正常下载（会回退成二进制流），
  // 列出来只是让 Content-Type 准确，方便用浏览器和抓包工具排查。
  '.dll': 'application/octet-stream',
  '.pdb': 'application/octet-stream',
  '.lua': 'text/plain; charset=utf-8',
  '.luac': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

/** manifest 扫描结果的缓存时长，避免每次请求都把整个目录的 md5 重算一遍。 */
const MANIFEST_TTL_MS = 10_000;

class AssetServer {
  constructor(configManager) {
    this.configManager = configManager;
    /** @type {Map<string, {at:number, data:object}>} */
    this.manifestCache = new Map();
    /**
     * 内容摘要 ETag 的缓存。
     *
     * 算内容摘要要读整个文件，不能每个请求都算一遍。用「大小 + 修改时间」
     * 作为失效依据：文件一变，这两个至少变一个，于是重算。
     * （毫秒级 mtime + 字节数同时撞车的概率可以忽略；真要较真可以换成
     *  监控文件系统事件，但对这个工具是过度设计。）
     *
     * @type {Map<string, {key:string, hashes:Record<string,string>}>}
     */
    this.hashCache = new Map();
  }

  /** 资产根目录的绝对路径。 */
  root() {
    // 相对路径按「存储根」解析（不是 backend/）：这样默认值 'assets' 会跟着
    // HOT_UPDATE_STORAGE 一起搬走，服务器和 npm run sample 永远指同一个地方。
    return this.configManager.resolvePath('server.assetDir', storageRoot())
      || assetsDir();
  }

  /**
   * 安全拼接路径。
   *
   * 这是整个文件里最需要小心的地方：客户端传来的子路径完全可控，
   * 如果直接拼进去，用 ../../ 就能读到项目里的任何文件
   * （包括 .env 里的密钥）。
   *
   * ⚠️ 光做字符串判断**不够**：目录里放一个符号链接/junction 指向外面，
   * 字符串上它还在根目录内，但 fs 会跟着链接跑出去。实测过：
   *   storage/assets/Android/escape → C:\somewhere\else   （junction）
   *   GET /assets/Android/escape/secret.txt  → 200，读到了根目录之外的内容
   * 所以字符串检查通过之后还要解析真实路径再校验一次。
   *
   * @returns {string|null} 绝对路径；越界、含非法字符、或解析后跑到根外时返回 null
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

    // 第一层：字符串上在根目录内。
    // 第二层：把它（或它最近的已存在祖先）解析成真实路径，确认没被链接带出去。
    return AssetServer.staysInside(root, target) ? target : null;
  }

  /**
   * 目标解析符号链接之后，是否仍落在 root 的真实路径之内。
   *
   * 为什么无需担心"往上找祖先"的开销：
   *   要发出去的文件**必然存在**，于是 realpathSync(target) 一次就成功，
   *   只花一次系统调用。向上回溯只在目标不存在时发生，而那种情况随后就会 404，
   *   纯粹是防御性的。
   *   回溯限制层数是为了挡住"用极深的不存在路径逼出上千次 syscall"的骚扰。
   *
   * @returns {boolean}
   */
  static staysInside(root, target) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return false; // 根目录都不存在，谈不上"在里面"
    }

    let probe = target;
    for (let depth = 0; depth < 8; depth += 1) {
      let real;
      try {
        real = fs.realpathSync(probe);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return false; // 已经到文件系统根部
        probe = parent;
        continue;
      }
      // probe 可能只是目标的一个祖先，把剩下的相对部分接回去
      const rest = path.relative(probe, target);
      const full = rest ? path.resolve(real, rest) : real;
      const rel = path.relative(realRoot, full);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }
    return false;
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

  /** 配置里声明的渠道名。这个列表现在**真的**参与目录解析了。 */
  channels() {
    const list = this.configManager.get('hotUpdate.channels');
    return Array.isArray(list) && list.length ? list.map(String) : ['default'];
  }

  /** 默认渠道名。 */
  defaultChannel() {
    return this.configManager.get('hotUpdate.defaultChannel')
      || this.channels()[0]
      || 'default';
  }

  /**
   * 平台目录是不是「按渠道分层」的布局。
   *
   * 判据：平台目录下存在**以配置的渠道名命名**的子目录。
   *
   * 这个判据同时决定了要不要迁移：旧布局（`Android/bundles/...`）里没有叫
   * `default`/`beta` 的子目录，所以判定为"平铺布局"，整个平台目录就是默认渠道
   * —— 已有数据一行都不用动。想用多渠渠道时，建一个 `beta/` 目录即可。
   *
   * 用配置里的渠道名而不是"任意子目录"，是因为平铺布局下 `bundles/`、`dll/`
   * 也是子目录；不区分的话会把它们误当成渠道。
   */
  hasChannelLayout(platformDir) {
    const names = this.channels();
    try {
      return fs.readdirSync(platformDir, { withFileTypes: true })
        .some((e) => e.isDirectory() && names.includes(e.name));
    } catch {
      return false;
    }
  }

  /** 列出某个平台实际有内容的渠道。 */
  listChannels(platform) {
    const root = this.root();
    const platformDir = this.safeResolve(root, platform);
    if (!platformDir || !fs.existsSync(platformDir)) return [];

    if (!this.hasChannelLayout(platformDir)) {
      // 平铺布局：整个平台就是默认渠道
      return [this.defaultChannel()];
    }
    const names = this.channels();
    try {
      return fs.readdirSync(platformDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && names.includes(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 解析出某个平台 + 渠道的**内容目录**。
   *
   * @returns {{dir:string, channel:string, channelInUrl:boolean, platformDir:string}|null}
   *   channelInUrl 表示资产 URL 里要不要带渠道这一段
   */
  resolveChannelDir(platform, channel) {
    const root = this.root();
    const platformDir = this.safeResolve(root, platform);
    if (!platformDir || !fs.existsSync(platformDir)) return null;

    if (!this.hasChannelLayout(platformDir)) {
      // 平铺布局：整个平台目录就是默认渠道的内容。
      //
      // 但**不能**因此忽略请求里的渠道名 —— 那样拼错渠道会静默拿到默认内容，
      // 正是 2.0.0 声称消除掉的失败模式。而且 /api/version 还会把这个拼错的
      // 名字回显进 `channel`，客户端照它给缓存分目录就会把默认渠道的内容
      // 记在 nosuchchannel/ 名下。
      //
      // 平铺布局下唯一存在的渠道就是默认渠道，所以只接受它（或没传）。
      // 想让客户端用的名字生效，把 hotUpdate.defaultChannel 设成那个名字即可
      // （注意它必须在 hotUpdate.channels 里）。
      const def = this.defaultChannel();
      const wanted = channel ? String(channel) : '';
      if (wanted && wanted !== def) return null;

      return {
        dir: platformDir,
        platformDir,
        channel: def,
        channelInUrl: false,
      };
    }

    const wanted = channel || this.defaultChannel();
    const dir = this.safeResolve(platformDir, wanted);
    if (!dir || !fs.existsSync(dir)) return null;

    return { dir, platformDir, channel: wanted, channelInUrl: true };
  }

  /**
   * 把请求路径解析成磁盘上的文件。
   * @param {string} platform 平台名，例如 Android
   * @param {string} subPath  平台目录下的相对路径；分层布局时**第一段是渠道名**
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

    // 分层布局：URL 的第一段必须是渠道名。
    // 这里给出明确的 404 而不是"静默退回默认渠道" —— 渠道拼错时
    // 悄悄给一份别的渠道的内容，比报错难查得多。
    let contentDir = platformDir;
    let rest = subPath;
    if (this.hasChannelLayout(platformDir)) {
      const segs = subPath.split('/');
      const wanted = segs[0];
      const names = this.channels();
      if (!names.includes(wanted)) {
        return {
          ok: false,
          status: 404,
          message: `平台 ${platform} 按渠道分层，URL 第一段必须是渠道名。`
            + `可用：${names.join(', ')}；收到 "${wanted}"。`
            + `示例：/assets/${platform}/${this.defaultChannel()}/...`,
        };
      }
      const dir = this.safeResolve(platformDir, wanted);
      if (!dir || !fs.existsSync(dir)) {
        return {
          ok: false,
          status: 404,
          message: `渠道 "${wanted}" 在平台 ${platform} 下没有目录。`
            + `已有的：${this.listChannels(platform).join(', ') || '（无）'}`,
        };
      }
      contentDir = dir;
      rest = segs.slice(1).join('/');
    }

    if (!rest) {
      return { ok: false, status: 400, message: '缺少文件路径' };
    }

    const filePath = this.safeResolve(contentDir, rest);
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
   * 配置要求的摘要算法列表。
   *
   * 第一个是"主算法"：清单里的 `hash` 字段和资产的 ETag 都用它，
   * 保证两者是同一个值（这是客户端能本地决策的前提）。
   */
  hashAlgorithms() {
    const raw = this.configManager.get('hotUpdate.hashAlgorithms');
    const list = (Array.isArray(raw) ? raw : [raw])
      .map((a) => String(a || '').toLowerCase())
      .filter((a) => crypto.getHashes().includes(a));
    return list.length ? list : ['md5'];
  }

  /**
   * 取某个文件的摘要，带缓存。
   * @param {string} filePath
   * @param {import('fs').Stats} stat
   * @returns {Promise<Record<string,string>|null>}
   */
  async hashesFor(filePath, stat) {
    const key = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
    const cached = this.hashCache.get(filePath);
    if (cached && cached.key === key) return cached.hashes;

    const hashes = await AssetServer.hashFile(filePath, this.hashAlgorithms());
    if (!hashes) return null;
    this.hashCache.set(filePath, { key, hashes });
    return hashes;
  }

  /**
   * 处理 /assets/{platform}/{subPath} 请求。
   * app.js 会把 URL 拆分后塞进 req.params.platform / req.params.subPath。
   *
   * 是 async 的：内容摘要型 ETag 需要读文件（有缓存，但首次要算）。
   */
  async handle(req, res) {
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

    // ETag = 内容摘要，和清单里的 hash 是同一个值。
    // 算不出来（文件读不了）就退回到「大小 + 修改时间」的弱 ETag，
    // 至少缓存还能工作，不至于因为算不了摘要就让整个下载失败。
    const hashes = await this.hashesFor(filePath, stat);
    const primary = hashes ? hashes[this.hashAlgorithms()[0]] : null;
    const etag = primary
      ? AssetServer.etagForHash(primary)
      : AssetServer.weakEtagFor(stat);
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
    // 便于在浏览器/抓包工具里确认到底下的是哪个版本。
    //
    // 必须 percent-encode：HTTP 头的值只能是 ASCII，而平台名是使用者随便起的
    // 目录名。实测平台名叫「微信小游戏」时 setHeader 直接抛 ERR_INVALID_CHAR，
    // 整个下载变成 500 / 连接中断 —— 而 /api/version 和 /api/manifest 走
    // JSON body 完全正常，于是表现为"版本查得到、文件下不来"这种很难查的现象。
    res.setHeader('X-Asset-Platform', encodeURIComponent(String(platform)));
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
    // 渠道影响内容，所以缓存必须按 (平台, 渠道) 分键。
    // 只用平台当键的话，请求 beta 会拿到 default 的缓存 —— 而且不报错。
    const channel = options.channel ? String(options.channel) : '';
    const cacheKey = `${platform}::${channel}`;

    const cached = this.manifestCache.get(cacheKey);
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

    const pending = this._buildManifestUncached(platform, channel);
    this.manifestCache.set(cacheKey, { at: Date.now(), data: pending });

    let manifest;
    try {
      manifest = await pending;
    } catch (err) {
      this.manifestCache.delete(cacheKey);
      throw err;
    }

    if (!manifest) {
      this.manifestCache.delete(cacheKey);
      return null;
    }
    this.manifestCache.set(cacheKey, { at: Date.now(), data: manifest });
    return manifest;
  }

  async _buildManifestUncached(platform, channel = '') {
    // 渠道解析：可能是分层布局（内容在 {platform}/{channel}/ 下），
    // 也可能是平铺布局（整个平台目录就是默认渠道，旧数据不用迁移）。
    const resolved = this.resolveChannelDir(platform, channel);
    if (!resolved) return null;
    const { dir: contentDir, channel: actualChannel, channelInUrl } = resolved;

    // 资产 URL 的前缀：分层布局要带上渠道那一段
    const urlPrefix = channelInUrl
      ? `/assets/${encodeURIComponent(platform)}/${encodeURIComponent(actualChannel)}`
      : `/assets/${encodeURIComponent(platform)}`;

    // 平台自带的元信息文件（在内容目录里）
    let meta = {};
    const metaPath = path.join(contentDir, 'manifest.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
      } catch (err) {
        meta = { _warning: `manifest.json 解析失败：${err.message}` };
      }
    }

    // 代码热更轨道（可选）。要先于资源清单算出来：它的文件必须从资源清单里排除。
    const code = await this._buildCodeTrack(platform, contentDir, meta.code, urlPrefix);

    // 主算法：清单里的 hash 和资产的 ETag 都用它，所以两者是同一个值。
    const algos = this.hashAlgorithms();
    const primary = algos[0];

    let files;
    if (Array.isArray(meta.files) && meta.files.length) {
      // 自定义清单：hash 由使用方声明，服务器不校验它和文件内容是否一致。
      // 注意这会让 ETag（服务器按内容算的）和这里的 hash 可能对不上 ——
      // 那是使用方自己的选择，不是 bug。
      files = meta.files.map((f) => {
        const declared = f.hash || f.md5 || null;
        const p = String(f.path || '').replace(/\\/g, '/');
        return {
          path: p,
          size: Number(f.size) || 0,
          hash: declared,
          hashAlgo: declared ? (f.hashAlgo || 'md5') : null,
          hashes: declared ? { [f.hashAlgo || 'md5']: declared } : {},
          url: f.url || `${urlPrefix}/${p.split('/').map(encodeURIComponent).join('/')}`,
        };
      });
    } else {
      const scanned = await AssetServer.scanDirectory(contentDir, contentDir, 4, algos);
      files = scanned.map((f) => ({
        path: f.path,
        size: f.size,
        // 向后兼容：hash 仍是裸字符串，老客户端照旧能读
        hash: f.hashes[primary] || null,
        // 新增：说明 hash 用的是什么算法；多算法时 hashes 里全都有
        hashAlgo: primary,
        hashes: f.hashes,
        url: `${urlPrefix}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      }));
      // manifest.json 自己不该出现在下载清单里
      files = files.filter((f) => f.path !== 'manifest.json');
      // 代码轨道下的文件也不该出现在资源清单里：否则同一份 dll 会被下两次，
      // 而客户端无法区分"资源更新"和"代码更新"——这两个的失败处理策略完全不同。
      if (code) {
        const codePaths = new Set(code.files.map((f) => f.path));
        files = files.filter((f) => !codePaths.has(f.path));
      }
    }

    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

    const manifest = {
      platform,
      // 实际生效的渠道（可能和请求的不同：平铺布局下一定是默认渠道）
      channel: actualChannel,
      channelInUrl,
      // meta.channel 是使用方在 manifest.json 里写的标签，仅作展示；
      // 真正决定内容的是目录，这两者可以不一致，如实都给出。
      declaredChannel: meta.channel || null,
      version: meta.version || AssetServer.deriveVersion(files),
      minVersion: meta.minVersion || null,
      forceUpdate: Boolean(meta.forceUpdate),
      notice: meta.notice || '',
      hashAlgorithms: algos,
      fileCount: files.length,
      totalSize,
      generatedAt: new Date().toISOString(),
      files,
    };
    // 清单身份：内容变了它就变，用来固定版本、消除竞态。
    // 放在 files 之后算，因为它要覆盖文件列表本身。
    manifest.manifestId = AssetServer.manifestIdFor(manifest);
    if (code) manifest.code = code;
    if (meta._warning) manifest.warning = meta._warning;
    return manifest;
  }

  /**
   * 构建「代码热更」轨道。
   *
   * 为什么值得单独一条轨道，而不是让使用者把 dll 混在资源里：
   *
   *   1. **版本要分开**。成熟管线（YooAsset 的 Package Version vs App Version、
   *      Addressables、HybridCLR 的 DLL 集）里，代码版本和资源版本是两条独立的
   *      线：资源可以每天发好几个版本，代码可能一周才动一次。混在一个版本号里，
   *      客户端就没法只更其中一边。
   *
   *   2. **兼容性门禁**。这是 HybridCLR 时代最容易出的事故：热更 DLL 引用了
   *      主包没做 AOT 泛型生成的类型，**编译期毫无征兆，运行期才炸**，
   *      而且报错信息跟根因隔得很远。所以真实管线会声明
   *      "这份代码更新要求主包 >= X"，客户端据此决定要不要更。
   *      这里用 minAppVersion + aotHash 两个字段把这个门禁表达出来。
   *
   * 文件来源：优先用 code.files 完全自定义；否则扫描 code.dir（默认 "dll"）。
   * 目录不存在就认为没有代码轨道，返回 null，一切照旧。
   *
   * @param {string} platform
   * @param {string} platformDir
   * @param {object|undefined} raw manifest.json 里的 code 块
   */
  async _buildCodeTrack(platform, contentDir, raw, urlPrefix) {
    if (!raw || typeof raw !== 'object') return null;

    const dir = String(raw.dir || 'dll')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '') || 'dll';

    const algos = this.hashAlgorithms();
    const primary = algos[0];
    const prefix = urlPrefix || `/assets/${encodeURIComponent(platform)}`;

    /** 把扫描结果铺成统一的条目形状（和资源轨道一致）。 */
    const shape = (pathStr, size, hashes) => ({
      path: pathStr,
      size,
      hash: hashes[primary] || null,
      hashAlgo: primary,
      hashes,
      url: `${prefix}/${pathStr.split('/').map(encodeURIComponent).join('/')}`,
    });

    let files;
    if (Array.isArray(raw.files) && raw.files.length) {
      files = raw.files.map((f) => {
        const p = String(f.path || '').replace(/\\/g, '/');
        const declared = f.hash || f.md5 || null;
        const algo = f.hashAlgo || 'md5';
        const item = shape(p, Number(f.size) || 0, declared ? { [algo]: declared } : {});
        // 自定义清单允许直接给 url
        if (f.url) item.url = f.url;
        return item;
      });
    } else {
      const codeDir = this.safeResolve(contentDir, dir);
      if (!codeDir || !fs.existsSync(codeDir)) return null;
      // 第二个参数是 base：让 path 带上 "dll/" 前缀，URL 才对得上
      const scanned = await AssetServer.scanDirectory(codeDir, contentDir, 4, algos);
      files = scanned.map((f) => shape(f.path, f.size, f.hashes));
    }

    if (!files.length) return null;

    return {
      platform,
      dir,
      hashAlgorithms: algos,
      // 没写版本就按内容推导，和资源轨道同一套逻辑
      version: raw.version || AssetServer.deriveVersion(files),
      // 主包版本低于它就不能热更代码（AOT 元数据对不上）
      minAppVersion: raw.minAppVersion || null,
      // 期望的 AOT 元数据指纹；客户端把它算出来一起提交，对不上就说明不兼容
      aotHash: raw.aotHash || null,
      forceUpdate: Boolean(raw.forceUpdate),
      notice: raw.notice || '',
      fileCount: files.length,
      totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
      files,
    };
  }

  /** 清掉 manifest 缓存（上传新包后调用，让客户端立刻看到新版本）。 */
  invalidateManifest(platform) {
    if (platform) {
      // 渠道分键之后，一个平台对应多条缓存，按前缀一起清掉
      const prefix = `${platform}::`;
      for (const key of [...this.manifestCache.keys()]) {
        if (key === platform || key.startsWith(prefix)) this.manifestCache.delete(key);
      }
    } else {
      this.manifestCache.clear();
    }
  }

  /**
   * 递归扫描目录（异步），返回 [{path, size, hash}]，path 用正斜杠且相对平台目录。
   *
   * 用并发上限而不是 Promise.all 全放出去：一个平台目录下可能有上万个文件，
   * 同时打开上万个读流会把文件句柄耗尽。
   */
  static async scanDirectory(dir, base = dir, concurrency = 4, algos = ['md5']) {
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
              // 一次读盘算全部算法，所以多算法不额外增加 I/O
              hashes: (await AssetServer.hashFile(full, algos)) || {},
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
   * 流式计算文件的摘要，**一次读取可以同时算多个算法**。
   *
   * 为什么支持多算法：真实热更服务端会声明用的是什么（`{algo, value}`），
   * 让客户端有选择余地。多算一个摘要只是多 update 一次，I/O 成本不变 ——
   * 真正的开销在读文件，不在摘要计算。
   *
   * 绝不 readFileSync：那会把整个文件读进内存，并同步阻塞事件循环。
   *
   * @param {string} filePath
   * @param {string[]} algos 例如 ['md5'] 或 ['md5','sha256']
   * @returns {Promise<Record<string,string>|null>} 算法名 → 十六进制摘要
   */
  static hashFile(filePath, algos = ['md5']) {
    const list = (Array.isArray(algos) ? algos : [algos])
      .map((a) => String(a).toLowerCase())
      .filter((a) => crypto.getHashes().includes(a));
    if (!list.length) list.push('md5');

    return new Promise((resolve) => {
      const digests = list.map((algo) => ({ algo, hash: crypto.createHash(algo) }));
      let stream;
      try {
        stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      } catch {
        resolve(null);
        return;
      }
      stream.on('data', (chunk) => {
        for (const d of digests) d.hash.update(chunk);
      });
      stream.on('error', () => resolve(null));
      stream.on('end', () => {
        const out = {};
        for (const d of digests) out[d.algo] = d.hash.digest('hex');
        resolve(out);
      });
    });
  }

  /** 兼容旧调用点：只算 md5，返回裸字符串。 */
  static async md5File(filePath) {
    const hashes = await AssetServer.hashFile(filePath, ['md5']);
    return hashes ? hashes.md5 : null;
  }

  /**
   * 生成内容摘要型 ETag。
   *
   * 为什么不用「大小 + 修改时间」那种弱 ETag：
   *   清单里已经给了每个文件的内容 hash，如果 ETag 是另一套东西，客户端
   *   就没法把两者对上 —— 它手里明明有 hash，却还得再发一次条件请求去问
   *   "服务器上那个文件还是我这份吗"。
   *   让 ETag **就是**内容 hash 之后，客户端看清单即可本地决策，零请求。
   *
   * 强 ETag（不带 W/ 前缀）：同一个 hash 一定对应同一份字节内容。
   */
  static etagForHash(hexHash) {
    return `"${hexHash}"`;
  }

  /**
   * 退化用的弱 ETag：大小 + 修改时间。
   * 只在算不出内容摘要时使用（文件读不了），保证缓存仍能工作。
   */
  static weakEtagFor(stat) {
    return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  }

  /**
   * 清单身份：内容一变它就变，内容不变它就稳定。
   *
   * 用途是**消除竞态**。客户端典型流程是两步：
   *   1. GET /api/version      → 得知要更新到 1.2.0
   *   2. GET /api/manifest     → 取文件列表
   * 如果第 1 步和第 2 步之间有人在面板上换了配置，客户端会拿到 1.3.0 的文件列表，
   * 却以为自己在做 1.2.0 的更新 —— 下到一半的包和预期不符，而且**不报错**。
   *
   * 带上 manifestId 之后，客户端可以在第 2 步回传它；对不上服务端返回 409，
   * 客户端重新走一遍即可。这比"下完发现不对"便宜得多。
   *
   * 注意：这个值刻意**不包含 generatedAt**，否则每次重扫都会变，
   * 就失去了"内容相同则身份相同"的意义。
   */
  static manifestIdFor(manifest) {
    const hash = crypto.createHash('md5');
    hash.update(`v1|${manifest.platform}|${manifest.version}|${manifest.minVersion || ''}`);
    hash.update(`|${manifest.forceUpdate ? 1 : 0}|${manifest.channel || ''}|`);
    if (manifest.code) {
      hash.update(`code:${manifest.code.version}:${manifest.code.minAppVersion || ''}:`);
    }
    for (const f of [...(manifest.files || [])].sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`${f.path}:${f.size}:${f.hash || ''};`);
    }
    for (const f of [...((manifest.code && manifest.code.files) || [])]
      .sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`c:${f.path}:${f.size}:${f.hash || ''};`);
    }
    return hash.digest('hex').slice(0, 16);
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
