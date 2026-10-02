// frontend/src/views/manual.js
//
// 使用手册。把 backend/public/manual.md 抓过来，用 marked 渲染成页面。
//
// 为什么在面板里渲染，而不是让后端把 markdown 转成 HTML：
//   1. 前端本来就依赖 marked（原来是那句写错的 `import marked from 'marked'`
//      留下的孤儿依赖：声明了、装了，但从没被 import）。用上它，后端就不必
//      再多一个 markdown 渲染依赖。
//   2. 样式能和面板统一 —— 手册里有大量代码块和表格，交给 Bootstrap 之外的
//      东西渲染出来风格会割裂。
//
// 关于安全性：marked **不做** HTML 消毒，它会把源文件里的 HTML 原样输出，
// 而这里是直接 innerHTML 插入的。之所以可以接受：manual.md 是本仓库里
// 我们自己维护的静态文件，不是用户输入。如果以后允许用户编辑手册内容，
// 这里必须先加消毒（DOMPurify 之类）再插入。

import { marked } from 'marked'
import { t } from '../locales/index.js'
import { reportError } from '../ui/toast.js'
import { esc } from '../ui/dom.js'
import { View, pageHeader } from './common.js'

/** 把标题文字转成锚点 id。重复的标题会拿到 -2、-3 后缀。 */
function slugify(text, used) {
  const base = String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
  let id = base
  let n = 2
  while (used.has(id)) {
    id = `${base}-${n}`
    n += 1
  }
  used.add(id)
  return id
}

export class ManualView extends View {
  constructor() {
    super('manual')
    this.observer = null
  }

  async render() {
    this.container.innerHTML = `
      ${pageHeader('manual.title', 'manual.intro')}
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <a class="btn btn-sm btn-outline-secondary" href="/manual.md?raw=1" target="_blank" rel="noopener">
          <i class="bi bi-filetype-md"></i> ${esc(t('manual.viewSource'))}
        </a>
        <span class="small text-secondary">${esc(t('manual.sourceHint'))}</span>
      </div>
      <div id="manualBody">
        <div class="text-secondary small">
          <span class="spinner-border spinner-border-sm"></span> ${esc(t('common.loading'))}
        </div>
      </div>`

    await this.load()
  }

  async load() {
    const body = this.container.querySelector('#manualBody')
    if (!body) return

    try {
      // 显式声明只要 markdown：后端在 /manual.md 上做了内容协商 ——
      // 浏览器直接打开（Accept 含 text/html）会被重定向到面板里的这个页面，
      // 而这里要的正是原始源文件。
      const res = await fetch('/manual.md', { headers: { Accept: 'text/markdown, text/plain' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const markdown = await res.text()

      if (!this.isActive()) return

      const html = await marked.parse(markdown, { gfm: true, breaks: false })
      if (!this.isActive()) return

      body.innerHTML = `
        <div class="hus-manual-layout">
          <nav class="hus-manual-toc" id="manualToc" aria-label="${esc(t('manual.toc'))}"></nav>
          <article class="hus-markdown" id="manualContent">${html}</article>
        </div>`

      this.buildToc()
    } catch (err) {
      if (!this.isActive()) return
      body.innerHTML = `
        <div class="alert alert-danger">
          ${esc(t('manual.loadFailed'))}
          <div class="small mono mt-1">${esc(err.message)}</div>
        </div>`
      reportError(err, t('manual.title'))
    }
  }

  /** 从渲染结果里收集 h2/h3/h4，生成目录并给标题加锚点。 */
  buildToc() {
    const content = this.container.querySelector('#manualContent')
    const toc = this.container.querySelector('#manualToc')
    if (!content || !toc) return

    const used = new Set()
    const headings = Array.from(content.querySelectorAll('h2, h3, h4'))
    if (!headings.length) {
      toc.remove()
      return
    }

    const links = []
    headings.forEach((heading) => {
      const id = slugify(heading.textContent, used)
      heading.id = id
      const level = Number(heading.tagName.slice(1))
      const link = document.createElement('a')
      link.href = `#${id}`
      link.textContent = heading.textContent
      link.className = `level-${level}`
      link.dataset.target = id
      links.push(link)
      toc.appendChild(link)
    })

    toc.addEventListener('click', (evt) => {
      const link = evt.target.closest('a[data-target]')
      if (!link) return
      evt.preventDefault()
      const target = content.querySelector(`#${CSS.escape(link.dataset.target)}`)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    this.setupScrollSpy(links)
  }

  /**
   * 滚动时高亮当前所在的章节。
   * 用 IntersectionObserver 而不是监听 scroll：后者每帧都要读布局，
   * 在这种长文档上很容易掉帧。
   */
  setupScrollSpy(links) {
    if (!links.length) return
    const byId = new Map(links.map((l) => [l.dataset.target, l]))

    // 顶栏是 sticky 的，判定"当前章节"时要把它的高度让出来
    const topOffset = (this.container.querySelector('.hus-topbar') ? 56 : 0) + 24

    this.observer = new IntersectionObserver((entries) => {
      if (!this.isActive()) return
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (!visible.length) return

      const id = visible[0].target.id
      byId.forEach((link, key) => link.classList.toggle('active', key === id))
    }, {
      rootMargin: `-${topOffset}px 0px -70% 0px`,
      threshold: 0,
    })

    byId.forEach((link, id) => {
      const target = this.container.querySelector(`#${CSS.escape(id)}`)
      if (target) this.observer.observe(target)
    })

    this.addCleanup(() => {
      if (this.observer) {
        this.observer.disconnect()
        this.observer = null
      }
    })
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
    super.destroy()
  }
}
