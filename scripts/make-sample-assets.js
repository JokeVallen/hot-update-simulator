#!/usr/bin/env node
// scripts/make-sample-assets.js
//
// 生成一批示例热更包，用来测试下载、限速、断点续传、校验这些流程。
//
// 为什么内容用固定种子生成：这样同样参数每次跑出来的文件 md5 都一样，
// 清单里的版本号就不会莫名其妙地变，客户端也就不会误判"有新版本"。
//
// 用法：
//   npm run sample
//   node scripts/make-sample-assets.js --size 5 --count 4
//   node scripts/make-sample-assets.js --platforms Android,iOS,Windows --size 1
//   node scripts/make-sample-assets.js --clean          # 先清空再生成

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 删目录不能用 fs.rmSync：Windows + 非 ASCII 路径上它会静默失败甚至让进程硬崩。
// 详见 scripts/lib/safe-rm.js
const { removeDirSync } = require('./lib/safe-rm');

const STORAGE_ROOT = path.resolve(__dirname, '..', 'storage');
const ASSETS_ROOT = path.join(STORAGE_ROOT, 'assets');

/** 解析 --key value 形式的参数。 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sizeMb = Number(args.size) || 2;
const fileCount = Number(args.count) || 3;
const platforms = String(args.platforms || 'Android,iOS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 一个简单的确定性伪随机数生成器（xorshift32）。
 * 用它而不是 Math.random，是为了让每次生成的内容完全一致。
 */
function makeRandom(seed) {
  let state = seed >>> 0 || 1;
  return function next() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** 生成一个二进制文件，头部放一点可读标识，方便用十六进制工具确认内容。 */
function makeBundle(filePath, bytes, seed, label) {
  const random = makeRandom(seed);
  const buffer = Buffer.alloc(bytes);

  // 前 32 字节写成可见文本，用来看"这个文件是哪个平台哪个包的"
  const header = Buffer.from(`HU-SIM:${label}`.padEnd(32, '\0'), 'utf8').subarray(0, 32);
  header.copy(buffer, 0);

  for (let i = 32; i < bytes; i += 1) {
    buffer[i] = Math.floor(random() * 256);
  }

  fs.writeFileSync(filePath, buffer);
  return {
    path: path.relative(path.join(ASSETS_ROOT, label.split('/')[0]), filePath).split(path.sep).join('/'),
    size: bytes,
    hash: crypto.createHash('md5').update(buffer).digest('hex'),
  };
}

function main() {
  if (args.clean && fs.existsSync(ASSETS_ROOT)) {
    // 不用 fs.rmSync：资产目录里可能有一级子目录是中文平台名，
    // 而它在 Windows 上会静默失败甚至让进程硬崩。见 scripts/lib/safe-rm.js
    removeDirSync(ASSETS_ROOT);
    console.log(`已清空 ${ASSETS_ROOT}`);
  }

  const bytesPerFile = Math.round(sizeMb * 1024 * 1024);
  let created = 0;
  let totalBytes = 0;

  for (const platform of platforms) {
    const platformDir = path.join(ASSETS_ROOT, platform);
    const bundlesDir = path.join(platformDir, 'bundles');
    fs.mkdirSync(bundlesDir, { recursive: true });

    const files = [];
    for (let i = 1; i <= fileCount; i += 1) {
      // 每个文件的种子由平台名和序号决定，保证可重现
      const seed = crypto
        .createHash('md5')
        .update(`${platform}-${i}`)
        .digest()
        .readUInt32BE(0);

      const fileName = `${platform.toLowerCase()}_bundle_${String(i).padStart(2, '0')}.ab`;
      const filePath = path.join(bundlesDir, fileName);
      const info = makeBundle(filePath, bytesPerFile, seed, `${platform}/bundles/${fileName}`);

      files.push({
        path: `bundles/${fileName}`,
        size: info.size,
        hash: info.hash,
      });

      created += 1;
      totalBytes += info.size;
    }

    // 代码热更轨道的示例文件。
    //
    // 为什么示例里也要放：代码热更和资源热更是**两条独立轨道**（独立版本 +
    // AOT 兼容性门禁），只写在文档里是个抽象概念。放两个假 dll 进去，
    // 启动后 `curl /api/manifest?platform=X&track=code` 就能直接看到效果，
    // 也能顺便验证客户端把两条轨道分开处理的逻辑。
    const dllDir = path.join(platformDir, 'dll');
    fs.mkdirSync(dllDir, { recursive: true });
    const dllFiles = [
      { name: 'Assembly-CSharp.dll.bytes', bytes: 256 * 1024, seed: 1001 },
      { name: 'GameLogic.dll.bytes', bytes: 128 * 1024, seed: 1002 },
    ];
    for (const dll of dllFiles) {
      makeBundle(path.join(dllDir, dll.name), dll.bytes, dll.seed, `${platform}/dll/${dll.name}`);
    }

    // 清单元信息。文件列表故意不写进 manifest.json，
    // 让服务器去扫描目录 —— 这样你手动往目录里丢文件也能立刻生效。
    const manifest = {
      version: '1.0.0',
      minVersion: '0.9.0',
      forceUpdate: false,
      notice: `${platform} 示例资源包，由 scripts/make-sample-assets.js 生成`,
      channel: 'default',
      // 代码轨道。minAppVersion / aotHash 是给客户端做兼容性门禁用的：
      // 把 minAppVersion 调高，或改掉 aotHash，就能测客户端会不会真的挡住，
      // 而不是闭着眼睛更一份跑不起来的代码。
      code: {
        version: '1.0.0',
        minAppVersion: '0.9.0',
        aotHash: 'sample-aot-hash',
        forceUpdate: false,
        notice: `${platform} 示例代码包`,
        dir: 'dll',
      },
    };
    fs.writeFileSync(
      path.join(platformDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    console.log(
      `${platform.padEnd(10)} ${String(files.length).padStart(2)} 个文件，`
      + `每个 ${sizeMb} MB，合计 ${(files.length * bytesPerFile / 1024 / 1024).toFixed(1)} MB`,
    );
  }

  console.log('');
  console.log(`生成完成：${created} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`位置：${ASSETS_ROOT}`);
  console.log('');
  console.log('提示：清单有 10 秒缓存，重新生成后执行下面这行可以立刻刷新：');
  console.log('  curl -X POST http://localhost:5500/api/manifest/refresh');
}

main();
