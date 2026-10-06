# 热更新模拟器（Hot Update Simulator）

一个用 Node.js + Express 写的**游戏热更新服务端模拟器**。目的不是实现热更，
而是把热更客户端会遇到的各种恶劣情况**复现出来**，让 U3D 端的下载、校验、
重试、续传逻辑在进真机测试之前就被打够。

面向的使用者是 Unity 前端开发：不需要改后端代码，打开面板点几下，
就能让接口变慢、让下载断流、让文件内容损坏。

> 完整说明见 [`backend/public/manual.zh-CN.md`](backend/public/manual.zh-CN.md)（英文版是
> [`manual.en.md`](backend/public/manual.en.md)），服务启动后也可以直接在浏览器里看
> `http://localhost:5500/manual`——面板里渲染好的版本，带目录，跟着界面语言切换。

---

## 快速开始

```bash
npm install          # 后端依赖
npm run sample       # 生成示例热更包（6 个 2MB 的假 AssetBundle）
npm start            # 启动，默认 http://localhost:5500
```

| 地址 | 说明 |
|---|---|
| http://localhost:5500/docs | Swagger 接口文档，可直接试调 |
| http://localhost:5500/manual | 使用手册（面板里渲染好的，带目录） |
| http://localhost:5500/api/system | 确认用的是哪份配置、资产目录在哪 |

前端面板（另开一个终端）：

```bash
cd frontend && npm run dev     # 开发模式，5173 端口，自动代理到 5500
npm run build                  # 或者构建成静态文件，由后端直接托管
```

### 和开发用的项目隔离

模拟器**不会往自己的目录以外写任何东西**。全部运行时数据只有两处：

| 内容 | 位置 | 进 git 吗 |
|---|---|---|
| 示例热更包、预置方案、收藏 | `<项目>/storage`（默认） | 否，已 gitignore |
| 模拟参数、故障规则 | `backend/config.json` | 是，这是项目文件 |

资产目录对服务器**只读**——没有任何代码会往里写或删。
`npm run sample --clean` 只清 `<存储根>/assets/`，
**碰不到你 Unity 工程的构建产物**。

想把数据整个挪到项目外面，**推荐写进 `.env`**（不用记 shell 语法）：

```ini
# .env
HOT_UPDATE_STORAGE=D:\hus-data
```

之后示例包、方案、收藏全落在 `D:\hus-data`。`npm run sample` 和服务器读的是
**同一个存储根**，不会各写各的（这条有一致性断言把关）。
相对路径按**项目根**解析，所以从 IDE 里启动也不会跑偏。

命令行也能临时指定，但各家 shell 写法不同，**cmd 不认 `VAR=value` 那种写法**：

```bat
:: cmd
set HOT_UPDATE_STORAGE=D:\hus-data && npm start

:: PowerShell
$env:HOT_UPDATE_STORAGE='D:\hus-data'; npm start

:: Git Bash / WSL
HOT_UPDATE_STORAGE=D:/hus-data npm start
```

想直接测 Unity 构建出来的真实包，把 `assetDir` 写成**绝对路径**指向构建产物目录：

```jsonc
{ "server": { "assetDir": "D:\\MyUnityProject\\ServerData\\Android" } }
```

### 在别的设备上用 / 打包成使用版

默认只监听 `127.0.0.1`，别的设备连不上。要开放：

```bash
HOST=0.0.0.0 npm start        # 然后在别的设备打开 http://<本机IP>:5500
```

> ⚠️ 控制接口没有认证，绑 `0.0.0.0` 等于开放给同一局域网。只在真机联调时开。

**项目没有单独的发行分支，仓库本身就是产品**，但别把开发目录整个复制过去——
里面有 `node_modules`、示例包、构建产物，还有一份被使用过程改写过的
`backend/config.json`。打一个干净的包：

```bash
npm run release               # → release/hot-update-simulator-1.0.0.tgz
```

