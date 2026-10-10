#!/usr/bin/env node
// scripts/docs-coverage.js
//
// 文档覆盖度自检：把代码里**真实存在的功能面**抽出来，逐项对照手册是否写到。
//
// 为什么需要它：文档漂移是悄悄发生的 —— 加了一个接口、一种故障类型、
// 一个配置项，手册不会自己更新，而且没人会定期去核对。靠人肉比对 500 行
// markdown 和 30 个接口，漏是必然的。
//
// 覆盖判定用的是"字面出现"，所以会有假阴性（手册用别的话描述了某个功能）。
// 因此脚本把未覆盖项列出来给人判断，而不是直接判死刑；确实属于
// "换了说法描述"的，加进 ALLOWLIST 并写清理由。
//
// 用法：npm run docs-check

const fs = require('fs');
const { finish } = require('./lib/exit');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANUALS = {
  'zh-CN': path.join(ROOT, 'backend', 'public', 'manual.zh-CN.md'),
  en: path.join(ROOT, 'backend', 'public', 'manual.en.md'),
};

/**
 * 允许"不写进手册"的项，以及理由。
 * 每一条都必须是深思熟虑的决定，不能因为"懒得写"就往这里塞。
 */
const ALLOWLIST = {
  endpoint: new Set([
    // 面板自己渲染手册用的数据通道，不是给客户端用的功能接口
    '/manual.md',
    // Swagger 原始 spec，/docs 页面自己会拉
    '/openapi.json',
  ]),
  configField: new Set([
    // 内部实现细节，使用者不需要也不应该去改
    'server.publicDir',
    'logging.maxEntries',
  ]),
  script: new Set([
    // 只是 `cd frontend && npm run dev` 的别名，手册的快速开始给的是等价写法。
    // 列两个只会让读者犹豫该用哪个。
    'dev:web',
  ]),
  preset: new Set([]),
};

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------- 抽取功能面

/** 从 routes/*.js 的 @openapi 注释里抽接口路径。 */
function extractEndpoints() {
  const dir = path.join(ROOT, 'backend', 'routes');
  const found = new Map(); // path -> 来源文件
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const text = read(path.join(dir, file));
    const re = /^\s*\*\s*(\/[A-Za-z0-9_/:{}-]+):\s*$/gm;
    let m = re.exec(text);
    while (m) {
      found.set(m[1], file);
      m = re.exec(text);
    }
  }

  // app.js 里直接挂的非 /api 路由
  const app = read(path.join(ROOT, 'backend', 'app.js'));
  const appRe = /app\.(?:use|get)\('(\/[A-Za-z0-9_/.:-]*)'/g;
  let a = appRe.exec(app);
  while (a) {
    if (a[1] !== '/') found.set(a[1], 'app.js');
    a = appRe.exec(app);
  }

  return found;
}

/** 从 configManager 的 DEFAULTS 抽配置项的 dotted path。 */
function extractConfigFields() {
  const { DEFAULTS } = require(path.join(ROOT, 'backend', 'core', 'configManager.js'));
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else out.push(key);
    }
  };
  walk(DEFAULTS, '');
  return out;
}

/** 故障类型。 */
function extractFaultTypes() {
  const { FAULT_TYPES, ACTION_FIELDS } = require(path.join(ROOT, 'backend', 'core', 'faultRule.js'));
  return { types: FAULT_TYPES, fields: ACTION_FIELDS };
}

/** 内置预置方案。 */
function extractPresets() {
  const { BUILTIN_PRESETS } = require(path.join(ROOT, 'backend', 'routes', 'presets.js'));
  return BUILTIN_PRESETS.map((p) => ({ id: p.id, name: p.name }));
}

/** npm 脚本。 */
function extractScripts() {
  const pkg = require(path.join(ROOT, 'package.json'));
  return Object.keys(pkg.scripts);
}

