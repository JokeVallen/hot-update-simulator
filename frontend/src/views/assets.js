// frontend/src/views/assets.js
//
// 资产目录：把热更包在磁盘上的布局摊开给人看。
//
// 为什么需要这一页：
//   平台列表和清单接口都有，但它们是**逻辑视图**——只告诉你"有什么"，
//   不告诉你"放在哪、属于哪条轨道、是不是和预期一致"。实际排查时最常问的是
//   "我把文件放对地方了吗"、"这个平台到底有哪几个渠道"、"代码包进去了没有"。
//
// **不新增任何后端接口。** 数据全部来自已有的三个：
//   GET /api/platforms                                  平台 + 渠道 + 两条轨道版本 + 数量
//   GET /api/manifest?platform=X&channel=Y              资源轨道完整文件列表
//   GET /api/manifest?platform=X&channel=Y&track=code   代码轨道完整文件列表
//   组合起来足够拼出完整视图，所以没必要再开一个接口、多一份攻击面。
//
// 按需加载：只有展开某个平台时才去取它的清单，不会一上来就发 N×M 个请求。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { reportError } from '../ui/toast.js'
import { esc, fmtBytes } from '../ui/dom.js'
import { View, pageHeader, emptyState } from './common.js'

export class AssetsView extends View {
  constructor() {
    super('assets')
    /** 展开的平台名 → { loading, error, channels: [{ name, resource, code }] } */
    this.expanded = new Map()
    this.summary = null
  }

  async render() {
    this.container.innerHTML = `
      ${pageHeader('assets.title', 'assets.intro')}
      <div id="assetsBody">
        <div class="text-secondary small">${esc(t('common.loading'))}</div>
      </div>`

    await this.refresh()
  }

  async refresh() {
    const body = this.container && this.container.querySelector('#assetsBody')
    if (!body) return

    try {
      this.summary = await api.platforms()
      if (!this.isActive()) return
      this.paint()
    } catch (err) {
      if (!this.isActive()) return
      body.innerHTML = `<div class="alert alert-danger small">${esc(err.message)}</div>`
    }
  }

  /** 展开/收起一个平台；展开时按需拉它的清单。 */
  async toggle(platform) {
    if (this.expanded.has(platform)) {
      this.expanded.delete(platform)
      this.paint()
      return
    }

    this.expanded.set(platform, { loading: true, error: null, channels: [] })
    this.paint()

    const entry = this.expanded.get(platform)
    try {
      const info = (this.summary.platforms || []).find((p) => p.name === platform)
      const channels = (info && info.channels && info.channels.length)
        ? info.channels
        : [this.summary.defaultChannel || 'default']

      // 每个渠道两条轨道。渠道数通常是个位数，所以这里并发发出去没问题；
      // 而且服务端的清单有 10 秒缓存。
      const loaded = await Promise.all(channels.map(async (name) => {
        const [resource, code] = await Promise.all([
          api.manifest(platform, { channel: name }).catch((e) => ({ __error: e.message })),
          // 没有代码轨道的平台会返回 404，那是正常情况，当成"没有"而不是错误
          api.manifest(platform, { channel: name, track: 'code' }).catch(() => null),
        ])
        return { name, resource, code }
      }))

      if (!this.isActive()) return
      entry.loading = false
      entry.channels = loaded
    } catch (err) {
      if (!this.isActive()) return
      entry.loading = false
      entry.error = err.message
    }
    this.paint()
  }

  paint() {
    const body = this.container && this.container.querySelector('#assetsBody')
    if (!body || !this.summary) return

    const platforms = this.summary.platforms || []
    const root = this.summary.assetRoot || ''

    const rootBar = `
      <div class="hus-card mb-3">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <span class="stat-label mb-0">${esc(t('assets.root'))}</span>
          <span class="mono small text-break flex-grow-1">${esc(root || t('assets.rootUnknown'))}</span>
          <button class="btn btn-sm btn-outline-secondary" id="assetsCopyRoot" type="button">
            <i class="bi bi-clipboard"></i> ${esc(t('common.copy'))}
          </button>
        </div>
        <div class="small text-secondary mt-1">
          ${esc(t('assets.channelsConfigured', {
    channels: (this.summary.configuredChannels || []).join(' / ') || '-',
  }))}
        </div>
      </div>`

    if (!platforms.length) {
      body.innerHTML = rootBar + `
        <div class="hus-card">
          ${emptyState(t('assets.empty'))}
          <div class="small text-secondary text-center mt-2">${esc(t('assets.emptyHint'))}</div>
        </div>`
      this.bindRootCopy()
      return
    }

    body.innerHTML = rootBar + platforms.map((p) => this.platformCard(p)).join('')
    this.bindRootCopy()

    for (const btn of body.querySelectorAll('[data-expand]')) {
      btn.addEventListener('click', () => this.toggle(btn.dataset.expand))
    }
  }

