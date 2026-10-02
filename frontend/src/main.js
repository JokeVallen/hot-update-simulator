// frontend/src/main.js
//
// 前端入口：初始化多语言、装配路由、维护顶栏状态。
//
// 路由用 hash（#/logs），不用 history API：
// 构建产物是被 Express 当静态文件托管的，没有服务端路由兜底，
// 用 history 模式刷新 /logs 会直接 404。

import 'bootstrap/dist/css/bootstrap.min.css'
// 目前没有用到任何 Bootstrap 的 JS 组件（侧栏是自己实现的），
// 但体积很小，先留着——以后要加 Modal / Dropdown 就不用再动依赖了
import 'bootstrap/dist/js/bootstrap.bundle.min.js'
import 'bootstrap-icons/font/bootstrap-icons.css'
import './styles/style.css'

import {
  initI18n, setLocale, getLocale, t,
} from './locales/index.js'
import {
  state, bootstrap, on, loadControl, setState,
} from './store.js'
import { api } from './api.js'
import { toastSuccess, reportError, toastWarn } from './ui/toast.js'
import { initSidebar } from './ui/sidebar.js'
import { esc } from './ui/dom.js'
import { initTheme, setTheme, getTheme } from './ui/theme.js'

import { DashboardView } from './views/dashboard.js'
import { NetworkView } from './views/network.js'
import { FaultsView } from './views/faults.js'
import { PresetsView } from './views/presets.js'
import { LogsView } from './views/logs.js'
import { ExplorerView } from './views/explorer.js'
import { FavoritesView } from './views/favorites.js'
import { ManualView } from './views/manual.js'

const ROUTES = {
  dashboard: DashboardView,
  network: NetworkView,
  faults: FaultsView,
  presets: PresetsView,
  logs: LogsView,
  explorer: ExplorerView,
  favorites: FavoritesView,
  manual: ManualView,
}

const DEFAULT_ROUTE = 'dashboard'

/** @type {import('./views/common.js').View|null} */
let currentView = null
let sidebar = null
let statusTimer = null

// ------------------------------------------------------------------ 路由

function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return ROUTES[hash] ? hash : DEFAULT_ROUTE
}

async function mountRoute(route) {
  const container = document.getElementById('husView')
  if (!container) return

  // 先卸载旧视图：它可能在跑定时器或 SSE，不清理会一直占着资源
  if (currentView) {
    currentView.destroy()
    currentView = null
  }

  const ViewClass = ROUTES[route] || ROUTES[DEFAULT_ROUTE]
  currentView = new ViewClass()
  container.innerHTML = ''

  if (sidebar) sidebar.setActive(route)

  try {
    await currentView.mount(container)
  } catch (err) {
    console.error(`[router] 视图 ${route} 渲染失败：`, err)
    container.innerHTML = `
      <div class="alert alert-danger">
        <strong>页面渲染失败</strong>
        <div class="small mt-1 mono">${esc(err.message)}</div>
      </div>`
  }
}

function navigate(route) {
  if (window.location.hash === `#/${route}`) {
    mountRoute(route)
  } else {
    window.location.hash = `#/${route}`
  }
}

// ------------------------------------------------------------------ 顶栏

function renderTopbar() {
  const conn = document.getElementById('husConnStatus')
  const sim = document.getElementById('husSimStatus')
  const footer = document.getElementById('husFooterInfo')

  if (conn) {
    const ok = state.connected === true
    const unknown = state.connected === null
    const cls = unknown ? 'warn' : (ok ? 'ok' : 'bad')
    const label = unknown
      ? t('status.checking')
      : (ok ? t('status.connected') : t('status.disconnected'))
    conn.innerHTML = `<span class="status-dot ${cls}"></span>${esc(label)}`
  }

  if (sim) {
    const active = Boolean(state.simulating)
    sim.className = `badge sim-indicator ${active ? 'text-bg-warning active' : 'text-bg-secondary'}`
    sim.innerHTML = active
      ? `<i class="bi bi-lightning-charge-fill"></i> ${esc(t('status.simulating'))}`
      : `<i class="bi bi-slash-circle"></i> ${esc(t('status.idle'))}`
  }

  if (footer && state.system) {
    const platforms = (state.system.platforms || []).length
    footer.textContent = `${state.system.runtime.node} · ${platforms} platform(s)`
    footer.title = state.system.paths ? state.system.paths.assetRoot : ''
  }
}

