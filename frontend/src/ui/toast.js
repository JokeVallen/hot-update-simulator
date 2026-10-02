// frontend/src/ui/toast.js
//
// 轻量的提示条。用它而不是 alert()：alert 会阻塞页面，
// 而调试过程中经常需要一边看日志一边操作。
//
// 做法是在页面右下角建一个容器，提示条插进去、几秒后自动移除。
// 用 Bootstrap 的 toast 样式，但自己控制生命周期，
// 免得依赖 Bootstrap 的 JS 实例管理。

import { esc } from './dom.js'

let container = null

function ensureContainer() {
  if (container) return container
  container = document.createElement('div')
  container.className = 'toast-container position-fixed bottom-0 end-0 p-3'
  container.style.zIndex = '1090'
  container.setAttribute('aria-live', 'polite')
  document.body.appendChild(container)
  return container
}

const VARIANT_CLASS = {
  success: 'text-bg-success',
  error: 'text-bg-danger',
  warn: 'text-bg-warning',
  info: 'text-bg-secondary',
}

/**
 * 弹一条提示。
 * @param {string} message
 * @param {'success'|'error'|'warn'|'info'} [variant]
 * @param {number} [timeoutMs] 0 表示不自动消失
 */
export function toast(message, variant = 'info', timeoutMs = 3500) {
  const host = ensureContainer()
  const node = document.createElement('div')
  node.className = `toast align-items-center border-0 ${VARIANT_CLASS[variant] || VARIANT_CLASS.info}`
  node.setAttribute('role', 'alert')
  node.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="关闭"></button>
    </div>`

  node.querySelector('.btn-close').addEventListener('click', () => node.remove())
  host.appendChild(node)
  // requestAnimationFrame 之后再显示，让 CSS 过渡动画能触发
  requestAnimationFrame(() => node.classList.add('show'))

  if (timeoutMs > 0) {
    setTimeout(() => {
      node.classList.remove('show')
      setTimeout(() => node.remove(), 300)
    }, timeoutMs)
  }

  return node
}

export const toastSuccess = (msg) => toast(msg, 'success')
export const toastError = (msg) => toast(msg, 'error', 6000)
export const toastWarn = (msg) => toast(msg, 'warn', 5000)

/**
 * 统一处理接口报错。把 ApiError 的 message 显示出来，
 * 而不是抛一个 "undefined is not a function" 让用户莫名其妙。
 */
export function reportError(err, prefix = '') {
  const message = err && err.message ? err.message : String(err)
  console.error('[api]', err)
  toastError(prefix ? `${prefix}：${message}` : message)
}
