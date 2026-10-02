// frontend/src/store.js
//
// 极简的应用状态容器 + 发布订阅。
//
// 为什么需要它：网络参数同时出现在「网络模拟」页和「预置方案」页，
// 故障规则同时出现在「故障注入」页和顶部的状态摘要里。
// 每个页面各自去拉一遍后端、各自维护一份副本，很快就会对不上。
// 所以统一放这里，谁改了 notify，其它页面跟着更新。

import { api } from './api.js'

const listeners = new Map()

/** @type {object} 应用状态。只有这里的数据是真的，视图都是它的投影。 */
export const state = {
  /** 与后端的连通性。断网模拟打开后会变成 false，这是正常的。 */
  connected: null,
  /** 后端是否正在被模拟（网络或故障任一开启） */
  simulating: false,
  network: null,
  fault: { enabled: false, rules: [] },
  hotUpdate: null,
  server: null,
  system: null,
  stats: null,
  presets: [],
  favorites: [],
  platforms: [],
  /** 用户当前选中的平台，多个视图共用 */
  activePlatform: null,
}

/** 订阅事件。返回取消订阅的函数。 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(handler)
  return () => listeners.get(event).delete(handler)
}

/** 广播事件。 */
export function emit(event, payload) {
  const set = listeners.get(event)
  if (!set) return
  for (const handler of set) {
    try {
      handler(payload)
    } catch (err) {
      // 一个订阅者出错不该影响其它订阅者
      console.error(`[store] 事件 ${event} 的处理函数出错：`, err)
    }
  }
}

/** 合并一批状态并广播。 */
export function setState(patch) {
  Object.assign(state, patch)
  emit('change', patch)
}

// ------------------------------------------------------------------ 数据加载

/** 从 /api/control 拉取网络与故障状态。 */
export async function loadControl() {
  const data = await api.control.get()
  setState({
    network: data.network,
    fault: data.fault,
    hotUpdate: data.hotUpdate,
    simulating: Boolean(data.network.enabled || data.fault.enabled),
    connected: true,
  })
  return data
}

/** 拉取平台列表，并在必要时选定默认平台。 */
export async function loadPlatforms() {
  const data = await api.platforms()
  const patch = { platforms: data.platforms || [] }
  if (!state.activePlatform && patch.platforms.length) {
    patch.activePlatform = patch.platforms[0].name
  }
  setState(patch)
  return data
}

export async function loadPresets() {
  const data = await api.presets.list()
  setState({ presets: data.presets || [] })
  return data
}

export async function loadFavorites() {
  const data = await api.favorites.list()
  setState({ favorites: data.favorites || [] })
  return data
}

export async function loadStats(windowMinutes = 5) {
  const data = await api.stats(windowMinutes)
  setState({ stats: data, connected: true })
  return data
}

export async function loadSystem() {
  const data = await api.system()
  setState({ system: data })
  return data
}

/**
 * 启动时的一次性初始化。
 * 用 allSettled：某个接口失败（比如资产目录还没建）不该让整个界面打不开。
 */
export async function bootstrap() {
  const results = await Promise.allSettled([
    loadControl(),
    loadPlatforms(),
    loadPresets(),
    loadFavorites(),
    loadSystem(),
    loadStats(),
  ])
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length === results.length) {
    setState({ connected: false })
  }
  return failed
}
