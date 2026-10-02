// frontend/src/views/presets.js
//
// 预置方案：一键切换整套模拟场景。
//
// 这个页面是整个工具最常用的入口——大多数时候你不想手工调参数，
// 只想"切到弱网看看客户端什么反应"。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { state, loadControl, loadPresets } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc } from '../ui/dom.js'
import { View, pageHeader, emptyState } from './common.js'

export class PresetsView extends View {
  constructor() {
    super('presets')
    /** 刚应用过的方案 id，用来高亮 */
    this.appliedId = null
  }

  async render() {
    const presets = state.presets || []
    const builtin = presets.filter((p) => p.builtin)
    const custom = presets.filter((p) => !p.builtin)

    this.container.innerHTML = `
      ${pageHeader('presets.title', 'presets.intro')}

      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <button class="btn btn-sm btn-outline-primary" id="presetCapture">
          <i class="bi bi-bookmark-plus"></i> ${esc(t('presets.capture'))}
        </button>
        <span class="small text-secondary">${esc(t('presets.captureHint'))}</span>
      </div>

      <div class="hus-card-title">${esc(t('presets.builtin'))}</div>
      <div class="row g-3 mb-4">
        ${builtin.map((p) => this.presetCard(p)).join('') || `<div class="col-12">${emptyState(t('common.none'))}</div>`}
      </div>

      <div class="hus-card-title">${esc(t('presets.custom'))}</div>
      <div class="row g-3" id="presetCustomRow">
        ${custom.map((p) => this.presetCard(p)).join('') || `<div class="col-12">${emptyState(t('common.none'))}</div>`}
      </div>`

    this.bind()
  }

  presetCard(preset) {
    const net = preset.network || {}
    const fault = preset.fault || {}
    const isApplied = this.appliedId === preset.id

    const netLabel = net.enabled ? t('presets.networkOn') : t('presets.networkOff')
    const faultLabel = fault.enabled ? t('presets.faultOn') : t('presets.faultOff')
    const ruleCount = (fault.rules || []).length

    return `
      <div class="col-12 col-md-6 col-xl-4">
        <div class="preset-card ${isApplied ? 'border-primary' : ''}" data-preset-id="${esc(preset.id)}">
          <div class="d-flex align-items-start justify-content-between">
            <div class="preset-name">${esc(preset.name)}</div>
            <span class="badge ${preset.builtin ? 'text-bg-secondary' : 'text-bg-primary'}">
              ${esc(preset.builtin ? t('presets.builtin') : t('presets.custom'))}
            </span>
          </div>
          <div class="preset-desc">${esc(preset.description || '')}</div>
          <div class="rule-meta mb-2">
            ${esc(t('presets.summary', { network: netLabel, fault: faultLabel, rules: ruleCount }))}
          </div>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-primary" data-preset-apply="${esc(preset.id)}">
              <i class="bi bi-play-fill"></i> ${esc(t('presets.apply'))}
            </button>
            ${preset.builtin ? '' : `
              <button class="btn btn-sm btn-outline-danger ms-auto" data-preset-delete="${esc(preset.id)}">
                <i class="bi bi-trash"></i>
              </button>`}
          </div>
        </div>
      </div>`
  }

  bind() {
    this.container.querySelectorAll('[data-preset-apply]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.presetApply
        btn.disabled = true
        try {
          await api.presets.apply(id)
          // 应用会同时改网络参数和故障规则，两个都要重新拉
          await Promise.all([loadControl(), loadPresets()])
          if (!this.isActive()) return
          this.appliedId = id
          const preset = (state.presets || []).find((p) => p.id === id)
          toastSuccess(t('presets.applied', { name: preset ? preset.name : id }))
          this.render()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
        } finally {
          btn.disabled = false
        }
      })
    })

    this.container.querySelectorAll('[data-preset-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(t('common.confirmDelete'))) return
        try {
          await api.presets.remove(btn.dataset.presetDelete)
          await loadPresets()
          if (!this.isActive()) return
          toastSuccess(t('presets.deleted'))
          this.render()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
        }
      })
    })

    this.container.querySelector('#presetCapture').addEventListener('click', async () => {
      const name = window.prompt(t('presets.capturePrompt'))
      if (!name || !name.trim()) return
      try {
        await api.presets.capture(name.trim())
        await loadPresets()
        if (!this.isActive()) return
        toastSuccess(t('presets.captureDone'))
        this.render()
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })
  }
}
