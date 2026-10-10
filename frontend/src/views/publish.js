// frontend/src/views/publish.js
//
// 发布配置：渠道 + 灰度。
//
// 为什么把这两件事放一页：它们回答的是同一个问题 ——
// **哪个客户端该拿到哪个版本**。渠道决定"内容从哪个目录读"，
// 灰度决定"这个版本先给谁"。分开放反而要在两页之间来回看。
//
// 这两块在 2.0.0 就已经完整实现了，但一直只能改 config.json ——
// 功能是齐的，只差点一下就能用。而渠道名恰恰是"客户端写死了什么"的问题，
// 改起来必须比手改配置文件容易得多（见 2.3.0 的 N-2 行为变更）。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { state, loadControl, loadPlatforms } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc } from '../ui/dom.js'
import { View, pageHeader, card, emptyState } from './common.js'

/** 和 backend/core/faultRule.js 里的匹配维度保持一致。 */
const RULE_FIELDS = [
  { key: 'devices', label: 'publish.grayDevices', placeholder: 'dev-001, dev-002' },
  { key: 'channels', label: 'publish.grayChannels', placeholder: 'beta, dev' },
  { key: 'platforms', label: 'publish.grayPlatforms', placeholder: 'Android, iOS' },
  { key: 'regions', label: 'publish.grayRegions', placeholder: 'CN, SEA' },
]

export class PublishView extends View {
  constructor() {
    super('publish')
    /** 正在编辑的灰度规则下标；null 表示没在编辑 */
    this.editingGray = null
  }

  async render() {
    const hot = state.hotUpdate || {}
    const channels = Array.isArray(hot.channels) ? hot.channels : []
    const gray = hot.gray || { enabled: false, rules: [] }
    const rules = Array.isArray(gray.rules) ? gray.rules : []

    // 配置声明的渠道 vs 各平台实际有的渠道 —— 这两者对不上是最常见的配置错误，
    // 所以直接摆在渠道区旁边，不用让人自己去比对
    const platforms = state.platforms || []

    this.container.innerHTML = `
      ${pageHeader('publish.title', 'publish.intro')}

      ${card(t('publish.channels'), `
        <div class="mb-3">
          <label class="form-label small mb-1">${esc(t('publish.defaultChannel'))}</label>
          <div class="d-flex flex-wrap gap-2">
            ${channels.map((c) => `
              <div class="form-check">
                <input class="form-check-input" type="radio" name="defaultChannel"
                  id="defch-${esc(c)}" value="${esc(c)}"
                  ${hot.defaultChannel === c ? 'checked' : ''}>
                <label class="form-check-label mono" for="defch-${esc(c)}">${esc(c)}</label>
              </div>`).join('')}
          </div>
          <div class="small text-secondary mt-1">${esc(t('publish.defaultChannelHint'))}</div>
        </div>

        <div class="mb-3">
          <label class="form-label small mb-1" for="channelList">${esc(t('publish.channelList'))}</label>
          <input class="form-control form-control-sm mono" id="channelList"
            value="${esc(channels.join(', '))}">
          <div class="small text-secondary mt-1">${esc(t('publish.channelListHint'))}</div>
        </div>

        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-primary" id="saveChannels">${esc(t('common.save'))}</button>
        </div>

        <hr class="my-3">

        <div class="small fw-semibold mb-1">${esc(t('publish.channelReality'))}</div>
        ${platforms.length ? `
          <table class="hus-log-table">
            <thead><tr>
              <th>${esc(t('publish.platform'))}</th>
              <th>${esc(t('publish.actualChannels'))}</th>
              <th>${esc(t('publish.verdict'))}</th>
            </tr></thead>
            <tbody>
              ${platforms.map((p) => {
    const actual = p.channels || []
    // 只声明了一个渠道、平台也只报一个 → 平铺布局，这是正常状态
    const mismatch = actual.some((a) => !channels.includes(a));
    return `<tr>
                  <td class="mono">${esc(p.name)}</td>
                  <td class="mono">${actual.length ? esc(actual.join(', ')) : esc(t('publish.none'))}</td>
                  <td class="small ${mismatch ? 'text-warning' : 'text-secondary'}">
                    ${mismatch
    ? esc(t('publish.mismatch')) : esc(t('publish.channelOk'))}
                  </td>
                </tr>`
  }).join('')}
            </tbody>
          </table>` : emptyState(t('publish.noPlatforms'))}
      `)}

      ${card(t('publish.gray'), `
        <div class="form-check form-switch mb-3">
          <input class="form-check-input" type="checkbox" role="switch" id="grayEnabled"
            ${gray.enabled ? 'checked' : ''}>
          <label class="form-check-label" for="grayEnabled">${esc(t('publish.grayEnabled'))}</label>
        </div>

        <div class="small text-secondary mb-2">${esc(t('publish.graySemantics'))}</div>

        <div class="d-flex align-items-center justify-content-between mb-2">
          <span class="small fw-semibold">${esc(t('publish.grayRules', { n: rules.length }))}</span>
          <button class="btn btn-sm btn-outline-secondary" id="grayAdd">
            <i class="bi bi-plus-lg"></i> ${esc(t('publish.grayAdd'))}
          </button>
        </div>

        ${rules.length ? `<div class="d-flex flex-column gap-2">${rules
    .map((r, i) => this.grayRuleRow(r, i)).join('')}</div>`
    : emptyState(t('publish.grayNoRules'))}

        <div class="d-flex gap-2 mt-3">
          <button class="btn btn-sm btn-primary" id="saveGray">${esc(t('common.save'))}</button>
        </div>
      `)}
    `

    this.bindChannels()
    this.bindGray()
  }

