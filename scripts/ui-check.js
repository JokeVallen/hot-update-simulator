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
const { finish, isExitSignal } = require('./lib/exit');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 删目录不能用 fs.rmSync：Windows + 非 ASCII 路径上它会静默失败甚至让进程硬崩。
// 详见 scripts/lib/safe-rm.js
const { removeDirSync } = require('./lib/safe-rm');

const TARGET_URL = (process.argv[2] || 'http://127.0.0.1:5500').replace(/\/$/, '');
const DEBUG_PORT = 9333;
const ROUTES = ['dashboard', 'network', 'faults', 'presets', 'logs', 'explorer', 'favorites', 'assets', 'publish', 'manual'];

const { sandboxArgs, cdpReadiness } = require('./lib/browser');

function assertBrowser() {
  const ready = cdpReadiness();
  if (!ready.ok) {
    console.error(`无法做界面检查：${ready.reason}\n`);
    console.error(ready.hint);
    finish(2);
  }
  return ready.browser;
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
  const browser = assertBrowser();

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
    finish(2);
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
    // root 下 Chrome 会拒绝启动沙箱（容器/CI 里常见），由 lib/browser 判断要不要加
    ...sandboxArgs(),
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill(); } catch { /* 已经退出 */ }
    // 临时目录名是 ASCII，但统一走 safe-rm 免得以后改名踩坑
    removeDirSync(userDataDir);
    restoreConfig();
  };

  /** 连接调试端口的客户端，在下面的 try 里赋值。 */
  let cdp;
  const problems = [];
  const consoleErrors = [];

  /** 断言辅助：失败时同时记进 problems，参与最后的汇总与退出码。 */
  let checksPassed = 0;
  let checksFailed = 0;
  function check(name, condition, detail = '') {
    if (condition) {
      checksPassed += 1;
      console.log(`  ✓ ${name}`);
    } else {
      checksFailed += 1;
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
    finish(1);
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
    // 方案数量是"文档说的"和"界面上的"必须一致的那类数字：
    // 手册里写着 17 个场景，这里就该是 17 张卡片。
    check('预置方案的卡片数与手册一致（17 张）',
      navInfo.hasCards === 17,
      `实际 ${navInfo.hasCards} 张 —— 加了新方案要同步改手册里的数量`);

    // 顶栏的连接状态必须很快就有结论。
    // 原来的实现只挂了 5 秒轮询、从没在初始化时探过一次，
    // 于是页面加载后的头 5 秒一直显示"检测中…"，看着像卡住了。
    await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('hus.locale','zh-CN')` });
    await cdp.send('Page.navigate', { url: `${TARGET_URL}/?ui-check=status#/dashboard` });
    await sleep(2000);
    const connStatus = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.getElementById('husConnStatus');
        const dot = el ? el.querySelector('.status-dot') : null;
        return JSON.stringify({
          text: el ? el.innerText.trim() : '',
          cls: dot ? dot.className : '',
        });
      })()`,
      returnByValue: true,
    });
    const conn = JSON.parse(connStatus.result.value);
    check('顶栏在 2 秒内就得出连接状态（不能停在"检测中"）',
      !/检测中|Checking/.test(conn.text),
      `显示的是「${conn.text}」`);
    check('连接状态是正常的绿色（后端确实在跑）',
      conn.cls.includes('ok'),
      `状态点 class=${conn.cls}`);

    // 页脚必须显示版本号。
    // 这是"改坏了没人会发现"的典型：版本号显示不出来不影响任何功能，
    // 但恰恰是出问题时第一个要看的东西（"我跑的到底是哪个版本"）。
    const expectedVersion = require('../package.json').version;
    const footerProbe = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const f = document.getElementById('husFooterInfo');
        return JSON.stringify({ text: f ? f.textContent : null });
      })()`,
      returnByValue: true,
    });
    const footerInfo = JSON.parse(footerProbe.result.value);
    check('页脚显示当前版本号（与 package.json 一致）',
      Boolean(footerInfo.text) && footerInfo.text.includes(`v${expectedVersion}`),
      `期望 v${expectedVersion}，实际「${footerInfo.text}」`);

    // 「模拟干预」卡片必须先说清"配置了什么"，再说"发生了什么"。
    //
    // 原来只有计数器，于是"配了规则但没请求命中"和"什么都没配"看起来一样，
    // 而顶栏同时显示"模拟进行中"——两处矛盾且没有任何解释。
    const simCard = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const cards = [...document.querySelectorAll('.hus-card')];
        const target = cards.find((c) => /模拟干预|Simulation impact/.test(c.textContent));
        if (!target) return JSON.stringify({ found: false });
        return JSON.stringify({
          found: true,
          text: target.innerText.replace(/\\s+/g, ' ').slice(0, 240),
          hasConfigLine: /没有启用任何模拟|No simulation is enabled/.test(target.innerText),
        });
      })()`,
      returnByValue: true,
    });
    const simInfo = JSON.parse(simCard.result.value);
    check('总览的「模拟干预」卡片刻意说明当前有没有启用模拟',
      simInfo.found && simInfo.hasConfigLine,
      simInfo.found ? `卡片内容：${simInfo.text}` : '没找到该卡片');

    // ---------------------------------------------------------- 主题切换
    //
    // 光看 data-bs-theme 属性不够 —— 属性设对了但 CSS 没跟上（比如变量名写错）
    // 一样是坏的。所以这里读**实际算出来的背景色**，确认亮暗确实换过来了。
    console.log('\n主题切换');

    const themeProbe = `(() => {
      const sel = document.getElementById('husThemeSelect');
      const cs = getComputedStyle(document.body);
      return JSON.stringify({
        attr: document.documentElement.getAttribute('data-bs-theme'),
        colorScheme: document.documentElement.style.colorScheme,
        bg: cs.backgroundColor,
        fg: cs.color,
        stored: localStorage.getItem('hus.theme'),
        selected: sel ? sel.value : null,
      });
    })()`;

    const readTheme = async () => JSON.parse(
      (await cdp.send('Runtime.evaluate', { expression: themeProbe, returnByValue: true })).result.value,
    );

    const setThemeValue = async (value) => {
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const sel = document.getElementById('husThemeSelect');
          sel.value = ${JSON.stringify(value)};
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
      });
      await sleep(250);
      return readTheme();
    };

    /** 把 rgb(a) 三个通道平均一下，用来判断"亮"还是"暗"。 */
    const brightness = (rgb) => {
      const m = String(rgb).match(/\d+/g);
      if (!m || m.length < 3) return null;
      return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
    };

    const light = await setThemeValue('light');
    check('切到浅色：data-bs-theme 变成 light',
      light.attr === 'light', `实际 ${light.attr}`);
    check('切到浅色：背景确实是亮的（不是只改了属性）',
      brightness(light.bg) > 180, `背景 ${light.bg}，亮度 ${brightness(light.bg)}`);
    check('切到浅色：文字与背景反差足够（深色字）',
      brightness(light.fg) < 100, `文字 ${light.fg}，亮度 ${brightness(light.fg)}`);

    const dark = await setThemeValue('dark');
    check('切到深色：data-bs-theme 变成 dark',
      dark.attr === 'dark', `实际 ${dark.attr}`);
    check('切到深色：背景确实是暗的',
      brightness(dark.bg) < 60, `背景 ${dark.bg}，亮度 ${brightness(dark.bg)}`);
    check('切到深色：文字是浅色的',
      brightness(dark.fg) > 150, `文字 ${dark.fg}，亮度 ${brightness(dark.fg)}`);

    // 「跟随系统」要真的去问系统，而不是固定成某一套
    const systemInfo = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const sel = document.getElementById('husThemeSelect');
        sel.value = 'system';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches });
      })()`,
      returnByValue: true,
    });
    const prefersDark = JSON.parse(systemInfo.result.value).prefersDark;
    await sleep(250);
    const system = await readTheme();
    check('切到跟随系统：解析结果与系统的偏好一致',
      system.attr === (prefersDark ? 'dark' : 'light'),
      `系统偏好 ${prefersDark ? '深色' : '浅色'}，实际 ${system.attr}`);

    check('主题选择写进了 localStorage（刷新后还在）',
      system.stored === 'system', `实际 ${system.stored}`);

    // 刷新一次，确认选择真的持久化了
    await cdp.send('Page.navigate', { url: `${TARGET_URL}/?ui-check=theme-persist#/dashboard` });
    await sleep(2000);
    const afterReload = await readTheme();
    check('刷新后主题选择仍然保留',
      afterReload.selected === 'system', `下拉框实际值 ${afterReload.selected}`);

    // 换回深色收尾，后面的截图才是深色的
    await setThemeValue('dark');

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
    // 必须在**每一个路由**上扫，而不是只看总览页。
    // 原来的检查只扫了 dashboard + 侧栏 + 顶栏，于是故障注入、接口调试、
    // 收藏、手册那几页里的中文全部漏网 —— 报"0 处漏翻"是假的。
    //
    // 手册改成中英各一份之后，这里不再为它开例外：英文界面下**整页**
    // 都不该出现中文（正文、目录都算）。唯一排除的是语言下拉框里的「中文」，
    // 那是语言的自称，跟中文界面里显示 English 一样，属于故意保留。
    console.log('\n语言包完整性（逐页扫描）');

    const localeLeaks = new Map();

    for (const route of ROUTES) {
      await cdp.send('Runtime.evaluate', {
        expression: `localStorage.setItem('hus.locale', 'en')`,
        returnByValue: true,
      });
      // 带查询参数强制真实加载：只改 hash 属于同文档跳转，
      // initI18n() 不会重跑，语言根本切不过去。
      await cdp.send('Page.navigate', { url: `${TARGET_URL}/?ui-check=locale-${route}#/${route}` });
      await sleep(1900);

      const scan = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const zones = [
            document.getElementById('husSidebar'),
            document.querySelector('.hus-topbar'),
            document.getElementById('husView'),
          ];
          const found = [];
          for (const zone of zones) {
            if (!zone) continue;
            const clone = zone.cloneNode(true);
            // 只排除**语言**下拉框：「中文」是语言的自称，英文界面里也该显示
            // 「中文」而不是 "Chinese"。除此之外一切都在扫描范围内 ——
            // 包括手册正文和目录，以及主题下拉框的选项文案。
            clone.querySelectorAll('#husLocaleSelect').forEach((n) => n.remove());
            const text = clone.innerText || clone.textContent || '';
            const matches = text.match(/[\\u4e00-\\u9fa5]+/g);
            if (matches) found.push(...matches);
          }
          return JSON.stringify([...new Set(found)]);
        })()`,
        returnByValue: true,
      });

      const samples = JSON.parse(scan.result.value);
      if (samples.length) localeLeaks.set(route, samples);
    }

    // 防"空洞通过"：如果页面主体还没渲染出来就扫描，扫到的是"加载中…"
    // （那句本身已翻译），检查会声称 0 处漏翻 —— 而实际内容根本没被检查。
    // 手册页尤其危险：它要 fetch 一份 20KB 的 markdown 再解析。
    // 所以这里等它渲染完，**在同一个页面上重新扫一遍**并覆盖循环里的结果。
    await cdp.send('Page.navigate', { url: `${TARGET_URL}/?ui-check=locale-verify#/manual` });
    await sleep(3200);
    const manualRendered = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const content = document.querySelector('#manualContent');
        const toc = document.querySelectorAll('.hus-manual-toc a').length;
        const zones = [
          document.getElementById('husSidebar'),
          document.querySelector('.hus-topbar'),
          document.getElementById('husView'),
        ];
        const found = [];
        for (const zone of zones) {
          if (!zone) continue;
          const clone = zone.cloneNode(true);
          clone.querySelectorAll('#husLocaleSelect').forEach((n) => n.remove());
          const text = clone.innerText || clone.textContent || '';
          const matches = text.match(/[\\u4e00-\\u9fa5]+/g);
          if (matches) found.push(...matches);
        }
        return JSON.stringify({
          chars: content ? content.innerText.length : 0,
          toc,
          leaks: [...new Set(found)],
        });
      })()`,
      returnByValue: true,
    });
    const rendered = JSON.parse(manualRendered.result.value);
    check('语言包扫描前手册确实渲染出来了（防止空洞通过）',
      rendered.chars > 3000 && rendered.toc > 10,
      `正文 ${rendered.chars} 字符，目录 ${rendered.toc} 项 —— 太少说明扫描时页面还没加载完`);

    // 用"确认渲染之后"的结果覆盖循环里那次可能过早的扫描
    if (rendered.leaks.length) localeLeaks.set('manual', rendered.leaks);
    else localeLeaks.delete('manual');

    const totalLeaks = [...localeLeaks.values()].reduce((n, s) => n + s.length, 0);
    const localeOk = totalLeaks === 0;
    check(`英文界面各页均无漏翻残留（扫描 ${ROUTES.length} 个路由）`, localeOk,
      localeOk ? '' : `${totalLeaks} 处，按页面见下`);

    for (const [route, samples] of localeLeaks) {
      console.log(`      #/${route}: ${samples.slice(0, 16).join(' / ')}`
        + `${samples.length > 16 ? ` …(+${samples.length - 16})` : ''}`);
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
    // 断言总数：包括上面那 3 个具名交互之外的（编辑器、连接状态、语言包等）。
    // 只报"3/3"会让人以为整个界面检查只有 3 条断言。
    console.log(`断言总计 ${checksPassed} 通过 / ${checksPassed + checksFailed} 条`);
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
    finish(allGood ? 0 : 1);
  } catch (err) {
    // 正常路径的 finish(0) 是靠抛信号中断的，必须放行 ——
    // 否则会被这里接住、当成"检查自身出错"，再被 finish(1) 覆盖掉退出码。
    // （实测踩过：21 条断言全过，退出码却是 1。）
    if (isExitSignal(err)) throw err;
    console.error('\n界面检查自身出错：', err.message);
    if (problems.length) {
      console.error('已捕获的问题：');
      for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
    }
    cleanup();
    finish(1);
  }
}

main();
