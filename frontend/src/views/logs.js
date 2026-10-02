// frontend/src/views/logs.js
//
// 实时日志。通过 SSE（/api/logs/stream）接收，不轮询。
//
// 性能上的取舍：日志可能来得很快（并发请求多的时候一秒几十条）。
//   * 只保留最近 500 条在内存里，显示 200 条
//   * 渲染节流 150ms，避免一秒内重建几十次 DOM
//
// 已知不足：paint() 目前是**整表重建**（最多 200 行），并不是增量插入。
// 后果是日志流动时无法选中复制 URL、hover 提示会被重置。
// 之所以先接受：跟随状态下这是纯 CPU 开销，实测不影响可用性；
// 真要修就该在跟随态下 prepend 单行并裁掉尾部，只在筛选变化时整表重建。
// 这里如实说明，免得注释比实现更乐观。
//
// 最新的在最上面：看实时日志时最常关心"刚刚发生了什么"，
// 放在底部还得不停滚动。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import {
  esc, fmtBytes, fmtDuration, fmtTime, statusBadge, debounce,
} from '../ui/dom.js'
import { View, pageHeader, card, emptyState } from './common.js'

/** 内存里最多保留多少条 */
const BUFFER_MAX = 500
/** DOM 里最多渲染多少行 */
const RENDER_MAX = 200
/** 渲染节流间隔 */
const RENDER_INTERVAL = 150

export class LogsView extends View {
  constructor() {
    super('logs')
    /** @type {object[]} 最新的在最前面 */
    this.entries = []
    this.filters = { level: '', onlySimulated: false, q: '' }
    this.closeStream = null
    this.renderTimer = null
    this.dirty = false
  }

  async render() {
    this.container.innerHTML = `
      ${pageHeader('logs.title', 'logs.intro')}

      ${card('', `
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" role="switch" id="logFollow" checked>
            <label class="form-check-label small" for="logFollow">
              ${esc(t('logs.follow'))}
              <span id="logFollowState" class="badge text-bg-success ms-1">${esc(t('logs.following'))}</span>
            </label>
          </div>

          <div class="form-check mb-0">
            <input class="form-check-input" type="checkbox" id="logOnlySim">
            <label class="form-check-label small" for="logOnlySim">${esc(t('logs.onlySimulated'))}</label>
          </div>

          <select class="form-select form-select-sm w-auto" id="logLevel">
            <option value="">${esc(t('logs.allLevels'))}</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>

          <input type="search" class="form-control form-control-sm w-auto flex-grow-1"
            id="logSearch" placeholder="${esc(t('logs.filterPlaceholder'))}" style="max-width:22rem">

          <span class="small text-secondary ms-auto" id="logCount"></span>
          <button class="btn btn-sm btn-outline-danger" id="logClear">
            <i class="bi bi-trash"></i> ${esc(t('logs.clear'))}
          </button>
        </div>

        <div class="log-scroll">
          <table class="hus-log-table">
            <thead>
              <tr>
                <th>${esc(t('logs.time'))}</th>
                <th>${esc(t('logs.method'))}</th>
                <th>${esc(t('logs.url'))}</th>
                <th>${esc(t('logs.result'))}</th>
                <th class="text-end">${esc(t('logs.duration'))}</th>
                <th class="text-end">${esc(t('logs.size'))}</th>
                <th>${esc(t('logs.sim'))}</th>
              </tr>
            </thead>
            <tbody id="logBody"></tbody>
          </table>
          <div id="logEmpty">${emptyState(t('logs.empty'))}</div>
        </div>
      `)}`

    await this.loadHistory()
    this.bind()
    this.paint(true)
  }

  /**
   * SSE 连接在这里建立，而不是 render() 里。
   * render() 会被 refresh() 反复调用（比如点急停），每次调都开一条新流
   * 会让旧连接泄漏、同一批日志被推两遍。
   */
  async setup() {
    this.startStream()
  }

  /** 按当前筛选条件从服务端拉一次历史。 */
  async loadHistory() {
    try {
      const params = { limit: BUFFER_MAX }
      if (this.filters.level) params.level = this.filters.level
      if (this.filters.q) params.q = this.filters.q
      if (this.filters.onlySimulated) params.onlySimulated = 'true'

      const data = await api.logs.query(params)
      // 服务端返回的是从旧到新，这里翻转成最新在前
      this.entries = (data.entries || []).slice().reverse()
    } catch (err) {
      reportError(err, t('toast.loadFailed'))
    }
  }

  startStream() {
    this.closeStream = api.logs.stream(
      (entry) => {
        if (!this.isActive()) return
        if (!this.passesFilter(entry)) return
        this.entries.unshift(entry)
        if (this.entries.length > BUFFER_MAX) this.entries.length = BUFFER_MAX
        this.scheduleRender()
      },
      () => {
        // 日志被清空（可能是别的客户端干的）
        this.entries = []
        this.scheduleRender()
      },
      () => {
        // SSE 断了：EventSource 会自己重连，但界面必须如实反映"现在不是跟随状态"，
        // 否则会一直显示"跟随中"却在悄悄丢日志（原来没传这个回调）。
        if (!this.isActive()) return
        const badge = this.container.querySelector('#logFollowState')
        if (badge) {
          badge.textContent = t('logs.paused')
          badge.className = 'badge text-bg-warning ms-1'
        }
      },
    )
    this.addCleanup(() => {
      if (this.closeStream) this.closeStream()
      this.closeStream = null
    })
  }