/**
 * 定期探测连通性和模拟状态。
 *
 * /api/health 是走模拟器的，所以断网/丢包打开后它就会失败——
 * 这正是我们想显示的："客户端现在连不上"。而 /api/control 不走模拟器，
 * 所以配置状态一直能读到。
 */
async function refreshStatus() {
  await Promise.all([
    api.health()
      // 连通性只有这一个写入路径。控制类接口不受模拟影响，永远会成功，
      // 拿它当连通性依据会让顶栏在断网时来回跳。
      .then(() => setState({ connected: true }))
      .catch(() => setState({ connected: false })),
    loadControl().catch(() => {
      // 控制接口也失败，说明后端是真的没起来
      setState({ connected: false })
    }),
  ])

  renderTopbar()
}

function bindTopbar() {
  const panic = document.getElementById('husPanicBtn')
  if (panic) {
    panic.addEventListener('click', async () => {
      try {
        await api.control.disable()
        await loadControl()
        // 用 refresh() 而不是 render()：render() 对 LogsView 会重开一条 SSE 流，
        // 旧的那条永远不会关闭，同一批日志被推两遍。
        if (currentView) await currentView.refresh()
        renderTopbar()
        toastSuccess(t('status.panicDone'))
      } catch (err) {
        reportError(err, t('toast.actionFailed'))
      }
    })
  }

  const localeSelect = document.getElementById('husLocaleSelect')
  if (localeSelect) {
    localeSelect.value = getLocale()
    localeSelect.addEventListener('change', async () => {
      await setLocale(localeSelect.value)
      // 语言变了要重画当前视图：列表里的文案是拼出来的，
      // translatePage() 只处理静态的 data-i18n 属性
      await mountRoute(currentRoute())
      renderTopbar()
    })
  }

  const themeSelect = document.getElementById('husThemeSelect')
  if (themeSelect) {
    themeSelect.value = getTheme()
    themeSelect.addEventListener('change', () => {
      // 不需要重挂视图：颜色全在 CSS 变量里，切属性就生效了。
      // 唯一例外是把颜色"烤"进实例的图表 —— 它们订阅了主题变化自己重画。
      setTheme(themeSelect.value)
    })
  }
}

// ------------------------------------------------------------------ 启动

async function main() {
  // 主题要在挂载视图之前定下来：仪表盘的图表会把 CSS 变量里的颜色读出来
  // "烤"进 Chart 实例，晚一步就会用错主题的配色。
  initTheme()

  await initI18n()

  sidebar = initSidebar({ onSelect: navigate })

  bindTopbar()
  renderTopbar()

  const failures = await bootstrap()

  // 后端整体不可用时给一次明确提示，而不是让每个页面各自报错。
  // 注意是 failed === total，不是和"路由数量"比 —— 原来拿失败数（最多 6）
  // 去和路由数（7）比，条件永远不成立，这段提示是死代码。
  if (failures.failed === failures.total) {
    toastWarn(t('errors.backendDown'), 8000)
  }

  // 立刻探一次连通性。
  // 不能只靠下面的 5 秒轮询：bootstrap 里的 loadControl() 不再写 connected
  // （那是刻意的，见 store.js），所以不主动探一次的话，顶栏会停在
  // "检测中…" 整整 5 秒才变。
  await refreshStatus()

  // 任何状态变化都刷新顶栏和侧栏底部
  on('change', renderTopbar)

  window.addEventListener('hashchange', () => mountRoute(currentRoute()))

  await mountRoute(currentRoute())

  // 顶栏状态轮询。5 秒足够及时，也不会给后端造成负担。
  statusTimer = setInterval(refreshStatus, 5000)
}

main().catch((err) => {
  console.error('[main] 启动失败：', err)
  const container = document.getElementById('husView')
  if (container) {
    container.innerHTML = `
      <div class="alert alert-danger">
        <strong>界面启动失败</strong>
        <div class="small mt-2 mono">${esc(err && err.message ? err.message : String(err))}</div>
        <div class="small mt-2">请打开浏览器控制台查看详细堆栈。</div>
      </div>`
  }
})

// 供调试使用：在浏览器控制台里可以直接查看当前状态
window.__HUS__ = {
  state,
  currentRoute,
  stopPolling: () => {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
  },
}
