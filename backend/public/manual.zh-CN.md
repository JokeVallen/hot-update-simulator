# 热更新模拟器 · 使用手册

一个用来模拟**真实游戏热更新服务端**的调试工具。目的不是"提供热更功能"，而是
**把热更客户端会遇到的各种恶劣情况复现出来**，让 U3D 端的下载、校验、重试、续传
逻辑在进真机测试之前就被打够。

---

## 快速开始

```bash
npm install                 # 安装后端依赖
npm run sample              # 生成一批示例热更包（几个 MB 的假 AssetBundle）
npm start                   # 启动，默认 http://localhost:5500
```

前端界面：

```bash
# 开发模式（热更新，端口 5173，代理到 5500）
cd frontend && npm run dev

# 或者构建成静态文件，由后端直接托管
npm run build && npm start
```

打开：

| 地址 | 说明 |
|---|---|
| `/` | 前端面板 |
| `/docs` | Swagger 接口文档，可以直接在页面上试调 |
| `/manual` | 本手册（面板里渲染好的，带目录） |
| `/api/system` | 确认当前用的是哪份配置、资产目录指到哪了 |

关于本手册的两个入口，别搞混：

- **`/manual`** —— 渲染好的页面，给人读的。
- **`/manual.md`** —— markdown 源文件本身。用 `curl`、编辑器打开、或者想复制原文时用它。
  在浏览器地址栏直接打开 `/manual.md` 会被自动转到 `/manual`（因为浏览器对
  `text/markdown` 只会当纯文本显示）；想强制看源文件就加 `?raw=1`。

手册按语言分成独立文件，和 `frontend/src/locales/` 的结构一致，用 `?lang=` 选：

| 文件 | 语言 |
|---|---|
| `backend/public/manual.zh-CN.md` | 中文（本文件） |
| `backend/public/manual.en.md` | 英文 |

例如 `curl "http://localhost:5500/manual.md?lang=en"` 拿到英文源文件。
不带 `?lang=` 时默认中文。改完刷新页面即可，不需要重启。

面板里的手册会**跟着界面语言自动切换**。如果你加了一种新语言，
记得同时补上对应的手册文件和 `backend/app.js` 里的 `MANUAL_FILES` 白名单
（那个映射是白名单，不是拼接路径——用它拼路径会变成任意文件读取）。

---

## 面板怎么用

打开 `http://localhost:5500/`（需要先 `npm run build`）后，左侧有 9 项——8 个页面，外加一个新标签页打开的 API 文档：

| 页面 | 什么时候用 |
|---|---|
| **总览** | 先看这里。除了请求量和延迟分位，重点是「模拟干预」那一栏——它告诉你**有多少请求是被模拟器动过手脚的**。否则看到 P95 十秒，你会以为是后端性能问题，其实是自己把延迟调上去了 |
| **网络模拟** | 调延迟/抖动/带宽/丢包/断网。改动立即生效，不用点保存 |
| **故障注入** | 加规则。右侧列出了 8 种故障类型各自在测客户端的哪个能力，不用去猜该选哪个 |
| **预置方案** | 最常用。17 个场景一键切换，绝大多数时候不用手工调参数 |
| **实时日志** | 每条请求都标出被做了什么：`abort`、`+300ms`、`100Kbps`、`Range`… 被掐断的请求状态列显示「断连」 |
| **接口调试** | 现场验证：调一次 `/api/version`，看耗时是不是真的变了 |
| **收藏** | 存下常用请求反复重放。重放由服务器发起，会完整经过模拟器 |
| **使用手册** | 就是本文件，渲染在面板内并带目录 |
| **API 文档** | 侧栏项，新标签页打开 Swagger UI |

### 顶栏

- **状态灯**反映的是**客户端视角**。打开断网后它会变成红色「连接中断」——这是对的，
  说明模拟真的在生效。而控制面板本身依然可用，所以你永远能把参数调回来。
- **急停**按钮：一键关掉全部网络模拟和故障注入。调错参数时的救命按钮。

### 一个容易踩的坑

`/assets` 是热更资产下载路由，所以前端构建产物不能放在 `dist/assets/`。
`frontend/vite.config.js` 里已经用 `build.assetsDir: 'web'` 避开了，别改回去。

---

## 目录结构

```
backend/
  app.js                  装配文件，只做接线
  server.js               进程入口
  config.json             可持久化的配置（模拟参数都在这）
  core/configManager.js   配置读写与校验
  modules/
    networkSimulator.js   延迟 / 抖动 / 限速 / 丢包 / 断网
    faultInjector.js      500 / 超时 / 断流 / 截断 / 损坏 / 空响应
    assetServer.js        资产分发（Range 续传、ETag、md5 清单）
    logger.js             内存日志环形缓冲
  middleware/
    requestPipeline.js    把上面两个模拟器串起来施加到请求上
    loggerMiddleware.js   记录每个请求的最终结果
  routes/                 各个接口
  public/manual.zh-CN.md  本文件（中文手册）
storage/                  运行时数据（已 gitignore）
  assets/{平台}/...       热更包放这里
    dll/                  代码热更（可选，见「代码热更怎么放」）
    bundles/              资源热更
  presets.json            自定义预置方案
  favorites.json          收藏的请求
frontend/                 Vite + Bootstrap 面板（原生 JS，无框架）
  src/api.js              接口封装
  src/store.js            应用状态与订阅
  src/locales/            中英文语言包
  src/ui/                 DOM 工具、提示条、侧边栏
  src/views/              8 个页面，各自 mount/unmount
dist/                     前端构建产物（已 gitignore）
scripts/                  示例资产生成、后端与前端测试
```

