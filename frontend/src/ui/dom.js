// frontend/src/ui/dom.js
//
// 一组很小的 DOM 辅助函数。
//
// 最重要的一条约定：**凡是要插进 HTML 的动态内容，必须过 esc()**。
// 日志里的 URL、故障规则的名字都是用户可控的，直接拼字符串就是 XSS。

/**
 * 转义 HTML 特殊字符。
 * 拼 innerHTML 之前，所有来自后端的字符串都要先过这里。
 */
export function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]))
}

/** querySelector 的简写。 */
export function qs(selector, root = document) {
  return root.querySelector(selector)
}

/** querySelectorAll 的简写，返回真数组方便用 map/filter。 */
export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
}

/**
 * 事件委托。动态生成的列表用这个，比给每个元素单独绑事件省事，
 * 也不会因为重新渲染而丢掉监听。
 */
export function delegate(root, eventName, selector, handler) {
  root.addEventListener(eventName, (evt) => {
    const target = evt.target.closest(selector)
    if (target && root.contains(target)) handler(evt, target)
  })
}

/** 格式化字节数。 */
export function fmtBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 格式化耗时。 */
export function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

/** 格式化时间戳为 HH:MM:SS。 */
export function fmtTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toTimeString().slice(0, 8)
}

/** 把状态码渲染成带颜色的徽章。status 为 null 表示连接被掐断。 */
export function statusBadge(status) {
  if (status === null || status === undefined) {
    return '<span class="badge text-bg-dark" title="连接被掐断，客户端只会看到网络错误">断连</span>'
  }
  const cls = status >= 500 ? 'text-bg-danger'
    : status >= 400 ? 'text-bg-warning'
      : status >= 300 ? 'text-bg-info'
        : 'text-bg-success'
  return `<span class="badge ${cls}">${esc(status)}</span>`
}

/**
 * 防抖。给输入框用，避免每敲一个字就发一次请求。
 */
export function debounce(fn, wait = 300) {
  let timer = null
  return function debounced(...args) {
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), wait)
  }
}

/** 按节流间隔执行，用于高频事件（例如日志流里的批量渲染）。 */
export function throttle(fn, wait = 200) {
  let last = 0
  let timer = null
  return function throttled(...args) {
    const now = Date.now()
    const remaining = wait - (now - last)
    if (remaining <= 0) {
      clearTimeout(timer)
      timer = null
      last = now
      fn.apply(this, args)
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now()
        timer = null
        fn.apply(this, args)
      }, remaining)
    }
  }
}