  /** 和 service 端的筛选语义保持一致，否则实时和历史会对不上。 */
  passesFilter(entry) {
    if (this.filters.level && entry.level !== this.filters.level) return false
    if (this.filters.onlySimulated) {
      const sim = entry.sim || {}
      if (!(sim.latencyMs || sim.fault || sim.throttled || sim.dropped)) return false
    }
    if (this.filters.q) {
      const needle = this.filters.q.toLowerCase()
      const haystack = `${entry.url || ''} ${entry.message || ''} ${entry.error || ''} ${entry.path || ''}`
        .toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  }

  scheduleRender() {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      if (this.isActive()) this.paint()
    }, RENDER_INTERVAL)
  }

  bind() {
    const search = this.container.querySelector('#logSearch')
    // 防抖函数存在实例上，destroy() 里才能 cancel 掉。
    // 原来是闭包局部变量，卸载后仍会发一次 /api/logs 请求。
    this.searchDebounced = debounce(async () => {
      if (!this.isActive()) return
      this.filters.q = search.value.trim()
      await this.loadHistory()
      if (this.isActive()) this.paint(true)
    }, 350)
    search.addEventListener('input', () => this.searchDebounced())

    this.container.querySelector('#logLevel').addEventListener('change', async (evt) => {
      this.filters.level = evt.target.value
      await this.loadHistory()
      if (this.isActive()) this.paint(true)
    })

    this.container.querySelector('#logOnlySim').addEventListener('change', async (evt) => {
      this.filters.onlySimulated = evt.target.checked
      await this.loadHistory()
      if (this.isActive()) this.paint(true)
    })

    this.container.querySelector('#logFollow').addEventListener('change', (evt) => {
      const badge = this.container.querySelector('#logFollowState')
      badge.textContent = evt.target.checked ? t('logs.following') : t('logs.paused')
      badge.className = `badge ms-1 ${evt.target.checked ? 'text-bg-success' : 'text-bg-secondary'}`
    })

    this.container.querySelector('#logClear').addEventListener('click', async () => {
      if (!window.confirm(t('logs.clearConfirm'))) return
      try {
        await api.logs.clear()
        this.entries = []
        if (!this.isActive()) return
        toastSuccess(t('logs.cleared'))
        this.paint(true)
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })
  }

  /**
   * 重画表格。
   * @param {boolean} [full] 强制整表重建（筛选条件变了、或者首次渲染）
   */
  paint(full = false) {
    const body = this.container.querySelector('#logBody')
    const emptyNode = this.container.querySelector('#logEmpty')
    const countNode = this.container.querySelector('#logCount')
    if (!body || !emptyNode) return

    const visible = this.entries.slice(0, RENDER_MAX)
    const follow = this.container.querySelector('#logFollow')?.checked !== false

    emptyNode.style.display = this.entries.length ? 'none' : 'block'

    if (!follow && !full) {
      // 暂停时不重画新行，但计数还是要更新，让人知道后台还在进日志
      if (countNode) {
        countNode.textContent = t('logs.buffered', { n: this.entries.length })
      }
      return
    }

    if (countNode) countNode.textContent = t('logs.buffered', { n: this.entries.length })

    body.innerHTML = visible.map((entry) => this.rowHtml(entry)).join('')
  }

  rowHtml(entry) {
    const sim = entry.sim || {}
    const simTags = []

    if (sim.fault) simTags.push(`<span class="sim-tag">${esc(sim.fault)}</span>`)
    if (sim.dropped) simTags.push(`<span class="sim-tag">${esc(sim.dropped)}</span>`)
    if (sim.latencyMs) simTags.push(`<span class="sim-tag">+${esc(sim.latencyMs)}ms</span>`)
    if (sim.throttled) simTags.push(`<span class="sim-tag">${esc(sim.bandwidthKbps)}Kbps</span>`)
    if (sim.range) simTags.push(`<span class="sim-tag">Range</span>`)
    if (sim.abortAfterBytes) simTags.push(`<span class="sim-tag">cut@${esc(fmtBytes(sim.abortAfterBytes))}</span>`)

    const simulated = simTags.length > 0
    const url = entry.url || entry.message || ''
    const hasError = Boolean(entry.error)

    return `
      <tr class="${simulated ? 'simulated' : ''}">
        <td class="text-secondary">${esc(fmtTime(entry.ts))}</td>
        <td>${esc(entry.method || '—')}</td>
        <td class="url-cell" title="${esc(url)}">${esc(url)}</td>
        <td>
          ${statusBadge(entry.status)}
          ${hasError ? `<i class="bi bi-exclamation-triangle text-danger ms-1"
            title="${esc(entry.error)}"></i>` : ''}
        </td>
        <td class="text-end">${esc(fmtDuration(entry.durationMs))}</td>
        <td class="text-end">${esc(fmtBytes(entry.size))}</td>
        <td>${simTags.join('')}</td>
      </tr>`
  }

  destroy() {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }
    if (this.searchDebounced && typeof this.searchDebounced.cancel === 'function') {
      this.searchDebounced.cancel()
    }
    if (this.closeStream) {
      this.closeStream()
      this.closeStream = null
    }
    this.entries = []
    super.destroy()
  }
}
