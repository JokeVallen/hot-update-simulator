// scripts/lib/browser.js
//
// 找 Chrome / Edge 的**唯一实现**。
//
// 为什么要单独抽出来：这个列表原本在三个脚本里各抄了一份
// （ui-check.js、run-all-checks.js、make-screenshots.js），而且**抄得不一致** ——
// run-all-checks 有 Linux/macOS 路径，ui-check 只有 Windows 路径。
// 于是 CI（ubuntu-latest，自带 Chrome）上：
//   run-all-checks 判定"有浏览器"→ 启动 ui-check
//   → ui-check 自己找不到 → finish(2) → `npm test` 失败
// **同一件事的两份实现不一致，比两份都错更难查** —— 因为一边的行为会掩盖另一边的。

const fs = require('fs');

/** 平台无关的候选路径。顺序 = 优先级。 */
const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // 用户级安装（不需要管理员权限那种）
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  // Linux：不同发行版/安装方式差很多，能列的都列上
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
  ],
};

/**
 * 找浏览器可执行文件。
 *
 * 环境变量优先，其次是各平台的常见路径。环境变量这条很关键 ——
 * CI 和用 snap/flatpak 装的机器上，路径无法穷举，得留一个出口。
 *
 * @returns {string|null}
 */
function findBrowser() {
  const fromEnv = process.env.CHROME_PATH
    || process.env.CHROME_BIN
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const list = CANDIDATES[process.platform] || [];
  for (const p of list) {
    // LOCALAPPDATA 为空时会拼出 '\Google\...'，existsSync 会返回 false，无需特判
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * headless 启动需要的额外参数。
 *
 * 以 root 跑时 Chrome 会**拒绝启动沙箱**（容器里很常见：Docker、部分 CI），
 * 必须给 `--no-sandbox`。非 root 时不要加 —— 那是白白削弱隔离。
 */
function sandboxArgs() {
  if (process.platform === 'win32' || process.platform === 'darwin') return [];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return isRoot ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'];
}

/** 给错误信息用的、可操作的提示。 */
function notFoundHint() {
  return [
    '  找过这些位置：',
    ...(CANDIDATES[process.platform] || []).map((p) => `    ${p}`),
    '  也可以用环境变量直接指定：',
    '    CHROME_PATH=/path/to/chrome',
  ].join('\n');
}

/**
 * 当前环境能不能驱动无头浏览器（界面检查的前提）。
 *
 * 两个前提，缺一不可：
 *   1. 有 Chrome / Edge
 *   2. 有全局 `WebSocket` —— **Node 22 才是稳定全局**
 *      （21 要 `--experimental-websocket`，20 完全没有）
 *
 * 为什么要显式区分这两种情况：CI 上 Node 20 与 22 并行跑，20 会
 * `ReferenceError: WebSocket is not defined` 直接崩掉，而报错信息里
 * 完全看不出"是 Node 版本不够"。区分开之后，Node 20 会明确说
 * "跳过，原因是没有全局 WebSocket"，而不是伪装成一个失败。
 *
 * @returns {{ok:true, browser:string}|{ok:false, reason:string, hint:string}}
 */
function cdpReadiness() {
  const browser = findBrowser();
  if (!browser) {
    return { ok: false, reason: '找不到 Chrome / Edge', hint: notFoundHint() };
  }
  if (typeof globalThis.WebSocket !== 'function') {
    return {
      ok: false,
      reason: `Node ${process.version} 没有全局 WebSocket（需要 Node 22+）`,
      hint: '  界面检查要连 Chrome 的调试端口，靠的是内置的 WebSocket 客户端。\n'
        + '  它从 Node 22 起才是稳定全局。服务器本身不受影响，只有这一项检查跑不了。\n'
        + '  升级 Node，或跳过这项检查（npm test 会自动跳过）。',
    };
  }
  return { ok: true, browser };
}

module.exports = {
  findBrowser, sandboxArgs, notFoundHint, cdpReadiness, CANDIDATES,
};
