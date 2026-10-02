// frontend/src/views/explorer.js
//
// 接口调试：直接调给游戏客户端用的热更接口。
//
// 这些接口会经过模拟器，所以这个页面是"验证模拟效果"最直接的地方：
// 把延迟调到 3 秒，然后在这里点一下"查询版本"，就能亲眼看到耗时变了。

import { t } from '../locales/index.js'
import { api, DOWNLOAD_TIMEOUT_MS } from '../api.js'
import { state, loadPlatforms, setState } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc, fmtBytes, fmtDuration, statusBadge } from '../ui/dom.js'
import { View, pageHeader, card, emptyState, prettyJson } from './common.js'

export class ExplorerView extends View {
  constructor() {
    super('explorer')
    /** 最近一次调用的结果，用来渲染响应面板 */
    this.result = null
    this.busy = false
    /** 上次下载测试的结果，按文件路径索引 */
    this.downloads = new Map()
    /** 在途的下载：url -> AbortController，用于去重和中止 */
    this.downloadAborters = new Map()
    /** 当前平台的清单 */
    this.manifest = null
  }

  async render() {
    const platforms = state.platforms || []
    const platform = state.activePlatform || (platforms[0] && platforms[0].name) || ''

    this.container.innerHTML = `
      ${pageHeader('explorer.title', 'explorer.intro')}

      <div class="row g-3">
        <div class="col-12 col-xl-5">
          ${card(t('explorer.params'), this.formHtml(platforms, platform))}
        </div>
        <div class="col-12 col-xl-7">
          ${card(t('explorer.result'), this.resultHtml(), '', 'expResultCard')}
        </div>
      </div>

      <div class="mt-3">
        ${card(t('explorer.assets'), this.assetsHtml(), '', 'expAssetsCard')}
      </div>`

    this.bind()
    // 有平台但还没拉过清单时，主动拉一次，省得用户先点按钮
    if (platform && !this.manifest) {
      this.callManifest(platform)
    }
  }

  formHtml(platforms, platform) {
    if (!platforms.length) {
      return `
        <div class="alert alert-warning small mb-0">
          <i class="bi bi-exclamation-triangle"></i> ${esc(t('explorer.noPlatform'))}
        </div>`
    }

    return `
      <div class="row g-2">
        <div class="col-12">
          <label class="form-label small mb-1">${esc(t('explorer.platform'))}</label>
          <select class="form-select form-select-sm" id="expPlatform">
            ${platforms.map((p) => `
              <option value="${esc(p.name)}" ${p.name === platform ? 'selected' : ''}>
                ${esc(p.name)} — ${esc(p.version || '?')} (${p.fileCount} files)
              </option>`).join('')}
          </select>
        </div>

        <div class="col-6">
          <label class="form-label small mb-1">${esc(t('explorer.currentVersion'))}</label>
          <input type="text" class="form-control form-control-sm mono" id="expCurrent"
            placeholder="1.0.0">
        </div>

        <div class="col-6">
          <label class="form-label small mb-1">${esc(t('explorer.channel'))}</label>
          <input type="text" class="form-control form-control-sm mono" id="expChannel"
            placeholder="default">
        </div>

        <div class="col-12">
          <label class="form-label small mb-1">${esc(t('explorer.deviceId'))}</label>
          <input type="text" class="form-control form-control-sm mono" id="expDeviceId"
            placeholder="device-abc-123">
          <div class="form-text">${esc(t('explorer.deviceIdHint'))}</div>
        </div>
      </div>

      <hr>

      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-primary" data-call="version">
          <i class="bi bi-tag"></i> ${esc(t('explorer.callVersion'))}
        </button>
        <button class="btn btn-sm btn-outline-primary" data-call="manifest">
          <i class="bi bi-list-ul"></i> ${esc(t('explorer.callManifest'))}
        </button>
        <button class="btn btn-sm btn-outline-primary" data-call="check">
          <i class="bi bi-box-seam"></i> ${esc(t('explorer.callCheck'))}
        </button>
        <button class="btn btn-sm btn-outline-secondary ms-auto" data-call="refresh">
          <i class="bi bi-arrow-clockwise"></i> ${esc(t('explorer.refreshManifest'))}
        </button>
      </div>`
  }

