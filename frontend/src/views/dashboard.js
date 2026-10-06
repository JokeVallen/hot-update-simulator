// frontend/src/views/dashboard.js
//
// 总览：把 /api/stats 的汇总数据画出来。
//
// 重点不是"好看"，而是让你一眼看清两件事：
//   1. 请求的整体健康度（延迟、错误率）
//   2. 有多少请求是被模拟器动过手脚的 —— 否则看到 P95 十秒，
//      你会以为是后端有性能问题，其实是自己把延迟调到 5 秒了

import Chart from 'chart.js/auto'
import { t } from '../locales/index.js'
import { loadStats, state } from '../store.js'
import { esc, fmtBytes, fmtDuration } from '../ui/dom.js'
import { onThemeChange } from '../ui/theme.js'
import { View, pageHeader, statCard, card, emptyState } from './common.js'

const WINDOWS = [1, 5, 15, 60]

/**
 * 从 CSS 变量里读当前主题的颜色。
 *
 * 为什么绕这一下：Chart.js 会把颜色"烤"进实例里，如果用 JS 常量定义配色，
 * 就得到处写 `theme === 'dark' ? A : B`，改主题时两边必然不同步。
 * 颜色统一在 style.css 的主题块里定义，这里只负责读。
 */
function cssVar(name, fallback = '#888888') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export class DashboardView extends View {
  constructor() {
    super('dashboard')
    this.windowMinutes = 5
    this.timelineChart = null
    this.statusChart = null
  }

  async render() {
    this.container.innerHTML = `
      ${pageHeader('dashboard.title', 'dashboard.intro')}
      <div class="d-flex align-items-center gap-2 mb-3">
        <label class="form-label mb-0 small text-secondary">${esc(t('dashboard.window'))}</label>
        <div class="btn-group btn-group-sm" id="dashWindow">
          ${WINDOWS.map((m) => `
            <button type="button" class="btn btn-outline-secondary ${m === this.windowMinutes ? 'active' : ''}"
              data-window="${m}">${m} ${esc(t('common.minutes'))}</button>
          `).join('')}
        </div>
        <button class="btn btn-sm btn-outline-secondary ms-auto" id="dashRefresh">
          <i class="bi bi-arrow-clockwise"></i> ${esc(t('common.refresh'))}
        </button>
      </div>

      <div id="dashBody"></div>`

    this.container.querySelector('#dashWindow').addEventListener('click', async (evt) => {
      const btn = evt.target.closest('[data-window]')
      if (!btn) return
      this.windowMinutes = Number(btn.dataset.window)
      this.container.querySelectorAll('#dashWindow .btn').forEach((b) => {
        b.classList.toggle('active', b === btn)
      })
      await this.refresh()
    })

    this.container.querySelector('#dashRefresh').addEventListener('click', () => this.refresh())

    await this.refresh()
  }

  /**
   * 定时刷新放在 setup() 而不是 render()。
   *
   * render() 会被 refresh() 反复调用，在里面注册 interval 和订阅的话，
   * 每次刷新都会多一份 —— 原来每 3 秒就会重建 4 个 Chart 实例。
   *
   * 这里也刻意**不**订阅 store 的 change 事件：refresh() 自己会画，
   * 再订阅一次就会每次刷两遍（一次来自 setState 的同步广播，一次来自
   * refresh 末尾的显式 paint）。
   */
  async setup() {
    this.every(3000, () => this.refresh())

    // 主题一变必须重画图表：颜色是构造时读出来烤进实例的。
    // 订阅放在 setup() 而不是 render()，否则每次 refresh 都会多攒一个监听器。
    this.offTheme = onThemeChange(() => {
      if (this.isActive()) this.paint()
    })
  }

  async refresh() {
    try {
      await loadStats(this.windowMinutes)
      if (this.isActive()) this.paint()
    } catch (err) {
      if (this.isActive()) {
        const body = this.container.querySelector('#dashBody')
        if (body) {
          body.innerHTML = card(
            '',
            `<div class="text-danger small">${esc(err.message)}</div>`,
          )
        }
      }
      // 不弹 toast：后端被模拟成断网时这个页面会每 3 秒失败一次，
      // 弹提示会刷屏。顶栏的状态指示已经能说明问题了。
    }
  }

  paint() {
    const body = this.container.querySelector('#dashBody')
    if (!body) return

    const stats = state.stats
    if (!stats || !stats.requests) {
      body.innerHTML = card('', emptyState(t('dashboard.noData')))
      return
    }

    const total = stats.requests.total || 0
    const errors = (stats.requests.byStatusClass['4xx'] || 0)
      + (stats.requests.byStatusClass['5xx'] || 0)
      + (stats.requests.byStatusClass.disconnected || 0)
    const errorRate = total ? ((errors / total) * 100).toFixed(1) : '0.0'
    const sim = stats.simulated || {}

    body.innerHTML = `
      <div class="row g-3 mb-3">
        <div class="col-6 col-lg-3">
          ${statCard(
    t('dashboard.totalRequests'),
    String(total),
    t('dashboard.lastMinutes', { n: this.windowMinutes }),
  )}
        </div>
        <div class="col-6 col-lg-3">
          ${statCard(
    t('dashboard.avgLatency'),
    fmtDuration(stats.latency.avgMs),
    `P50 ${fmtDuration(stats.latency.p50Ms)}`,
  )}
        </div>
        <div class="col-6 col-lg-3">
          ${statCard(
    t('dashboard.p95Latency'),
    fmtDuration(stats.latency.p95Ms),
    `${t('dashboard.max')} ${fmtDuration(stats.latency.maxMs)}`,
  )}
        </div>
        <div class="col-6 col-lg-3">
          ${statCard(
    t('dashboard.errorRate'),
    `${errorRate}%`,
    `${errors} / ${total}`,
  )}
        </div>
      </div>

      <div class="row g-3 mb-3">
        <div class="col-12 col-lg-8">
          ${card(t('dashboard.timeline'), '<div style="height:180px"><canvas id="dashTimeline"></canvas></div>')}
        </div>
        <div class="col-12 col-lg-4">
          ${card(t('dashboard.statusDist'), '<div style="height:180px"><canvas id="dashStatus"></canvas></div>')}
        </div>
      </div>

      <div class="row g-3">
        <div class="col-12 col-lg-5">
          ${card(t('dashboard.simulated'), this.interventionCard(sim, stats.throughput))}
        </div>
        <div class="col-12 col-lg-7">
          ${card(t('dashboard.topPaths'), this.topPathsTable(stats.topPaths))}
        </div>
      </div>`

    this.drawTimeline(stats.timeline)
    this.drawStatus(stats.requests.byStatusClass)
  }

  /**
   * 模拟干预：先说"配置了什么"，再说"实际发生了什么"。
   *
   * 为什么必须把配置放前面：
   *   这一栏原来只有计数器，而计数器统计的是**已经发生过的干预**。
   *   于是"配了规则但窗口内没有请求命中"和"什么都没配"看起来一模一样 ——
   *   全是 0。更糟的是顶栏同时显示"模拟进行中"（那个按配置算），
   *   两处互相矛盾，而且没有任何解释。
   *
   *   故障规则的 describeRules() 本来就返回 hits 和 effective，
   *   但界面一直没用 —— 这里把它用起来。
   */
  interventionCard(sim, throughput) {
    const net = state.network || {}
    const fault = state.fault || {}
    const rules = Array.isArray(fault.rules) ? fault.rules : []

    const netOn = Boolean(net.enabled)
    const faultOn = Boolean(fault.enabled)
    const effectiveRules = rules.filter((r) => r.effective)

    // 网络是否真的设了参数。"开着但全是 0"和"没开"在效果上是一样的，
    // 但原因不同，提示也得不同。
    const netHasParams = netOn && Boolean(
      net.offline || net.latencyMs || net.jitterMs || net.bandwidthKbps || net.packetLossRate,
    );

    // 配置状态用一个显式状态机，而不是几个互相独立的布尔量。
    // 之前就是栽在这里：fault.enabled 为真但没规则时，
    // "没有启用任何模拟"和"已配置但没命中"会同时显示，自相矛盾。
    //
    //   off     什么配置都没有
    //   idle    配了，但当前配置不可能产生任何效果
    //   armed   配了且有可能生效，但窗口内还没命中过
    //   active  窗口内已经命中过
    const anythingConfigured = netOn || faultOn || rules.length > 0;
    const canTrigger = netHasParams || effectiveRules.length > 0;
    const totalHits = ['delayed', 'throttled', 'faulted', 'dropped', 'ranged']
      .reduce((n, k) => n + (Number(sim[k]) || 0), 0);

    let state_ = 'off';
    if (anythingConfigured) {
      if (totalHits > 0) state_ = 'active';
      else state_ = canTrigger ? 'armed' : 'idle';
    }

    // ---- 配置摘要 ----
    const confLines = []

    if (netOn) {
      const parts = []
      if (net.offline) parts.push(t('dashboard.cfgOffline'))
      else {
        if (net.latencyMs) {
          parts.push(`${t('dashboard.cfgLatency')} ${net.latencyMs}ms`
            + (net.jitterMs ? ` ±${net.jitterMs}ms` : ''))
        }
        if (net.bandwidthKbps) parts.push(`${(net.bandwidthKbps / 1000).toFixed(1)} Mbps`)
        if (net.packetLossRate) {
          parts.push(`${t('dashboard.cfgLoss')} ${(net.packetLossRate * 100).toFixed(0)}%`)
        }
      }
      confLines.push({
        label: t('nav.network'),
        value: parts.length ? parts.join(' · ') : t('dashboard.cfgOnNoParams'),
        warn: !parts.length,
      })
    }

    if (rules.length) {
      // 总闸没开时说清楚"规则都在，但都不会生效"——这是
      // "我建了规则却什么都没发生"最常见的原因
      confLines.push({
        label: t('nav.faults'),
        value: faultOn
          ? t('dashboard.cfgRulesEffective', { total: rules.length, effective: effectiveRules.length })
          : t('dashboard.cfgRulesMasterOff', { total: rules.length }),
        warn: !faultOn || effectiveRules.length === 0,
      })
    } else if (faultOn) {
      // 总闸开着却一条规则都没有：这正是最容易被误读成"没配置"的情形
      confLines.push({
        label: t('nav.faults'),
        value: t('dashboard.cfgFaultOnNoRules'),
        warn: true,
      })
    }

    // 逐条列出规则（最多 4 条）：名称 + 类型 + 命中次数
    const ruleItems = rules.slice(0, 4).map((r) => {
      const type = (r.action && r.action.type) || '?'
      const hits = Number(r.hits) || 0
      const dim = r.effective ? '' : ' opacity-50'
      return `
        <div class="d-flex align-items-center justify-content-between small${dim}">
          <span class="text-truncate me-2" title="${esc(r.name || '')}">
            ${esc(r.name || '(未命名)')}
            <span class="text-secondary mono ms-1">${esc(type)}</span>
          </span>
          <span class="mono ${hits ? 'text-warning' : 'text-secondary'}">${hits}</span>
        </div>`
    }).join('')
    const moreRules = rules.length > 4
      ? `<div class="small text-secondary">${esc(t('dashboard.cfgMoreRules', { n: rules.length - 4 }))}</div>`
      : ''

    const confBlock = confLines.length
      ? `<div class="mb-2">
          ${confLines.map((l) => `
            <div class="d-flex align-items-start justify-content-between small">
              <span class="text-secondary me-2">${esc(l.label)}</span>
              <span class="text-end${l.warn ? ' text-warning' : ''}">${esc(l.value)}</span>
            </div>`).join('')}
          ${ruleItems ? `<div class="mt-1 ps-2 border-start">${ruleItems}${moreRules}</div>` : ''}
        </div>
        <hr class="my-2">`
      : `<div class="small text-secondary mb-2">${esc(t('dashboard.cfgNone'))}</div>
        <hr class="my-2">`

    // ---- 效果计数 ----
    const rows = [
      ['dashboard.delayed', sim.delayed, 'bi-hourglass-split'],
      ['dashboard.throttled', sim.throttled, 'bi-speedometer'],
      ['dashboard.faulted', sim.faulted, 'bi-lightning-charge'],
      ['dashboard.dropped', sim.dropped, 'bi-plug'],
      ['dashboard.ranged', sim.ranged, 'bi-arrow-repeat'],
    ]

    // 按状态给提示。三种"看起来都没生效"的原因完全不同，混成一句就等于没说。
    const hintText = {
      idle: t('dashboard.cfgIdle'),
      armed: t('dashboard.cfgArmed'),
    }[state_]
    const hint = hintText
      ? `<div class="alert alert-${state_ === 'idle' ? 'warning' : 'secondary'} py-1 px-2 small mt-2 mb-0">
          ${esc(hintText)}
        </div>`
      : ''

    return `
      <div>
        ${confBlock}
        <div class="d-flex flex-column gap-2">
          ${rows.map(([key, value, icon]) => `
            <div class="d-flex align-items-center justify-content-between">
              <span class="small">
                <i class="bi ${icon} me-2 text-secondary"></i>${esc(t(key))}
              </span>
              <span class="mono ${value ? 'text-warning' : 'text-secondary'}">${value || 0}</span>
            </div>`).join('')}
          <hr class="my-1">
          <div class="d-flex align-items-center justify-content-between">
            <span class="small text-secondary">${esc(t('dashboard.throughput'))}</span>
            <span class="mono">${esc(fmtBytes(throughput ? throughput.totalBytes : 0))}</span>
          </div>
        </div>
        ${hint}
      </div>`
  }

  topPathsTable(topPaths) {
    if (!topPaths || !topPaths.length) return emptyState(t('dashboard.noData'))

    return `
      <div class="table-responsive">
        <table class="table table-sm table-borderless align-middle mb-0">
          <thead>
            <tr class="stat-label">
              <th>${esc(t('logs.url'))}</th>
              <th class="text-end">${esc(t('dashboard.count'))}</th>
              <th class="text-end">${esc(t('dashboard.errors'))}</th>
              <th class="text-end">${esc(t('dashboard.avg'))}</th>
            </tr>
          </thead>
          <tbody>
            ${topPaths.map((p) => `
              <tr>
                <td class="mono url-cell" title="${esc(p.path)}">${esc(p.path)}</td>
                <td class="text-end mono">${p.count}</td>
                <td class="text-end mono ${p.errors ? 'text-danger' : 'text-secondary'}">${p.errors}</td>
                <td class="text-end mono">${esc(fmtDuration(p.avgMs))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
  }

  drawTimeline(timeline) {
    const canvas = this.container.querySelector('#dashTimeline')
    if (!canvas) return

    // 图表实例必须销毁，否则重复渲染会叠加、并持续持有 canvas 引用
    if (this.timelineChart) this.timelineChart.destroy()

    // 时间轴的标签：短窗口精确到秒，长窗口只到分钟。
    // 注意别用 mm:ss —— "24:40" 会被读成二十四点四十分，很误导。
    const label = this.windowMinutes <= 5
      ? (d) => d.toTimeString().slice(0, 8)
      : (d) => d.toTimeString().slice(0, 5)

    const labels = timeline.map((slot) => label(new Date(slot.at)))

    this.timelineChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: t('dashboard.requests'),
            data: timeline.map((s) => s.count),
            borderColor: cssVar('--hus-chart-requests'),
            backgroundColor: cssVar('--hus-chart-requests-fill'),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: t('dashboard.errors'),
            data: timeline.map((s) => s.errors),
            borderColor: cssVar('--hus-chart-errors'),
            backgroundColor: cssVar('--hus-chart-errors-fill'),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { boxWidth: 10, font: { size: 11 }, color: cssVar('--hus-chart-tick') },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 8, font: { size: 10 }, color: cssVar('--hus-chart-tick') },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0, font: { size: 10 }, color: cssVar('--hus-chart-tick') },
            grid: { color: cssVar('--hus-chart-grid') },
          },
        },
      },
    })
  }

  drawStatus(byStatusClass) {
    const canvas = this.container.querySelector('#dashStatus')
    if (!canvas) return

    if (this.statusChart) this.statusChart.destroy()

    const entries = Object.entries(byStatusClass).filter(([, v]) => v > 0)
    const COLORS = {
      '2xx': cssVar('--hus-status-2xx'),
      '3xx': cssVar('--hus-status-3xx'),
      '4xx': cssVar('--hus-status-4xx'),
      '5xx': cssVar('--hus-status-5xx'),
      disconnected: cssVar('--hus-status-none'),
    }

    if (!entries.length) {
      this.container.querySelector('#dashStatus').parentElement.innerHTML
        = emptyState(t('dashboard.noData'))
      return
    }

    this.statusChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: entries.map(([key]) => (key === 'disconnected' ? t('logs.result') : key)),
        datasets: [{
          data: entries.map(([, v]) => v),
          backgroundColor: entries.map(([key]) => COLORS[key] || cssVar('--hus-status-none')),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, font: { size: 11 }, color: cssVar('--hus-chart-tick') },
          },
        },
      },
    })
  }

  destroy() {
    if (this.offTheme) this.offTheme()
    this.offTheme = null
    if (this.timelineChart) this.timelineChart.destroy()
    if (this.statusChart) this.statusChart.destroy()
    this.timelineChart = null
    this.statusChart = null
    super.destroy()
  }
}