### 热更包怎么放

直接按平台建目录丢进去就行，**不需要手写清单**：

```
storage/assets/
  Android/
    manifest.json        ← 可选
    bundles/
      role.ab
      scene_01.ab
  iOS/
    bundles/...
```

- 没有 `manifest.json`：服务器自动扫描目录，算好每个文件的大小和 md5，
  并用内容推导出一个稳定的版本号（内容不变版本号就不变）。
- 有 `manifest.json`：用它声明版本等元信息。

```jsonc
// storage/assets/Android/manifest.json
{
  "version": "1.2.0",        // 客户端据此判断要不要更新
  "minVersion": "1.0.0",     // 低于这个版本强制更新
  "forceUpdate": false,
  "notice": "本次更新修复了登录闪退",
  "channel": "default"
  // 也可以额外提供 "files": [...] 完全自己控制清单，
  // 此时不再扫描目录
}
```

---

## 代码热更怎么放

热更其实是**两条独立的轨道**。成熟管线（YooAsset、Addressables、HybridCLR 的
DLL 集）都是分开版本、分开下发的：

| | 资源轨道 | 代码轨道 |
|---|---|---|
| 装什么 | AssetBundle、贴图、配置 | 程序集 `.dll`（HybridCLR / ILRuntime）、`.lua`、`.js` |
| 版本字段 | `version` | `code.version` |
| 多久变一次 | 每次改内容都变 | 可能一周才动一次 |
| 失败了怎么办 | 可以降级、可以少个贴图 | 往往必须成功，否则可能进不去游戏 |
| 兼容性 | 基本只要格式对 | **必须和主包的 AOT 元数据匹配** |

模拟器两条轨道都支持，而且**版本号是分开的**。在 `manifest.json` 里加一个 `code` 块：

```jsonc
// storage/assets/Android/manifest.json
{
  "version": "1.5.0",            // 资源版本
  "code": {
    "version": "2.1.0",          // 代码版本，独立于上面那个
    "minAppVersion": "1.2.0",    // 主包低于这个版本就不能热更代码
    "aotHash": "aot-abc123",     // 期望的 AOT 元数据指纹
    "forceUpdate": false,
    "notice": "修复了技能伤害计算错误",
    "dir": "dll"                 // 代码文件所在目录，默认就是 dll
  }
}
```

目录这样放：

```
storage/assets/Android/
  manifest.json
  dll/
    Assembly-CSharp.dll.bytes    ← 代码轨道
    GameLogic.dll.bytes
  bundles/
    role.ab                      ← 资源轨道
```

**`dll/` 下的文件不会出现在资源清单里**。两条轨道的清单是分开的，客户端用
`?track=code` 单独取代码清单。混在一起的话同一份 dll 会被下两次，而且客户端
没法区分"资源更新"和"代码更新"——而这两者的失败处理策略完全不同。

### 关于 AOT 兼容性

这是 HybridCLR 时代最容易出、也最难查的事故：热更 DLL 引用了主包**没有做 AOT
泛型生成**的类型。编译期毫无征兆，运行期才炸，而且报错信息离根因很远。

所以真实管线都会声明"这份代码更新要求主包 >= X"。客户端把已装主包的版本和
AOT 指纹一起提交，服务器告诉它能不能用：

```bash
curl "http://localhost:5500/api/version?platform=Android&current=1.5.0&codeCurrent=2.1.0&appVersion=1.0.0&aotHash=aot-abc123"
```

```jsonc
{
  "version": "1.5.0",
  "needUpdate": false,
  "code": {
    "version": "2.1.0",
    "needUpdate": true,
    "minAppVersion": "1.2.0",
    "compatible": false,        // 主包 1.0.0 < 1.2.0
    "requiresAppUpdate": true,  // 光靠热更换不上去，必须先升级主包
    "aotHash": "aot-abc123",
    "aotMatch": true,
    "fileCount": 2,
    "manifestUrl": "/api/manifest?platform=Android&track=code"
  }
}
```

⚠️ `compatible` 和 `aotMatch` 在**没提供判断依据**时是 `null`，**不是 `true`**。
"没检查"和"检查通过"是两件不同的事——客户端必须能区分，否则一个没传
`appVersion` 的旧客户端会被误告知"兼容"，然后更到一份会崩的代码。

