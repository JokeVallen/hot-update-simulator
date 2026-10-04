// backend/utils/jsonStore.js
//
// 极简的 JSON 文件存储。预置方案、收藏列表这类“用户的配置数据”用它落盘，
// 这样重启服务器不会丢。
//
// 为什么不用数据库：这个模拟器的数据量非常小（几十条记录），
// 用 SQLite 反而给使用者增加了一个要装/要备份的东西。
// 一个能直接打开看的 JSON 文件，对调试工具来说更合适。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { storageRoot } = require('../core/paths');

class JsonStore {
  /**
   * @param {string} filePath 数据文件的绝对路径
   * @param {*} fallback 文件不存在或损坏时返回的默认值
   */
  constructor(filePath, fallback = null) {
    this.filePath = filePath;
    this.fallback = fallback;
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) return this.cloneFallback();
      const raw = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return this.cloneFallback();
      return JSON.parse(raw);
    } catch (err) {
      // 文件坏了不能让接口整个 500 —— 返回默认值，用户还能从界面里修
      console.error(`[store] 读取 ${this.filePath} 失败：${err.message}`);
      return this.cloneFallback();
    }
  }

  write(data) {
    const dir = path.dirname(this.filePath);
    // 临时文件名必须唯一：原来所有并发写都用同一个 <file>.tmp，
    // 两个请求同时改收藏时，其中一个的 rename 会失败（另一个已经把 tmp 移走了），
    // 而失败被静默吞掉 —— 表现就是"我加了一条收藏但没保存上"。
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      console.error(`[store] 写入 ${this.filePath} 失败：${err.message}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能没建出来 */
      }
      return false;
    }
  }

  /** 文件不存在时把 fallback 写下去，让用户能看到一个可编辑的模板。 */
  ensure() {
    if (!fs.existsSync(this.filePath)) {
      this.write(this.cloneFallback());
    }
    return this.read();
  }

  cloneFallback() {
    return this.fallback === null || this.fallback === undefined
      ? this.fallback
      : JSON.parse(JSON.stringify(this.fallback));
  }
}

module.exports = JsonStore;
// 存储根由 core/paths 决定（默认 <项目>/storage，可用 HOT_UPDATE_STORAGE 改）。
// 用 getter 而不是加载时算死的常量：routes/system.js 会把它报给界面，
// 值必须是"现在真实在用"的那个。
Object.defineProperty(module.exports, 'STORAGE_ROOT', {
  enumerable: true,
  get: storageRoot,
});

/** 拼出存储根下的文件绝对路径。 */
module.exports.storagePath = function storagePath(...segments) {
  return path.join(storageRoot(), ...segments);
};
