// scripts/lib/exit.js
//
// 统一的「退出前先把 stdout 写出去」助手。
//
// 为什么需要它：
//   Windows 上 stdout 指向管道或文件时，Node 的写入是**异步**的；
//   process.exit() 会立刻终止进程，不等它排空 —— 于是最后几行输出
//   （往往正好是失败明细和汇总）凭空消失，只留下一个 exit code 1。
//
//   这个坑在实际排查里非常费时间：你知道有断言失败了，却看不到是哪条。
//   `npm test` 这类把 stdout 接进管道的调用方式最容易触发。
//
// 原先只有 regression-test.js 里有一份私有实现，其余脚本都是裸
// process.exit()，等于把这些脚本的失败明细放在赌运气上。

/**
 * 退出前把 stdout 排空，然后再退出。
 *
 * @param {number} code 退出码
 */
function exitAfterFlush(code) {
  const finish = () => process.exit(code);

  // 已经写完了就下一拍退出（用 setImmediate 而不是直接 exit：
  // 同一 tick 里可能还有排队的输出）
  if (process.stdout.writableLength === 0) {
    setImmediate(finish);
    return;
  }

  process.stdout.once('drain', finish);
  // 兜底：stdout 万一永远不 drain（比如对端不读了），也不能把进程挂死
  setTimeout(finish, 1000).unref();
}

/**
 * 在可能出错的主流程里安全退出：先排空 stdout/stderr，再退出。
 * 供 catch 分支使用。
 *
 * @param {number} code
 * @param {Error} [err]
 */
function failAndExit(code, err) {
  if (err) console.error(err && err.stack ? err.stack : String(err));
  exitAfterFlush(code);
}

module.exports = { exitAfterFlush, failAndExit };
