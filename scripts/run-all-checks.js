#!/usr/bin/env node
// scripts/run-all-checks.js
//
// 一条命令跑完全部闸门 —— `npm test` 就是它。
//
// 为什么单独写一个而不是用 `npm-run-all` 之类：
//   * ui-check 需要一个**正在运行的服务**，而别的检查不需要。
//     这个差异没法靠串命令解决，得在这里起停。
//   * 依赖越少越好：开源之后别人 clone 下来应该 `npm install && npm test` 就能跑。
//
// 每一项都是独立进程，各自的退出码决定成败；某一项失败不会中断后面的 ——
// 一次跑完看到全部问题，比修一个跑一次快得多。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { finish, isExitSignal } = require('./lib/exit');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 找一个空闲端口，免得和用户自己跑着的实例撞车。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 等 /api/health 就绪。 */
async function waitHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

/** 找一个可用的 Chrome / Edge（ui-check 需要）。 */
function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
      'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    : [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function run(script, args = []) {
  const started = Date.now();
  const r = spawnSync(NODE, [script, ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status === null ? 1 : r.status, out, ms: Date.now() - started };
}

(async () => {
  console.log('热更新模拟器 · 全部检查\n');

  const results = [];
  const push = (name, code, ms, note = '') => results.push({ name, code, ms, note });

  // ---- 不依赖服务的 ----
  const simple = [
    ['lint', 'scripts/../node_modules/.bin/eslint', null],
  ];
  void simple;

  const checks = [
    ['lint', () => run('node_modules/eslint/bin/eslint.js', ['.'])],
    ['arch', () => run('scripts/arch-report.js')],
    ['docs-check', () => run('scripts/docs-coverage.js')],
    ['version-check', () => run('scripts/version-check.js')],
    ['regression', () => run('scripts/regression-test.js')],
    ['smoke', () => run('scripts/smoke-test.js')],
    ['soak', () => run('scripts/soak-test.js')],
  ];

  for (const [name, fn] of checks) {
    process.stdout.write(`  ${name.padEnd(14)} …`);
    const r = fn();
    // eslint 的退出码非 0 才是错；warning 不影响
    const pass = r.code === 0;
    console.log(pass ? '✓' : '✗');
    if (!pass) {
      // 失败时把它自己的输出原样吐出来 —— 否则还要再跑一次才知道为什么
      console.log(r.out.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
    }
    push(name, r.code, r.ms);
  }

  // ---- ui-check：需要服务 + 浏览器 ----
  const browser = findBrowser();
  if (!browser) {
    console.log('  ui-check       ·  跳过（没找到 Chrome / Edge）');
    push('ui-check', 0, 0, '跳过');
  } else {
    process.stdout.write('  ui-check       …');
    const port = await freePort();
    const srv = spawn(NODE, ['backend/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
      stdio: 'ignore',
    });
    try {
      const healthy = await waitHealthy(port);
      if (!healthy) {
        console.log('✗');
        console.log('      服务没能在 15 秒内就绪');
        push('ui-check', 1, 0, '服务未就绪');
      } else {
        const r = run('scripts/ui-check.js', [`http://127.0.0.1:${port}`]);
        console.log(r.code === 0 ? '✓' : '✗');
        if (r.code !== 0) {
          console.log(r.out.split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
        }
        push('ui-check', r.code, r.ms);
      }
    } finally {
      srv.kill();
      await sleep(200);
    }
  }

  // ---- 汇总 ----
  console.log(`\n${'='.repeat(56)}`);
  const failed = results.filter((r) => r.code !== 0);
  for (const r of results) {
    const mark = r.code === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${r.name.padEnd(14)} ${String(r.ms).padStart(6)} ms  ${r.note}`);
  }
  console.log('='.repeat(56));
  console.log(failed.length
    ? `失败 ${failed.length} 项：${failed.map((r) => r.name).join(', ')}`
    : `全部通过（${results.length} 项）`);

  finish(failed.length ? 1 : 0);
})().catch((err) => {
  if (isExitSignal(err)) throw err;
  console.error(err);
  finish(1);
});
