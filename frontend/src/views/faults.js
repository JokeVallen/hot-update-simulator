// frontend/src/views/faults.js
//
// 故障注入：规则的增删改查。
//
// 编辑器做成页面内的面板而不是弹窗：调一条规则经常要回去看一眼
// 另一条规则的参数，弹窗会挡住列表。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { state, loadControl } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc } from '../ui/dom.js'
import { View, pageHeader, card, emptyState } from './common.js'

// 和 backend/core/faultRule.js 的 FAULT_TYPES 必须一致。
// 前后端是两个独立的包，没法直接共享这个常量，只能靠这条注释和
// docs-check / 冒烟测试兜底 —— 加了新类型记得两边都改。
const FAULT_TYPES = ['status', 'timeout', 'slowHeader', 'abort', 'truncate', 'corrupt', 'slowThenAbort', 'empty']
const METHODS = ['', 'GET', 'POST', 'PUT', 'DELETE']

export class FaultsView extends View {
  constructor() {
    super('faults')
    /** 正在编辑的规则；null 表示编辑器关闭 */
    this.editing = null
    /** 倒计时角标的位置与剩余量，由 rulesHtml() 填充、tickTimeBadges() 消费 */
    this.timeMarks = []
  }

  /**
   * 时间维度的倒计时要动。
   *
   * 做法是**只改角标文字**，不重建列表：
   *   * 重建会丢事件绑定，也会把正在编辑的输入框清掉
   *   * 倒计时由客户端自己算（渲染时的剩余量 + 本地流逝时间），
   *     所以不需要为此提高轮询频率
   */
  async setup() {
    this.every(250, () => this.tickTimeBadges())
  }

  /** 只刷新带时间窗的角标文字。 */
  tickTimeBadges() {
    if (!this.container || !this.timeMarks || !this.timeMarks.length) return
    const now = Date.now()
    for (const mark of this.timeMarks) {
      const el = this.container.querySelector(`[data-time-badge="${mark.id}"]`)
      if (!el) continue
      const elapsed = now - mark.renderedAt
      if (mark.kind === 'pending') {
        const left = Math.max(0, mark.activatesInMs - elapsed)
        el.textContent = t('faults.activatesIn', { s: Math.ceil(left / 1000) })
      } else if (mark.kind === 'active') {
        const left = Math.max(0, mark.expiresInMs - elapsed)
        el.textContent = t('faults.expiresIn', { s: Math.ceil(left / 1000) })
      }
    }
  }

  async render() {
    const fault = state.fault || { enabled: false, rules: [] }
    const rules = fault.rules || []

    this.container.innerHTML = `
      ${pageHeader('faults.title', 'faults.intro')}

      <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" role="switch" id="faultEnabled"
            ${fault.enabled ? 'checked' : ''}>
          <label class="form-check-label fw-semibold" for="faultEnabled">
            ${esc(t('faults.enabled'))}
          </label>
        </div>
        <span class="spacer flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" id="faultRestartClock"
          title="${esc(t('faults.restartClockHint'))}">
          <i class="bi bi-stopwatch"></i> ${esc(t('faults.restartClock'))}
        </button>
        <button class="btn btn-sm btn-outline-secondary" id="faultResetCounters">
          <i class="bi bi-arrow-counterclockwise"></i> ${esc(t('faults.resetCounters'))}
        </button>
        <button class="btn btn-sm btn-primary" id="faultAddRule">
          <i class="bi bi-plus-lg"></i> ${esc(t('faults.addRule'))}
        </button>
      </div>

      <div id="faultEditor"></div>

      <div class="row g-3">
        <div class="col-12 col-xl-8">
          ${card(t('faults.rules'), `<div id="faultRuleList">${this.rulesHtml(rules)}</div>`)}
        </div>
        <div class="col-12 col-xl-4">
          ${this.typeLegend()}
        </div>
      </div>`

    this.bind()
    if (this.editing) this.openEditor(this.editing)
  }

  rulesHtml(rules) {
    // 每次渲染都重算一遍角标位置，避免旧的引用留在列表里
    this.timeMarks = []
    if (!rules.length) return emptyState(t('faults.empty'))

    return `
      <div class="small text-secondary mb-2">
        <i class="bi bi-info-circle"></i> ${esc(t('faults.orderHint'))}
      </div>
      ${rules.map((rule) => this.ruleHtml(rule)).join('')}`
  }

