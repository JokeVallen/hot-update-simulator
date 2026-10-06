// backend/core/protocol.js
//
// 热更协议的版本与能力声明。
//
// 为什么需要它：
//   客户端是使用方自己写的 Unity 代码，而服务端会持续演进。没有版本协商时，
//   服务端加个字段、改个语义，老客户端**不会报错**，只会静默误判 ——
//   而"静默误判"恰恰是这个模拟器最该帮人发现的东西。
//
// 用法上的约定（写进手册）：
//   客户端启动时先看 `protocolVersion`：
//     * 比自己支持的**大** → 服务端有它不认识的能力，遇到不认识的字段要忽略而不是崩
//     * 比自己支持的**小** → 服务端不支持它依赖的能力，走降级分支
//   `capabilities` 是细粒度声明，让客户端能按能力而不是按版本号分支 ——
//   版本号只能表达"新旧"，能力位能表达"支不支持这一件事"。
//
// 改协议时的规矩：
//   * 加字段、加可选参数 → 不改 PROTOCOL_VERSION（向后兼容）
//   * 改已有字段的语义、改必填项 → PROTOCOL_VERSION 加一，并在 CHANGELOG 里写明
//     "哪个版本起语义变了"，否则老客户端升级后会踩坑

/** 协议版本。只在**破坏性**变更时递增。 */
const PROTOCOL_VERSION = 1;

/**
 * 能力位。每一项都对应一段可观察的行为，客户端据此决定走哪条分支。
 * 名字用 camelCase，和 JSON 字段风格一致。
 */
const CAPABILITIES = [
  // 代码热更轨道：/api/version 返回 code 块，/api/manifest?track=code 可取代码清单
  'codeTrack',
  // 资产支持 Range 断点续传（206 / Content-Range / 416）
  'rangeResume',
  // 条件请求缓存（ETag / If-None-Match → 304）
  'conditionalCache',
  // ETag 与清单里的内容 hash 是**同一个值**，客户端可据此本地决策、免掉一次请求
  'hashMatchesEtag',
  // 清单可固定版本：?expectVersion= / ?expectId= 不匹配时返回 409，用于消除竞态
  'manifestPinning',
  // 灰度支持 deviceId 百分比（后续版本会扩展为规则列表）
  'grayByDeviceId',
  // 清单条目同时给出算法名与多算法摘要
  'multiAlgorithmHash',
  // JSON 响应支持 gzip
  'gzip',
];

/**
 * 协议元信息。会被放进 /api/version、/api/manifest、/api/check 的响应里，
 * 也由 GET /api/protocol 单独提供（客户端还不知道 platform 时就能问）。
 *
 * @param {object} [extra] 额外合并进去的字段（如本次支持的 hash 算法列表）
 */
function protocolMeta(extra = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: CAPABILITIES.slice(),
    ...extra,
  };
}

/**
 * 客户端报了自己的协议版本时，给一句结论。
 *
 * 服务端**无法**用老格式回应（它只会说自己这套），所以这里的价值是
 * 让客户端知道"该不该相信我接下来发的东西"，而不是让服务端去适配。
 *
 * @param {*} clientVersion 客户端通过 ?protocol= 声明的版本
 * @returns {{clientProtocol:number, protocolCompatible:boolean, protocolNotice?:string}}
 */
function negotiate(clientVersion) {
  const n = Number(clientVersion);
  if (!clientVersion || !Number.isFinite(n) || n <= 0) return {};
  if (n === PROTOCOL_VERSION) {
    return { clientProtocol: n, protocolCompatible: true };
  }
  if (n < PROTOCOL_VERSION) {
    return {
      clientProtocol: n,
      protocolCompatible: true,
      protocolNotice: `服务端协议版本是 ${PROTOCOL_VERSION}，比你声明的 ${n} 新；`
        + '调用前请只使用 capabilities 里列出的能力，不认识的响应字段请忽略。',
    };
  }
  // 客户端比服务端新：服务端没法降级，只能如实告知
  return {
    clientProtocol: n,
    protocolCompatible: false,
    protocolNotice: `客户端声明协议 ${n}，服务端只到 ${PROTOCOL_VERSION}；`
      + '服务端无法用更新的格式回应，请客户端按 capabilities 降级。',
  };
}

module.exports = {
  PROTOCOL_VERSION,
  CAPABILITIES,
  protocolMeta,
  negotiate,
};
