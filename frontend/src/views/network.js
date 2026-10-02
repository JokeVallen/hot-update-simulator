// frontend/src/views/network.js
//
// 网络模拟：延迟、抖动、带宽、丢包、断网。
//
// 交互上的取舍：所有改动都立即生效（数字输入防抖 350ms），
// 而不是填完再点"保存"。调这类参数靠的是"改一下、看客户端什么反应"，
// 多一步确认会很烦。代价是需要节流，否则每敲一个数字发一次请求。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { state, loadControl } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc, debounce } from '../ui/dom.js'
import { View, pageHeader, card } from './common.js'

/** 常用档位，一键填好。数值按运营商口径（千比特每秒）。 */
/** WiFi/4G/3G 是各语言通用的，只有"弱网"需要翻译，所以用 labelKey。 */
const QUICK_SETS = [
  { key: 'wifi', label: 'WiFi', latencyMs: 20, jitterMs: 5, bandwidthKbps: 20000, packetLossRate: 0 },
  { key: '4g', label: '4G', latencyMs: 150, jitterMs: 60, bandwidthKbps: 2000, packetLossRate: 0 },
  { key: '3g', label: '3G', latencyMs: 400, jitterMs: 150, bandwidthKbps: 400, packetLossRate: 0 },
  { key: 'weak', labelKey: 'network.quickWeak', latencyMs: 1200, jitterMs: 500, bandwidthKbps: 100, packetLossRate: 0.05 },
]

const FIELDS = [
  { key: 'latencyMs', labelKey: 'network.latency', hintKey: null, min: 0, max: 600000, step: 10, unitKey: 'network.ms' },
  { key: 'jitterMs', labelKey: 'network.jitter', hintKey: 'network.jitterHint', min: 0, max: 600000, step: 10, unitKey: 'network.ms' },
  { key: 'bandwidthKbps', labelKey: 'network.bandwidth', hintKey: 'network.bandwidthHint', min: 0, max: 10000000, step: 100, unitKey: 'network.kbps' },
  { key: 'packetLossRate', labelKey: 'network.packetLoss', hintKey: 'network.packetLossHint', min: 0, max: 1, step: 0.01, unitKey: null },
]

export class NetworkView extends View {
  constructor() {
    super('network')
    /** 防抖后的保存函数，只建一次，避免每次输入都新建定时器 */
    this.saveDebounced = debounce(() => this.save(), 350)
  }

  async render() {
    const net = state.network || {}

    this.container.innerHTML = `
      ${pageHeader('network.title', 'network.intro')}

      <div class="row g-3">
        <div class="col-12 col-lg-7">
          ${card('', `
            <div class="d-flex align-items-center justify-content-between mb-3">
              <div class="form-check form-switch mb-0">
                <input class="form-check-input" type="checkbox" role="switch" id="netEnabled"
                  ${net.enabled ? 'checked' : ''}>
                <label class="form-check-label fw-semibold" for="netEnabled">
                  ${esc(t('network.enabled'))}
                </label>
              </div>
              <span id="netSaveState" class="small text-success" style="opacity:0">
                <i class="bi bi-check2"></i> ${esc(t('toast.saved'))}
              </span>
            </div>

            <div class="form-check form-switch mb-4">
              <input class="form-check-input" type="checkbox" role="switch" id="netOffline"
                ${net.offline ? 'checked' : ''}>
              <label class="form-check-label" for="netOffline">${esc(t('network.offline'))}</label>
              <div class="form-text">${esc(t('network.offlineHint'))}</div>
            </div>

            <div id="netFields">
              ${FIELDS.map((f) => this.fieldHtml(f, net[f.key])).join('')}
            </div>

            <div class="d-flex gap-2 mt-3">
              <button class="btn btn-sm btn-outline-secondary" id="netReset">
                <i class="bi bi-arrow-counterclockwise"></i> ${esc(t('common.reset'))}
              </button>
            </div>
          `)}
        </div>

        <div class="col-12 col-lg-5">
          ${card(t('network.quick'), `
            <div class="d-flex flex-wrap gap-2">
              ${QUICK_SETS.map((q) => `
                <button class="btn btn-sm btn-outline-primary" data-quick="${esc(q.key)}">
                  ${esc(q.labelKey ? t(q.labelKey) : q.label)}
                </button>`).join('')}
            </div>
            <hr>
            <div class="stat-label">${esc(t('network.estimate'))}</div>
            <div class="stat-value" id="netEstimate">—</div>
            <div class="stat-sub" id="netEstimateNote"></div>
          `)}
        </div>
      </div>`

    this.bind()
    this.updateEstimate()
  }

  fieldHtml(field, value) {
    const current = value === undefined ? 0 : value
    return `
      <div class="mb-3">
        <label class="form-label small mb-1" for="net_${esc(field.key)}">
          ${esc(t(field.labelKey))}
          <span class="text-secondary mono" id="val_${esc(field.key)}">${esc(current)}</span>
          ${field.unitKey ? `<span class="text-secondary small">${esc(t(field.unitKey))}</span>` : ''}
        </label>
        <input type="number" class="form-control form-control-sm" id="net_${esc(field.key)}"
          value="${esc(current)}" min="${field.min}" max="${field.max}" step="${field.step}">
        ${field.hintKey ? `<div class="form-text">${esc(t(field.hintKey))}</div>` : ''}
      </div>`
  }

