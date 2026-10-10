#!/usr/bin/env node
// scripts/arch-report.js
//
// 架构度量报告。用可复现的数字回答"这套代码的结构是不是在烂掉"。
//
// 为什么需要它：代码审查是主观的，而"模块依赖图里有没有环""分层有没有被打破"
// "单文件有多大"是客观的、能重复测出来的。主观结论可以争，数字不行。
//
// 它检查四件事：
//   1. 依赖图与**循环依赖**（有环就意味着两个模块无法独立理解和测试）
//   2. **分层方向**（core 不能反过来依赖 modules / routes）
//   3. 扇入扇出（谁是枢纽、谁是孤儿）
//   4. 规模分布（文件行数、函数长度、嵌套深度）
//
// 用法：npm run arch

const fs = require('fs');
const { finish } = require('./lib/exit');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['backend', 'frontend/src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'storage', '.git', 'ui-check-shots']);

/** 分层定义：数字越小越底层。上层可以依赖下层，反之是违规。 */
const LAYERS = [
  { name: 'core', match: /^backend[/\\]core[/\\]/, level: 0 },
  { name: 'utils', match: /^backend[/\\]utils[/\\]/, level: 0 },
  { name: 'modules', match: /^backend[/\\]modules[/\\]/, level: 2 },
  { name: 'middleware', match: /^backend[/\\]middleware[/\\]/, level: 3 },
  { name: 'routes', match: /^backend[/\\]routes[/\\]/, level: 4 },
  { name: 'app', match: /^backend[/\\](app|server)\.js$/, level: 5 },
  { name: 'frontend', match: /^frontend[/\\]src[/\\]/, level: 1 },
  { name: 'scripts', match: /^scripts[/\\]/, level: 6 },
];

function layerOf(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  for (const layer of LAYERS) {
    if (layer.match.test(relPath) || layer.match.test(normalized)) return layer;
  }
  return { name: 'other', level: 99 };
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 用正则抽取 require / import 的目标。对这个代码库的风格足够准确。 */
function extractDeps(source) {
  const deps = new Set();
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m = re.exec(source);
    while (m) {
      deps.add(m[1]);
      m = re.exec(source);
    }
  }
  return [...deps];
}

/** 把依赖说明符解析成文件路径（只关心仓库内部的相对依赖）。 */
function resolveDep(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 外部包不算内部依赖
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Tarjan 强连通分量，用来找环。 */
function findCycles(nodes, edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  function strongConnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) || []) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }

    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      // 单个节点且没有自环不算环
      if (component.length > 1) cycles.push(component);
      else if ((edges.get(v) || []).includes(v)) cycles.push(component);
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node);
  }
  return cycles;
}

