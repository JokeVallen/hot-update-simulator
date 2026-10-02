// frontend/src/locales/index.js
//
// 多语言。
//
// 相比最初的版本，这里修了几个问题：
//   1. t() 原来只支持扁平 key，但注释里说支持 'nav.presets' 这种嵌套路径 ——
//      现在真的支持嵌套了，并且找不到时逐级回退到默认语言、最后回退到 key 本身。
//   2. 语言包改成显式 import 而不是 `import(\`./${locale}.json\`)`：
//      显式写法打包器一定能静态分析出来，也不用担心语言包没被打进去。
//   3. 记住用户的选择（localStorage），刷新页面不会跳回默认语言。
//   4. 支持 data-i18n / data-i18n-placeholder / data-i18n-title 三种属性。

export const locales = ['zh-CN', 'en']
export const defaultLocale = 'zh-CN'

/** 显式登记语言包，避免动态拼接路径。 */
const loaders = {
  'zh-CN': () => import('./zh-CN.json'),
  en: () => import('./en.json'),
}

const STORAGE_KEY = 'hus.locale'

let currentLocale = defaultLocale
/** @type {Record<string, any>} */
let messages = {}
/** 默认语言的文案，作为当前语言缺 key 时的回退 */
let fallbackMessages = {}

/** 从嵌套对象里按 'a.b.c' 取值。 */
function resolve(source, key) {
  if (!source || !key) return undefined
  return String(key).split('.').reduce((acc, part) => {
    if (acc === null || acc === undefined) return undefined
    return acc[part]
  }, source)
}

async function loadBundle(locale) {
  const loader = loaders[locale]
  if (!loader) return {}
  try {
    const mod = await loader()
    return mod.default || mod
  } catch (err) {
    console.error(`[i18n] 语言包 ${locale} 加载失败：`, err)
    return {}
  }
}

/**
 * 取翻译文本。
 * @param {string} key 支持 'nav.presets' 这种嵌套路径
 * @param {Record<string, any>} [params] 用于替换文案里的 {name} 占位符
 */
export function t(key, params = {}) {
  let text = resolve(messages, key)
  if (text === undefined) text = resolve(fallbackMessages, key)
  if (text === undefined) {
    // 找不到就原样显示 key，方便一眼看出漏翻了哪个
    if (import.meta.env?.DEV) console.warn(`[i18n] 缺少文案：${key}`)
    return key
  }
  if (typeof text !== 'string') return String(text)

  return text.replace(/\{(\w+)\}/g, (match, name) => (
    params[name] === undefined ? match : String(params[name])
  ))
}

/** 替换页面里所有带 data-i18n* 属性的元素。 */
export function translatePage(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    const text = t(key)
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = text
    } else if (el.tagName === 'TITLE') {
      el.textContent = text
      document.title = text
    } else {
      el.textContent = text
    }
  })

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')))
  })

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
  })
}

/** 当前语言。 */
export function getLocale() {
  return currentLocale
}

/**
 * 切换语言。
 * @returns {Promise<boolean>} 语言不支持时返回 false
 */
export async function setLocale(locale) {
  if (!locales.includes(locale)) {
    console.warn(`[i18n] 不支持的语言：${locale}`)
    return false
  }

  messages = await loadBundle(locale)
  currentLocale = locale

  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略即可
  }

  document.documentElement.setAttribute('lang', locale)
  translatePage()

  // 让各视图有机会重新渲染（列表里的文案是拼出来的，光靠 translatePage 不够）
  window.dispatchEvent(new CustomEvent('localeChanged', { detail: { locale } }))
  return true
}

/** 页面初始化时调用。 */
export async function initI18n() {
  fallbackMessages = await loadBundle(defaultLocale)

  let preferred = defaultLocale
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && locales.includes(stored)) {
      preferred = stored
    } else if (navigator.language && navigator.language.toLowerCase().startsWith('en')) {
      preferred = 'en'
    }
  } catch {
    // 读不到就用默认语言
  }

  await setLocale(preferred)
}