  bind() {
    const enabled = this.container.querySelector('#netEnabled')
    const offline = this.container.querySelector('#netOffline')

    // 开关类：立即生效，不防抖 —— 点一下就应该看到结果
    enabled.addEventListener('change', async () => {
      await this.patch({ enabled: enabled.checked })
    })

    offline.addEventListener('change', async () => {
      await this.patch({ offline: offline.checked })
    })

    // 数字输入：防抖，避免每敲一位就发一次请求
    FIELDS.forEach((field) => {
      const input = this.container.querySelector(`#net_${field.key}`)
      if (!input) return

      input.addEventListener('input', () => {
        const label = this.container.querySelector(`#val_${field.key}`)
        if (label) label.textContent = input.value
        this.updateEstimate()
        this.saveDebounced()
      })
      // 失焦时立刻落盘，避免防抖还没到就切走了
      input.addEventListener('blur', () => this.save())
    })

    this.container.querySelector('#netReset').addEventListener('click', async () => {
      try {
        const res = await api.control.resetNetwork()
        await loadControl()
        if (!this.isActive()) return
        toastSuccess(t('network.resetDone'))
        await this.render()
        this.flashSaved()
        void res
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })

    this.container.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const preset = QUICK_SETS.find((q) => q.key === btn.dataset.quick)
        if (!preset) return
        await this.patch({
          enabled: true,
          offline: false,
          latencyMs: preset.latencyMs,
          jitterMs: preset.jitterMs,
          bandwidthKbps: preset.bandwidthKbps,
          packetLossRate: preset.packetLossRate,
        })
        if (this.isActive()) {
          await this.render()
          this.flashSaved()
        }
      })
    })
  }

  /** 收集当前表单里的数值。 */
  collect() {
    const patch = {}
    FIELDS.forEach((field) => {
      const input = this.container.querySelector(`#net_${field.key}`)
      if (!input) return
      const value = Number(input.value)
      if (Number.isFinite(value)) patch[field.key] = value
    })
    return patch
  }

  /** 保存到后端。后端会做越界夹取并把结果写回配置。 */
  async save() {
    // 卸载之后不再发请求：防抖可能还排着一次，而那时 container 已经没了
    if (!this.isActive() || !this.container) return
    const patch = this.collect()
    if (!Object.keys(patch).length) return
    await this.patch(patch, { flash: true })
  }

  async patch(partial, { flash = false } = {}) {
    try {
      const res = await api.control.patchNetwork(partial)
      await loadControl()
      if (!this.isActive()) return
      // 后端会把越界值夹到合法范围，所以要把夹过之后的值回填到输入框，
      // 否则界面显示的数字和后端实际生效的数字会对不上
      this.syncInputs(res.network)
      this.updateEstimate()
      if (flash) this.flashSaved()
    } catch (err) {
      reportError(err, t('network.title'))
    }
  }

  syncInputs(network) {
    if (!network) return
    FIELDS.forEach((field) => {
      const input = this.container.querySelector(`#net_${field.key}`)
      if (!input) return
      // 正在输入时不覆盖，否则光标会跳
      if (document.activeElement === input) return
      input.value = network[field.key]
      const label = this.container.querySelector(`#val_${field.key}`)
      if (label) label.textContent = network[field.key]
    })
  }

  /** 用当前表单值估算下载 10MB 需要多久。 */
  updateEstimate() {
    const box = this.container.querySelector('#netEstimate')
    const note = this.container.querySelector('#netEstimateNote')
    if (!box || !note) return

    const kbps = Number((this.container.querySelector('#net_bandwidthKbps') || {}).value) || 0
    const latency = Number((this.container.querySelector('#net_latencyMs') || {}).value) || 0
    const offline = this.container.querySelector('#netOffline')?.checked
    const enabled = this.container.querySelector('#netEnabled')?.checked

    if (!enabled) {
      box.textContent = t('common.disabled')
      note.textContent = ''
      return
    }
    if (offline) {
      box.textContent = '∞'
      note.textContent = t('network.offline')
      return
    }
    if (kbps <= 0) {
      box.textContent = t('common.unlimited')
      note.textContent = latency > 0 ? `${latency} ms` : ''
      return
    }

    // 10MB = 10 * 1024 * 1024 字节 = 83886080 比特
    const seconds = 83886080 / (kbps * 1000)
    const total = seconds + latency / 1000
    box.textContent = total < 60
      ? `${total.toFixed(1)} ${t('common.seconds')}`
      : `${(total / 60).toFixed(1)} min`
    note.textContent = `${t('network.bandwidth')} ${kbps} ${t('network.kbps')}`
  }

  /** 短暂显示"已保存"再淡出，比每次弹 toast 清静。 */
  flashSaved() {
    const node = this.container.querySelector('#netSaveState')
    if (!node) return
    node.style.transition = 'none'
    node.style.opacity = '1'
    setTimeout(() => {
      if (!node.isConnected) return
      node.style.transition = 'opacity 0.6s ease'
      node.style.opacity = '0'
    }, 900)
  }

  destroy() {
    // 必须真的取消排队中的那次防抖，而不是把引用置空 ——
    // 置空拦不住已经排好的 setTimeout，它仍会执行并访问已清空的 container。
    if (this.saveDebounced && typeof this.saveDebounced.cancel === 'function') {
      this.saveDebounced.cancel()
    }
    this.saveDebounced = () => {}
    super.destroy()
  }
}