这两个字段就是用来测客户端门禁逻辑的：把 `minAppVersion` 调高、或者改掉
`aotHash`，看客户端会不会真的挡住，而不是闭着眼睛更下去。

### 只对代码下载注入故障

用 `pathGlob` 就能把故障限定在代码轨道上：

```jsonc
{ "match": { "pathGlob": "/assets/**/dll/**" },
  "action": { "type": "abort", "ratio": 0.5 } }
```

这样能测"资源全下完了，代码包下到一半断了"。**代码不全可能让游戏直接进不去，
资源不全可能只是少个贴图**——两者的处理方式完全不同，值得单独测。

### 这一块没有建模的部分

说白了这是**协议层**的支持，不是一个完整的代码热更框架：

- **不发差量包**：只发整文件。Lua 项目按文件增量更新没问题，
  整包 DLL 的差量下发做不了。
- **没有文件依赖顺序**：清单是平铺的，没有"必须先下 A 再下 B"。
- **没有代码专属校验**：Lua 字节码版本、DLL 架构不匹配之类，服务器不认。
- **没有差量包**：见上。

渠道**已经真正影响内容**了（协议 2 起），做法见前面的「渠道真正影响内容」一节。

---

## 协议版本与能力协商

客户端是你自己写的 Unity 代码，而服务端会持续演进。没有版本协商时，服务端加个字段、
改个语义，老客户端**不会报错**，只会静默误判——而"静默误判"恰恰是这个模拟器
最该帮你发现的东西。

所以每个热更接口的响应里都带：

```jsonc
{
  "protocolVersion": 1,
  "capabilities": [
    "codeTrack",          // 支持代码热更轨道
    "rangeResume",        // 资产支持 Range 断点续传
    "conditionalCache",   // 支持 ETag 条件请求（304）
    "hashMatchesEtag",    // ETag 与清单 hash 是同一个值（见下）
    "manifestPinning",    // 清单可固定版本，用于消除竞态
    "grayByDeviceId",     // 灰度支持 deviceId 百分比
    "multiAlgorithmHash", // 清单同时给出算法名与多算法摘要
    "gzip"                // JSON 响应可能被 gzip
  ]
}
```

`GET /api/protocol` 不需要任何参数，客户端在还不知道平台时就能先问一次。

### 客户端应该怎么做

```csharp
// 1. 启动时问一次协议
var probe = await GetJson($"{BaseUrl}/api/protocol");
int proto = probe.protocolVersion;
bool hasCode = probe.capabilities.Contains("codeTrack");

// 2. 按**能力**分支，而不是按版本号
//    版本号只能表达"新旧"，能力位能表达"支不支持这一件事"
if (!hasCode) { /* 走不含代码热更的降级分支 */ }
```

服务端也能接收客户端声明的版本：`?protocol=2`。如果客户端比服务端新，
响应里会带 `protocolCompatible: false` 和一句 `protocolNotice`——**服务端没法
用更新格式回应**（它只会说自己这套），这个字段的价值是让客户端知道
"该不该相信我接下来发的东西"。

### ETag 就是内容 hash

资产的响应头 `ETag` **就是清单里那个 hash**：

```
清单里：  "hash": "58435bb4…"
响应头：  ETag: "58435bb4…"
```

这不是巧合，是刻意的。**好处是客户端可以完全免掉一次请求**：

```
客户端已有文件 X，本地记录的 hash 是 H
新清单说 X 的 hash 还是 H
→ 直接跳过下载，一个请求都不用发
```

如果 ETag 是另一套东西（比如"大小 + 修改时间"），客户端手里明明有 hash，
却还得再发一次条件请求去问"服务器上那份还是我这份吗"。

想用条件请求也可以——拿清单里的 hash 当 `If-None-Match` 发过去，没变就是 `304`。

摘要算法可以在 `hotUpdate.hashAlgorithms` 里配（默认 `md5`）：

```jsonc
{ "hotUpdate": { "hashAlgorithms": ["md5"] } }
```

配多个（如 `["sha256","md5"]`）时，**第一个是主算法**——清单的 `hash` 字段和
ETag 都用它；`hashes` 里会给出全部算法的摘要。多算一个摘要不会增加 I/O，
文件只读一遍。清单条目里同时给出 `hashAlgo` 说明 `hash` 用的是什么。

### 清单身份：消除竞态

热更的典型流程是**两步**：

```
1. GET /api/version    → 得知要更新到 1.2.0
2. GET /api/manifest   → 取文件列表
```

如果这两步之间有人在面板上换了配置（或者你刚好在改 `manifest.json`），
客户端会拿到 **1.3.0 的文件列表**，却以为自己在做 1.2.0 的更新——
下到一半发现对不上，而且**不报错**。

在真实项目里这个竞态很难触发，**在这里却很容易**——你就是在不停地改配置。

所以清单带一个 `manifestId`（内容变了它就变，内容不变它稳定），
客户端在第 2 步把它带回来：