  /** 预览：这条规则会匹配谁。让"规则内 AND、规则间 OR"看得见。 */
  grayRuleRow(rule, index) {
    if (this.editingGray === index) return this.grayRuleEditor(rule, index)

    const conds = []
    for (const { key, label } of RULE_FIELDS) {
      const v = rule[key]
      if (Array.isArray(v) && v.length) conds.push(`${t(label)}: ${v.join('/')}`)
    }
    if (rule.minAppVersion) conds.push(`${t('publish.grayMinApp')} ≥ ${rule.minAppVersion}`)
    if (rule.maxAppVersion) conds.push(`${t('publish.grayMaxApp')} ≤ ${rule.maxAppVersion}`)
    if (Number(rule.percent) > 0) conds.push(`${t('publish.grayPercent')} ${rule.percent}%`)

    return `
      <div class="d-flex align-items-center justify-content-between border rounded px-2 py-1">
        <div class="min-w-0">
          <div class="small fw-semibold text-truncate">
            ${esc(rule.name || t('publish.grayUnnamed'))}
            ${rule.enabled === false
    ? `<span class="badge text-bg-secondary ms-1">${esc(t('common.disabled'))}</span>` : ''}
          </div>
          <div class="rule-meta text-truncate">${esc(conds.join(' · ') || t('publish.grayNoConds'))}</div>
        </div>
        <div class="d-flex gap-1 flex-shrink-0">
          <button class="btn btn-sm btn-outline-secondary" data-gray-edit="${index}">
            ${esc(t('common.edit'))}
          </button>
          <button class="btn btn-sm btn-outline-danger" data-gray-del="${index}">
            ${esc(t('common.delete'))}
          </button>
        </div>
      </div>`
  }

  grayRuleEditor(rule, index) {
    return `
      <div class="border rounded p-2">
        <div class="row g-2">
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1">${esc(t('publish.grayName'))}</label>
            <input class="form-control form-control-sm" data-gray-field="name"
              value="${esc(rule.name || '')}">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1">${esc(t('publish.grayPercent'))}</label>
            <input class="form-control form-control-sm" type="number" min="0" max="100"
              data-gray-field="percent" value="${Number(rule.percent) || 0}">
          </div>
          ${RULE_FIELDS.map(({ key, label, placeholder }) => `
            <div class="col-12 col-md-6">
              <label class="form-label small mb-1">${esc(t(label))}</label>
              <input class="form-control form-control-sm mono" data-gray-field="${key}"
                placeholder="${esc(placeholder)}"
                value="${esc((rule[key] || []).join(', '))}">
            </div>`).join('')}
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('publish.grayMinApp'))}</label>
            <input class="form-control form-control-sm mono" data-gray-field="minAppVersion"
              placeholder="1.2.0" value="${esc(rule.minAppVersion || '')}">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('publish.grayMaxApp'))}</label>
            <input class="form-control form-control-sm mono" data-gray-field="maxAppVersion"
              placeholder="2.0.0" value="${esc(rule.maxAppVersion || '')}">
          </div>
        </div>
        <div class="form-check form-switch mt-2">
          <input class="form-check-input" type="checkbox" data-gray-field="enabled"
            ${rule.enabled === false ? '' : 'checked'}>
          <label class="form-check-label small">${esc(t('publish.grayRuleEnabled'))}</label>
        </div>
        <div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-primary" data-gray-apply="${index}">
            ${esc(t('common.apply'))}
          </button>
          <button class="btn btn-sm btn-outline-secondary" data-gray-cancel="1">
            ${esc(t('common.cancel'))}
          </button>
        </div>
      </div>`
  }

  // ------------------------------------------------------------------ 渠道

