#!/usr/bin/env node
// scripts/make-release.js
//
// 打一个「使用版」的发型包，和开发目录彻底分开。
//
// 为什么需要它：
//   在此之前项目**没有发行版本** —— 仓库本身就是产品，想用只能把开发目录
//   整个复制一份。而开发目录里有 node_modules、storage（示例包/收藏/方案）、
//   构建产物，还有一份**被使用过程改写过的 backend/config.json**。
//   直接复制等于把开发状态一起带过去。
//
// 这个脚本产出的包：
//   * 只含 git 跟踪的文件（+ 构建好的前端），没有 node_modules、没有 storage
//   * `backend/config.json` 被**重置成默认值** —— 这是关键：
//     那份文件是跟踪的、又会被界面改写，开发时留下的故障规则/模拟参数
//     会原样进到发行包里。发行版必须是干净的默认状态。
//   * 附一份 RELEASE.txt 说明来自哪个提交、怎么用
//
// 用法：
//   npm run release              # 工作区干净时才允许打
//   npm run release -- --force   # 工作区脏也照打（会标注出来）
//   npm run release -- --skip-build   # 不重新构建前端（用现有 dist）

const { execFileSync } = require('child_process');
const { exitAfterFlush } = require('./lib/exit');
const fs = require('fs');
const path = require('path');
const { removeDirSync } = require('./lib/safe-rm');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const ConfigManager = require(path.join(ROOT, 'backend', 'core', 'configManager'));

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const skipBuild = argv.includes('--skip-build');

const OUT_DIR = path.join(ROOT, 'release');
const NAME = `${PKG.name}-${PKG.version}`;
const STAGE = path.join(OUT_DIR, NAME);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}

function copyFile(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function main() {
  console.log(`打包 ${NAME}\n`);

  // ---- 0. 版本号与变更记录必须一致 ----
  //
  // 放在最前面：没有变更记录的版本不允许打包出去。
  // 发行包的用途正是"给使用方一个新版本"，而使用方要靠 CHANGELOG 判断
  // 这次要不要升级、升了会怎样。
  try {
    run(process.execPath, ['scripts/version-check.js']);
  } catch (err) {
    console.error(String(err.stdout || '').trim());
    console.error('\n版本检查没过，拒绝打包。');
    exitAfterFlush(1);
  }

  // ---- 1. 工作区必须干净 ----
  //
  // 发行包要能对应到某个确切的提交，否则出问题没法回溯"到底是哪份代码"。
  const dirty = git('status', '--porcelain');
  if (dirty && !force) {
    console.error('工作区不干净，拒绝打包：\n');
    console.error(dirty.split('\n').map((l) => `  ${l}`).join('\n'));
    console.error('\n先提交，或者用 --force 强制打包（会在 RELEASE.txt 里标注 dirty）。');
    exitAfterFlush(1);
  }
  const commit = git('rev-parse', '--short', 'HEAD');
  console.log(`  提交     ${commit}${dirty ? '  ⚠️ 工作区脏（--force）' : ''}`);

  // ---- 2. 前端要先构建好 ----
  if (!skipBuild) {
    console.log('  构建前端 …');
    run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
  }
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('\n找不到 dist/。先跑 npm run build，或去掉 --skip-build。');
    exitAfterFlush(1);
  }

  // ---- 3. 铺开临时目录 ----
  if (fs.existsSync(STAGE)) removeDirSync(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  const tracked = git('ls-files').split('\n').filter(Boolean);
  for (const rel of tracked) copyFile(rel);
  console.log(`  源码     ${tracked.length} 个跟踪文件`);

  copyDir(dist, path.join(STAGE, 'dist'));
  console.log('  前端     dist/（开箱即可 npm start，不用再构建）');

  // ---- 4. 把配置重置成默认值 ----
  //
  // 这一步是打包的重点。backend/config.json 是被 git 跟踪的，同时又是
  // 界面上改一下就会写盘的文件 —— 开发时调出来的模拟参数、故障规则、
  // 灰度开关全都在里面。不重置的话，发行包一打开就是开发时的状态。
  fs.writeFileSync(
    path.join(STAGE, 'backend', 'config.json'),
    `${JSON.stringify(ConfigManager.DEFAULTS, null, 2)}\n`,
    'utf8',
  );
  console.log('  配置     已重置为默认值（不含开发时调出来的参数）');

  // ---- 5. 附一份说明 ----
  fs.writeFileSync(path.join(STAGE, 'RELEASE.txt'), [
    `${PKG.name} ${PKG.version}`,
    `构建时间   ${new Date().toISOString()}`,
    `来源提交   ${commit}${dirty ? '（工作区有未提交改动）' : ''}`,
    '',
    '这是一个「使用版」包，和开发目录无关：',
    '  * 不含 node_modules / storage / 开发时的配置',
    '  * backend/config.json 是干净的默认值',
    '  * dist/ 已构建好，不需要再跑前端构建',
    '',
    '怎么用：',
    '  npm install                    # 只装后端依赖',
    '  npm run sample                 # 生成示例热更包（可选）',
    '  npm start                      # http://localhost:5500',
    '',
    '想让它和别的项目彻底隔离（数据放到这个目录之外）：',
    '  HOT_UPDATE_STORAGE=D:\\hus-data npm start',
    '',
    '想让别的设备（手机 / 另一台电脑）访问：',
    '  HOST=0.0.0.0 npm start',
    '  然后在那台设备上打开 http://<本机IP>:5500',
    '  ⚠️ 控制接口没有认证，绑 0.0.0.0 等于开放给同一局域网。只在联调时开。',
    '',
  ].join('\n'), 'utf8');

  // ---- 6. 打包 ----
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tarball = path.join(OUT_DIR, `${NAME}.tgz`);
  if (fs.existsSync(tarball)) fs.unlinkSync(tarball);
  run('tar', ['-czf', tarball, '-C', OUT_DIR, NAME]);

  removeDirSync(STAGE);

  const mb = (fs.statSync(tarball).size / 1024 / 1024).toFixed(2);
  console.log(`\n完成：${path.relative(ROOT, tarball)}  (${mb} MB)`);
  console.log('\n在别处使用：');
  console.log(`  mkdir D:\\hus-runtime && tar -xzf ${NAME}.tgz -C D:\\hus-runtime --strip-components=1`);
  console.log('  cd D:\\hus-runtime && npm install && npm start');
}

main();