```bash
# 推荐：精确匹配
curl "http://localhost:5500/api/manifest?platform=Android&expectId=8b030cd618bf7f9d"

# 或者只比版本号，客户端实现更简单
curl "http://localhost:5500/api/manifest?platform=Android&expectVersion=1.2.0"
```

对不上就返回 **409**，并在响应里带上当前的真实身份，客户端直接重来即可。
这比"下完发现不对"便宜得多。

> 更省事的做法：直接用 `GET /api/check`——它**一次返回版本判断和清单**，
> 结构上就不存在这个竞态。

### 渠道真正影响内容

`channel` 现在**决定服务端读哪个目录**，不只是被回显。

平台目录下以配置里的渠道名命名的子目录，就是那个渠道的内容：

```
storage/assets/Android/
  default/                 ← 渠道名来自 hotUpdate.channels
    manifest.json
    bundles/role.ab
  beta/
    manifest.json
    bundles/role.ab        ← 可以和 default 完全不同
```

请求时带上渠道，URL 里也会带上渠道那一段：

```bash
curl "http://localhost:5500/api/version?platform=Android&channel=beta"
# 清单里的 url 变成 /assets/Android/beta/bundles/role.ab
```

**旧布局一行都不用改**。判据是"平台目录下有没有以渠道名命名的子目录"：

| 布局 | 例子 | 行为 |
|---|---|---|
| **平铺**（旧） | `Android/bundles/role.ab` | 整个平台目录就是默认渠道，URL 不带渠道段 |
| **分渠道**（新） | `Android/default/bundles/role.ab` | 按渠道解析，URL 带渠道段 |

`bundles/`、`dll/` 这些目录**不会被误认成渠道**——只有出现在
`hotUpdate.channels` 配置里的名字才算。所以想用多渠渠道时，
建一个 `beta/` 目录并在配置里声明即可。

渠道拼错会返回 **404** 并列出可用渠道，**不会静默退回默认渠道**——
"beta 用户拿到了正式内容"这种事，不报错的话根本查不出来。

`GET /api/platforms` 会列出每个平台实际有内容的渠道，以及配置里声明了哪些名字。

---

## 两种"坏"的分工

这个分法很重要，调参时别搞混：

| | 模拟什么 | 表现 |
|---|---|---|
| **networkSimulator** | 链路质量差 | 慢、抖、断。客户端看到的是**网络问题** |
| **faultInjector** | 服务器或文件有问题 | 500、超时、内容损坏。客户端看到的是**服务端问题** |

两者可以叠加。"3G 弱网 + 资产下到一半断流"就是真实外网最常见的样子，
预置方案里的 `弱网 + 断流（组合）` 就是这个。

### 故障类型一览

| type | 客户端会看到什么 | 用来测 |
|---|---|---|
| `status` | HTTP 500 / 404 / 403 | 错误提示、降级逻辑 |
| `timeout` | 一直没响应，直到自己超时 | 超时时间设置是否合理 |
| `slowHeader` | 响应头很慢才回来 | 连接超时与读取超时是否分开配置 |
| `abort` | 下载到一半连接被重置 | 断点续传（Range） |
| `truncate` | 长度声明完整但提前结束 | 内容长度校验 |
| `corrupt` | **下载成功但内容是坏的** | md5 校验是不是真做了 |
| `slowThenAbort` | 先卡很久，然后下载到一半又断 | "超时重试后又断"这条完整链路 |
| `empty` | 200 但响应体为空 | 空文件/空清单不能崩 |

`corrupt` 是最容易被忽略的一个：不校验 hash 的客户端会一路"成功"，
然后在解包或运行时才炸，排查成本极高。建议早点用它测一遍。

`slowThenAbort` 是唯一的**复合类型**。单条规则只能表达一个动作，而线上最常见的
失败链路是两段的：客户端等太久 → 触发超时重试 → 重试时又在传输中途断掉。
它同时用 `delayMs` 和 `ratio` 两个字段，一次把这两段都复现出来。
其余组合（比如"先损坏再截断"）目前不支持——那需要把故障拆成可编排的原子链，
代价远大于收益，而且会引入"配得出来但语义无效"的组合（详见项目里的讨论记录）。

### maxHits：做"前 N 次失败"

规则里的 `maxHits` 用来构造失败序列，专治重试逻辑：

```jsonc
{
  "name": "版本接口前两次 500",
  "maxHits": 2,              // 只失败 2 次，第 3 次就成功
  "match": { "pathPrefix": "/api/version" },
  "action": { "type": "status", "status": 500 }
}
```

配合 `POST /api/control/fault/reset-counters` 可以把计数清零再跑一遍。
预置方案 `前两次失败后成功` 就是这个场景。

### 规则的匹配字段

| 字段 | 说明 |
|---|---|
| `method` | 请求方法，留空不限 |
| `pathPrefix` | 路径前缀，留空不限 |
| `pathGlob` | 路径通配，留空不限 |
| `platform` | 按 `/assets/{平台}/` 的第一段判断 |

`pathGlob` 支持三种通配符：`*` 匹配单层内的任意字符、`**` 跨目录、
`?` 匹配单个字符。例如 `/assets/**/*.ab`、`/api/version`。

