# dsh-liveshare-relay

[中文](#dsh-liveshare-relay) | [English](#english)

**MIT** · Node 20+ · 仅依赖 `ws` · Docker 就绪 · 冒烟测试覆盖

为 DeepSeek Harness (DSH) 的实验性 **LiveShare 会话分享**功能提供的**社区自建中继服务器（Relay）**。官方只开源了 owner 端插件 `@deepseek-ai/dsh-experimental-liveshare`(0.2.2-rc.5) 与协议库 `@deepseek-ai/dsh-experimental-liveshare-protocol`(0.2.2-rc.5)，**服务端没有官方实现**；本仓库依据两份源码中的 wire 契约实现了一个内网/信任场景可用的 Relay。

> **English**: A community, self-hosted relay server for the experimental **LiveShare** session-sharing feature of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The official project ships the owner-side plugin and the wire protocol, but no server implementation — this repository fills that gap for LAN / trusted-network use. Aligned with owner/protocol packages **0.2.2-rc.5** (`protocolVersion = 1`). See the [English](#english) section below.

> ⚠️ **安全须知（务必先读）**
> - 身份是 **mock** 的，不是认证边界：`open` 分享"拿到链接即可观看"。只部署在你信任的网络（内网/VPN）。
> - **`run_code` 不受分享沙箱限制**（这是官方协议自身的边界）：被分享者可能经 `run_code` 读写共享工作区之外的文件。**只与信任的人分享。**
> - LiveShare 协议是 **experimental**：owner 插件、观看端与本中继三方版本必须一致（当前对齐 `0.2.2-rc.5`），官方升级可能破坏兼容。
> - 本项目为**非官方社区实现**，与 DeepSeek 官方无关。

## 快速开始

### Docker(推荐)

```bash
cd liveshare-relay
docker compose up -d --build
# 健康检查
curl http://127.0.0.1:8787/__liveshare/health
```

### 本地运行(Node 20+,仅依赖 `ws`)

```bash
cd liveshare-relay
npm install
node server.mjs
# [liveshare-relay] listening on http://0.0.0.0:8787
```

自带的端到端冒烟测试(先启动服务再执行,模拟 owner 登录、网关注册、观看页与 RPC 全链路):

```bash
node smoke-test.mjs            # 默认打 http://127.0.0.1:8787
node smoke-test.mjs http://其他地址:端口
```

环境变量(均可省略):

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVESHARE_RELAY_PORT`(或 `PORT`) | `8787` | 监听端口 |
| `LIVESHARE_RELAY_HOST` | `0.0.0.0` | 绑定地址 |
| `LIVESHARE_BASE_PATH` | 空 | 挂载子路径(如 `/liveshare`),需与反代路径一致 |
| `LIVESHARE_RELAY_STATE_FILE` | 空(纯内存) | 分享列表 JSON 持久化文件;同时保存 mock 凭证签名密钥,重启后 owner 已签发的凭证仍然有效 |
| `LIVESHARE_OWNER_CREDENTIAL_TTL_HOURS` | `24` | owner 凭证签发有效期 |

## owner 端地址填什么

在 DSH 分享面板的 LiveShare 服务器地址里填 **http(s) 基地址**(允许带子路径,不允许凭据/查询串),例如:

- 同机:`http://127.0.0.1:8787`
- 局域网:`http://192.168.1.10:8787`
- 反代子路径:`https://relay.example.com/liveshare`(同时设置 `LIVESHARE_BASE_PATH=/liveshare`)

地址规范化规则与 owner 端一致(`relay-url.ts normalizeRelayUrl`):仅 http/https、去 query/hash/尾斜杠。面板的"测试连接"就是对基地址发起匿名 GET,任何 HTTP 应答(包括 401/403)都算可达。

## 使用流程(mock 身份)

1. **owner 登录**:分享面板点"验证/登录" → 弹出 Relay 的 `GET /__liveshare/owner-authorize?state&code_challenge&instance&origin`(PKCE S256)→ 选择 mock persona(本地 Owner / 本地 Reviewer)→ 页面 `postMessage` 单次码回 owner 页 → owner 端用 `code_verifier` 向 `POST /__liveshare/owner-credential` 兑换 HMAC 签名凭证并保存。
2. **创建分享**:面板创建分享后,owner 网关进程以 `GET /__tunnel_gateway__?shareId=...&protocolVersion=1&capabilities=...` 等 WebSocket 注册;版本不符回 **426**,无有效凭证回 **401**;握手成功后 Relay 下发 `share-access-state` 快照(v1)并把链接形如 `http://<relay>/?shareId=<shareId>` 返回给 owner。
3. **观看**:浏览器打开链接 → Relay 经 `asset` 读取从 owner 取渲染好的 index → 把 viewer carrier 脚本插到最前、丢掉 manifest 链接 → 页面所有 reads 经 `POST /__share/rpc` 转发;`assets/...`、`plugins/...`、favicon、manifest 等静态资源同样经 `asset` 读取代理;`.map` source map 一律拒绝;`/open-in-app/apps`、`/api/present.host` 由 carrier 在页面内转发(不走 Relay HTTP)。
4. **停止分享**:owner 端停止 → `DELETE /__liveshare/share?shareId=...` → Relay 删行并关闭网关 socket;之后观看者读取得到 **404 share-not-found**;过期分享得到 **410 share-expired**。

观看者身份:**带链接即 guest**。首次访问时签发 HttpOnly cookie(`liveshare_viewer`),actor 三元组为 `local-mock : mock : guest-xxxxxxxx`。`open` 分享对全部 guest 放行;`selected` 分享因 ACL 不含 guest 而拒绝(403 access-denied)——需要 ACL 命中时,把对应身份键加入允许名单(见遗留 TODO)。

## FAQ

### DSH 桌面版点"登录"提示"无法打开登录窗口"？

这是桌面版（Electron 壳）弹窗策略的已知限制：登录授权弹窗里的 **HTTP 链接会被直接拒绝**，HTTPS 链接会转交系统浏览器打开（跨进程后授权码无法 `postMessage` 回传）。可行的方向：

- 用**带 HTTPS 的反向代理**部署本中继（Caddy / Nginx + 证书），再从桌面版重试；
- 在**浏览器版 DSH**（`dsh --profile web`，弹窗行为正常）里完成登录——owner 凭证与分享注册表按 `$DSH_HOME` 共享，桌面版重启后即可使用；
- 关注官方对桌面弹窗策略的后续调整。

### 需要暴露到公网吗？

不建议直接暴露。如确需公网访问：务必加 TLS（Caddy 可自动签证书）并在反代层加认证（Basic Auth / IP 白名单 / VPN），同时牢记上面的 `run_code` 风险。

## 端点一览(路径 → 行为 → 源码依据)

| 路径 | 行为 | 源码依据(owner/协议库) |
|---|---|---|
| `GET /`(基地址) | 匿名连通性探测,任意应答即可达;带 `?shareId=` 时返回观看页 | `share-operations.ts testRelay` → `tunnel-supervision.ts probeRelayConnectivity`;链接格式 `owner-share-operations.ts create`(`{relay}/?shareId=`) |
| `WS /__tunnel_gateway__?shareId&sessionId&sessionTitle&accessMode&ownerDisplayName&dshVersion?&ownerInstanceId?&protocolVersion&capabilities&allowsFork?&sessionMode?&ownerProviderId?&ownerTenantId?&allowedSubjectId*&expiresAt?` | owner 网关注册;校验顺序:协议版本(≠1→**426**)→ Bearer token → owner 凭证(缺失/签名错→**401**)→ 字段(→400);成功后发 `share-access-state` v1,期间收 `share-rpc-res`,发 `share-rpc`/`share-rpc-cancel` | `owner-gateway/registration-url.ts`、`relay-refusal.ts`、`worker.ts`、协议库 `tunnel-protocol.ts` |
| `GET /__liveshare/requests?shareId=` | Bearer 管理令牌 → 返回准入快照 `{version,accessMode,allowedSubjectIds,sessionMode,allowsFork,expiresAt?}`;未知→404、令牌错→401 | `relay-authority.ts relayRequests`(5s 超时,`parseShareAccessState` 解析) |
| `DELETE /__liveshare/share?shareId=` | Bearer 管理令牌 → 删除分享行、关闭网关 socket;未知→404(owner 把 404 也视为已删) | `tunnel-supervision.ts deleteRelayRow` |
| `GET /__liveshare/owner-credential` | 带 `x-liveshare-owner-credential` 头→校验并回 `{supported:true,ownerCredentialExpiresAt}`;无头→`{supported:true}` | `tunnel-supervision.ts probeRelayCredentialSupport` |
| `POST /__liveshare/owner-credential` | `{code,code_verifier,instanceKey}` → 校验 PKCE(S256)与实例绑定→`{credential,ownerCredentialExpiresAt}`;重放→`{error:"code-replayed"}` | `owner-http-routes.ts ownerLoginRedeem` |
| `GET /__liveshare/owner-authorize?state&code_challenge&instance&origin` | mock 登录页(记录待授权,校验 origin 为 http/https) | `owner-authorization.ts ownerAuthorizeUrl` |
| `POST /__liveshare/share/claim?shareId=` | Bearer 管理令牌 + owner 凭证头 → 把既有分享绑定到该身份 `{claimed:true|false,ownerCredentialExpiresAt?}` | `tunnel-supervision.ts claimOwnedShares` |
| `GET /__liveshare/audit?shareId=` | Bearer 管理令牌 → `{events:[{id,action,createdAt,actor?,detail?}]}`(内存环形,上限 200) | `owner-share-operations.ts audit`(`readShareAudit` 解析) |
| `POST /__share/rpc?shareId=` | 观看者读取通道:body(`op: call/stream-open/stream-next/stream-cancel` 等)不解读,以 `share-rpc{ id, body, actor }` 帧经 WS 转发给 owner,回传 `share-rpc-res` 的 status/body;观看者断开→发 `share-rpc-cancel`;等待超 130s→504(owner-offline,可重试) | 协议库 `viewer-carrier.ts`、`tunnel-protocol.ts`;`viewer-channel.ts`;README "Understand the implementation" |
| `GET /?shareId=`(及 `/s/<code>` 别名) | 观看页:`asset` 读取 path `''` → 注入 carrier 脚本到 `<head>` 最前 → 丢 manifest 链接 → `text/html` | README(asset 读取、carrier 注入、丢 manifest) |
| `GET /assets/…`、`/plugins/…`、`/index.html`、`/favicon.svg`、`/favicon-dark.svg`、`/manifest.webmanifest` | 同一 `asset` 读取代理(owner 状态/字节原样回写);`*.map` → 404 sourcemap-refused | README("三个顶层文件"、source map 拒绝) |
| `GET /__liveshare/health` | 本服务健康检查(Docker HEALTHCHECK 用) | 本项目自加 |

观看者拒绝条件 → HTTP 状态/错误码(`viewer-states.ts` 词汇 + carrier 的重试分类):

| 条件 | 状态 | 错误码 | 语义 |
|---|---|---|---|
| 链接无分享/已删除 | 404 | `share-not-found` | terminal |
| 过期 | 410 | `share-expired` | terminal |
| 已停止(行已删除) | 404 | `share-not-found` | terminal |
| owner 离线/等待超时 | 503 / 504 | `owner-offline` | retryable |
| ACL 不放行 | 403 | `access-denied` | terminal |
| 观看者会话失效 | 401 | `sign-in-expired` | terminal(mock guest 流程不会自然产生) |

## 目录结构

```
liveshare-relay/
├── server.mjs            # 入口:env、装配、http server、upgrade 转发、优雅退出
├── src/
│   ├── protocol.mjs      # wire 契约:版本/帧编解码/准入规则/观看者状态映射(转录自协议库)
│   ├── carrier.mjs       # viewer carrier 脚本(逐字转录编译产物 lib/index.js 的 installViewerCarrier)
│   ├── identity.mjs      # mock 身份:owner 凭证(PKCE+HMAC)、登录一次性码、viewer guest 会话
│   ├── store.mjs         # 分享注册表 + 审计 + 可选 JSON 持久化 + 签名密钥
│   ├── gateway.mjs       # WS 注册握手(426/401/400)、心跳、share-rpc 关联与取消
│   ├── http-routes.mjs   # 全部 HTTP 路由 + 观看页/carrier 注入/asset 代理 + mock 登录页
│   └── base64url.mjs     # 与 owner 端 base64-url.ts 一致的编解码
├── Dockerfile            # node:22-alpine,HEALTHCHECK 打 /__liveshare/health
├── docker-compose.yml    # 端口映射;状态文件卷挂载(注释示例)
└── smoke-test.mjs        # 端到端冒烟测试:模拟 owner 登录/网关注册 + 观看者读取(node smoke-test.mjs [baseUrl])
```

## 已知限制(与官方 Relay 的差距)

1. **mock 身份,不是认证边界**:owner 登录是自选 persona 的假 OAuth;观看者是"带链接即 guest"。签名凭证仅 HMAC(密钥在 state 文件里),不做 JWKS/签名轮换。`selected` 分享无法通过 UI 把 guest 加入 ACL。
2. **`run_code` 不受分享沙箱限制(官方契约本身如此)**:README 明确 "Shared PTC programs are not sandboxed to the share"——观看者的 `run_code` 在 owner 的常规文件策略下执行,可触达共享工作区之外的文件。**只与信任的人分享**;这不是 Relay 能修的。
3. **experimental 三方版本必须一致**:owner 插件、协议库与本 Relay 目前对齐 `0.2.2-rc.5`(`protocolVersion=1`);官方声明 "Owner, viewer, and the Liveshare server require matching versions; cross-version compatibility is not established"。协议升级时本仓库需同步修改。
4. **无持久化审计数据库**:审计是每个分享最多 200 条的内存环形,重启即清空。
5. **部分页面读取仍会 404**:绕过 Connection carrier 的浏览器直取(deliverable reads、PDF 资产、HMR 事件、根绝对路径的 manifest/favicon 链接)按官方 README 同样"到达 Relay 而非 owner",本实现仅代理 assets/plugins/三个顶层文件,其余回 404。
6. **单实例内存态**:无集群、无多 Relay、无 rate limit;WS 断线后行保留等待重连,重启(未挂 state 文件)丢全部分享。
7. **直接连接模式未实现**:owner 能力声明里的 `direct-connection` 仅登记不启用;`connection.mode` 只支持 `relay`(与当前 owner 行为一致)。

## 遗留 TODO

- [ ] 真实 OAuth/IdP 适配:替换 `src/identity.mjs`(实现 IdentityProvider 契约即可)
- [ ] `selected` 分享的观看者登录页与 ACL 命中(当前 guest 恒被拒)
- [ ] 持久化审计数据库;`share-access-state` 的 version 随 ACL/限期变更递增推送(当前仅注册时下发 v1,变更经 owner 重新注册)
- [ ] 观看者会话/登录过期路径(`sign-in-expired`)的真实触发场景
- [ ] 反向代理场景的 X-Forwarded-* 处理与 TLS 终结示例
- [ ] 限流与多分享大规模并发验证

## 免责声明

本项目是社区驱动的非官方实现，与 DeepSeek 及 DeepSeek Harness 官方无关。LiveShare 协议处于 experimental 阶段，官方随时可能调整；请自行评估在所在环境部署与使用的安全和合规风险。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 本项目的全部 wire 行为依据官方开源仓库中的 LiveShare owner 插件与协议契约（`@deepseek-ai/dsh-experimental-liveshare(-protocol)`）源码实现。

## License

[MIT](LICENSE)

-----

## English

**dsh-liveshare-relay** is a community, self-hosted relay server for the experimental **LiveShare** session-sharing feature of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). The official project ships the owner-side plugin and the wire protocol but no server implementation; this repository implements the server side of that wire contract — `protocolVersion = 1`, aligned with the owner/protocol packages **0.2.2-rc.5**.

### What it does

- Owner gateway registration over WebSocket, with protocol-version (`426`), token (`401`), and credential (`401`) refusal semantics, plus `share-access-state` v1 snapshots
- Viewer page delivery: asset reads of the owner's rendered index, viewer-carrier script injected first, manifest link dropped, source maps refused
- Opaque viewer RPC forwarding (`POST /__share/rpc`) with relay-asserted actor identity outside the body
- `/__liveshare/context` (share confirmation for the viewer page), access-state snapshots, audit ring, owner credential support probe
- Mock identity: PKCE (S256) one-time-code login and HMAC-signed owner credentials; viewer guests identified by a link-carried session cookie
- Share registry with optional JSON persistence, lifetimes, stop/expire semantics, and Docker packaging with a health check

### Quick start

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/__liveshare/health
# then enter http://<this-host>:8787 as the LiveShare server address
# in the DSH share dialog, sign in, and create a share
```

### Security

- Mock identity is **not an authentication boundary**: for `open` shares, anyone with the link can view. Deploy only on trusted networks (LAN/VPN).
- `run_code` is **not sandboxed to the share** (an official protocol boundary): a viewer's program can reach files outside the shared workspace. Share only with people you trust.
- The protocol is experimental; owner, viewer, and relay versions must match. This project is unofficial and not affiliated with DeepSeek.

See the Chinese sections above for the full endpoint reference, configuration, FAQ, and limitations. MIT licensed.
