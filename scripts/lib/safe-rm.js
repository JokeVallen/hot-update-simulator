// scripts/lib/safe-rm.js
//
// 删除目录的安全实现。
//
// 为什么不能用 `fs.rmSync(dir, { recursive: true })`：
// 实测在 **Node 24 + Windows** 上，路径含非 ASCII 字符时它会出问题，而且是两种
// 完全不同的故障形态：
//
//   | 路径            | fs.rmSync 的行为                        |
//   |-----------------|----------------------------------------|
//   | 纯 ASCII        | 正常                                    |
//   | ASCII + 中文    | **静默失败**：不抛异常，但目录还在        |
//   | 纯中文          | **进程硬崩**：0xC0000409 STATUS_STACK_BUFFER_OVERRUN |
//
// 最要命的是第三种：原生崩溃 try/catch 抓不住，脚本会**静默死掉**，只留下一个
// 莫名其妙的退出码。这个坑我实际踩过一次 —— 回归测试跑到一半进程消失、没有
// 任何报错、汇总行也不打印，定位花了很久。
//
// 实测 `fs.rm`（异步版）和「手工 unlinkSync + rmdirSync」在三种路径上都正常，
// 所以这里用它们。
//
// 注意：服务端运行时代码不删任何目录，所以只影响脚本。

const fs = require('fs');
const path = require('path');

/**
 * 自底向上手工删除：先删文件，再删目录。
 * 全程只用 unlinkSync / rmdirSync（不带 recursive），避开出问题的那条路径。
 * @returns {boolean} 是否删干净了
 */
function removeDirSync(dir) {
  if (!fs.existsSync(dir)) return true;

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(current);
  };

  try {
    walk(dir);
  } catch {
    // 尽力而为：调用方通过返回值判断
  }
  return !fs.existsSync(dir);
}

/**
 * 异步删除：优先用 fs.rm，失败或没删干净再走手工路径。
 * @returns {Promise<boolean>} 是否删干净了
 */
function removeDir(dir) {
  return new Promise((resolve) => {
    if (!fs.existsSync(dir)) {
      resolve(true);
      return;
    }
    fs.rm(dir, { recursive: true, force: true }, () => {
      if (!fs.existsSync(dir)) {
        resolve(true);
        return;
      }
      resolve(removeDirSync(dir));
    });
  });
}

module.exports = { removeDir, removeDirSync };