  resultHtml() {
    if (this.busy) {
      return `<div class="text-center text-secondary py-4">
        <span class="spinner-border spinner-border-sm"></span>
        <div class="small mt-2">${esc(t('explorer.requesting'))}</div>
      </div>`
    }

    if (!this.result) {
      return emptyState(t('explorer.result'))
    }

    const { label, status, durationMs, data, error } = this.result

    return `
      <div class="d-flex align-items-center gap-2 mb-2">
        <span class="mono small">${esc(label)}</span>
        ${error
    ? `<span class="badge text-bg-danger">${esc(t('common.no'))}</span>`
    : statusBadge(status)}
        <span class="small text-secondary">${esc(fmtDuration(durationMs))}</span>
      </div>
      ${error
    ? `<div class="alert alert-danger small mb-0">${esc(error)}</div>`
    : `<pre class="result-pre">${esc(prettyJson(data))}</pre>`}`
  }

  assetsHtml() {
    const manifest = this.manifest
    if (!manifest) return emptyState(t('explorer.selectFile'))

    return `
      <div class="d-flex flex-wrap align-items-center gap-3 mb-2 small">
        <span>${esc(t('explorer.version'))}：<span class="mono text-primary">${esc(manifest.version)}</span></span>
        <span>${esc(t('explorer.files'))}：<span class="mono">${manifest.fileCount}</span></span>
        <span>${esc(t('explorer.totalSize'))}：<span class="mono">${esc(fmtBytes(manifest.totalSize))}</span></span>
      </div>
      <div class="table-responsive" style="max-height:24rem;overflow:auto">
        <table class="table table-sm table-borderless align-middle mb-0">
          <thead>
            <tr class="stat-label">
              <th>${esc(t('explorer.file'))}</th>
              <th class="text-end" style="width:6rem">${esc(t('logs.size'))}</th>
              <th style="width:9rem">${esc(t('explorer.hash'))}</th>
              <th class="text-end" style="width:6rem">${esc(t('common.actions'))}</th>
            </tr>
          </thead>
          <tbody>
            ${manifest.files.map((file) => this.fileRow(file)).join('')}
          </tbody>
        </table>
      </div>`
  }

  fileRow(file) {
    const result = this.downloads.get(file.path)

    return `
      <tr>
        <td class="mono url-cell" title="${esc(file.path)}">${esc(file.path)}</td>
        <td class="text-end mono">${esc(fmtBytes(file.size))}</td>
        <td class="mono text-secondary" style="font-size:0.7rem">${esc((file.hash || '').slice(0, 12))}…</td>
        <td class="text-end">
          ${result ? `
            <span class="small ${result.ok ? 'text-success' : 'text-danger'} me-2">
              ${esc(result.text)}
            </span>` : ''}
          <button class="btn btn-sm btn-outline-secondary" data-download="${esc(file.url)}"
            data-expect="${esc(file.size)}">
            <i class="bi bi-download"></i>
          </button>
        </td>
      </tr>`
  }

  bind() {
    const platformSelect = this.container.querySelector('#expPlatform')
    if (platformSelect) {
      platformSelect.addEventListener('change', () => {
        setState({ activePlatform: platformSelect.value })
        this.manifest = null
        this.downloads.clear()
        this.callManifest(platformSelect.value)
      })
    }

    this.container.querySelectorAll('[data-call]').forEach((btn) => {
      btn.addEventListener('click', () => this.dispatch(btn.dataset.call))
    })

    this.bindDownloads()
  }

  bindDownloads() {
    this.container.querySelectorAll('[data-download]').forEach((btn) => {
      btn.addEventListener('click', () => this.testDownload(btn.dataset.download, Number(btn.dataset.expect)))
    })
  }

  /** 收集表单参数。 */
  params() {
    const value = (sel) => {
      const node = this.container.querySelector(sel)
      return node ? node.value.trim() : ''
    }
    const params = { platform: value('#expPlatform') }
    if (value('#expCurrent')) params.current = value('#expCurrent')
    if (value('#expChannel')) params.channel = value('#expChannel')
    if (value('#expDeviceId')) params.deviceId = value('#expDeviceId')
    return params
  }

