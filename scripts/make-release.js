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
const { finish } = require('./lib/exit');
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

/**
 * 根目录下**允许**进发行包的文档。
 *
 * 其余根目录 `.md` 一律不进包（**默认拒绝**）。
 * 为什么用白名单而不是黑名单：黑名单要求每新增一个内部文档都记得来加一条，
 * 漏一次就把开发过程的记录发给了使用方 —— 实际就漏过一次
 * （`模拟器评估报告.md` 没进黑名单，跟着 2.6.0 的包出去了）。
 * 白名单反过来：忘了加反而更安全。
 *
 * 判据仍然是"使用者需不需要它来用这个工具"：
 *   README.md    要，第一份说明
 *   CHANGELOG.md 要，使用方靠它判断这次要不要升级
 * 子目录里的文档不受影响（`backend/public/manual.*.md` 是面板要渲染的手册）。
 */
const SHIPPED_ROOT_DOCS = ['README.md', 'CHANGELOG.md'];

/** 这个仓库相对路径要不要排除在发行包之外。 */
function isInternalDoc(rel) {
  if (rel.includes('/')) return false;          // 只管根目录
  if (!rel.endsWith('.md')) return false;       // 只管 markdown
  return !SHIPPED_ROOT_DOCS.includes(rel);
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/**
 * 取 git 跟踪的文件列表，**按字面**原样取。
 *
 * 为什么必须加 -z：
 *   git 默认（core.quotePath=true）会对含非 ASCII 的路径加双引号并转成
 *   八进制转义，于是 `ls-files` 给出的是 `"\346\250\241..."` 这种字符串。
 *   拿它当文件名拼路径就直接 ENOENT，而且报错里的路径看着像乱码，
 *   很难一眼认出是转义问题 —— 实测就是被一个中文名的 md 文件绊倒的。
 *
 *   -z 以 NUL 分隔并原样输出路径，对空格、引号、换行、非 ASCII 一律安全。
 */
function gitListFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}

/**
 * 找 gh（GitHub CLI）。
 *
 * 优先 PATH；再兜底几个常见安装位置 —— 装在非系统盘时（实测见过
 * `D:\Program Files\GitHub CLI\`），PATH 里能不能找到取决于终端是不是
 * 安装之后才开的。
 */
function findGh() {
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || '', 'GitHub CLI'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'GitHub CLI'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI')]
      : ['/usr/bin', '/usr/local/bin', '/snap/bin'],
  );
  for (const d of dirs) {
    try {
      const p = path.join(d, exe);
      if (fs.existsSync(p)) return p;
    } catch { /* 目录名不合法，跳过 */ }
  }
  return null;
}

/**
 * 顺手在 GitHub 上建一个 Release，把 tgz 当附件传上去。
 *
 * **失败只警告，绝不让 `npm run release` 失败。** 打包是纯本地操作，
 * 和 GitHub 没有依赖关系：没装 gh、没登录、离线、或者这是别人的 fork ——
 * 都不该让"出个包"这件事做不成。
 *
 * 但也**不能静默跳过**：每一步跳过都说清原因和补救命令。
 * "跳过"和"做成了"分不出来，比直接报错还糟。
 *
 * @param {string} tarball
 */
function publishRelease(tarball) {
  const tag = `v${PKG.version}`;
  const skip = (why) => console.log(`\n— GitHub Release：跳过（${why}）`);

  const hasTag = (() => {
    try { return git('tag', '-l', tag) === tag; } catch { return false; }
  })();
  if (!hasTag) return skip(`本地没有 tag ${tag} —— 先 git tag -a ${tag} -m "..."`);

  // 必须确认 tag **已经推到远程**：否则 gh 会把 tag 建在默认分支 HEAD 上，
  // 可能指向一个和这次发布无关的提交，而且不报错
  const onRemote = (() => {
    try {
      return run('git', ['ls-remote', '--tags', 'origin', tag], { timeout: 20000 }).trim() !== '';
    } catch { return false; }
  })();
  if (!onRemote) return skip(`tag ${tag} 还没推到远程 —— git push origin ${tag}`);

  const gh = findGh();
  if (!gh) return skip('没找到 gh（GitHub CLI）');

  try {
    run(gh, ['auth', 'status'], { timeout: 20000 });
  } catch {
    return skip('gh 还没登录 —— gh auth login');
  }

  const already = (() => {
    try { run(gh, ['release', 'view', tag], { timeout: 20000 }); return true; } catch { return false; }
  })();
  if (already) return skip(`${tag} 的 Release 已经存在`);

  process.stdout.write(`\n— GitHub Release：创建 ${tag} … `);
  try {
    const url = run(gh, ['release', 'create', tag, tarball,
      '--title', PKG.version, '--generate-notes'], { timeout: 180000 }).trim();
    console.log('✓');
    console.log(`  ${url.split('\n').pop()}`);
  } catch (err) {
    console.log('✗');
    const msg = `${err.stdout || ''}${err.stderr || ''}`.trim() || err.message;
    console.log(`  ${msg.split('\n')[0]}`);
    console.log('  打包本身已经成功，这一步可以稍后手动重试。');
  }
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
    finish(1);
  }

  // ---- 1. 工作区必须干净 ----
  //
  // 发行包要能对应到某个确切的提交，否则出问题没法回溯"到底是哪份代码"。
  // 显示用的路径不要让 git 转义，否则中文文件名会变成 "\346\250\241..."，
  // 报错时看不出到底是哪个文件脏了
  const dirty = git('-c', 'core.quotePath=false', 'status', '--porcelain');
  if (dirty && !force) {
    console.error('工作区不干净，拒绝打包：\n');
    console.error(dirty.split('\n').map((l) => `  ${l}`).join('\n'));
    console.error('\n先提交，或者用 --force 强制打包（会在 RELEASE.txt 里标注 dirty）。');
    finish(1);
  }
  const commit = git('rev-parse', '--short', 'HEAD');
  console.log(`  提交     ${commit}${dirty && force ? '  ⚠️ 工作区脏（--force）' : ''}`);

  // ---- 2. 前端要先构建好 ----
  if (!skipBuild) {
    console.log('  构建前端 …');
    run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
  }
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('\n找不到 dist/。先跑 npm run build，或去掉 --skip-build。');
    finish(1);
  }

  // ---- 3. 铺开临时目录 ----
  if (fs.existsSync(STAGE)) removeDirSync(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  const tracked = gitListFiles();
  const excluded = [];
  const shipped = tracked.filter((rel) => {
    if (!isInternalDoc(rel)) return true;
    excluded.push(rel);
    return false;
  });
  for (const rel of shipped) copyFile(rel);
  console.log(`  源码     ${shipped.length} 个跟踪文件`);
  if (excluded.length) {
    console.log(`  排除     ${excluded.length} 个内部工作文档（使用者用不到，不该出现在发行包里）`);
    for (const rel of excluded) console.log(`             - ${rel}`);
  }
  console.log(`  文档     根目录只放行 ${SHIPPED_ROOT_DOCS.join(' / ')}，其余 .md 默认不进包`);

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
    '  * 不含内部工作文档（代码审计结论、待修清单等）',
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

  // ---- 7. 顺手在 GitHub 上建 Release ----
  if (!argv.includes('--no-github')) publishRelease(tarball);
}

main();