包里只有 git 跟踪的源码 + 构建好的 `dist/`，**不含**任何开发数据，
而且 `backend/config.json` 会被**重置成默认值**——否则开发时调出来的故障规则
和模拟参数会跟着进到发行包里。工作区不干净时会拒绝打包（发行包必须对应到
确切的提交），要强制加 `--force`。

```bash
mkdir D:\hus-runtime
tar -xzf hot-update-simulator-1.0.0.tgz -C D:\hus-runtime --strip-components=1
cd D:\hus-runtime && npm install && npm start
```

### 可视化面板

构建之后打开 `http://localhost:5500/`，侧栏共 10 项（9 个页面 + API 文档外链）：

| 页面 | 做什么 |
|---|---|
| **总览** | 请求量、延迟分位、错误率、状态码分布、时间线，以及**当前配了什么模拟、有多少请求被它动过手脚** |
| **网络模拟** | 延迟/抖动/带宽/丢包/断网的滑块，带 WiFi/4G/3G/弱网 快捷档位和下载耗时预估 |
| **故障注入** | 规则的增删改查，右侧列出 8 种故障类型各自在测客户端的什么能力 |
| **预置方案** | 17 个场景卡片，一键切换；也可把当前配置存成自己的方案 |
| **实时日志** | SSE 实时流，每条都标出被做了什么（`abort`、`+300ms`、`100Kbps`、`Range`…） |
| **接口调试** | 直接调热更接口、看响应、下载资产测试耗时，用来现场验证模拟效果 |
| **收藏** | 存下常用请求并重放（重放由服务器发起，会完整经过模拟器） |
| **资产目录** | 热更包在磁盘上的实际布局：平台、渠道、资源轨道与代码轨道分别装了什么。排查"文件放对地方了吗"先看这里 |
| **使用手册** | 手册渲染在面板内（带目录）。中英文各一份：`manual.zh-CN.md` / `manual.en.md` |
| **API 文档** | 侧栏项，新标签页打开 Swagger UI |

顶栏常驻一个**急停**按钮和模拟状态指示。注意状态灯反映的是"客户端视角"：
打开断网后它会变成红色"连接中断"——这是对的，说明模拟在生效；
而控制面板本身依然可用，所以永远能把参数调回来。

### 测试

```bash
npm run lint         # ESLint（含复杂度预算：complexity / max-depth / max-lines）
npm run arch         # 结构：循环依赖 / 分层方向 / 孤儿模块 / 规模分布
npm run smoke        # 后端端到端：74 项断言，每种故障都真的触发一遍
npm run regression   # 边界与回归：122 项断言，覆盖 chunked / 0 字节 / Range / 缓存 / 版本语义
npm run ui-check     # 前端界面：无头 Chrome 走完 8 个路由，并逐页扫描漏翻
npm run soak         # 稳定性：400 个混合请求，检查内存是否稳定、结束后是否仍可用
npm run docs-check   # 文档覆盖度：代码里的接口/配置/故障类型有没有漏写进手册
```

`ui-check` 需要 Chrome 或 Edge，会在 `ui-check-shots/` 下给每个页面留一张截图。
跑完会自动还原 `backend/config.json`（测试会真的改动它）。

文档也是被检查的：`docs-check` 把接口、配置项、故障类型、面板页面和 npm 脚本
从代码里抽出来逐项对照手册，加了功能忘了写文档时会直接报出来。

### 版本与变更记录

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，变更记录见
[`CHANGELOG.md`](CHANGELOG.md)（格式参考 Keep a Changelog）。

**`package.json` 里的 `version` 是唯一来源。** Swagger 信息、面板页脚、发行包名
全都从它派生，不单独维护。面板左下角常驻显示当前版本，方便确认"我跑的到底是哪个"。

发一个新版本：

```bash
npm run bump minor          # 或 patch / major / 具体版本号如 1.2.0
```

它会**一次做完该同步的三件事**，这正是最容易漏的地方：

| 它做什么 | 漏了会怎样 |
|---|---|
| 改根 `package.json` | —— |
| 改 `frontend/package.json` | 两处版本号漂移，而且看起来都"像"是对的 |
| 在 `CHANGELOG.md` 插入带日期的小节 | 用的人不知道这次要不要升级、升了会怎样 |