> **为什么是通配而不是正则**：正则表达式会被应用到**每一个**请求上，
> 而灾难性回溯的模式（比如 `(a|a)*$`）能让单线程的 Node 挂死几十秒，
> 期间所有连接——包括控制面板——一起卡住，只能重启进程。
> 实测连成熟的静态检测器 `safe-regex2` 也拦不住这一类模式。
> 通配符编译出来的匹配是线性时间的，代价可控。

### 规则的动作字段

| 字段 | 适用的 type | 说明 |
|---|---|---|
| `type` | 全部 | 故障类型，取值见上表 |
| `status` | `status` | 返回的状态码，100~599 |
| `body` | `status` | 自定义响应体；留空则用一句默认提示文本 |
| `ratio` | `abort` `truncate` `corrupt` `slowThenAbort` | 作用在多大比例的数据上，0.01~1 |
| `delayMs` | `slowHeader` `slowThenAbort` | 响应头延迟多久才返回，不填默认 3000 毫秒 |

`ratio` 是最不直观的一个，它决定"坏在多深"。以 `ratio: 0.5` 为例：

| 类型 | 实际效果 |
|---|---|
| `abort` | 数据发到一半就掐断连接，客户端只能重下或从断点续传 |
| `truncate` | 只发一半就正常结束，但 `Content-Length` 声明的仍是完整长度 |
| `corrupt` | 长度完全不变，把中间一半的字节改坏（只有校验才能发现） |
| `slowThenAbort` | 先按 `delayMs` 卡住，再按 `abort` 的方式断在一半 |

不属于当前 `type` 的字段会被**忽略**：后端按类型只取相关字段，
面板里的规则编辑器也会把无关字段一并隐藏并禁用，避免"看不见的值被提交上去"。

### 多条规则谁生效

**列表里最靠前的、符合条件的规则说了算。**

- 未启用、不匹配、`maxHits` 已用完的规则会被跳过，继续看下一条；
- 第一条"合格"的规则掷一次 `probability` 骰子：命中就注入它，
  **没命中就这次什么都不注入**（不会再往下找）。

第二条很关键：如果掷输了继续往下找，N 条各 50% 的规则实际命中率会变成
`1-(1-0.5)^N`（两条就有 75%），`probability` 就完全不是它字面上的意思了。

---

## 安全边界（重要）

这是一个本机开发工具，**控制类接口没有任何认证**，而它们能读写模拟参数、
注入故障规则、读取全部请求日志。所以：

- **默认只监听 `127.0.0.1`**。确实要给手机/真机联调时，
  把 `backend/config.json` 的 `server.host` 改成 `0.0.0.0`，
  并清楚这意味着**同局域网内任何一台机器**都能操作它。
- **跨站请求会被拒绝**。带非本机 `Origin` 的状态变更请求（POST/PATCH/…）
  直接返回 403，跨站页面也拿不到响应内容。否则任何网页只要在用户浏览器里
  跑起来，就能读到你的全部请求日志。
- **回放不能指向控制类接口**，也不能重放重放接口自己 —— 后者会在几秒内
  自我放大到上万个内联请求，把临时端口耗尽。
- 出错的响应不再回传 `err.message`（那里面会带磁盘绝对路径），
  详细信息只进日志。

---

## 客户端接入（Unity C# 示例）

核心就是三个接口，和真实热更服务端一模一样：

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

[Serializable]
public class VersionInfo
{
    public string platform;
    public string version;
    public string currentVersion;
    public bool needUpdate;
    public bool forceUpdate;
    public string notice;
    public int fileCount;
    public long totalSize;
    public string manifestUrl;
}

public class HotUpdateClient : MonoBehaviour
{
    // 注意：端口要和 backend/config.json 里的 server.port 一致
    const string BaseUrl = "http://127.0.0.1:5500";
    const string Platform = "Android";

    /// <summary>第一步：问服务器要不要更新。</summary>
    public IEnumerator CheckVersion(string currentVersion, Action<VersionInfo> onDone)
    {
        string url = $"{BaseUrl}/api/version?platform={Platform}" +
                     $"&current={UnityWebRequest.EscapeURL(currentVersion)}" +
                     $"&deviceId={SystemInfo.deviceUniqueIdentifier}";

        using (var req = UnityWebRequest.Get(url))
        {
            // 超时必须设，否则命中 timeout 故障时会永远挂住
            req.timeout = 10;
            yield return req.SendWebRequest();

            if (req.result != UnityWebRequest.Result.Success)
            {
                // 这里同时覆盖了：服务器 500、超时、连接被重置（断网/丢包）
                Debug.LogError($"版本查询失败: {req.error} / {req.responseCode}");
                onDone(null);
                yield break;
            }

            var info = JsonUtility.FromJson<VersionInfo>(req.downloadHandler.text);
            onDone(info);
        }
    }

