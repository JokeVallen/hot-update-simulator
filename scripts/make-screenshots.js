// 生成 README 用的截图（默认配置下的干净状态）
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { finish, isExitSignal, drainAndExit } = require('./lib/exit');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const CONFIG = path.join(ROOT, 'backend', 'config.json');
const DEBUG_PORT = 9491;
const SERVER_PORT = 5777;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const BROWSERS = process.platform === 'win32'
  ? ['D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

const put = (method, p, data) => new Promise((resolve) => {
  const body = data ? JSON.stringify(data) : null;
  const req = http.request({
    host: '127.0.0.1', port: SERVER_PORT, method, path: p,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
  }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', resolve);
  if (body) req.write(body);
  req.end();
});
const get = (p) => put('GET', p);

/**
 * 造出"工具正在干活"的状态。
 *
 * 为什么不截默认状态：默认状态下「模拟干预」显示"没有启用任何模拟"、
 * 热点接口全是页面自身的加载请求 —— 那说明不了这个工具是干什么的。
 * README 的截图要让人一眼看到"请求真的被动了手脚"。
 *
 * ⚠️ 这里**故意不去下载真实的 2MB 资产**：种子里一旦开了限速，
 * 下载一个 2MB 文件要 8 秒，而断流规则还会中途掐断它 ——
 * 实测会让这个脚本卡死（promise 不 resolve）。
 * 统计数字靠打小接口就够了。
 */
async function seedActivity() {
  await put('PATCH', '/api/control/network', {
    // 带宽给宽一点：截图脚本自己要加载前端资源（index.js 415KB + css 320KB + 图标字体 314KB），
    // 限到 2000kbps 时图标字体常常还没下完就截图了 —— 侧栏会变成一排占位方块。
    // 150ms 的延迟已经足够让统计上显出"被延迟"。
    enabled: true, latencyMs: 150, jitterMs: 50, bandwidthKbps: 8000, packetLossRate: 0,
  });
  await put('POST', '/api/control/fault/rules', {
    name: '下载中途断流', enabled: true, probability: 0.4, maxHits: 0,
    match: { pathPrefix: '/assets' }, action: { type: 'abort', ratio: 0.5 },
  });
  await put('POST', '/api/control/fault/rules', {
    name: '版本接口前两次 500', enabled: true, probability: 1, maxHits: 2,
    match: { pathPrefix: '/api/version' }, action: { type: 'status', status: 500 },
  });
  await put('PATCH', '/api/control/fault', { enabled: true });

  // 打一批轻量请求，让统计与计数非 0
  for (let i = 0; i < 12; i += 1) {
    await get(`/api/version?platform=Android&current=1.0.0&deviceId=demo-${i % 3}`);
  }
  await get('/api/manifest?platform=Android');
  await sleep(300);
}

(async () => {
  const original = fs.readFileSync(CONFIG);
  const browser = BROWSERS.find((b) => fs.existsSync(b));
  if (!browser) { console.error('  没有找到 Chrome / Edge，跳过'); finish(1); }

  // 硬超时：这个脚本会起服务 + 浏览器，卡住时不能把配置留在改动状态。
  // 用 drainAndExit 而不是裸 process.exit —— 后者在 Windows 上可能截断输出
  // （回归测试里有一条断言专门守着这件事）。
  const guard = setTimeout(() => {
    console.error('\n  ⚠️ 超过 90 秒，强制收尾并还原配置');
    fs.writeFileSync(CONFIG, original);
    drainAndExit(1);
  }, 90000);
  guard.unref?.();

  fs.mkdirSync(OUT, { recursive: true });

  // 用默认配置截图 —— 否则截出来的是开发时调出来的参数
  const ConfigManager = require('../backend/core/configManager');
  fs.writeFileSync(CONFIG, `${JSON.stringify(ConfigManager.DEFAULTS, null, 2)}\n`, 'utf8');

  const srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(SERVER_PORT) }, stdio: 'ignore',
  });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hus-shot-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    await sleep(3500);
    await seedActivity();

    let list = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        if (list.find((t) => t.type === 'page')) break;
      } catch { /* 等 */ }
      await sleep(250);
    }
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const myId = id++; pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

    await send('Page.enable');
    const shots = [
      ['network', '网络模拟', 'network.png', 6000],
      ['faults', '故障注入', 'faults.png', 7000],
      ['dashboard', '总览', 'dashboard.png', 7000],
    ];
    for (const [route, label, file, wait] of shots) {
      await send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/?shot=1#/${route}` });
      await sleep(wait);
      // 等图标字体就绪 —— 不等的话侧栏会是一排占位方块（实测踩过）
      await send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)',
        awaitPromise: true,
      });
      await sleep(600);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(OUT, file);
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`  ✓ ${label.padEnd(6)} → docs/screenshots/${file}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    }
  } finally {
    child.kill();
    srv.kill();
    await sleep(400);
    // 还原配置，并把示例规则清掉（还原本身就覆盖了，这里只是双保险）
    fs.writeFileSync(CONFIG, original);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log('\n  配置已还原为原来的内容');
  finish(0);
})().catch((err) => {
  // finish() 是靠抛信号退出的，别把它当异常打印出来 ——
  // 否则正常退出也会在 stderr 里留一段吓人的堆栈
  if (isExitSignal(err)) throw err;
  console.error(err);
  finish(1);
});
