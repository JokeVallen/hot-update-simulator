// scripts/lib/exit.js
//
// 脚本的统一退出机制。
//
// 为什么不是一个普通的 `process.exit` 包装：
//
//   1. Windows 上 stdout 指向管道或文件时，Node 的写入是**异步**的；
//      process.exit() 会立刻终止进程、不等它排空 —— 于是最后几行输出
//      （往往正好是失败明细和汇总）凭空消失，只留下一个 exit code。
//      `npm test` 这类把 stdout 接进管道的调用方式最容易触发。
//
//   2. 但"排空后再退出"不能直接做成「先注册一个回调再返回」——
//      那样调用点**后面的代码会继续执行**。实测踩过：
//      make-release.js 里"工作区不干净，拒绝打包"打印完之后，
//      打包流程照样跑完、把包生成了出来，最后才退出 1。
//      安全守卫一旦拦不住后面的代码，就等于没有守卫。
//
// 所以这里用**抛出信号**的方式：finish() 之后当前流程立即中断，
// 由本模块安装的顶层处理器统一排空输出再退出。
// 这样"停下来"和"把话说完"两件事同时成立，而且调用点不用关心自己
// 是在流程中间还是在结尾 —— 只有一种用法，也就没有用错的机会。

/** 内部信号。不承载用户可见信息，只带退出码。 */
class ExitSignal extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.name = 'ExitSignal';
    this.code = code;
    this.isExitSignal = true;
  }
}

/**
 * 排空 stdout/stderr 之后再退出。
 *
 * 用 setImmediate 而不是直接 exit：同一 tick 里可能还有排队的输出。
 * 兜底定时器**不能 unref** —— 否则进程可能在它触发前就自然退出，
 * 退出码会变成 0，把失败当成成功。
 */
function drainAndExit(code) {
  const finishNow = () => process.exit(code);

  if (process.stdout.writableLength === 0) {
    setImmediate(finishNow);
    return;
  }
  process.stdout.once('drain', finishNow);
  setTimeout(finishNow, 1000);
}

/**
 * 已经定下的退出码。**第一次调用 finish() 说了算。**
 *
 * 为什么需要这个：
 *   信号是靠抛出来中断流程的，而 JS 里任何一层 try/catch 都能把它吞掉。
 *   实测踩过：ui-check.js 的 `try { …; finish(0) } catch (err) { …; finish(1) }`，
 *   正常路径的 finish(0) 被自己的 catch 接住，然后 catch 用 finish(1) 覆盖了它 ——
 *   21 条断言全过，退出码却是 1。
 *
 *   加上"首次为准"之后，后面那些被误导的 finish(1) 改不动它。
 */
let decided = null;

/** 判断一个错误是不是本模块抛出的退出信号（供 catch 分支放行用）。 */
function isExitSignal(err) {
  return Boolean(err && err.isExitSignal);
}

/**
 * 结束脚本。
 *
 * ⚠️ 它通过**抛出**实现，所以调用点之后的代码不会执行。
 * 这既是"守卫"需要的行为，也适用于正常收尾 —— 只有一种用法。
 *
 * 被 try/catch 吞掉时也安全：退出码已经写进 process.exitCode，
 * 进程自然结束时用的就是它。catch 分支最好还是显式放行信号
 * （`if (isExitSignal(err)) throw err`），那样报错信息才不会被噪音污染。
 *
 * @param {number} code 退出码
 */
function finish(code) {
  if (decided === null) {
    decided = code;
    // 兜底：即使信号被某层 catch 吞掉、脚本继续跑到自然结束，
    // 退出码也还是对的 —— 绝不能把失败报成成功
    process.exitCode = code;
  }
  throw new ExitSignal(decided);
}

/**
 * 顶层处理器：把信号翻译成"排空 + 退出"。
 *
 * 两种都接：
 *   * uncaughtException —— 同步流程里抛出的信号
 *   * unhandledRejection —— 在 .catch() 里调用 finish() 时，
 *     抛出会变成未处理的 rejection（而不是未捕获异常）
 */
function onFatal(err) {
  if (err && err.isExitSignal) {
    drainAndExit(err.code);
    return;
  }
  // 不是退出信号，就是真的出错了：照原样报出来，别把它藏掉
  console.error(err && err.stack ? err.stack : String(err));
  drainAndExit(1);
}

process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

module.exports = { finish, drainAndExit, isExitSignal, ExitSignal };
