// backend/core/paths.js
//
// 「运行时数据放哪」的唯一事实来源。
//
// 为什么需要单独一个模块：
//   在这之前，存储位置散在三处，而且互不知情 ——
//     * utils/jsonStore.js     模块加载时算死 <项目>/storage，导出一个常量
//     * core/configManager.js  配置里的 assetDir 是相对 **backend/** 解析的
//     * scripts/make-sample-assets.js  自己又硬编码了一份 <项目>/storage
//   后果是"想让数据离开项目目录"根本做不到，而且三者一旦不一致就会出现
//   很难查的现象：`npm run sample` 明明说生成成功，面板里却一个平台都没有。
//
// 现在统一走这里：默认 <项目>/storage，用环境变量 HOT_UPDATE_STORAGE 可以
// 指到任何地方（相对路径按项目根解析，绝对路径原样用）。
//
// 这是「把模拟器和开发用的项目隔离开」的主要开关：
//   HOT_UPDATE_STORAGE=D:\hus-data npm start
// 之后示例包、预置方案、收藏全都落在 D:\hus-data，项目目录里干干净净。

const path = require('path');

/** 项目根目录（本文件在 backend/core/ 下，往上两级）。 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

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