然后填 CHANGELOG、提交、打 tag、打包：

```bash
# 1. 把改动填进 CHANGELOG.md 新插入的小节（新增 / 变更 / 修复）
git add -A && git commit -m "chore: 发布 1.1.0"
git tag v1.1.0
npm run release
```

**`npm run version-check`** 会校验版本号格式、两处 package.json 是否一致、
CHANGELOG 里有没有当前版本的小节。它也被 `npm run release` 自动调用——
**没有变更记录的版本不允许打包出去**。

> 不用 `npm version`：它只改当前目录的 `package.json`，不会碰 `frontend/` 那份，
> 正好会造成上面那种漂移。

### 安全边界

控制类接口**没有认证**，默认只监听 `127.0.0.1`。要改成 `0.0.0.0` 给真机联调时，
请清楚这等于把"读写模拟参数 + 读取全部请求日志"开放给整个局域网。
跨站的状态变更请求会被拒绝，错误响应也不回传磁盘路径。

详见 [使用手册的安全边界一节](backend/public/manual.zh-CN.md)。

---

## 它到底做什么

### 1. 网络模拟（链路差）

延迟、抖动、带宽限制、丢包、断网。客户端看到的是**网络问题**。

带宽用千比特每秒，和运营商口径一致：

| 设置 | 相当于 | 下载 10MB |
|---|---|---|
| 20000 Kbps | 20 Mbps（WiFi） | 约 4 秒 |
| 2000 Kbps | 2 Mbps（4G） | 约 40 秒 |
| 400 Kbps | 400 Kbps（3G） | 约 200 秒 |

### 2. 故障注入（服务端/文件有问题）

| 类型 | 客户端看到什么 | 测什么 |
|---|---|---|
| `status` | 500 / 404 / 403 | 错误提示、降级 |
| `timeout` | 一直不响应 | 超时设置 |
| `slowHeader` | 响应头很慢 | 连接超时与读取超时是否分开 |
| `abort` | 下到一半连接被重置 | **断点续传** |
| `truncate` | 长度声明完整但提前结束 | 内容长度校验 |
| `corrupt` | **下载成功但内容是坏的** | **md5 校验有没有真做** |
| `slowThenAbort` | 先卡很久，再下到一半又断 | 超时重试后又断这条完整链路 |
| `empty` | 200 但响应体为空 | 空文件/空清单 |

`corrupt` 是最容易被忽略的一个：不校验 hash 的客户端会一路"成功"，
然后在解包或运行时才炸。建议早点用它测一遍。

`slowThenAbort` 是唯一的复合类型。单条规则只能表达一个动作，
而线上最常见的失败链路是两段的：等太久 → 超时重试 → 重试时又断。

### 3. 资源热更与代码热更分成两条轨道

热更在成熟管线里是**分开版本、分开下发**的（YooAsset 的 Package Version vs App Version、
Addressables、HybridCLR 的 DLL 集）。模拟器两条都支持：

```jsonc
// storage/assets/Android/manifest.json
{
  "version": "1.5.0",            // 资源版本
  "code": {
    "version": "2.1.0",          // 代码版本，独立
    "minAppVersion": "1.2.0",    // 主包低于它就不能热更代码（AOT 元数据门禁）
    "aotHash": "aot-abc123"      // 期望的 AOT 指纹，不匹配说明不兼容
  }
}
```

`dll/` 下的文件**不进资源清单**，用 `?track=code` 单独取。
`/api/version` 会返回 `compatible` / `aotMatch` / `requiresAppUpdate`，
用来测客户端的门禁逻辑——**AOT 元数据不匹配是 HybridCLR 的头号事故，
编译期没征兆、运行期才炸。**

详见手册的「代码热更怎么放」一节。

### 4. 开箱即用的场景方案

内置 17 个方案，一键切换：`理想网络`、`4G 一般`、`3G 弱网`、`极端弱网`、
`丢包 20%`、`服务器宕机`、`资产下载中途断流`、`资产内容损坏`、
`前两次失败后成功`、`弱网 + 断流（组合）`、`慢响应后断流（复合）` 等。