/** 粗略统计函数长度与嵌套深度。不是精确的 AST 分析，但足以暴露趋势。 */
function measureFunctions(source) {  const lines = source.split('\n');
  const functions = [];
  const declRe = /^\s*(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*\([^)]*\)\s*\{|(\w+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>)/;
  let current = null;
  let depth = 0;
  let maxDepth = 0;

  lines.forEach((line, i) => {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (!current) {
      // 跳过注释行
      if (!line.trim().startsWith('//') && !line.trim().startsWith('*')) {
        const m = declRe.exec(line);
        if (m) {
          current = { name: m[1] || m[2] || m[3] || '(anon)', start: i + 1, depth: 0 };
          maxDepth = 0;
        }
      }
    }

    depth += opens - closes;
    if (current) {
      maxDepth = Math.max(maxDepth, depth - (current.baseDepth || 0));
    }

    if (current && depth <= (current.baseDepth || 0) && i > current.start - 1) {
      current.lines = i + 1 - current.start;
      current.depth = maxDepth;
      functions.push(current);
      current = null;
      depth = 0;
      maxDepth = 0;
    }
  });

  return functions;
}

function main() {
  const started = performance.now();
  const files = [];
  for (const dir of SCAN_DIRS) {
    walk(path.join(ROOT, dir), files);
  }

  const rel = (f) => path.relative(ROOT, f);
  const nodes = files.map(rel);
  const edges = new Map(nodes.map((n) => [n, []]));
  const externalDeps = new Set();
  const fileStats = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const key = rel(file);
    const deps = extractDeps(source);

    for (const spec of deps) {
      const resolved = resolveDep(file, spec);
      if (resolved) {
        const target = rel(resolved);
        if (target !== key && edges.has(target)) edges.get(key).push(target);
      } else if (!spec.startsWith('.')) {
        externalDeps.add(spec.split('/')[0].startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]);
      }
    }

    const lines = source.split('\n').length;
    const functions = measureFunctions(source);
    fileStats.push({
      file: key,
      lines,
      functions: functions.length,
      longest: functions.reduce((max, f) => Math.max(max, f.lines || 0), 0),
      deepest: functions.reduce((max, f) => Math.max(max, f.depth || 0), 0),
      layer: layerOf(key).name,
    });
  }

  // ------------------------------------------------------------ 循环依赖
  const cycles = findCycles(nodes, edges);

  // ------------------------------------------------------------ 分层违规
  const violations = [];
  for (const [from, tos] of edges) {
    const fromLayer = layerOf(from);
    for (const to of tos) {
      const toLayer = layerOf(to);
      if (fromLayer.level < toLayer.level) {
        violations.push({ from, fromLayer: fromLayer.name, to, toLayer: toLayer.name });
      }
    }
  }

  // ------------------------------------------------------------ 扇入扇出
  const fanOut = new Map();
  const fanIn = new Map(nodes.map((n) => [n, 0]));
  for (const [from, tos] of edges) {
    fanOut.set(from, tos.length);
    for (const to of tos) fanIn.set(to, (fanIn.get(to) || 0) + 1);
  }

  const orphans = nodes.filter((n) => (fanIn.get(n) || 0) === 0
    && !/^(backend[/\\](app|server)\.js|scripts[/\\]|frontend[/\\]src[/\\]main\.js)/.test(n));

  const hubs = [...fanIn.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]);

  // ------------------------------------------------------------ 输出
  const totalLines = fileStats.reduce((n, f) => n + f.lines, 0);
  const totalFunctions = fileStats.reduce((n, f) => n + f.functions, 0);

  console.log('');
  console.log('架构度量报告');
  console.log('='.repeat(64));
  console.log(`文件数        ${files.length}`);
  console.log(`总行数        ${totalLines}`);
  console.log(`函数数        ${totalFunctions}`);
  console.log(`模块依赖边数  ${[...edges.values()].reduce((n, t) => n + t.length, 0)}`);
  console.log(`外部依赖      ${[...externalDeps].sort().join(', ')}`);
  console.log(`分析耗时      ${(performance.now() - started).toFixed(0)} ms`);

  console.log('');
  console.log('--- 循环依赖 ---');
  if (!cycles.length) {
    console.log('  ✓ 没有循环依赖。依赖图是一个有向无环图，模块可以独立理解和测试。');
  } else {
    console.log(`  ✗ 发现 ${cycles.length} 组循环依赖：`);
    for (const c of cycles) console.log(`      ${c.join('  <->  ')}`);
  }

  console.log('');
  console.log('--- 分层方向 ---');
  console.log('  约定：core/utils(0) → frontend(1) → modules(2) → middleware(3) → routes(4) → app(5)');
  console.log('        上层可以依赖下层，反向即违规。');
  if (!violations.length) {
    console.log('  ✓ 没有反向依赖。');
  } else {
    console.log(`  ✗ 发现 ${violations.length} 处反向依赖：`);
    for (const v of violations) {
      console.log(`      ${v.fromLayer}(${v.from})  →  ${v.toLayer}(${v.to})`);
    }
  }

  console.log('');
  console.log('--- 扇入 >= 3 的模块（被多处依赖，改动影响面大）---');
  if (!hubs.length) console.log('  （无）');
  for (const [file, count] of hubs) console.log(`  ${String(count).padStart(2)}  ${file}`);

  console.log('');
  console.log('--- 没有任何模块引用的文件（可能是死代码）---');
  if (!orphans.length) console.log('  ✓ 没有孤儿模块。');
  for (const o of orphans) console.log(`      ${o}`);

  console.log('');
  console.log('--- 规模最大的 8 个文件 ---');
  console.log('  注意：这里的长/深是**基于文本的粗略估算**。对 class 体它会把整个类');
  console.log('  当成一个"函数"，所以 assetServer(552 行/1 函数) 这类数字会偏大。');
  console.log('  精确的函数粒度请看 `npm run lint` 里 max-lines-per-function 的告警。');
  const byLines = [...fileStats].sort((a, b) => b.lines - a.lines).slice(0, 8);
  for (const f of byLines) {
    console.log(`  ${String(f.lines).padStart(4)} 行  ${String(f.functions).padStart(3)} 函数  `
      + `最长函数 ${String(f.longest).padStart(3)} 行  最深嵌套 ${f.deepest}  ${f.file}`);
  }

  console.log('');
  console.log('--- 按分层统计 ---');
  const byLayer = new Map();
  for (const f of fileStats) {
    const cur = byLayer.get(f.layer) || { files: 0, lines: 0 };
    cur.files += 1;
    cur.lines += f.lines;
    byLayer.set(f.layer, cur);
  }
  for (const [name, stat] of [...byLayer.entries()].sort((a, b) => a[1].lines - b[1].lines)) {
    console.log(`  ${name.padEnd(12)} ${String(stat.files).padStart(3)} 个文件  ${String(stat.lines).padStart(5)} 行`);
  }

  console.log('');
  console.log('='.repeat(64));
  const healthy = !cycles.length && !violations.length;
  console.log(healthy
    ? '结论：无环、无反向依赖，依赖方向是单向的。'
    : '结论：结构问题见上。');
  console.log('');

  finish(healthy ? 0 : 1);
}

main();
