// frontend/src/views/common.js
//
// 各视图共用的片段与工具。
//
// 视图的约定：每个视图导出一个对象 { id, mount(container), unmount() }。
// mount 负责把内容填进容器，unmount 负责清理定时器和 SSE 订阅——
// 不清理的话，切走页面后旧视图还在后台拉数据、还在往已删除的 DOM 上写。

import { t } from '../locales/index.js'
import { esc } from '../ui/dom.js'

/** 页面标题 + 说明。 */
export function pageHeader(titleKey, introKey) {
  return `
    <h2 class="hus-page-title">${esc(t(titleKey))}</h2>
    <p class="hus-page-intro">${esc(t(introKey))}</p>`
}

/** 一个大数字统计卡。 */
export function statCard(label, value, sub = '') {
  return `
    <div class="hus-card">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>`
}

/** 带标题的卡片容器。 */
export function card(title, bodyHtml, extraClass = '') {
  return `
    <div class="hus-card ${extraClass}">
      ${title ? `<div class="hus-card-title">${esc(title)}</div>` : ''}
      ${bodyHtml}
    </div>`
}

/** 空状态提示。 */
export function emptyState(message) {
  return `<div class="empty-state"><i class="bi bi-inbox d-block fs-3 mb-2"></i>${esc(message)}</div>`
}

/**
 * 把任意值渲染成可读的 JSON。
 * 循环引用和超长内容都要处理——接口返回的东西不完全可控。
 */
export function prettyJson(value, maxChars = 20000) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (!text) return ''
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n\n…（内容过长，已截断，共 ${text.length} 字符）`
  }
  return text
}

/**
 * 视图基类：统一处理"只在我还活着的时候更新 DOM"这件事。
 *
 * 异步请求回来时视图可能已经被切走了。isActive() 用来判断，
 * 避免往已经卸载的 DOM 里写数据（那是内存泄漏和诡异报错的常见来源）。
 */
export class View {
  constructor(id) {
    this.id = id
    this.container = null
    this.timers = []
    this.cleanups = []
    this.active = false
  }

  isActive() {
    return this.active
  }

  /** 注册一个 setInterval，卸载时自动清掉。 */
  every(ms, fn) {
    const timer = setInterval(() => {
      if (this.active) fn()
    }, ms)
    this.timers.push(timer)
    return timer
  }

  /** 注册一个卸载时要执行的清理函数。 */
  addCleanup(fn) {
    this.cleanups.push(fn)
  }

  destroy() {
    this.active = false
    this.timers.forEach(clearInterval)
    this.timers = []
    this.cleanups.forEach((fn) => {
      try {
        fn()
      } catch (err) {
        console.error(`[view ${this.id}] 清理时出错：`, err)
      }
    })
    this.cleanups = []
    this.container = null
  }

  async mount(container) {
    this.container = container
    this.active = true
    await this.render()
    // 副作用只在挂载时安装一次
    await this.setup()
  }

  /**
   * 渲染 DOM。
   *
   * **可以**被 refresh() 反复调用，所以这里不能注册定时器、订阅或 SSE 连接 ——
   * 那些要放在 setup()。否则每刷新一次就多一份，且旧的永远不会被清理。
   */
  async render() {
    throw new Error('视图必须实现 render()')
  }

  /**
   * 安装副作用：定时器、事件订阅、SSE 连接。
   * 只在 mount() 时调用一次，配合 destroy() 里的清理形成完整生命周期。
   */
  async setup() {}

  /**
   * 重新拉数据并重画。
   *
   * 外部想"刷新当前页面"时应该调这个，**不要**直接调 render()：
   * 原来的急停按钮就是直接调 render()，于是 LogsView 又开了一条 SSE 流，
   * 旧的那条永远不会关闭，同一批日志被推两遍。
   */
  async refresh() {
    if (!this.active || !this.container) return
    await this.render()
  }
}