    /// <summary>
    /// 第二步：下载文件，支持断点续传。
    /// 断点续传是必须的——预置方案里的 abort 就是专门打这个的。
    /// </summary>
    public IEnumerator DownloadAsset(string relativePath, string savePath, Action<bool> onDone)
    {
        string url = $"{BaseUrl}/assets/{Platform}/{relativePath}";

        long existing = 0;
        if (System.IO.File.Exists(savePath))
            existing = new System.IO.FileInfo(savePath).Length;

        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = 30;
            if (existing > 0)
            {
                // Range 头是关键：有了它中断后才能接着下
                req.SetRequestHeader("Range", $"bytes={existing}-");
            }

            yield return req.SendWebRequest();

            if (req.responseCode == 416)
            {
                // 服务器说范围不满足，通常说明本地文件已经比服务器上的还完整
                Debug.LogWarning("本地文件已完整或与服务器不一致，删除后重下");
                onDone(false);
                yield break;
            }

            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"下载中断（第 {existing} 字节处）: {req.error}");
                onDone(false);   // 调用方应该重试，而不是直接失败
                yield break;
            }

            byte[] data = req.downloadHandler.data;
            // 206 表示是续传，要把新数据接在已有内容后面
            bool isPartial = req.responseCode == 206;
            using (var fs = new System.IO.FileStream(
                savePath, isPartial ? System.IO.FileMode.Append : System.IO.FileMode.Create))
            {
                fs.Write(data, 0, data.Length);
            }
            onDone(true);
        }
    }
}
```

### 三个必须做对的地方

1. **一定要设 `timeout`**。命中 `timeout` 故障时，没设超时的客户端会永远卡住。
2. **一定要带 `Range` 头做续传**。用预置方案 `资产下载中途断流` 验证：
   断掉之后重新调用，应该从断点继续，而不是从头开始。
3. **一定要校验 md5**。用预置方案 `资产内容损坏` 验证：
   `corrupt` 返回的文件长度完全正确，只有校验才能发现内容被改坏了。
   清单接口（`/api/manifest`）已经提供了每个文件的 `hash`。

---

## 常用接口

### 给客户端用（受网络模拟影响）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/protocol` | 协议版本与能力声明。不需要参数，客户端启动时先问这个 |
| GET | `/api/version` | 查版本、判断是否要更新。参数 `platform`、`current`、`channel`、`deviceId`，代码热更再加 `codeCurrent`、`appVersion`、`aotHash` |
| GET | `/api/manifest` | 拿完整文件清单（路径/大小/md5/下载地址）。`?track=code` 取代码轨道；`?expectId=` / `?expectVersion=` 固定版本，对不上返回 409 |
| GET | `/api/check` | 一步拿到上面两个结果，省一次往返 |
| GET | `/api/platforms` | 列出所有平台及其资源版本与代码版本 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/manifest/refresh` | 清清单缓存，让新传的包立刻生效 |
| GET | `/assets/{平台}/{路径}` | 下载资产，支持 Range 续传和 ETag 协商缓存 |

### 控制面板用（不受影响，随时可用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/control` | 当前模拟状态 |
| PATCH | `/api/control/network` | 改网络参数 |
| POST | `/api/control/network/reset` | 网络参数恢复默认 |
| PATCH | `/api/control/fault` | 故障注入总开关 |
| GET/POST | `/api/control/fault/rules` | 列出 / 新增故障规则 |
| PUT/DELETE | `/api/control/fault/rules/{id}` | 修改 / 删除规则 |
| POST | `/api/control/fault/reset-counters` | 清零规则的命中次数 |
| POST | `/api/control/disable` | **急停**：关掉全部模拟 |
| POST | `/api/control/reset` | 全部恢复默认 |
| GET/POST | `/api/presets` | 列出 / 新建预置方案 |
| POST | `/api/presets/{id}/apply` | 应用方案 |
| POST | `/api/presets/capture` | 把当前配置存成方案 |
| GET/POST/DELETE | `/api/favorites` | 收藏请求 |
| POST | `/api/favorites/{id}/replay` | 重放（会完整经过模拟器） |
| GET | `/api/logs` | 查日志 |
| GET | `/api/logs/stream` | 实时日志流（SSE） |
| DELETE | `/api/logs` | 清空日志 |
| GET | `/api/stats` | 统计汇总（延迟分位、状态码分布、时间线） |
| GET | `/api/system` | 运行时与路径信息 |

### 几个实用的快捷调用

```bash
# 一键切到"资产下到一半断流"
curl -X POST http://localhost:5500/api/presets/abort-download/apply

# 看看刚刚发生了什么（只看被模拟器干预过的请求）
curl "http://localhost:5500/api/logs?limit=20&onlySimulated=true"

# 急停（界面卡住时的救命按钮）
curl -X POST http://localhost:5500/api/control/disable

# 确认资产目录到底指到哪了
curl http://localhost:5500/api/system
```

---

## 配置说明

`backend/config.json` 是唯一需要改的文件，改完**立即生效，不用重启**。