  platformCard(p) {
    const open = this.expanded.has(p.name)
    const entry = this.expanded.get(p.name)
    const channelCount = (p.channels || []).length

    // 版本信息：两条轨道分开显示，这正是"代码热更"和"资源热更"是两个东西的体现
    const meta = [
      `${t('assets.resourceTrack')} ${p.version || '-'}`,
      `${t('assets.codeTrack')} ${p.codeVersion || t('assets.codeTrackNone')}`,
      t('assets.fileCounts', { files: p.fileCount || 0, code: p.codeFileCount || 0 }),
      fmtBytes(p.totalSize || 0),
    ].join(' · ')

    return `
      <div class="hus-card mb-2">
        <div class="d-flex align-items-start justify-content-between gap-2">
          <div class="min-w-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <i class="bi ${open ? 'bi-chevron-down' : 'bi-chevron-right'} text-secondary"></i>
              <span class="fw-semibold">${esc(p.name)}</span>
              ${(p.channels || []).map((c) => `
                <span class="badge text-bg-secondary">${esc(c)}</span>`).join('')}
              ${channelCount === 0
    ? `<span class="badge text-bg-warning">${esc(t('assets.noChannels'))}</span>` : ''}
            </div>
            <div class="rule-meta mt-1">${esc(meta)}</div>
          </div>
          <button class="btn btn-sm btn-outline-secondary flex-shrink-0"
            data-expand="${esc(p.name)}" type="button">
            ${esc(open ? t('common.collapse') : t('common.expand'))}
          </button>
        </div>
        ${open ? this.channelList(entry) : ''}
      </div>`
  }

  channelList(entry) {
    if (!entry) return ''
    if (entry.loading) {
      return `<div class="small text-secondary mt-2 ps-4">${esc(t('common.loading'))}</div>`
    }
    if (entry.error) {
      return `<div class="alert alert-danger small mt-2 mb-0">${esc(entry.error)}</div>`
    }

    return entry.channels.map((ch) => {
      // 资源清单请求失败时给的是 {__error}，单独标出来而不是显示成"0 个文件"
      if (ch.resource && ch.resource.__error) {
        return `
          <div class="alert alert-warning small mt-2 mb-0">
            <div class="fw-semibold">${esc(ch.name)}</div>
            ${esc(ch.resource.__error)}
          </div>`
      }
      return `
        <div class="mt-2 ps-4 border-start">
          <div class="d-flex align-items-center gap-2 mb-1">
            <span class="badge text-bg-secondary">${esc(ch.name)}</span>
            ${ch.resource && ch.resource.channelInUrl === false
    ? `<span class="small text-secondary">${esc(t('assets.flatLayout'))}</span>` : ''}
          </div>
          ${this.trackTable(t('assets.resourceTrack'), ch.resource)}
          ${this.trackTable(t('assets.codeTrack'), ch.code)}
        </div>`
    }).join('')
  }

  trackTable(label, manifest) {
    if (!manifest) {
      return `<div class="small text-secondary mb-1">
        ${esc(label)}：${esc(t('assets.trackAbsent'))}
      </div>`
    }
    const files = manifest.files || []
    if (!files.length) {
      return `<div class="small text-secondary mb-1">
        ${esc(label)}：${esc(t('assets.trackEmpty'))}
      </div>`
    }

    // 按目录分组，让"文件放在哪个子目录"一眼可见 —— 这正是这一页存在的理由
    const groups = new Map()
    for (const f of files) {
      const idx = f.path.lastIndexOf('/')
      const dir = idx >= 0 ? f.path.slice(0, idx) : '.'
      if (!groups.has(dir)) groups.set(dir, [])
      groups.get(dir).push(f)
    }

    const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, list]) => `
        <tr>
          <td class="mono" style="width:34%">${esc(dir)}/</td>
          <td class="mono text-secondary">${list.length} ${esc(t('assets.filesUnit'))}</td>
          <td class="mono text-end">${esc(fmtBytes(list.reduce((n, f) => n + (f.size || 0), 0)))}</td>
        </tr>`).join('')

    return `
      <div class="small mb-2">
        <div class="d-flex align-items-center justify-content-between">
          <span class="text-secondary">${esc(label)} · ${esc(manifest.version || '-')}</span>
          <span class="mono">${files.length} ${esc(t('assets.filesUnit'))} · ${esc(fmtBytes(manifest.totalSize || 0))}</span>
        </div>
        <table class="hus-log-table mt-1">
          <tbody>${rows}</tbody>
        </table>
      </div>`
  }

  bindRootCopy() {
    const btn = this.container && this.container.querySelector('#assetsCopyRoot')
    if (!btn) return
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.summary.assetRoot || '')
      } catch (err) {
        reportError(err, t('common.copyFailed'))
      }
    })
  }
}