  ruleHtml(rule) {
    const match = rule.match || {}
    const action = rule.action || {}
    const hits = rule.hits || 0
    const maxHits = Number(rule.maxHits) || 0

    const matchParts = []
    if (match.method) matchParts.push(`method=${match.method}`)
    if (match.pathPrefix) matchParts.push(`path^=${match.pathPrefix}`)
    if (match.pathGlob) matchParts.push(`glob=${match.pathGlob}`)
    if (match.platform) matchParts.push(`platform=${match.platform}`)
    const matchText = matchParts.length ? matchParts.join('  ') : `*  ${t('faults.matchAny')}`

    const actionParts = [`${action.type}`]
    if (action.type === 'status') actionParts.push(`→ ${action.status}`)
    if (action.delayMs) actionParts.push(`+${action.delayMs}ms`)
    if (['abort', 'truncate', 'corrupt', 'slowThenAbort'].includes(action.type)) actionParts.push(`ratio=${action.ratio}`)
    if (rule.probability !== undefined && Number(rule.probability) < 1) {
      actionParts.push(`p=${rule.probability}`)
    }

    const hitsText = maxHits > 0
      ? `${hits} / ${maxHits}`
      : `${hits}`

    // 时间窗状态的角标。文字由 tickTimeBadges() 持续刷新，
    // 所以这里记下渲染时刻的剩余量，之后靠本地流逝时间推算。
    let timeBadge = ''
    if (rule.timeState === 'pending' && rule.activatesInMs !== undefined) {
      this.timeMarks.push({
        id: rule.id, kind: 'pending', activatesInMs: rule.activatesInMs, renderedAt: Date.now(),
      })
      timeBadge = `<span class="badge text-bg-info ms-1" data-time-badge="${esc(rule.id)}">`
        + `${esc(t('faults.activatesIn', { s: Math.ceil(rule.activatesInMs / 1000) }))}</span>`
    } else if (rule.timeState === 'active' && rule.expiresInMs !== undefined) {
      this.timeMarks.push({
        id: rule.id, kind: 'active', expiresInMs: rule.expiresInMs, renderedAt: Date.now(),
      })
      timeBadge = `<span class="badge text-bg-success ms-1" data-time-badge="${esc(rule.id)}">`
        + `${esc(t('faults.expiresIn', { s: Math.ceil(rule.expiresInMs / 1000) }))}</span>`
    } else if (rule.timeState === 'expired') {
      timeBadge = `<span class="badge text-bg-secondary ms-1">${esc(t('faults.windowExpired'))}</span>`
    }

    return `
      <div class="rule-item ${rule.enabled === false ? 'disabled' : ''}" data-rule-id="${esc(rule.id)}">
        <div class="d-flex align-items-start gap-2">
          <div class="form-check form-switch mb-0 mt-1">
            <input class="form-check-input" type="checkbox" role="switch"
              data-rule-toggle="${esc(rule.id)}" ${rule.enabled === false ? '' : 'checked'}>
          </div>
          <div class="flex-grow-1 min-width-0">
            <div class="rule-name">${esc(rule.name || rule.id)}${timeBadge}</div>
            <div class="rule-meta">${esc(matchText)}</div>
            <div class="rule-meta text-warning">${esc(actionParts.join('  '))}</div>
          </div>
          <div class="text-end">
            <div class="small text-secondary">${esc(t('faults.hits'))}</div>
            <div class="mono ${hits ? 'text-warning' : 'text-secondary'}">${esc(hitsText)}</div>
          </div>
          <div class="btn-group btn-group-sm ms-2">
            <button class="btn btn-outline-secondary" data-rule-edit="${esc(rule.id)}"
              title="${esc(t('common.edit'))}">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-outline-danger" data-rule-delete="${esc(rule.id)}"
              title="${esc(t('common.delete'))}">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
      </div>`
  }

  /** 右侧的故障类型说明。这是整个页面最有信息量的部分。 */
  typeLegend() {
    return card(
      t('faults.actionType'),
      `<div class="d-flex flex-column gap-3">
        ${FAULT_TYPES.map((type) => `
          <div>
            <div class="mono text-primary small">${esc(type)}</div>
            <div class="small fw-semibold">${esc(t(`faults.types.${type}`))}</div>
            <div class="small text-secondary" style="line-height:1.5">
              ${esc(t(`faults.typeHints.${type}`))}
            </div>
          </div>`).join('')}
      </div>`,
    )
  }