```bash
# 一键切到"资产下到一半断流"
curl -X POST http://localhost:5500/api/presets/abort-download/apply

# 急停：关掉全部模拟
curl -X POST http://localhost:5500/api/control/disable
```

### 4. 可观测

所有请求都被记录，并且会标注**这次被模拟器做了什么手脚**。
支持 SSE 实时日志流和统计汇总（延迟分位、状态码分布、时间线）。

---

## 一个重要的设计约定

**控制类接口不受模拟影响。**

`/api/control`、`/api/logs`、`/api/presets`、`/api/favorites`、`/api/stats`、
`/api/system` 都挂在模拟器中间件**之前**。所以哪怕你把延迟调到 30 秒、
或者把服务设成断网，控制面板依然能连上——否则你一旦调错参数就再也调不回来了。

受影响的只有给客户端用的 `/api/version`、`/api/manifest`、`/api/check`
和 `/assets/*`。这个分界在 `backend/app.js` 里有注释说明，改中间件顺序时请注意。

---

## 目录结构

```
backend/
  app.js                  装配文件，只做接线
  server.js               进程入口
  config.json             唯一的配置文件（改完立即生效，不用重启）
  core/configManager.js   配置读写、校验、深合并
  modules/
    networkSimulator.js   延迟 / 抖动 / 限速 / 丢包 / 断网
    faultInjector.js      500 / 超时 / 断流 / 截断 / 损坏 / 空响应
    assetServer.js        资产分发（Range 续传、ETag、md5 清单）
    logger.js             内存日志环形缓冲
  middleware/
    requestPipeline.js    组合上面两个模拟器
    loggerMiddleware.js   记录请求的最终结果
  routes/                 26 个接口，Swagger 注解写在文件里
  public/manual.zh-CN.md  使用手册·中文（含 Unity C# 接入示例）
  public/manual.en.md     使用手册·英文
storage/                  运行时数据，已 gitignore
  assets/{平台}/...       热更包放这里，不用手写清单
frontend/                 Vite + Bootstrap 面板（原生 JS，无框架）
  src/
    api.js                接口封装
    store.js              应用状态与订阅
    locales/              中英文语言包
    ui/                   DOM 工具、提示条、侧边栏
    views/                7 个页面，各自 mount/unmount
scripts/
  make-sample-assets.js   生成示例热更包
  smoke-test.js           后端端到端测试
  ui-check.js             无头浏览器界面测试
```

### 一个容易踩的坑：`/assets` 前缀

后端的 `/assets` 是**热更资产下载路由**，所以前端构建产物**不能**放在
`dist/assets/`（那是 Vite 的默认值）。两者一撞，浏览器请求
`/assets/index-xxx.js` 会被热更处理器当成"平台名 = index-xxx.js"，返回 400，页面白屏。

因此 `frontend/vite.config.js` 里把 `build.assetsDir` 改成了 `web`。
这个配置别改回去。

### 热更包怎么放

按平台建目录，直接把文件丢进去就行，**服务器会自动扫描并算好 md5 和版本号**：

```
storage/assets/
  Android/
    manifest.json        ← 可选，用来声明 version/minVersion/forceUpdate
    bundles/role.ab
  iOS/
    bundles/...
```

---

## 技术栈

后端 Express 5 + swagger-jsdoc（注解式 OpenAPI），前端 Vite + Bootstrap 5 + Chart.js。
数据用 JSON 文件持久化（`storage/`），不引入数据库——这是个调试工具，
一个能直接打开看的文件比一个要装要备份的数据库合适。

## 已知限制

- 限速不处理背压：用极低带宽下载超大文件时，上游会把数据先读进内存排队。
  作为模拟器可以接受，但支撑上 GB 的测试包时需要改成按需暂停数据源。
  （见 `backend/modules/networkSimulator.js` 的 `throttle()`）
- 日志只在内存里留最近 N 条（默认 2000），没有落盘。
- 灰度发布只支持按 deviceId 哈希取模，没有更细的分组规则。
