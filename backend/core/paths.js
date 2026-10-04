// backend/core/paths.js
//
// 「运行时数据放哪」的唯一事实来源，同时也是 **.env 的唯一加载点**。
//
// 为什么需要单独一个模块：
//   在这之前，存储位置散在三处，而且互不知情 ——
//     * utils/jsonStore.js     模块加载时算死 <项目>/storage，导出一个常量
//     * core/configManager.js  配置里的 assetDir 是相对 **backend/** 解析的
//     * scripts/make-sample-assets.js  自己又硬编码了一份 <项目>/storage
//   后果是"想让数据离开项目目录"根本做不到，而且三者一旦不一致就会出现
//   很难查的现象：`npm run sample` 明明说生成成功，面板里却一个平台都没有。
//
// 为什么 .env 在这里加载：
//   原来只有 backend/app.js 加载 dotenv。于是把 HOT_UPDATE_STORAGE 写进 .env
//   时，**服务器读得到、scripts/ 下的脚本读不到** ——
//   服务器去 D:\hus-data 找资产，npm run sample 却写到项目内的 storage，
//   两边都不报错，面板里一个平台都没有。踩过一次，别再踩。
//   放在这里之后，任何 require 本模块的入口（服务器、示例生成、测试脚本、
//   发行包）都拿到同一份配置，不用谁记得去加载。
//
// 加载顺序很重要：dotenv 必须在读取 process.env 之前执行，
// 所以这一段放在模块顶部；storageRoot() 又是每次调用时才读 process.env。

const path = require('path');

/** 项目根目录（本文件在 backend/core/ 下，往上两级）。 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// dotenv 是可选依赖：万一没装或 .env 不存在，也只是没有 .env 支持，
// 不该让整个项目起不来。
try {
  require('dotenv').config({
    path: path.join(PROJECT_ROOT, '.env'),
    // 已经存在的环境变量优先：命令行的显式设置要能盖过 .env 文件
    override: false,
    quiet: true,
  });
} catch {
  // 走默认值，不影响使用
}

/**
 * 运行时数据的根目录（绝对路径）。
 *
 * 每次调用都重新读环境变量而不是在模块加载时算死：开销可以忽略，
 * 但能避免"改了配置却还指着旧路径"这类只在特定启动顺序下才出现的 bug。
 */
function storageRoot() {
  const raw = String(process.env.HOT_UPDATE_STORAGE || '').trim();
  if (!raw) return path.join(PROJECT_ROOT, 'storage');
  // 相对路径按**项目根**解析，不是按当前工作目录 —— 否则从别的目录
  // 启动（比如 IDE 里）就会指到意料之外的地方。
  return path.resolve(PROJECT_ROOT, raw);
}

/** 资产目录（存储根下的 assets）。 */
function assetsDir() {
  return path.join(storageRoot(), 'assets');
}

module.exports = { PROJECT_ROOT, storageRoot, assetsDir };
