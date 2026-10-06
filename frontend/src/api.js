// frontend/src/api.js
//
// 后端接口的统一封装。
//
// 用相对路径（空字符串开头）而不是写死 http://localhost:5500：
// 开发时 Vite 的 proxy 会把 /api 转发到后端，构建后后端自己托管前端，
// 两种情况都是同源，所以相对路径两边都对。
//
// 所有函数失败时都抛 ApiError，调用方统一用 catch 处理，
// 不用每个地方都判断 res.ok。

const BASE = ''

// 面向用户的错误文案走语言包。api.js 依赖 locales 是单向的
// （locales 不反过来依赖 api），不会形成环。
import { t, getLocale } from './locales/index.js'

export class ApiError extends Error {
  constructor(message, { status = null, body = null, cause = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.cause = cause
  }
}

/**
 * 默认请求超时。
 *
 * 这个前端**必须**有超时：后端的主要功能之一就是模拟"服务器不响应"，
 * 命中 timeout 故障时请求会永远不 settle。没有超时的话，接口调试页的
 * 「响应」卡片会一直停在转圈上，只能刷新页面才能恢复。
 */
const DEFAULT_TIMEOUT_MS = 15000
/** 下载资产可能很慢（限速 100Kbps 下 10MB 要 13 分钟），单独放宽。 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 发一个请求。
 * @param {string} path 形如 /api/control
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body] 会被 JSON 序列化
 * @param {object} [options.headers]
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @param {number} [options.timeoutMs] 超时毫秒数，0 表示不限
 */
async function request(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const init = { method, headers: { ...headers } }

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  // 把「超时」和「调用方主动取消」统一到一个 controller 上
  const controller = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : null

  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  init.signal = controller.signal

  let res
  try {
    res = await fetch(BASE + path, init)
  } catch (err) {
    if (timedOut) {
      throw new ApiError(t('errors.timeout', { s: Math.round(timeoutMs / 1000) }), { cause: err })
    }
    if (err.name === 'AbortError') {
      // 调用方主动取消，不算错误，交给上层按取消处理
      const abortErr = new ApiError(t('errors.cancelled'), { cause: err })
      abortErr.cancelled = true
      throw abortErr
    }
    // 连不上后端，或者请求被模拟器掐断了
    throw new ApiError(t('errors.networkDown'), { cause: err })
  } finally {
    if (timer) clearTimeout(timer)
  }

  // 204 和 304 没有响应体
  if (res.status === 204 || res.status === 304) {
    return { status: res.status, data: null, headers: res.headers }
  }

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // 后端返回的不是 JSON（例如资产下载返回的二进制、或者故障注入返回的纯文本）
      data = text
    }
  }

  if (!res.ok) {
    const message = (data && data.error)
      || (typeof data === 'string' && data)
      || t('errors.requestFailed', { status: res.status })
    throw new ApiError(message, { status: res.status, body: data })
  }

  return { status: res.status, data, headers: res.headers }
}

/** 只关心返回数据、不关心状态码时用这个。 */
async function json(path, options) {
  return (await request(path, options)).data
}

// ------------------------------------------------------------------ 具体接口

export const api = {
  // 观测
  health: () => json('/api/health'),
  system: () => json('/api/system'),
  stats: (windowMinutes = 5) => json(`/api/stats?windowMinutes=${windowMinutes}`),

  // 热更业务
  platforms: () => json('/api/platforms'),
  version: (params) => json(`/api/version?${new URLSearchParams(params)}`),
  /**
   * 取清单。
   * @param {string} platform
   * @param {{channel?:string, track?:'resource'|'code'}} [opts]
   */
  manifest: (platform, opts = {}) => {
    const q = new URLSearchParams({ platform: String(platform) })
    if (opts.channel) q.set('channel', String(opts.channel))
    if (opts.track) q.set('track', String(opts.track))
    return json(`/api/manifest?${q.toString()}`)
  },
  check: (params) => json(`/api/check?${new URLSearchParams(params)}`),
  refreshManifest: (platform) =>
    json(`/api/manifest/refresh${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`, { method: 'POST' }),

  // 控制
  control: {
    get: () => json('/api/control'),
    patchNetwork: (patch) => json('/api/control/network', { method: 'PATCH', body: patch }),
    resetNetwork: () => json('/api/control/network/reset', { method: 'POST' }),
    patchFault: (enabled) => json('/api/control/fault', { method: 'PATCH', body: { enabled } }),
    rules: {
      list: () => json('/api/control/fault/rules'),
      create: (rule) => json('/api/control/fault/rules', { method: 'POST', body: rule }),
      update: (id, rule) => json(`/api/control/fault/rules/${id}`, { method: 'PUT', body: rule }),
      remove: (id) => json(`/api/control/fault/rules/${id}`, { method: 'DELETE' }),
    },
    resetCounters: () => json('/api/control/fault/reset-counters', { method: 'POST' }),
    /** 急停：关掉全部模拟。界面卡住时的救命按钮。 */
    disable: () => json('/api/control/disable', { method: 'POST' }),
    reset: () => json('/api/control/reset', { method: 'POST' }),
  },

  // 预置方案
  presets: {
    list: () => json('/api/presets'),
    get: (id) => json(`/api/presets/${id}`),
    /**
     * 应用方案。
     *
     * 自动带上当前语言：应用方案会把故障规则的**名称**和响应体写进配置，
     * 那些是落盘的字符串，之后不会随界面语言变化，所以必须在这一刻定语言。
     * 由 API 层统一附加，调用方不用关心这件事。
     */
    apply: (id) => json(
      `/api/presets/${encodeURIComponent(id)}/apply?lang=${encodeURIComponent(getLocale())}`,
      { method: 'POST' },
    ),
    capture: (name, description) =>
      json('/api/presets/capture', { method: 'POST', body: { name, description } }),
    remove: (id) => json(`/api/presets/${id}`, { method: 'DELETE' }),
  },

  // 收藏
  favorites: {
    list: () => json('/api/favorites'),
    create: (favorite) => json('/api/favorites', { method: 'POST', body: favorite }),
    remove: (id) => json(`/api/favorites/${id}`, { method: 'DELETE' }),
    replay: (id) => json(`/api/favorites/${id}/replay`, { method: 'POST' }),
  },

  // 日志
  logs: {
    query: (params = {}) => json(`/api/logs?${new URLSearchParams(params)}`),
    clear: () => json('/api/logs', { method: 'DELETE' }),
    /**
     * 订阅实时日志。返回一个取消订阅的函数。
     * @param {(entry: object) => void} onEntry
     * @param {(info: object) => void} [onClear]
     * @param {(err: Event) => void} [onError]
     */
    stream(onEntry, onClear, onError) {
      const source = new EventSource(`${BASE}/api/logs/stream`)
      source.addEventListener('entry', (evt) => {
        try {
          onEntry(JSON.parse(evt.data))
        } catch {
          /* 单条解析失败不该让整个流断掉 */
        }
      })
      if (onClear) {
        source.addEventListener('clear', (evt) => {
          try {
            onClear(JSON.parse(evt.data))
          } catch {
            onClear({})
          }
        })
      }
      if (onError) source.addEventListener('error', onError)
      return () => source.close()
    },
  },
}

export default api
