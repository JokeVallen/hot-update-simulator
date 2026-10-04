// frontend/vite.config.js
import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import { createRequire } from 'module'

// 版本号的唯一来源是**仓库根**的 package.json。
// 前端自己的 package.json 里那个 version 不参与任何事，只作为 npm 的常规字段存在；
// scripts/version-check.js 会断言两者一致，防止有人只改了一边。
const require = createRequire(import.meta.url)
const rootPkg = require(path.resolve(__dirname, '..', 'package.json'))

export default defineConfig(({ mode }) => {
  // .env 系列文件在仓库根目录，不在 frontend/ 下
  const env = loadEnv(mode, path.resolve(__dirname, '..'))
  const apiBase = env.VITE_API_BASE_URL || 'http://localhost:5500'

  return {
    // 编译期常量：代码里写 __APP_VERSION__，构建时被替换成字面量。
    // 比运行时去请求 /api/system 好在"后端挂了也能显示"。
    define: {
      __APP_VERSION__: JSON.stringify(rootPkg.version),
      __APP_NAME__: JSON.stringify(rootPkg.name),
    },
    server: {
      port: parseInt(env.VITE_PORT, 10) || 5173,
      proxy: {
        '/api': apiBase,
        '/assets': apiBase,
        '/docs': apiBase,
        '/manual.md': apiBase,
        '/openapi.json': apiBase,
      },
    },
    build: {
      // 构建产物放在仓库根的 dist/，由 Express 直接托管
      // （见 backend/app.js 里的 webRoot）
      outDir: '../dist',
      emptyOutDir: true,

      // 关键：不能叫 'assets'。
      //
      // Vite 默认输出到 dist/assets/，而后端的 /assets 是**热更资产下载路由**
      // （backend/app.js 里挂给 AssetServer 的那个）。两者一撞，
      // 浏览器请求 /assets/index-xxxx.js 会被热更处理器当成
      // "平台名=index-xxxx.js、文件路径为空"，直接返回 400，页面白屏。
      //
      // 改成 'web' 之后 /assets 前缀就专属热更内容，不会再打架。
      assetsDir: 'web',
    },
  }
})
