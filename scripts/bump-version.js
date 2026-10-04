#!/usr/bin/env node
// scripts/bump-version.js
//
// 升版本号，并把该同步的地方一次性改对。
//
// 为什么不用 `npm version`：
//   它只改**当前目录**的 package.json。而本项目有两份（根的和 frontend/ 的），
//   于是 `npm version minor` 之后，两处版本号立刻漂移 ——
//   而且它们看起来都"像"是对的，不会有人发现。
//   版本号一旦对外承诺，这种漂移比报错还麻烦。
//
// 这个脚本做四件事，都是"漏一件就出问题"的：
//   1. 校验新版本号格式合法、且确实比当前版本大
//   2. 同时更新根 package.json 和 frontend/package.json
//   3. 在 CHANGELOG.md 顶部插入对应的小节（带日期和空的分类骨架）
//   4. 打印接下来该做什么（填内容、提交、打 tag）
//
// 用法：
//   npm run bump 1.1.0        # 指定版本
//   npm run bump minor        # 或者给 patch|minor|major，自动推算

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_PKG = path.join(ROOT, 'package.json');
const FRONTEND_PKG = path.join(ROOT, 'frontend', 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(v) {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

/** 语义化比较：只看三段数字，预发布版本视为更小（和项目里的 compareVersions 口径一致）。 */
function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) return a.pre === b.pre ? 0 : (a.pre < b.pre ? -1 : 1);
  return 0;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const current = require(ROOT_PKG).version;
const currentParsed = parse(current);
const arg = String(process.argv[2] || '').trim();

if (!arg) {
  console.error('用法：npm run bump <版本号|patch|minor|major>');
  console.error(`当前版本：${current}`);
  process.exit(1);
}

// ---- 算出目标版本 ----
let next;
if (['patch', 'minor', 'major'].includes(arg)) {
  const b = { ...currentParsed, pre: null };
  if (arg === 'major') { b.major += 1; b.minor = 0; b.patch = 0; }
  else if (arg === 'minor') { b.minor += 1; b.patch = 0; }
  else b.patch += 1;
  next = `${b.major}.${b.minor}.${b.patch}`;
} else {
  next = arg.replace(/^v/, '');
}

const nextParsed = parse(next);
if (!nextParsed) {
  console.error(`"${arg}" 不是合法的版本号。应当形如 1.2.3 或 1.2.3-beta.1`);
  process.exit(1);
}
if (compare(nextParsed, currentParsed) <= 0) {
  console.error(`新版本号必须大于当前版本：${next} <= ${current}`);
  process.exit(1);
}

console.log(`版本号：${current} → ${next}\n`);

// ---- 1. 两份 package.json 一起改 ----
function bumpPkg(file, label) {
  const raw = fs.readFileSync(file, 'utf8');
  const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
  if (updated === raw) {
    console.error(`  ✗ ${label} 里没找到 version 字段，没有改动`);
    process.exit(1);
  }
  fs.writeFileSync(file, updated, 'utf8');
  console.log(`  ✓ ${label} → ${next}`);
}
bumpPkg(ROOT_PKG, 'package.json');
bumpPkg(FRONTEND_PKG, 'frontend/package.json');

// ---- 2. 在 CHANGELOG 里插入小节 ----
const changelog = fs.readFileSync(CHANGELOG, 'utf8');
if (new RegExp(`^##\\s+\\[?${next.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm').test(changelog)) {
  console.log(`  · CHANGELOG.md 已有 ${next} 的小节，跳过`);
} else {
  const lines = changelog.split('\n');
  // 插到「## 未发布」之后；没有「未发布」就插到第一个版本小节之前
  let at = lines.findIndex((l) => /^##\s+未发布\s*$/.test(l));
  if (at >= 0) {
    at += 1;
    // 跳过紧跟的空行，让插入位置干净
    while (at < lines.length && lines[at].trim() === '') at += 1;
  } else {
    at = lines.findIndex((l) => /^##\s+\[?\d/.test(l));
    if (at < 0) at = lines.length;
  }

  const section = [
    `## ${next} - ${today()}`,
    '',
    '### 新增',
    '',
    '### 变更',
    '',
    '### 修复',
    '',
  ];
  lines.splice(at, 0, ...section);
  fs.writeFileSync(CHANGELOG, lines.join('\n'), 'utf8');
  console.log(`  ✓ CHANGELOG.md 插入了 ${next} 的小节（${today()}）`);
}

// ---- 3. 自检一次 ----
console.log('');
try {
  require('child_process').execFileSync(process.execPath, ['scripts/version-check.js'],
    { cwd: ROOT, stdio: 'inherit' });
} catch {
  console.error('\n版本检查没过。把 CHANGELOG 里空的小节填上内容再试。');
  process.exit(1);
}

console.log('\n接下来：');
console.log(`  1. 把这次改动填进 CHANGELOG.md 的 ${next} 小节`);
console.log('     （分类是「新增 / 变更 / 修复」，用不着的小节删掉）');
console.log('  2. git add -A && git commit -m "chore: 发布 ' + next + '"');
console.log(`  3. git tag v${next}`);
console.log('  4. npm run release');