  bindChannels() {
    const btn = this.container.querySelector('#saveChannels')
    if (!btn) return
    btn.addEventListener('click', async () => {
      const raw = this.container.querySelector('#channelList').value || ''
      const channels = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
      const picked = this.container.querySelector('input[name="defaultChannel"]:checked')
      const defaultChannel = picked ? picked.value : undefined

      if (!channels.length) {
        reportError(new Error(t('publish.channelEmpty')), t('publish.saveFailed'))
        return
      }
      try {
        const res = await api.control.patchHotUpdate({
          channels,
          ...(defaultChannel ? { defaultChannel } : {}),
        })
        await loadControl()
        await loadPlatforms()
        // 被规范化掉的部分要说出来 —— 否则界面显示的和存下来的不是一回事
        if (res.notes && res.notes.length) {
          reportError(new Error(res.notes.join('；')), t('publish.normalized'))
        } else {
          toastSuccess(t('publish.saved'))
        }
        await this.render()
      } catch (err) {
        reportError(err, t('publish.saveFailed'))
      }
    })
  }

  // ------------------------------------------------------------------ 灰度

  bindGray() {
    const on = this.container.querySelector('#grayEnabled')
    if (on) {
      on.addEventListener('change', () => this.saveGray({ enabled: on.checked }))
    }

    const add = this.container.querySelector('#grayAdd')
    if (add) {
      add.addEventListener('click', () => {
        const rules = this.currentGrayRules()
        rules.push({ name: '', enabled: true, percent: 0 })
        this.editingGray = rules.length - 1
        this.saveGray({ rules }, { silent: true })
      })
    }

    this.container.querySelectorAll('[data-gray-edit]').forEach((el) => {
      el.addEventListener('click', () => {
        this.editingGray = Number(el.dataset.grayEdit)
        this.render()
      })
    })

    this.container.querySelectorAll('[data-gray-del]').forEach((el) => {
      el.addEventListener('click', () => {
        const rules = this.currentGrayRules()
        rules.splice(Number(el.dataset.grayDel), 1)
        this.editingGray = null
        this.saveGray({ rules })
      })
    })

    this.container.querySelectorAll('[data-gray-cancel]').forEach((el) => {
      el.addEventListener('click', () => {
        this.editingGray = null
        this.render()
      })
    })

    this.container.querySelectorAll('[data-gray-apply]').forEach((el) => {
      el.addEventListener('click', () => {
        const index = Number(el.dataset.grayApply)
        const rules = this.currentGrayRules()
        const box = el.closest('.border')

        const readList = (key) => {
          const input = box.querySelector(`[data-gray-field="${key}"]`)
          return input ? input.value.split(',').map((s) => s.trim()).filter(Boolean) : []
        }
        const readOne = (key) => {
          const input = box.querySelector(`[data-gray-field="${key}"]`)
          return input ? input.value.trim() : ''
        }

        const next = {
          name: readOne('name') || `规则 ${index + 1}`,
          enabled: box.querySelector('[data-gray-field="enabled"]').checked,
          percent: Number(readOne('percent')) || 0,
        }
        for (const { key } of RULE_FIELDS) next[key] = readList(key)
        const min = readOne('minAppVersion')
        const max = readOne('maxAppVersion')
        if (min) next.minAppVersion = min
        if (max) next.maxAppVersion = max

        rules[index] = next
        this.editingGray = null
        this.saveGray({ rules })
      })
    })

    const save = this.container.querySelector('#saveGray')
    if (save) {
      save.addEventListener('click', () => this.saveGray({}))
    }
  }

  /**
   * 当前的灰度规则列表。
   *
   * 注意用 **state** 而不是 DOM 里渲染出来的——编辑中的那条在 DOM 里是表单，
   * 从 DOM 反解会丢掉没渲染出来的字段。
   */
  currentGrayRules() {
    const hot = state.hotUpdate || {}
    const gray = hot.gray || {}
    return JSON.parse(JSON.stringify(Array.isArray(gray.rules) ? gray.rules : []))
  }

  async saveGray(patch, opts = {}) {
    const hot = state.hotUpdate || {}
    const gray = hot.gray || {}
    const body = {
      gray: {
        enabled: patch.enabled === undefined ? Boolean(gray.enabled) : patch.enabled,
        percent: Number(gray.percent) || 0,
        rules: patch.rules || this.currentGrayRules(),
      },
    }
    try {
      const res = await api.control.patchHotUpdate(body)
      await loadControl()
      if (!opts.silent && res.notes && res.notes.length) {
        reportError(new Error(res.notes.join('；')), t('publish.normalized'))
      } else if (!opts.silent) {
        toastSuccess(t('publish.saved'))
      }
      await this.render()
    } catch (err) {
      reportError(err, t('publish.saveFailed'))
    }
  }
}