  bind() {
    this.container.querySelector('#faultEnabled').addEventListener('change', async (evt) => {
      try {
        await api.control.patchFault(evt.target.checked)
        await loadControl()
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })

    this.container.querySelector('#faultAddRule').addEventListener('click', () => {
      this.editing = {
        id: null,
        name: '',
        enabled: true,
        probability: 1,
        maxHits: 0,
        match: { method: '', pathPrefix: '', pathGlob: '', platform: '' },
        action: { type: 'abort', status: 500, delayMs: 0, ratio: 0.5, body: '' },
      }
      this.render()
    })

    this.container.querySelector('#faultRestartClock').addEventListener('click', async () => {
      try {
        await api.control.restartClock()
        await loadControl()
        if (!this.isActive()) return
        toastSuccess(t('faults.clockRestarted'))
        this.render()
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })

    this.container.querySelector('#faultResetCounters').addEventListener('click', async () => {
      try {
        await api.control.resetCounters()
        await loadControl()
        if (!this.isActive()) return
        toastSuccess(t('faults.countersReset'))
        this.render()
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })

    // 开关：立即落盘
    this.container.querySelectorAll('[data-rule-toggle]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.dataset.ruleToggle
        const rule = (state.fault.rules || []).find((r) => r.id === id)
        if (!rule) return
        try {
          await api.control.rules.update(id, { ...rule, enabled: input.checked })
          await loadControl()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
          if (this.isActive()) this.render()
        }
      })
    })

    this.container.querySelectorAll('[data-rule-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rule = (state.fault.rules || []).find((r) => r.id === btn.dataset.ruleEdit)
        if (!rule) return
        this.editing = JSON.parse(JSON.stringify(rule))
        this.render()
      })
    })

    this.container.querySelectorAll('[data-rule-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(t('common.confirmDelete'))) return
        try {
          await api.control.rules.remove(btn.dataset.ruleDelete)
          await loadControl()
          if (!this.isActive()) return
          toastSuccess(t('faults.deleted'))
          this.render()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
        }
      })
    })

    // 注意：这里**不能**调 bindEditor()。
    // bind() 执行时 #faultEditor 还是空的（编辑器 HTML 由 openEditor 写入），
    // bindEditor() 里的 host.querySelector('#feCancel') 会拿到 null 而抛
    // TypeError —— 结果是点「新增规则」直接报错、编辑器永远打不开。
    // 编辑器的事件绑定放在 openEditor() 写完 innerHTML 之后。
  }

  // ------------------------------------------------------------- 规则编辑器

  openEditor(rule) {
    const host = this.container.querySelector('#faultEditor')
    if (!host) return

    const match = rule.match || {}
    const action = rule.action || {}

    host.innerHTML = `
      <div class="hus-card mb-3">
        <div class="hus-card-title">
          ${esc(rule.id ? t('faults.editRule') : t('faults.addRule'))}
        </div>

        <div class="row g-3">
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1">${esc(t('faults.ruleName'))}</label>
            <input type="text" class="form-control form-control-sm" id="feName"
              value="${esc(rule.name)}" placeholder="${esc(t('faults.ruleNamePlaceholder'))}">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.probability'))}</label>
            <input type="number" class="form-control form-control-sm" id="feProbability"
              value="${esc(rule.probability)}" min="0" max="1" step="0.05">
            <div class="form-text">${esc(t('faults.probabilityHint'))}</div>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.maxHits'))}</label>
            <input type="number" class="form-control form-control-sm" id="feMaxHits"
              value="${esc(rule.maxHits)}" min="0" step="1">
            <div class="form-text">${esc(t('faults.maxHitsHint'))}</div>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.afterMs'))}</label>
            <input type="number" class="form-control form-control-sm" id="feAfterMs"
              value="${esc(rule.afterMs || 0)}" min="0" step="100">
            <div class="form-text">${esc(t('faults.afterMsHint'))}</div>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.forMs'))}</label>
            <input type="number" class="form-control form-control-sm" id="feForMs"
              value="${esc(rule.forMs || 0)}" min="0" step="100">
            <div class="form-text">${esc(t('faults.forMsHint'))}</div>
          </div>
        </div>

        <hr class="my-3">
        <div class="hus-card-title">${esc(t('faults.matchTitle'))}</div>

        <div class="row g-3">
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.matchMethod'))}</label>
            <select class="form-select form-select-sm" id="feMethod">
              ${METHODS.map((m) => `
                <option value="${esc(m)}" ${match.method === m ? 'selected' : ''}>
                  ${esc(m || t('faults.matchAny'))}
                </option>`).join('')}
            </select>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.matchPathPrefix'))}</label>
            <input type="text" class="form-control form-control-sm mono" id="fePathPrefix"
              value="${esc(match.pathPrefix)}" placeholder="/assets">
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.matchPathGlob'))}</label>
            <input type="text" class="form-control form-control-sm mono" id="fePathGlob"
              value="${esc(match.pathGlob)}" placeholder="/assets/**/*.ab">
            <div class="form-text">${esc(t('faults.matchPathGlobHint'))}</div>
          </div>
          <div class="col-6 col-md-3">
            <label class="form-label small mb-1">${esc(t('faults.matchPlatform'))}</label>
            <input type="text" class="form-control form-control-sm mono" id="fePlatform"
              value="${esc(match.platform)}" placeholder="Android">
            <div class="form-text">${esc(t('faults.matchPlatformHint'))}</div>
          </div>
        </div>

        <hr class="my-3">
        <div class="hus-card-title">${esc(t('faults.actionTitle'))}</div>

        <div class="row g-3">
          <div class="col-12 col-md-4">
            <label class="form-label small mb-1">${esc(t('faults.actionType'))}</label>
            <select class="form-select form-select-sm" id="feType">
              ${FAULT_TYPES.map((type) => `
                <option value="${esc(type)}" ${action.type === type ? 'selected' : ''}>
                  ${esc(t(`faults.types.${type}`))}
                </option>`).join('')}
            </select>
            <div class="form-text" id="feTypeHint">${esc(t(`faults.typeHints.${action.type || 'status'}`))}</div>
          </div>

          <div class="col-6 col-md-2" data-when="status">
            <label class="form-label small mb-1">${esc(t('faults.statusCode'))}</label>
            <input type="number" class="form-control form-control-sm" id="feStatus"
              value="${esc(action.status)}" min="100" max="599" step="1">
          </div>

          <div class="col-6 col-md-2" data-when="delay">
            <label class="form-label small mb-1">${esc(t('faults.delayMs'))}</label>
            <input type="number" class="form-control form-control-sm" id="feDelayMs"
              value="${esc(action.delayMs)}" min="0" step="100">
          </div>

          <div class="col-6 col-md-2" data-when="ratio">
            <label class="form-label small mb-1">${esc(t('faults.ratio'))}</label>
            <input type="number" class="form-control form-control-sm" id="feRatio"
              value="${esc(action.ratio)}" min="0.01" max="1" step="0.05">
            <div class="form-text">${esc(t('faults.ratioHint'))}</div>
          </div>

          <div class="col-12 col-md-6" data-when="body">
            <label class="form-label small mb-1">${esc(t('faults.body'))}</label>
            <input type="text" class="form-control form-control-sm" id="feBody"
              value="${esc(action.body)}" placeholder="${esc(t('faults.bodyPlaceholder'))}">
          </div>
        </div>

        <div class="d-flex gap-2 mt-3">
          <button class="btn btn-sm btn-primary" id="feSave">
            <i class="bi bi-check2"></i> ${esc(t('common.save'))}
          </button>
          <button class="btn btn-sm btn-outline-secondary" id="feCancel">
            ${esc(t('common.cancel'))}
          </button>
          ${rule.id ? `
            <button class="btn btn-sm btn-outline-danger ms-auto" id="feDelete">
              <i class="bi bi-trash"></i> ${esc(t('common.delete'))}
            </button>` : ''}
        </div>
      </div>`

    this.applyVisibility()
    // innerHTML 写完之后才绑定事件。放在这里而不是 bind() 里，
    // 是因为 bind() 运行时这些元素还不存在。
    this.bindEditor()
  }

  /** 按当前故障类型显示/隐藏相关字段——不相关的字段留着只会让人填错。 */
  applyVisibility() {
    const typeSelect = this.container.querySelector('#feType')
    if (!typeSelect) return
    const type = typeSelect.value

    const show = {
      status: ['status', 'delay', 'body'],
      timeout: [],
      slowHeader: ['delay'],
      abort: ['ratio'],
      truncate: ['ratio'],
      corrupt: ['ratio'],
      // 复合类型：延迟和比例都要显示
      slowThenAbort: ['delay', 'ratio'],
      empty: [],
    }[type] || []

    this.container.querySelectorAll('[data-when]').forEach((node) => {
      const visible = node.dataset.when.split(',').some((g) => show.includes(g))
      node.classList.toggle('d-none', !visible)
      // 隐藏的同时必须 disabled：只加 d-none 的话，输入框里的值依然会被
      // 提交上去。实测后果是——把一条 slowHeader(delayMs=3000) 改成 abort 时，
      // 看不见的延迟值仍然落盘，规则悄悄变成"先等 3 秒再掐断"，
      // 而且在编辑器里再也改不掉（除非切回慢响应头）。
      node.querySelectorAll('input, select, textarea').forEach((field) => {
        field.disabled = !visible
      })
    })

    const hint = this.container.querySelector('#feTypeHint')
    if (hint) hint.textContent = t(`faults.typeHints.${type}`)
  }

  bindEditor() {
    const host = this.container.querySelector('#faultEditor')
    if (!host || !this.editing) return

    const typeSelect = host.querySelector('#feType')
    if (typeSelect) typeSelect.addEventListener('change', () => this.applyVisibility())

    // 全部加判空：编辑器可能因为任何原因没有完整渲染出来，
    // 这里抛异常会让整个页面卡在半途（原来就是这样，点「新增规则」直接报错）。
    const cancelBtn = host.querySelector('#feCancel')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.editing = null
        this.render()
      })
    }

    const saveBtn = host.querySelector('#feSave')
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true
        try {
          await this.submitEditor()
        } finally {
          // 保存成功后整页会重新渲染，saveBtn 已经脱离文档；
          // 给一个已卸载的节点设 disabled 没有意义。
          if (saveBtn.isConnected) saveBtn.disabled = false
        }
      })
    }

    const deleteBtn = host.querySelector('#feDelete')
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!window.confirm(t('common.confirmDelete'))) return
        try {
          await api.control.rules.remove(this.editing.id)
          this.editing = null
          await loadControl()
          if (!this.isActive()) return
          toastSuccess(t('faults.deleted'))
          this.render()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
        }
      })
    }
  }

  async submitEditor() {
    const host = this.container.querySelector('#faultEditor')
    const value = (id) => {
      const node = host.querySelector(id)
      return node ? node.value : ''
    }
    const num = (id, fallback = 0) => {
      const n = Number(value(id))
      return Number.isFinite(n) ? n : fallback
    }

    const payload = {
      name: value('#feName').trim() || t('faults.addRule'),
      enabled: this.editing.enabled !== false,
      probability: num('#feProbability', 1),
      maxHits: num('#feMaxHits', 0),
      afterMs: num('#feAfterMs', 0),
      forMs: num('#feForMs', 0),
      match: {
        method: value('#feMethod'),
        pathPrefix: value('#fePathPrefix').trim(),
        pathGlob: value('#fePathGlob').trim(),
        platform: value('#fePlatform').trim(),
      },
      action: {
        type: value('#feType'),
        status: num('#feStatus', 500),
        delayMs: num('#feDelayMs', 0),
        ratio: num('#feRatio', 0.5),
        body: value('#feBody'),
      },
    }

    try {
      if (this.editing.id) {
        // 注意：update 接口会用默认值归一化，所以编辑时要保留 id
        await api.control.rules.update(this.editing.id, { ...payload, id: this.editing.id })
        toastSuccess(t('faults.updated'))
      } else {
        await api.control.rules.create(payload)
        toastSuccess(t('faults.created'))
      }
      this.editing = null
      await loadControl()
      if (this.isActive()) this.render()
    } catch (err) {
      reportError(err, t('toast.actionFailed'))
    }
  }

  destroy() {
    this.editing = null
    super.destroy()
  }
}
