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
import { View, pageHeader, statCard, card, emptyState } from './common.js'

const WINDOWS = [1, 5, 15, 60]

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
              data-window="${m}">${m} ${esc(t('common.seconds')) === 's' ? 'min' : '分钟'}</button>
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
          ${card(t('dashboard.simulated'), this.simulatedRows(sim, stats.throughput))}
        </div>
        <div class="col-12 col-lg-7">
          ${card(t('dashboard.topPaths'), this.topPathsTable(stats.topPaths))}
        </div>
      </div>`

    this.drawTimeline(stats.timeline)
    this.drawStatus(stats.requests.byStatusClass)
  }

  /** 模拟干预的明细。这一块是"为什么这么慢"的答案。 */
  simulatedRows(sim, throughput) {
    const rows = [
      ['dashboard.delayed', sim.delayed, 'bi-hourglass-split'],
      ['dashboard.throttled', sim.throttled, 'bi-speedometer'],
      ['dashboard.faulted', sim.faulted, 'bi-lightning-charge'],
      ['dashboard.dropped', sim.dropped, 'bi-plug'],
      ['dashboard.ranged', sim.ranged, 'bi-arrow-repeat'],
    ]

    return `
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
            borderColor: '#4c8dff',
            backgroundColor: 'rgba(76, 141, 255, 0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: t('dashboard.errors'),
            data: timeline.map((s) => s.errors),
            borderColor: '#ff5c5c',
            backgroundColor: 'rgba(255, 92, 92, 0.15)',
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
        plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
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
      '2xx': '#38d39f',
      '3xx': '#4cc9f0',
      '4xx': '#ffc14d',
      '5xx': '#ff5c5c',
      disconnected: '#8b93a1',
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
          backgroundColor: entries.map(([key]) => COLORS[key] || '#8b93a1'),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } },
      },
    })
  }

  destroy() {
    if (this.timelineChart) this.timelineChart.destroy()
    if (this.statusChart) this.statusChart.destroy()
    this.timelineChart = null
    this.statusChart = null
    super.destroy()
  }
}