```jsonc
{
  "server": {
    "port": 5500,              // 必须和 .env 的 VITE_API_BASE_URL 一致
    "assetDir": "assets",      // 相对「存储根」解析，见下面「运行时数据放哪」
    "enableBrowse": true,      // /browse 目录浏览
    "enableDocs": true         // /docs 接口文档
  },
  "network": {
    "enabled": false,          // 总开关
    "offline": false,          // 断网：直接掐连接（不是返回 503）
    "latencyMs": 0,            // 基础延迟
    "jitterMs": 0,             // 延迟抖动 ±N ms
    "bandwidthKbps": 0,        // 限速，千比特/秒；0 = 不限速
    "packetLossRate": 0        // 整包丢失概率 0~1
  },
  "fault": {
    "enabled": false,
    "rules": []                // 规则结构见 modules/faultInjector.js 顶部注释
  },
  "hotUpdate": {
    "defaultChannel": "default",
    "channels": ["default", "beta", "dev"],   // 渠道名。只有这里声明的名字才会被当成渠道目录
    "hashAlgorithms": ["md5"],   // 文件摘要算法，第一个是主算法（清单 hash 与 ETag 都用它）
    "gray": {
      "enabled": false,
      // 灰度规则。语义：**一条规则内是 AND，规则之间是 OR**
      "rules": [
        { "name": "内部白名单", "devices": ["dev-001", "dev-002"] },
        { "name": "beta 渠道全量", "channels": ["beta"] },
        { "name": "只给新主包", "minAppVersion": "1.5.0" },
        { "name": "随机 10%", "percent": 10 }
      ],
      "percent": 0                 // 兼容旧配置的简写；有 rules 时被忽略
    }
  },
  "logging": {
    "maxEntries": 2000         // 日志环形缓冲上限
  }
}
```

### 关于带宽单位

`bandwidthKbps` 用的是**千比特每秒**，和运营商口径一致：

| 设置值 | 相当于 | 下载 10MB 需要 |
|---|---|---|
| 20000 | 20 Mbps（WiFi） | 约 4 秒 |
| 2000 | 2 Mbps（4G） | 约 40 秒 |
| 400 | 400 Kbps（3G） | 约 200 秒 |
| 100 | 100 Kbps（极端弱网） | 约 13 分钟 |

---

## 运行时数据放哪（和开发项目隔离）

模拟器**不会往项目外写任何东西**，它的全部运行时数据只有两处：

| 内容 | 位置 | 进 git 吗 |
|---|---|---|
| 示例热更包、预置方案、收藏 | 存储根（默认 `<项目>/storage`） | 否，已 gitignore |
| 模拟参数、故障规则等配置 | `backend/config.json` | **是**，这是项目文件 |

资产目录对服务器是**只读**的——没有任何代码会往里写或删。
`npm run sample --clean` 也只删存储根下的 `assets/`，
**不可能碰到你 Unity 工程的构建产物**。

### 把数据挪到项目外面

**推荐写进 `.env`**（项目根目录）——不用记各家的 shell 语法，直接 `npm start` 就行：

```ini
# .env
HOT_UPDATE_STORAGE=D:\hus-data
```

> ⚠️ 路径用反斜杠或正斜杠都行，但**不要加引号**。目录不用自己建。

也可以在命令行临时指定，但**每个 shell 的写法不一样**，这是最容易踩的坑：

```bash
# Git Bash / WSL / macOS / Linux
HOT_UPDATE_STORAGE=D:/hus-data npm start
```

```bat
:: Windows cmd —— 注意不能写成 VAR=value 的形式，cmd 不认那种语法
set HOT_UPDATE_STORAGE=D:\hus-data && npm start
```

```powershell
# Windows PowerShell
$env:HOT_UPDATE_STORAGE='D:\hus-data'; npm start
```

三者等价。命令行设置**优先级高于 `.env`**，临时试一下很方便。

之后示例包、预置方案、收藏全都落在 `D:\hus-data`，项目目录里干干净净。
相对路径按**项目根**解析（不是当前工作目录，所以从 IDE 里启动也不会跑偏）。

`npm run sample` 和服务器读的是**同一个**存储根，不会各写各的。
装到哪儿可以用这条确认：

```bash
curl http://localhost:5500/api/system
# paths.storageRoot / paths.assetRoot / paths.storageRootOverridden
```

### 想直接测 Unity 构建出来的真实包

把 `assetDir` 写成**绝对路径**指向构建产物目录即可：

```jsonc
{ "server": { "assetDir": "D:\\MyUnityProject\\ServerData\\Android" } }
```

这样 Unity 一构建就能测，不用手动复制。注意服务器只读不写，
但你的真实热更包会通过 `http://127.0.0.1:5500/assets/...` 暴露出来——
默认只监听回环地址，所以仅限本机。

---

## 部署与多设备

### 让别的设备访问（手机 / 真机 / 另一台电脑）

默认只监听 `127.0.0.1`，别的设备连不上。要开放：

```bash
HOST=0.0.0.0 npm start
```

