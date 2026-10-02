// frontend/src/ui/sidebar.js
//
// 侧边栏：高亮当前路由、窄屏下抽屉式展开。
//
// 这个是原来 src/scripts/custom_offcanvas.js 想做的事，但那个文件里
// 函数体是空的、也没被任何地方 import，等于完全没生效。
// 现在改成基于自定义侧边栏（不用 Bootstrap 的 offcanvas），
// 因为桌面端需要的是一个常驻的固定侧栏，而不是浮层。

/**
 * @param {object} options
 * @param {(route: string) => void} options.onSelect 点击导航项时回调
 */
export function initSidebar({ onSelect }) {
  const sidebar = document.getElementById('husSidebar')
  const nav = document.getElementById('husNav')
  const toggle = document.getElementById('husSidebarToggle')
  if (!sidebar || !nav) return { setActive() {}, close() {} }

  let backdrop = null

  function close() {
    sidebar.classList.remove('open')
    if (backdrop) {
      backdrop.remove()
      backdrop = null
    }
  }

  function open() {
    sidebar.classList.add('open')
    if (!backdrop) {
      backdrop = document.createElement('div')
      backdrop.className = 'hus-backdrop'
      backdrop.addEventListener('click', close)
      document.body.appendChild(backdrop)
    }
  }

  if (toggle) {
    toggle.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) close()
      else open()
    })
  }

  nav.addEventListener('click', (evt) => {
    const link = evt.target.closest('[data-route]')
    if (!link) return
    evt.preventDefault()
    onSelect(link.dataset.route)
    // 窄屏上选完就收起抽屉，否则会挡住内容
    if (window.matchMedia('(max-width: 991.98px)').matches) close()
  })

  // 窗口拉宽回桌面尺寸时，把抽屉状态清掉，否则会残留遮罩
  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 991.98px)').matches) close()
  })

  return {
    /** 高亮指定的导航项。 */
    setActive(route) {
      nav.querySelectorAll('[data-route]').forEach((link) => {
        link.classList.toggle('active', link.dataset.route === route)
      })
    },
    close,
  }
}
