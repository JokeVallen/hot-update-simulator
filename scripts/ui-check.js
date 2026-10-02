#!/usr/bin/env node
// scripts/ui-check.js
//
// 前端界面冒烟测试：用无头 Chrome 真的把面板打开，逐个路由走一遍，
// 捕获浏览器控制台里的报错和未捕获异常。
//
// 为什么需要它：前端构建成功只能说明语法和依赖没问题，
// 完全不能说明运行时不炸。一个拼错的 DOM id、一个 undefined 的属性访问，
// 构建都会通过，但页面会白屏或按钮点了没反应。
//
// 用 Chrome DevTools Protocol 而不是 puppeteer：项目里已经不需要再多一个
// 几百兆的依赖，而 Node 22+ 自带 WebSocket，够用了。
//
// 用法：
//   node scripts/ui-check.js                     # 默认检查 http://127.0.0.1:5500
//   node scripts/ui-check.js http://127.0.0.1:5500

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET_URL = (process.argv[2] || 'http://127.0.0.1:5500').replace(/\/$/, '');
const DEBUG_PORT = 9333;
const ROUTES = ['dashboard', 'network', 'faults', 'presets', 'logs', 'explorer', 'favorites'];

const CHROME_CANDIDATES = [
  'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 极简 CDP 客户端。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const set = this.handlers.get(msg.method);
        if (set) set.forEach((fn) => fn(msg.params));
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 20000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
  }
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('找不到 Chrome 或 Edge，无法做界面检查。');
    process.exit(2);
  }

  // 界面检查会点「急停」等按钮，那些操作会真的写进 backend/config.json。
  // 跑完必须还原，否则每跑一次测试就把用户的模拟参数改一遍
  // （这个坑真的踩到了：某次跑完 config.json 里留下了 bandwidthKbps=8000）。
  const configPath = path.resolve(__dirname, '..', 'backend', 'config.json');
  let originalConfig = null;
  try {
    originalConfig = fs.readFileSync(configPath, 'utf8');
  } catch {
    /* 没有配置文件也能跑 */
  }
  const restoreConfig = () => {
    if (originalConfig === null) return;
    try {
      fs.writeFileSync(configPath, originalConfig, 'utf8');
    } catch {
      /* 忽略 */
    }
  };

  // 先确认目标服务在跑，否则后面全是超时，看不出真正原因
  try {
    const res = await fetch(`${TARGET_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`目标服务 ${TARGET_URL} 不可达：${err.message}`);
    console.error('请先执行 npm start（并确认后端已在 5500 端口运行）。');
    process.exit(2);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hus-ui-check-'));
  console.log(`浏览器：${browser}`);
  console.log(`目标：${TARGET_URL}`);
  console.log(`临时配置目录：${userDataDir}\n`);

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill(); } catch { /* 已经退出 */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    restoreConfig();
  };

  /** 连接调试端口的客户端，在下面的 try 里赋值。 */
  let cdp;
  const problems = [];
  const consoleErrors = [];

  /** 断言辅助：失败时同时记进 problems，参与最后的汇总与退出码。 */
  function check(name, condition, detail = '') {
    if (condition) {
      console.log(`  ✓ ${name}`);
    } else {
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
      problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  try {
    // 等调试端口起来
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        version = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error('浏览器调试端口没有就绪');

    // 复用启动时那个 about:blank 标签页。不同 Chrome 版本对 /json/new 的
    // HTTP 方法要求不一致（有的要 GET，有的要 PUT），直接复用最省事。
    const targets = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');
  } catch (err) {
    console.error('连接浏览器失败：', err.message);
    cleanup();
    process.exit(1);
  }

  try {
    const targets = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('连接调试端口失败')));
    });
    cdp = new Cdp(ws);

    // 收集各类错误
    cdp.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails || {};
      const text = d.exception && d.exception.description
        ? d.exception.description
        : d.text;
      problems.push(`未捕获异常：${String(text).split('\n')[0]}`);
    });

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      if (params.type === 'error') {
        consoleErrors.push(text);
        problems.push(`console.error：${text}`);
      } else if (params.type === 'warning' && /i18n|缺少文案/.test(text)) {
        // 漏翻的文案单独归类，方便一次性补齐
        consoleErrors.push(text);
      }
    });

    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') {
        problems.push(`浏览器日志错误：${entry.text} ${entry.url || ''}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    // ---------------------------------------------------------- 逐个路由检查
    let passed = 0;
    for (const route of ROUTES) {
      const before = problems.length;
      await cdp.send('Page.navigate', { url: `${TARGET_URL}/#/${route}` });
      await sleep(2200);

      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const view = document.getElementById('husView');
          const nav = document.getElementById('husNav');
          return JSON.stringify({
            title: document.title,
            viewLength: view ? view.innerHTML.length : -1,
            navCount: nav ? nav.querySelectorAll('[data-route]').length : -1,
            activeRoute: nav && nav.querySelector('[data-route].active')
              ? nav.querySelector('[data-route].active').dataset.route : null,
            hasErrorAlert: Boolean(document.querySelector('#husView .alert-danger')),
            errorText: (document.querySelector('#husView .alert-danger') || {}).textContent || '',
            bodyPreview: view ? view.textContent.slice(0, 160).replace(/\\s+/g, ' ').trim() : '',
          });
        })()`,
        returnByValue: true,
      });

      const info = JSON.parse(result.result.value);
      const newProblems = problems.length - before;

      const ok = info.viewLength > 300
        && info.navCount === ROUTES.length
        && info.activeRoute === route
        && !info.hasErrorAlert
        && newProblems === 0;

      if (ok) passed += 1;
      console.log(`${ok ? '  ✓' : '  ✗'} #/${route}  (视图 ${info.viewLength} 字符, 激活=${info.activeRoute})`);
      if (!ok) {
        if (info.hasErrorAlert) console.log(`      渲染出错：${info.errorText.slice(0, 200)}`);
        if (newProblems) console.log(`      新增 ${newProblems} 条控制台报错`);
      } else {
        console.log(`      ${info.bodyPreview.slice(0, 110)}…`);
      }
    }

    // ---------------------------------------------------------- 交互检查
    console.log('\n交互检查');

    // 点一下"急停"，确认按钮真的绑上了事件
    const panicWorked = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.getElementById('husPanicBtn');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      })()`,
      returnByValue: true,
    });
    await sleep(1200);
    const panicOk = panicWorked.result.value === 'clicked';

    const toastVisible = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.toast-container .toast').length`,
      returnByValue: true,
    });

    console.log(`${panicOk ? '  ✓' : '  ✗'} 急停按钮可点击`);
    console.log(`  ${toastVisible.result.value > 0 ? '✓' : '✗'} 操作后有提示反馈（${toastVisible.result.value} 条 toast）`);

    // 侧边导航点击能切换路由
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-route="presets"]').click()`,
      returnByValue: true,
    });
    await sleep(1500);
    const navResult = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ hash: location.hash, hasCards: document.querySelectorAll('.preset-card').length })`,
      returnByValue: true,
    });
    const navInfo = JSON.parse(navResult.result.value);
    const navOk = navInfo.hash === '#/presets' && navInfo.hasCards > 0;
    console.log(`${navOk ? '  ✓' : '  ✗'} 侧边导航切换正常（hash=${navInfo.hash}，方案卡片 ${navInfo.hasCards} 张）`);

    // ---------------------------------------------------------- 故障规则编辑器
    //
    // 这一段是补上的：原来的界面检查只验证"路由能渲染"和三个按钮，
    // 从没点过「新增规则」。而恰恰是这个按钮 100% 报错 ——
    // bindEditor() 在编辑器 HTML 写入之前执行，querySelector 拿到 null
    // 直接抛 TypeError，编辑器永远打不开。
    console.log('\n故障规则编辑器');
    await cdp.send('Runtime.evaluate', {
      expression: `location.hash = '#/faults'`,
      returnByValue: true,
    });
    await sleep(2000);

    const beforeCount = problems.length;
    // 点「新增规则」
    await cdp.send('Runtime.evaluate', {
      expression: `(document.querySelector('#faultAddRule') || {click(){}}).click()`,
      returnByValue: true,
    });
    await sleep(1200);

    const editorState = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        hasEditor: Boolean(document.querySelector('#faultEditor #feSave')),
        hasName: Boolean(document.querySelector('#feName')),
        hasType: Boolean(document.querySelector('#feType')),
        hasCancel: Boolean(document.querySelector('#feCancel')),
      })`,
      returnByValue: true,
    });
    const editor = JSON.parse(editorState.result.value);
    // 先算控制台报错的增量，再调用 check()（check 自己也会往 problems 里写）
    const newProblems = problems.length - beforeCount;

    check('点「新增规则」后编辑器出现', editor.hasEditor, JSON.stringify(editor));
    check('编辑器各字段都在', editor.hasName && editor.hasType && editor.hasCancel, JSON.stringify(editor));
    check('打开编辑器过程中没有控制台报错', newProblems === 0,
      problems.slice(beforeCount).join(' / '));

    // 改故障类型，确认相关字段的显示/隐藏与 disabled 生效
    const typeSwitch = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const sel = document.querySelector('#feType');
        if (!sel) return 'no-select';
        sel.value = 'abort';
        sel.dispatchEvent(new Event('change'));
        const delayNode = document.querySelector('[data-when="delay"]');
        const ratioNode = document.querySelector('[data-when="ratio"]');
        const delayInput = delayNode ? delayNode.querySelector('input') : null;
        const ratioInput = ratioNode ? ratioNode.querySelector('input') : null;
        return JSON.stringify({
          delayHidden: delayNode ? delayNode.classList.contains('d-none') : null,
          delayDisabled: delayInput ? delayInput.disabled : null,
          ratioHidden: ratioNode ? ratioNode.classList.contains('d-none') : null,
          ratioDisabled: ratioInput ? ratioInput.disabled : null,
        });
      })()`,
      returnByValue: true,
    });
    const typeInfo = JSON.parse(typeSwitch.result.value);
    check('切到 abort 时延迟字段被隐藏并禁用（不会把看不见的值提交上去）',
      typeInfo.delayHidden === true && typeInfo.delayDisabled === true,
      JSON.stringify(typeInfo));
    check('切到 abort 时比例字段可见且可用',
      typeInfo.ratioHidden === false && typeInfo.ratioDisabled === false,
      JSON.stringify(typeInfo));

    // 关掉编辑器，避免把测试状态留下
    await cdp.send('Runtime.evaluate', {
      expression: `(document.querySelector('#feCancel') || {click(){}}).click()`,
      returnByValue: true,
    });
    await sleep(500);

    // 每个路由都截一张图，方便人工看布局有没有问题
    const shotDir = path.resolve(__dirname, '..', 'ui-check-shots');
    fs.mkdirSync(shotDir, { recursive: true });
    for (const route of ROUTES) {
      await cdp.send('Page.navigate', { url: `${TARGET_URL}/#/${route}` });
      await sleep(2200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, `${route}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`\n已保存各页面截图：${shotDir}`);

    // ---------------------------------------------------------- 语言包完整性
    //
    // t() 找不到 key 时会回退到中文，所以英文界面里如果冒出中文，
    // 就说明 en.json 漏翻了。只看侧边栏和顶栏——这两块文案完全来自
    // 语言包；页面正文里可能有后端返回的中文（比如预置方案的名字），
    // 拿它判断会误报。
    console.log('\n语言包完整性');
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('hus.locale', 'en')`,
      returnByValue: true,
    });
    // 必须带上查询参数：只改 hash 属于同文档跳转，页面不会重新加载，
    // initI18n() 也就不会重跑，语言根本切不过去。
    await cdp.send('Page.navigate', { url: `${TARGET_URL}/?ui-check=locale#/dashboard` });
    await sleep(2800);
    const localeResult = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        // 连主视图一起扫：只查侧栏和顶栏会漏掉页面内部的硬编码
        // （比如统计窗口的"分钟"、网络页的"弱网"档位）。
        // 这里停在 dashboard 路由上，它的内容全是前端文案 + ASCII 数据
        // （路径、数字），不会有后端返回的中文造成误报。
        const zones = [
          document.getElementById('husSidebar'),
          document.querySelector('.hus-topbar'),
          document.getElementById('husView'),
        ];
        const found = [];
        for (const zone of zones) {
          if (!zone) continue;
          // 语言下拉框里的「中文」是语言的自称，跟中文界面里显示 English 一样，
          // 属于故意保留的，不是漏翻 —— 先把它摘掉再扫描
          const clone = zone.cloneNode(true);
          clone.querySelectorAll('select').forEach((s) => s.remove());
          const text = clone.innerText || clone.textContent || '';
          const matches = text.match(/[\\u4e00-\\u9fa5]+/g);
          if (matches) found.push(...matches);
        }
        return JSON.stringify({ samples: [...new Set(found)].slice(0, 12), count: found.length });
      })()`,
      returnByValue: true,
    });
    const localeInfo = JSON.parse(localeResult.result.value);
    const localeOk = localeInfo.count === 0;
    console.log(`${localeOk ? '  ✓' : '  ✗'} 英文界面没有漏翻残留（发现 ${localeInfo.count} 处）`);
    if (!localeOk) {
      console.log(`      残留样例：${localeInfo.samples.join(' / ')}`);
      problems.push(`en.json 漏翻：${localeInfo.samples.join(' / ')}`);
    }

    // 恢复成中文，别把测试状态留给用户
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('hus.locale', 'zh-CN')`,
      returnByValue: true,
    });

    // ---------------------------------------------------------- 汇总
    const uniqueProblems = [...new Set(problems)];
    const interactionPassed = [panicOk, toastVisible.result.value > 0, navOk].filter(Boolean).length;
    console.log(`\n${'='.repeat(56)}`);
    console.log(`路由通过 ${passed} / ${ROUTES.length}`);
    console.log(`交互通过 ${interactionPassed} / 3`);
    console.log(`语言包 ${localeOk ? '通过' : '有漏翻'}`);
    if (uniqueProblems.length) {
      console.log(`\n发现 ${uniqueProblems.length} 个问题：`);
      for (const p of uniqueProblems.slice(0, 25)) console.log(`  - ${p}`);
    } else {
      console.log('没有捕获到任何控制台错误或未捕获异常。');
    }
    if (consoleErrors.length) {
      const missing = [...new Set(consoleErrors.filter((e) => /缺少文案/.test(e)))];
      if (missing.length) {
        console.log(`\n漏翻的文案 ${missing.length} 条：`);
        for (const m of missing.slice(0, 20)) console.log(`  - ${m}`);
      }
    }
    console.log('='.repeat(56));

    cleanup();
    const allGood = passed === ROUTES.length && uniqueProblems.length === 0 && localeOk;
    process.exit(allGood ? 0 : 1);
  } catch (err) {
    console.error('\n界面检查自身出错：', err.message);
    if (problems.length) {
      console.error('已捕获的问题：');
      for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
    }
    cleanup();
    process.exit(1);
  }
}

main();