/** 面板页面。 */
function extractPanelRoutes() {
  const main = read(path.join(ROOT, 'frontend', 'src', 'main.js'));
  const block = /const ROUTES = \{([\s\S]*?)\n\}/.exec(main);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------- 覆盖判定

function makeChecker(manualText) {
  return (needle) => manualText.includes(needle);
}

/**
 * 配置项检查用的是**叶子名**（`assetDir`）而不是完整路径（`server.assetDir`）。
 * 手册里是以 JSONC 示例的形式给出配置的，字段名和层级靠缩进表达，
 * 完整路径不会字面出现。用完整路径匹配会产生大片假阴性。
 */
function configLeaf(dotted) {
  return dotted.split('.').pop();
}

/**
 * 面板页面检查用**界面上的名称**（总览 / 故障注入 / …），
 * 而不是路由 key（dashboard / faults / …）——手册是给人看的，
 * 用的是界面上显示的名字。名称取自语言包，保证和界面一致。
 */
function panelLabels() {
  const zh = JSON.parse(read(path.join(ROOT, 'frontend', 'src', 'locales', 'zh-CN.json')));
  const en = JSON.parse(read(path.join(ROOT, 'frontend', 'src', 'locales', 'en.json')));
  return { zh: zh.nav, en: en.nav };
}

function report(title, items, covered, extra = '') {
  const missing = items.filter((i) => !covered(i));
  const mark = missing.length ? '✗' : '✓';
  console.log(`\n${mark} ${title}  共 ${items.length} 项，已覆盖 ${items.length - missing.length} 项${extra}`);
  for (const m of missing) console.log(`      未覆盖: ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  return missing.length;
}

function main() {
  const manuals = {};
  for (const [lang, file] of Object.entries(MANUALS)) {
    if (!fs.existsSync(file)) {
      console.error(`缺少手册文件：${file}`);
      finish(2);
    }
    manuals[lang] = read(file);
  }

  // 以中文手册为准（它是源语言），英文只做对照报告
  const zh = manuals['zh-CN'];
  const en = manuals.en;
  const coveredZh = makeChecker(zh);
  const coveredEn = makeChecker(en);

  const endpoints = [...extractEndpoints().keys()].filter((p) => !ALLOWLIST.endpoint.has(p));
  const configFields = extractConfigFields().filter((f) => !ALLOWLIST.configField.has(f));
  const { types: faultTypes, fields: actionFields } = extractFaultTypes();
  const presets = extractPresets();
  const scripts = extractScripts().filter((s) => !ALLOWLIST.script.has(s));
  const panelRoutes = extractPanelRoutes();

  console.log('手册覆盖度自检');
  console.log('='.repeat(64));
  console.log(`中文手册 ${zh.split('\n').length} 行，英文手册 ${en.split('\n').length} 行`);

  let missed = 0;

  missed += report('接口', endpoints, coveredZh);
  missed += report('配置项', configFields, (f) => coveredZh(configLeaf(f)),
    '（按叶子名匹配，因为手册以 JSONC 示例给出配置）');
  missed += report('故障类型', faultTypes, coveredZh);

  // 面板页面：要求手册的页面表里**有以它命名的一行**。
  //
  // 这里原来只是"名字在全文里出现过"，会产生**假通过** ——
  // 加「资产目录」这一页时，"资产目录"三个字早就散落在别处
  // （/api/system 的说明、curl 注释、只读说明），于是检查报告"已覆盖"，
  // 而页面表里根本没有这一行。
  // 手册的页面表固定写成 `| **总览** | 说明 |`，所以按这个形状匹配，
  // 才算真的写进去了。
  const labels = panelLabels();
  const pages = panelRoutes.filter((r) => labels.zh[r]);
  const asTableRow = (label) => new RegExp(`^\\|\\s*\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*\\s*\\|`, 'm');
  missed += report(
    '面板页面',
    pages.map((r) => labels.zh[r]),
    (label) => asTableRow(label).test(zh),
    '（要求在页面表里有 `| **名称** |` 这一行）',
  );
  const pagesEnMissing = pages.filter((r) => !asTableRow(labels.en[r]).test(en));
  console.log(`      英文手册未覆盖的页面名: ${pagesEnMissing.length ? pagesEnMissing.map((r) => labels.en[r]).join(', ') : '无'}`);

  missed += report('npm 脚本', scripts, coveredZh);
  // 预置方案只要求"整体提到"（手册没必要逐个列 16 个场景名），
  // 但至少要能看出有哪些典型场景
  const presetCovered = presets.filter((p) => coveredZh(p.name));
  console.log(`\n${presetCovered.length >= 3 ? '✓' : '✗'} 预置方案  共 ${presets.length} 个，`
    + `手册里点名了 ${presetCovered.length} 个：${presetCovered.map((p) => p.name).join('、')}`);

  // 协议段落里的**值**必须和代码一致。
  //
  // 为什么单独查这个：上面的检查全都是"名字有没有被提到"，不看值。
  // 于是手册里的 protocolVersion 从 1.1.0 起就一直写着 1（实际早已是 2），
  // capabilities 示例也多了一个已删除的 grayByDeviceId、少了协议 2 新增的两项 ——
  // 而 docs-check 一直报"全部覆盖"。清单 M-1 就是这么漏掉的。
  //
  // 注意 missed 是**计数器**（missed += report(...)），不是数组。
  // 初版这里写成 missed.push(...)，结果值正确时静默通过、
  // 值错误时直接 TypeError 崩掉 —— 恰恰在最该报错的时候不报错。
  {
    const proto = require('../backend/core/protocol');
    const bad = [];
    for (const [label, text] of [['中文', zh], ['英文', en]]) {
      const verMatch = text.match(/"protocolVersion"\s*:\s*(\d+)/);
      const capMatch = text.match(/"capabilities"\s*:\s*\[([\s\S]*?)\n\s*\]/);
      const caps = capMatch
        ? [...capMatch[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1])
        : [];

      const verOk = Boolean(verMatch) && Number(verMatch[1]) === proto.PROTOCOL_VERSION;
      const missing = proto.CAPABILITIES.filter((c) => !caps.includes(c));
      const extra = caps.filter((c) => !proto.CAPABILITIES.includes(c));
      const capsOk = Boolean(capMatch) && missing.length === 0 && extra.length === 0;

      if (!verOk) bad.push(`${label}手册的 protocolVersion（写的是 ${verMatch ? verMatch[1] : '没写'}，代码是 ${proto.PROTOCOL_VERSION}）`);
      if (!capsOk) {
        bad.push(`${label}手册的 capabilities（${caps.length} 项 vs 代码 ${proto.CAPABILITIES.length} 项`
          + `${missing.length ? `，缺 ${missing.join('/')}` : ''}`
          + `${extra.length ? `，多 ${extra.join('/')}` : ''}）`);
      }

      console.log(`\n${verOk ? '✓' : '✗'} ${label}手册的协议版本  `
        + `${verMatch ? verMatch[1] : '(没写)'} vs 代码 ${proto.PROTOCOL_VERSION}`);
      console.log(`  ${capsOk ? '✓' : '✗'} ${label}手册的能力位  `
        + `${caps.length} 项 / 代码 ${proto.CAPABILITIES.length} 项`);
    }
    if (bad.length) {
      console.log('\n✗ 协议段落的值与代码不一致（手册里写死的值会过期，改代码时记得同步）');
      for (const b of bad) console.log(`      不一致: ${b}`);
    }
    missed += bad.length;
  }

  // 英文手册的覆盖度（作为翻译完整性的旁证）
  const enMissing = endpoints.filter((p) => !coveredEn(p));
  console.log(`\n${enMissing.length ? '✗' : '✓'} 英文手册的接口覆盖  未覆盖 ${enMissing.length} 项`
    + (enMissing.length ? `：${enMissing.join(', ')}` : ''));

  // 故障类型各自的动作字段（ratio/status/delayMs/body）有没有解释
  const fieldMissing = [];
  for (const [type, fields] of Object.entries(actionFields)) {
    for (const f of fields) {
      if (f === 'delayMs') continue; // 在别处统一解释
      if (!coveredZh(f)) fieldMissing.push(`${type}.${f}`);
    }
  }
  console.log(`\n${fieldMissing.length ? '✗' : '✓'} 故障动作字段  未解释 ${fieldMissing.length} 项`
    + (fieldMissing.length ? `：${fieldMissing.join(', ')}` : ''));

  console.log('');
  console.log('='.repeat(64));
  const totalGaps = missed + fieldMissing.length;
  if (totalGaps === 0) {
    console.log('手册覆盖了当前版本的全部接口、配置项、故障类型与面板页面。');
  } else {
    console.log(`共发现 ${totalGaps} 处未覆盖。若是"换了说法描述"的假阴性，`);
    console.log('请在 scripts/docs-coverage.js 的 ALLOWLIST 里补上并写明理由。');
  }
  console.log('');

  finish(totalGaps === 0 && presetCovered.length >= 3 ? 0 : 1);
}

main();
