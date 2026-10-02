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
 * 发一个请求。
 * @param {string} path 形如 /api/control
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body] 会被 JSON 序列化
 * @param {object} [options.headers]
 */
async function request(path, options = {}) {
  const { method = 'GET', body, headers = {}, signal } = options

  const init = { method, headers: { ...headers }, signal }

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(BASE + path, init)
  } catch (err) {
    // 连不上后端，或者请求被模拟器掐断了
    if (err.name === 'AbortError') throw err
    throw new ApiError('无法连接到后端服务，请确认服务器正在运行', { cause: err })
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
    const message = (data && data.error) || (typeof data === 'string' && data) || `请求失败（HTTP ${res.status}）`
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
  manifest: (platform) => json(`/api/manifest?platform=${encodeURIComponent(platform)}`),
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
    apply: (id) => json(`/api/presets/${id}/apply`, { method: 'POST' }),
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
