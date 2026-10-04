#!/usr/bin/env node
// scripts/version-check.js
//
// 版本号与变更记录的一致性检查。
//
// 为什么值得单独有一个脚本：
//   版本号一旦开始对外承诺，"改没改对"和"记没记上"就是两件必须一起做的事。
//   漏掉任何一件的后果都不小 ——
//     * 改了版本号忘了写 CHANGELOG：用的人不知道这次要不要升级、升了会怎样
//     * 只改了根 package.json 忘了前端那份：两处版本号开始漂移，
//       而它们看起来都"像"是对的
//     * 版本号格式写错（v1.0 / 1.0）：语义化比较、发行包命名全都会歪
//   这些靠自觉是保不住的，所以做成检查。
//
// 用法：npm run version-check
// 也会被 npm run release 自动调用 —— 没有变更记录的版本不允许打包出去。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const frontendPkg = require(path.join(ROOT, 'frontend', 'package.json'));
const changelogPath = path.join(ROOT, 'CHANGELOG.md');

const VERSION = pkg.version;
const problems = [];
const checked = [];

function ok(label, detail = '') {
  checked.push([true, label, detail]);
}
function bad(label, detail = '') {
  checked.push([false, label, detail]);
  problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- 1. 版本号格式必须是严格的 semver ----
//
// 不用正则硬凑：semver 的合法形式比看上去复杂（预发布、构建元数据）。
// 这里用宽松但足够严的检查，并明确要求三段数字。
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (SEMVER.test(VERSION)) ok('package.json 的版本号是合法 semver', VERSION);
else bad('package.json 的版本号不是合法 semver', `得到 ${JSON.stringify(VERSION)}`);

// ---- 2. 前端那份不能漂移 ----
if (frontendPkg.version === VERSION) {
  ok('frontend/package.json 的版本号与根一致', VERSION);
} else {
  bad('frontend/package.json 的版本号与根不一致',
    `根 ${VERSION} vs 前端 ${frontendPkg.version} —— 两处都要改`);
}

// ---- 3. CHANGELOG 必须有当前版本的小节 ----
if (!fs.existsSync(changelogPath)) {
  bad('CHANGELOG.md 存在');
} else {
  const text = fs.readFileSync(changelogPath, 'utf8');
  const lines = text.split('\n');

  // 匹配形如 `## 1.0.0 - 2026-10-04` 或 `## [1.0.0] - 2026-10-04`
  const heading = new RegExp(`^##\\s+\\[?${VERSION.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm');
  const match = heading.exec(text);

  if (!match) {
    bad('CHANGELOG.md 里有当前版本的小节',
      `没有找到 "## ${VERSION}" —— 加了功能就要记一笔`);
  } else {
    const start = lines.findIndex((l) => l.includes(match[0].trim()));
    // 小节内容 = 从这个标题到下一個同级标题
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    const body = lines.slice(start + 1, end).join('\n').trim();

    if (!body) {
      bad(`CHANGELOG.md 里 ${VERSION} 的小节不是空的`, '标题下面什么都没有');
    } else {
      ok('CHANGELOG.md 里有当前版本的小节且非空', `${body.split('\n').length} 行内容`);
    }

    // 日期格式：有的话必须是 YYYY-MM-DD
    //
    // 注意要拿**完整的那一行**来解析。match[0] 只匹配到版本号后的第一个空白
    // 就结束了（正则里是 `(?:\s|$)`），里面根本没有日期。
    const headingLine = lines[start];
    const dateMatch = /^##\s+\[?[\d.]+\]?\s+-\s+(.+?)\s*$/.exec(headingLine);
    if (dateMatch) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateMatch[1])) {
        ok('版本小节带合法日期', dateMatch[1]);
      } else {
        bad('版本小节的日期格式应为 YYYY-MM-DD', `得到 ${JSON.stringify(dateMatch[1])}`);
      }
    } else {
      bad('版本小节应当带日期', `写成 "## ${VERSION} - YYYY-MM-DD"，实际是 ${JSON.stringify(headingLine.trim())}`);
    }
  }

  // ---- 4. 最新的版本小节必须是最上面那个 ----
  //
  // 顺序反了不会报错，但读的人会以为最新的是旧的，白白浪费一次排查。
  const allHeadings = [...text.matchAll(/^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/gm)]
    .map((m) => m[1]);
  if (allHeadings.length >= 2) {
    const cmp = (a, b) => {
      const pa = a.split('-')[0].split('.').map(Number);
      const pb = b.split('-')[0].split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    };
    const descending = allHeadings.every((v, i) => i === 0 || cmp(allHeadings[i - 1], v) >= 0);
    if (descending) ok('CHANGELOG 的版本小节从新到旧排列', allHeadings.join(' > '));
    else bad('CHANGELOG 的版本小节没有按从新到旧排列', allHeadings.join(' > '));
  }
}

// ---- 输出 ----
console.log('版本一致性检查\n');
for (const [good, label, detail] of checked) {
  console.log(`  ${good ? '✓' : '✗'} ${label}${detail ? `  （${detail}）` : ''}`);
}

console.log('');
if (problems.length === 0) {
  console.log(`全部通过。当前版本 ${VERSION}。`);
  process.exit(0);
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  console.log('发新版本的正确顺序：');
  console.log('  1. 把改动写进 CHANGELOG.md（新开一个小节，带日期）');
  console.log('  2. npm run bump patch|minor|major   # 两份 package.json 一起改，并插入 CHANGELOG 骨架');
  console.log('  3. 填完 CHANGELOG，提交并 git tag');
  console.log('  4. npm run release');
  process.exit(1);
}
