// frontend/src/ui/theme.js
//
// 主题：浅色 / 深色 / 跟随系统。
//
// 为什么用 data-bs-theme 属性而不是自己写一套类名：
// Bootstrap 5.3 的所有组件（表单、卡片、徽章、下拉）都读 `--bs-*` 变量，
// 而这些变量由 `data-bs-theme` 决定。改这一个属性，全套组件跟着变，
// 不需要逐个组件覆盖样式。
//
// 「跟随系统」是**动态**的：用户可能在面板开着的时候切系统主题
// （macOS/Windows 都支持日落自动切换），所以必须监听 matchMedia 的变化，
// 不能只在启动时读一次。

const STORAGE_KEY = 'hus.theme'
const VALID = ['light', 'dark', 'system']
const DEFAULT_THEME = 'system'

/** @type {'light'|'dark'|'system'} */
let current = DEFAULT_THEME
/** @type {MediaQueryList|null} */
let media = null
/** @type {Set<(resolved:'light'|'dark')=>void>} */
const listeners = new Set()

/** 用户在界面上选的那个值（可能是 'system'）。 */
export function getTheme() {
  return current
}

/** 实际生效的主题：把 'system' 解析成 'light' 或 'dark'。 */
export function getResolvedTheme() {
  if (current === 'system') {
    return media && media.matches ? 'dark' : 'light'
  }
  return current
}

/**
 * 把主题写到 <html data-bs-theme> 上。
 *
 * FOUC（刷新时先闪一下另一种主题）由 index.html 里的内联脚本负责挡掉：
 * 它在样式生效前就按 localStorage 设好了属性。这里只负责后续的切换。
 */
function apply() {
  const resolved = getResolvedTheme()
  document.documentElement.setAttribute('data-bs-theme', resolved)
  // 让浏览器知道该给表单控件、滚动条用哪种配色
  document.documentElement.style.colorScheme = resolved
  for (const fn of listeners) {
    try {
      fn(resolved)
    } catch (err) {
      console.error('[theme] 监听器出错：', err)
    }
  }
}

/**
 * 切换主题。
 * @param {'light'|'dark'|'system'} theme
 */
export function setTheme(theme) {
  current = VALID.includes(theme) ? theme : DEFAULT_THEME
  try {
    localStorage.setItem(STORAGE_KEY, current)
  } catch {
    // 隐私模式下 localStorage 可能不可写，不影响本次会话使用
  }
  apply()
  return current
}

/**
 * 订阅主题变化（生效后的 light/dark）。
 * 图表这类"把颜色烤进实例"的东西需要靠它重画。
 * @param {(resolved:'light'|'dark')=>void} fn
 * @returns {() => void} 取消订阅
 */
export function onThemeChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 启动时调用一次。 */
export function initTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    current = VALID.includes(stored) ? stored : DEFAULT_THEME
  } catch {
    current = DEFAULT_THEME
  }

  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', () => {
      // 只有「跟随系统」才需要跟着变；用户明确选了浅色/深色就不该被系统覆盖
      if (current === 'system') apply()
    })
  }

  apply()
  return current
}
