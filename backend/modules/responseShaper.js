// backend/modules/responseShaper.js
//
// 响应体改写的**唯一**入口。
//
// 为什么要有这个模块（架构决策，不是随手抽出来的工具函数）：
//
// 原来 faultInjector 和 networkSimulator 各自去改写 res.write / res.end，
// 两层包裹，谁在外谁在内完全由 requestPipeline 的调用顺序决定。顺序一变，
// abort 的切点计算就会在第一个分片就触发，"限速下的断流"变成"延迟一下然后立刻断"，
// 而且不会有任何报错。更糟的是 faultInjector 里 abort/truncate/corrupt 三个
// 分支各自复制了一份「参数归一化 + sizeOf + limit」逻辑，改一处漏两处。
//
// 现在：一次安装、一个 state、一条串行的写出队列。
// 限速和截断在同一条队列里排队，顺序天然正确，也不可能漏掉某个分支。
//
// 覆盖的响应形态（原实现只正确处理了其中一种，另外两种是静默失效的）：
//   1. 有 Content-Length 的流式响应（assetServer 的 fs.createReadStream）
//   2. 有 Content-Length 的单块响应（Express 的 res.send(buffer)）
//   3. **没有 Content-Length 的 chunked 响应** —— 原来 abort/truncate 在这里
//      完全不生效（Number(undefined) 是 NaN，limit 被算成 Infinity）

const SLICE_BYTES = 16 * 1024;
/** 无 Content-Length 时必须缓冲；超过这个上限就放弃改写，避免把内存吃光。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** SSE 是永不结束的流，绝不能缓冲，也不能被截断逻辑碰到。 */
const STREAM_CONTENT_TYPE = 'text/event-stream';

/**
 * 背压水位（字节）。
 *
 * 这是必须的：包裹了 res.write 之后如果恒返回 true，`fs.createReadStream().pipe(res)`
 * 会以为下游跟得上，于是一路全速把整个文件读进我们的队列里排队。
 * 实测 100Kbps 限速下载 120MB 资产时，服务端 RSS 从 57MB 涨到 180MB 且还在涨，
 * 也就是说整个文件最终都会驻留内存 —— 用 GB 级热更包 + 弱网就会 OOM。
 *
 * 所以：排队字节数超过高水位就返回 false（pipe 会暂停数据源），
 * 排空到低水位再 emit('drain') 让它继续。这就是 Node 原生的背压协议。
 */
const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;

const MODES = ['abort', 'truncate', 'corrupt'];

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  return Buffer.alloc(0);
}

/** 把 res.end(chunk, encoding, callback) 的三种重载归一化成 {buf, cb}。 */
function normalizeEndArgs(chunk, encoding, callback) {
  if (typeof chunk === 'function') return { buf: null, cb: chunk };
  if (chunk === undefined || chunk === null) {
    return { buf: null, cb: typeof encoding === 'function' ? encoding : callback };
  }
  if (typeof encoding === 'function') return { buf: toBuffer(chunk, undefined), cb: encoding };
  return { buf: toBuffer(chunk, encoding), cb: callback };
}

/**
 * 把 buffer 中间的一段字节取反。用于 corrupt。
 * 刻意从中间开始改：改文件头会让客户端报"格式不对"，
 * 那样就测不出"校验失败"这个真正想测的场景。
 */
function damageMiddle(buffer, ratio) {
  if (!buffer.length) return buffer;
  const out = Buffer.from(buffer);
  const count = Math.max(1, Math.floor(out.length * ratio));
  const start = Math.max(0, Math.floor((out.length - count) / 2));
  for (let i = 0; i < count; i += 1) {
    const idx = start + i;
    if (idx >= out.length) break;
    out[idx] ^= 0xff;
  }
  return out;
}

/**
 * 为一次响应安装改写。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} options
 * @param {{mode:string, ratio:number}|null} [options.shape] 截断/断流/损坏策略
 * @param {number} [options.throttleKbps] 限速，千比特每秒；0 表示不限速
 * @returns {boolean} 是否安装了改写
 */