  async dispatch(action) {
    const params = this.params()

    if (action === 'refresh') {
      try {
        await api.refreshManifest(params.platform)
        await loadPlatforms()
        if (!this.isActive()) return
        this.manifest = null
        toastSuccess(t('explorer.refreshed'))
        await this.callManifest(params.platform)
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
      return
    }

    if (!params.platform) return

    this.busy = true
    this.paintResult()

    const started = Date.now()
    try {
      let data
      let label
      if (action === 'version') {
        data = await api.version(params)
        label = 'GET /api/version'
      } else if (action === 'manifest') {
        data = await api.manifest(params.platform)
        label = 'GET /api/manifest'
      } else {
        data = await api.check(params)
        label = 'GET /api/check'
      }

      if (!this.isActive()) return
      this.result = { label, status: 200, durationMs: Date.now() - started, data }
    } catch (err) {
      if (!this.isActive()) return
      this.result = {
        label: `GET /api/${action}`,
        status: err.status,
        durationMs: Date.now() - started,
        error: err.message,
      }
    } finally {
      this.busy = false
      if (this.isActive()) this.paintResult()
    }
  }

  async callManifest(platform) {
    if (!platform) return
    try {
      const manifest = await api.manifest(platform)
      if (!this.isActive()) return
      this.manifest = manifest
      this.paintAssets()
      this.bindDownloads()
    } catch (err) {
      // 清单拉不到是常见的（平台目录被删、命中故障规则），日志里留个痕迹方便排查
      console.warn('[explorer] 拉取清单失败：', err.message)
      if (!this.isActive()) return
      this.manifest = null
      this.paintAssets()
    }
  }

  /**
   * 下载测试：真的把文件下下来，报告耗时和字节数。
   *
   * 注意浏览器里拿不到 MD5（WebCrypto 不支持 MD5），所以这里只能比对
   * 字节数。内容是否损坏要靠客户端自己做 md5 校验——这正是
   * corrupt 故障想要逼出来的东西。
   *
   * 三件事必须做，否则命中 timeout 故障时这一页就废了：
   *   1. 超时（用 AbortController）—— 否则请求永不 settle，一直转圈
   *   2. 同一文件不允许并发重复下载 —— 否则连点会并行拉好几份
   *   3. 视图卸载时中止在途请求 —— 否则切走页面后它还在占带宽
   */
  async testDownload(url, expectedSize) {
    const key = decodeURIComponent(url).replace(/^\/assets\/[^/]+\//, '')

    if (this.downloadAborters.has(url)) return // 已经在下了，忽略重复点击

    const controller = new AbortController()
    this.downloadAborters.set(url, controller)

    const started = Date.now()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, DOWNLOAD_TIMEOUT_MS)

    // 先把"下载中"画出来，让使用者知道点到了
    this.downloads.set(key, { ok: null, text: t('explorer.downloading') })
    if (this.isActive()) {
      this.paintAssets()
      this.bindDownloads()
    }

    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const ms = Date.now() - started
      const ok = blob.size === expectedSize

      this.downloads.set(key, {
        ok,
        text: `${fmtBytes(blob.size)} / ${fmtDuration(ms)}${ok ? '' : ' ⚠'}`,
      })
    } catch (err) {
      // 下载失败多半是命中了 abort/断网/超时，这本身就是预期结果
      const reason = timedOut
        ? t('explorer.downloadTimeout', { s: Math.round(DOWNLOAD_TIMEOUT_MS / 1000) })
        : (err && err.message ? err.message : String(err))
      this.downloads.set(key, { ok: false, text: `✗ ${reason}` })
    } finally {
      clearTimeout(timer)
      this.downloadAborters.delete(url)
    }

    if (!this.isActive()) return
    this.paintAssets()
    this.bindDownloads()
  }

  paintResult() {
    // 用稳定的 id 定位，而不是 `.col-12.col-xl-7 .hus-card` 这种
    // 依赖 DOM 结构的写法 —— 那种选择器在布局调整后会静默失效
    // （面板从此不再更新且不报任何错）。
    const node = this.container.querySelector('#expResultCard')
    if (!node) return
    node.innerHTML = `<div class="hus-card-title">${esc(t('explorer.result'))}</div>${this.resultHtml()}`
  }

  paintAssets() {
    const node = this.container.querySelector('#expAssetsCard')
    if (!node) return
    node.innerHTML = `<div class="hus-card-title">${esc(t('explorer.assets'))}</div>${this.assetsHtml()}`
  }

  destroy() {
    // 中止所有在途下载：切走页面后不该还占着带宽和服务端连接
    for (const controller of this.downloadAborters.values()) {
      try { controller.abort() } catch { /* 已经结束 */ }
    }
    this.downloadAborters.clear()
    this.result = null
    this.manifest = null
    this.downloads.clear()
    super.destroy()
  }
}