然后在别的设备上打开 `http://<本机IP>:5500`（Windows 用 `ipconfig` 看 IPv4 地址）。

> ⚠️ **控制接口没有认证**。绑 `0.0.0.0` 等于把模拟参数、故障规则、全部请求日志
> 开放给同一局域网里的任何一台机器。只在真机联调时开，用完改回来。
> 绑的不是回环地址时，启动日志里会有一条醒目警告。

两点说明：

- **Unity 客户端**走 `/api` 和 `/assets`，不带 `Origin` 头，一直没问题。
- **面板本身**在别的设备上也完全可用，包括急停、改参数这些写操作。
  跨站防护的判定基准是**同源**（Origin 与 Host 一致即放行），不是"是不是回环
  地址"——否则从 LAN 地址打开时，面板会被自己的防护静默变成只读的。

### 打包成使用版（和开发目录分开）

**仓库本身就是产品，没有单独的发行分支。** 但你不该把开发目录整个复制过去：
里面有 `node_modules`、示例包、构建产物，还有一份被使用过程改写过的
`backend/config.json`。

用这个打一个干净的包：

```bash
npm run release
# → release/hot-update-simulator-1.0.0.tgz
```

包里包含 git 跟踪的源码加构建好的 `dist/`，并且：

- **不含** `node_modules` / `storage` / 任何开发时的数据
- `backend/config.json` **被重置成默认值**——这是重点：那份文件既被 git 跟踪、
  又会被界面改写，开发时调出来的故障规则和模拟参数不加处理就会进到发行包里
- 附一份 `RELEASE.txt`，写明来自哪个提交、怎么用

在别处展开使用：

```bash
mkdir D:\hus-runtime
tar -xzf hot-update-simulator-1.0.0.tgz -C D:\hus-runtime --strip-components=1
cd D:\hus-runtime
npm install          # 只装后端依赖，前端已经构建好了
npm start
```

发行包默认没有示例资产，先跑一次 `npm run sample`，
或者用 `HOT_UPDATE_STORAGE` 指到一份已有的数据上。

脚本会拒绝在工作区不干净时打包——发行包必须能对应到某个确切的提交。
确实需要就加 `--force`，它会在 `RELEASE.txt` 里标注出来。

---

## 关于灰度发布

`hotUpdate.gray.enabled` 打开后，只有落在灰度百分比内的客户端才会看到新版本。
分组依据是客户端传的 `deviceId`（取 md5 后取模），**同一个设备每次结果都一样**——
灰度必须稳定，否则客户端会一会儿看到新版本、一会儿看到旧版本。

客户端不传 `deviceId` 时不拦截（否则等于把所有人都挡住）。

---

## 自检与测试

项目自带几套检查。改完代码跑一遍，比人肉翻要可靠得多：

```bash
npm run lint         # ESLint，含复杂度预算（complexity / max-depth / max-lines）
npm run arch         # 结构：循环依赖 / 分层方向 / 孤儿模块 / 规模分布
npm run smoke        # 后端端到端：74 项断言，每种故障都真的触发一遍
npm run regression   # 边界与回归：66 项断言，覆盖 chunked / 0 字节 / Range / 缓存 / 版本语义
npm run ui-check     # 前端界面：无头 Chrome 走完 8 个路由，并逐页扫描漏翻
npm run soak         # 稳定性：400 个混合请求，检查内存是否稳定、结束后是否仍可用
npm run docs-check   # 文档覆盖度：代码里的接口/配置/故障类型有没有漏写进本手册
npm run version-check # 版本一致性：版本号格式、两份 package.json、CHANGELOG 条目
npm run bump minor   # 升版本号（patch|minor|major 或具体版本号），并插入 CHANGELOG 小节
```

几点说明：

- `ui-check` 需要 Chrome 或 Edge，会在 `ui-check-shots/` 下给每个页面留一张截图。
- `smoke`、`regression`、`ui-check` 都会改动 `backend/config.json`，跑完自动还原。
  中途强杀进程可能留下脏配置，`git diff backend/config.json` 看一眼就知道。
- `docs-check` 会把代码里真实的接口、配置项、故障类型、面板页面和 npm 脚本抽出来
  逐项对照本手册。加了新功能却忘了写文档时，它会直接报出来。

---

## 排查问题

**接口都连不上？**
先 `curl http://localhost:5500/api/control/disable`。控制接口不受模拟影响，
这个调用一定能通。如果它也不通，那就是服务器真没起来。

**资源 404？**
`curl http://localhost:5500/api/system`，看 `paths.assetRoot` 和 `assetRootExists`。
多半是包没放到对的位置。

**改了配置没生效？**
改的是 `backend/config.json` 吗？`storage/` 下的文件是运行时数据，不是配置。
清单有 10 秒缓存，传了新包可以 `curl -X POST .../api/manifest/refresh` 立刻刷新。

**端口冲突？**
见启动时的提示。注意同时要改 `.env` 里的 `VITE_API_BASE_URL`，
否则前端代理会指向旧端口。
