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
| `/docs` | Swagger 接口文档，可以直接在页面上试调 |
| `/api/system` | 确认当前用的是哪份配置、资产目录指到哪了 |
| `/` | 前端面板（构建后才可用） |

---

## 面板怎么用

打开 `http://localhost:5500/`（需要先 `npm run build`）后，左侧有 7 个页面：

| 页面 | 什么时候用 |
|---|---|
| **总览** | 先看这里。除了请求量和延迟分位，重点是「模拟干预」那一栏——它告诉你**有多少请求是被模拟器动过手脚的**。否则看到 P95 十秒，你会以为是后端性能问题，其实是自己把延迟调上去了 |
| **网络模拟** | 调延迟/抖动/带宽/丢包/断网。改动立即生效，不用点保存 |
| **故障注入** | 加规则。右侧列出了 7 种故障类型各自在测客户端的哪个能力，不用去猜该选哪个 |
| **预置方案** | 最常用。16 个场景一键切换，绝大多数时候不用手工调参数 |
| **实时日志** | 每条请求都标出被做了什么：`abort`、`+300ms`、`100Kbps`、`Range`… 被掐断的请求状态列显示「断连」 |
| **接口调试** | 现场验证：调一次 `/api/version`，看耗时是不是真的变了 |
| **收藏** | 存下常用请求反复重放。重放由服务器发起，会完整经过模拟器 |

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
  public/manual.md        本文件
storage/                  运行时数据（已 gitignore）
  assets/{平台}/...       热更包放这里
  presets.json            自定义预置方案
  favorites.json          收藏的请求
frontend/                 Vite + Bootstrap 面板（原生 JS，无框架）
  src/api.js              接口封装
  src/store.js            应用状态与订阅
  src/locales/            中英文语言包
  src/ui/                 DOM 工具、提示条、侧边栏
  src/views/              7 个页面，各自 mount/unmount
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
| `empty` | 200 但响应体为空 | 空文件/空清单不能崩 |

`corrupt` 是最容易被忽略的一个：不校验 hash 的客户端会一路"成功"，
然后在解包或运行时才炸，排查成本极高。建议早点用它测一遍。

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
| GET | `/api/version` | 查版本、判断是否要更新。参数 `platform`、`current`、`channel`、`deviceId` |
| GET | `/api/manifest` | 拿完整文件清单（路径/大小/md5/下载地址） |
| GET | `/api/check` | 一步拿到上面两个结果，省一次往返 |
| GET | `/api/platforms` | 列出所有平台及其版本 |
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
    "assetDir": "../storage/assets",   // 相对 backend/ 目录
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
    "channels": ["default", "beta", "dev"],
    "gray": { "enabled": false, "percent": 0 }   // 灰度发布百分比
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

## 关于灰度发布

`hotUpdate.gray.enabled` 打开后，只有落在灰度百分比内的客户端才会看到新版本。
分组依据是客户端传的 `deviceId`（取 md5 后取模），**同一个设备每次结果都一样**——
灰度必须稳定，否则客户端会一会儿看到新版本、一会儿看到旧版本。

客户端不传 `deviceId` 时不拦截（否则等于把所有人都挡住）。

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