function install(req, res, { shape = null, throttleKbps = 0 } = {}) {
  const mode = shape && MODES.includes(shape.mode) ? shape.mode : null;
  const ratio = shape ? Math.min(1, Math.max(0.01, Number(shape.ratio) || 0.5)) : 0;
  const kbps = Number(throttleKbps) || 0;

  if (!mode && kbps <= 0) return false;

  const sim = req._sim || (req._sim = {});
  const writeRaw = res.write.bind(res);
  const endRaw = res.end.bind(res);
  const socket = req.socket;

  if (kbps > 0) {
    sim.throttled = true;
    sim.bandwidthKbps = kbps;
  }
  if (mode) sim.fault = mode;

  // 千比特/秒 → 字节/毫秒
  const bytesPerMs = kbps > 0 ? kbps / 8 : Infinity;

  /** 串行写出队列：保证顺序，并让限速与截断共用同一套节拍。 */
  let chain = Promise.resolve();
  let sent = 0;
  let limit = null;
  let finished = false;
  let damagedPosition = 0;
  let damageWindow = null;
  /** 无 Content-Length 时的缓冲 */
  let buffer = null;
  let gaveUp = false;
  /** 已入队但还没写到 socket 的字节数，用于背压 */
  let pendingBytes = 0;
  let drainPending = false;

  const declaredLength = () => {
    const n = Number(res.getHeader('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const enqueue = (fn) => {
    chain = chain.then(fn).catch(() => { /* 连接可能已被对端关闭 */ });
    return chain;
  };

  /** 队列排空到低水位就通知数据源继续。 */
  const maybeEmitDrain = () => {
    if (!drainPending || pendingBytes > LOW_WATER_BYTES) return;
    drainPending = false;
    // pipe() 监听的是目标流上的 'drain'，靠它恢复被暂停的数据源
    try {
      res.emit('drain');
    } catch {
      /* 已经销毁 */
    }
  };

  /** 按限速把一个 buffer 切片写出。没有限速时一次写出。 */
  const pacedWrite = (buf) => {
    if (!buf || !buf.length) return;
    const slices = [];
    if (bytesPerMs === Infinity) {
      slices.push(buf);
    } else {
      for (let offset = 0; offset < buf.length; offset += SLICE_BYTES) {
        slices.push(buf.subarray(offset, Math.min(offset + SLICE_BYTES, buf.length)));
      }
    }

    for (const slice of slices) {
      const delayMs = bytesPerMs === Infinity ? 0 : slice.length / bytesPerMs;
      pendingBytes += slice.length;
      sent += slice.length;
      // 注意：这里**不能**因为 finished 就跳过。
      // finishWith() 是同步置位 finished 的，而本任务是稍后才执行的；
      // 用它当"取消"标志会让所有已入队的数据都被丢掉（表现就是客户端收到 0 字节）。
      // finished 的语义只是"不再接收新的数据"，和"已经排队的数据要不要发"是两件事。
      enqueue(() => new Promise((resolve) => {
        const write = () => {
          try {
            // 用 write 的回调当作“这片真的落到内核了”，这既是节奏也是背压信号
            writeRaw(slice, () => {
              pendingBytes -= slice.length;
              maybeEmitDrain();
              resolve();
            });
          } catch {
            pendingBytes -= slice.length;
            resolve();
          }
        };
        if (delayMs <= 0) write();
        else setTimeout(write, delayMs);
      }));
    }
  };

  /** 数据发完之后收尾：正常结束、或掐断连接。 */
  const finishWith = (cutMode) => {
    if (finished) return;
    finished = true;

    if (cutMode === 'abort') {
      // 必须等最后一次写出真的落到内核再断，否则缓冲区里的数据会被一起丢掉
      // （这正是原实现"单块响应 abort 交付 0 字节"的原因）。
      enqueue(() => new Promise((resolve) => {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
        resolve();
      }));
      return;
    }

    // truncate：正常结束响应，但实际发出的字节数少于声明的 Content-Length。
    // 客户端会看到"内容长度不符 / 提前结束"。
    enqueue(() => new Promise((resolve) => {
      try {
        endRaw(() => resolve());
      } catch {
        resolve();
      }
    }));
  };

  /** 计算切点。Content-Length 已知时立即得到；未知时只能等到 end。 */
  const resolveLimit = (total) => {
    if (limit === null) {
      limit = Math.max(0, Math.floor(total * ratio));
      sim.abortAfterBytes = mode === 'corrupt' ? undefined : limit;
    }
    return limit;
  };

  /** 处理有内容长度、可以边收边发的响应。 */
  const handleStreaming = (buf) => {
    const total = declaredLength();
    if (total === null) return false;
    const cut = resolveLimit(total);

    if (mode === 'corrupt') {
      if (!damageWindow) {
        const count = Math.max(1, Math.floor(total * ratio));
        const start = Math.max(0, Math.floor((total - count) / 2));
        damageWindow = { start, end: start + count };
      }
      const pos = damagedPosition;
      damagedPosition += buf.length;
      if (pos >= damageWindow.end || pos + buf.length <= damageWindow.start) {
        pacedWrite(buf);
        return true;
      }
      const out = Buffer.from(buf);
      const from = Math.max(0, damageWindow.start - pos);
      const to = Math.min(buf.length, damageWindow.end - pos);
      for (let i = from; i < to; i += 1) out[i] ^= 0xff;
      pacedWrite(out);
      return true;
    }

    // abort / truncate：只放出切点之前的字节
    const remaining = cut - sent;
    if (remaining <= 0) {
      finishWith(mode);
      return true;
    }
    if (buf.length <= remaining) {
      pacedWrite(buf);
      return true;
    }
    pacedWrite(buf.subarray(0, remaining));
    finishWith(mode);
    return true;
  };

  /** 处理没有内容长度的响应：必须先攒齐才知道总量。 */
  const handleBuffered = (buf) => {
    if (gaveUp) return;
    if (!buffer) buffer = [];
    buffer.push(buf);
    const total = buffer.reduce((n, b) => n + b.length, 0);
    if (total > MAX_BUFFER_BYTES) {
      // 放弃改写，原样放行。宁可少注入一次故障，也不能把内存吃光。
      gaveUp = true;
      sim.shapeSkipped = 'buffer-limit';
      const all = Buffer.concat(buffer);
      buffer = null;
      pacedWrite(all);
    }
  };

  const flushBuffered = () => {
    if (!buffer) return;
    const all = Buffer.concat(buffer);
    buffer = null;
    const total = all.length;
    if (!total) {
      if (mode === 'abort') finishWith('abort');
      else finishWith(null);
      return;
    }

    if (mode === 'corrupt') {
      pacedWrite(damageMiddle(all, ratio));
      finishWith(null);
      return;
    }

    const cut = resolveLimit(total);
    pacedWrite(all.subarray(0, cut));
    finishWith(mode);
  };

  /** 首字节写入时判断这是不是不该碰的流（SSE）。 */
  let isBypassedStream = false;
  const checkBypass = () => {
    if (isBypassedStream || gaveUp) return isBypassedStream;
    const contentType = String(res.getHeader('content-type') || '');
    if (contentType.includes(STREAM_CONTENT_TYPE)) {
      isBypassedStream = true;
      sim.shapeSkipped = 'event-stream';
    }
    return isBypassedStream;
  };

  let installed = false;

  res.write = function shapedWrite(chunk, encoding, callback) {
    if (!installed) {
      installed = true;
      checkBypass();
    }
    if (isBypassedStream) return writeRaw(chunk, encoding, callback);
    if (finished) {
      if (typeof callback === 'function') callback();
      return false;
    }

    const buf = toBuffer(chunk, encoding);
    // 三种模式走同一套分支判断。
    //
    // 这里原来给 corrupt 单独开了一条 `if (mode === 'corrupt') handleStreaming(buf)`，
    // 少了 declaredLength() 检查 —— 而 handleStreaming 在不知道总长度时会直接
    // return false 且**一个字节都不写**，返回值又被忽略。结果是：
    // 对一个 chunked 响应注入 corrupt，客户端收到 **0 字节**，
    // 而且没有任何错误信号。res.end 里那份同样的判断反而是对的（有 fallback），
    // 所以只有"中间分片"这一段被吞掉，症状更隐蔽。
    if (!mode) {
      // 只限速
      pacedWrite(buf);
    } else if (declaredLength() !== null) {
      // 知道总长度，可以边收边发
      handleStreaming(buf);
    } else {
      // 不知道总长度（chunked）：必须先攒齐才能算切点
      handleBuffered(buf);
    }

    if (typeof callback === 'function') callback();

    // 背压：队列积压太多就返回 false，pipe() 会暂停数据源；
    // 等排空到低水位时由 maybeEmitDrain() 触发 'drain' 恢复。
    if (pendingBytes > HIGH_WATER_BYTES) {
      drainPending = true;
      return false;
    }
    return true;
  };

  res.end = function shapedEnd(chunk, encoding, callback) {
    if (!installed) {
      installed = true;
      checkBypass();
    }
    const { buf, cb } = normalizeEndArgs(chunk, encoding, callback);

    if (isBypassedStream) {
      return endRaw(buf === null ? undefined : buf, cb);
    }
    if (finished) {
      if (typeof cb === 'function') cb();
      return this;
    }

    if (buf && buf.length) {
      if (!mode) {
        pacedWrite(buf);
      } else if (declaredLength() !== null) {
        handleStreaming(buf);
      } else {
        handleBuffered(buf);
      }
    }

    if (buffer) {
      flushBuffered();
    } else if (!finished) {
      if (mode === 'abort' && !buf) {
        // 流式响应没到切点就自然结束（文件比切点还小）——仍然按注入的语义掐断
        finishWith('abort');
      } else {
        finishWith(null);
      }
    }

    if (typeof cb === 'function') enqueue(() => { cb(); });
    return this;
  };

  return true;
}

module.exports = { install, damageMiddle, MODES, SLICE_BYTES, MAX_BUFFER_BYTES };
