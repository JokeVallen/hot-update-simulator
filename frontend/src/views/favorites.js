// frontend/src/views/favorites.js
//
// 收藏：存下常用请求并一键重放。
//
// 重放是**服务器向自己发请求**（见 backend/routes/favorites.js），
// 所以延迟、限速、故障注入都会照常生效。这比在浏览器里点一下要准——
// 浏览器那边还有自己的超时和重试在干扰观察。

import { t } from '../locales/index.js'
import { api } from '../api.js'
import { state, loadFavorites } from '../store.js'
import { reportError, toastSuccess } from '../ui/toast.js'
import { esc, fmtDuration, statusBadge } from '../ui/dom.js'
import { View, pageHeader, card, emptyState } from './common.js'

export class FavoritesView extends View {
  constructor() {
    super('favorites')
    /** 正在重放的收藏 id 集合 */
    this.replaying = new Set()
  }

  async render() {
    const favorites = state.favorites || []

    this.container.innerHTML = `
      ${pageHeader('favorites.title', 'favorites.intro')}

      <div class="row g-3">
        <div class="col-12 col-xl-4">
          ${card(t('favorites.add'), this.formHtml())}
        </div>
        <div class="col-12 col-xl-8">
          ${card(t('common.actions'), `<div id="favList">${this.listHtml(favorites)}</div>`)}
        </div>
      </div>`

    this.bind()
  }

  formHtml() {
    return `
      <div class="mb-2">
        <label class="form-label small mb-1">${esc(t('common.name'))}</label>
        <input type="text" class="form-control form-control-sm" id="favName"
          placeholder="${esc(t('favorites.namePlaceholder'))}">
      </div>
      <div class="mb-2">
        <label class="form-label small mb-1">${esc(t('logs.method'))}</label>
        <select class="form-select form-select-sm" id="favMethod">
          <option>GET</option>
          <option>POST</option>
        </select>
      </div>
      <div class="mb-2">
        <label class="form-label small mb-1">URL</label>
        <input type="text" class="form-control form-control-sm mono" id="favUrl"
          placeholder="${esc(t('favorites.urlPlaceholder'))}">
      </div>
      <div class="mb-3">
        <label class="form-label small mb-1">Body</label>
        <textarea class="form-control form-control-sm mono" id="favBody" rows="2"
          placeholder='{"key": "value"}'></textarea>
      </div>
      <button class="btn btn-sm btn-primary w-100" id="favAdd">
        <i class="bi bi-plus-lg"></i> ${esc(t('favorites.add'))}
      </button>`
  }

  listHtml(favorites) {
    if (!favorites.length) return emptyState(t('favorites.empty'))

    return favorites.map((fav) => {
      const last = fav.lastResult
      const isReplaying = this.replaying.has(fav.id)

      return `
        <div class="rule-item" data-fav-id="${esc(fav.id)}">
          <div class="d-flex align-items-start gap-2">
            <div class="flex-grow-1 min-width-0">
              <div class="rule-name">${esc(fav.name)}</div>
              <div class="rule-meta">${esc(fav.method)} ${esc(fav.url)}</div>
              ${last ? `
                <div class="rule-meta mt-1">
                  ${esc(t('favorites.lastResult'))}：
                  ${statusBadge(last.status)}
                  <span class="ms-1">${esc(fmtDuration(last.durationMs))}</span>
                  ${last.error ? `<span class="text-danger ms-1">${esc(last.error)}</span>` : ''}
                </div>` : ''}
            </div>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-primary" data-fav-replay="${esc(fav.id)}"
                ${isReplaying ? 'disabled' : ''}>
                ${isReplaying
    ? `<span class="spinner-border spinner-border-sm"></span>`
    : `<i class="bi bi-play-fill"></i> ${esc(t('favorites.replay'))}`}
              </button>
              <button class="btn btn-outline-danger" data-fav-delete="${esc(fav.id)}">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>`
    }).join('')
  }

  bind() {
    this.container.querySelector('#favAdd').addEventListener('click', async () => {
      const name = this.container.querySelector('#favName').value.trim()
      const url = this.container.querySelector('#favUrl').value.trim()
      const method = this.container.querySelector('#favMethod').value
      const body = this.container.querySelector('#favBody').value.trim()

      if (!name || !url) {
        reportError(new Error(`${t('common.name')} / URL`), t('toast.actionFailed'))
        return
      }

      try {
        await api.favorites.create({ name, url, method, body })
        await loadFavorites()
        if (!this.isActive()) return
        toastSuccess(t('favorites.created'))
        this.render()
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })

    this.container.querySelectorAll('[data-fav-replay]').forEach((btn) => {
      btn.addEventListener('click', () => this.replay(btn.dataset.favReplay))
    })

    this.container.querySelectorAll('[data-fav-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm(t('common.confirmDelete'))) return
        try {
          await api.favorites.remove(btn.dataset.favDelete)
          await loadFavorites()
          if (!this.isActive()) return
          toastSuccess(t('favorites.deleted'))
          this.render()
        } catch (err) {
          reportError(err, t('toast.actionFailed'))
        }
      })
    })
  }

  async replay(id) {
    this.replaying.add(id)
    if (this.isActive()) {
      const host = this.container.querySelector('#favList')
      if (host) host.innerHTML = this.listHtml(state.favorites || [])
      this.bind()
    }

    try {
      const result = await api.favorites.replay(id)
      await loadFavorites()
      if (!this.isActive()) return
      toastSuccess(t('favorites.replayOk', {
        status: result.status,
        ms: fmtDuration(result.durationMs),
      }))
    } catch (err) {
      // 重放失败是常见情况（超时故障、断网），要把原因说清楚
      const message = err && err.message ? err.message : String(err)
      reportError(new Error(message), t('favorites.replay'))
    } finally {
      this.replaying.delete(id)
      if (this.isActive()) this.render()
    }
  }

  destroy() {
    this.replaying.clear()
    super.destroy()
  }
}
