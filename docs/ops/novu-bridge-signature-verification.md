# Novu chat-webhook 签名契约验证（V1）

> 状态：**已验证（源码级，file:line 证据）**。Task 6（bridge 实现）以本文「契约快照」为准，不得凭假设。
> 验证日期：2026-08-15。源码 clone：`/Users/duo/orca/workspaces/explore/分析-casbin-cube-和-message-nest-结合的可能性/源码分析/novu`（只读，commit `fc9a0fd2`，2026-08-14）。
> 本文档为 spec §5.4 / plan Task 4 的 P0b 验证产物；RT-11（签名是否绑定 URL）、RT-8（去重键）判断点在此钉死。

## TL;DR（对 Task 6 的直接影响）

| 问题 | 结论 |
|---|---|
| 签名算法 | HMAC-SHA256，**hex 输出**，key = 集成 credentials.secretKey |
| 签名入参 | **仅 JSON body 字符串**（`JSON.stringify` 后的原文，即线上字节）|
| 含时间戳？ | **否**。无 timestamp、无 nonce 入参 → 签名本身不防重放 |
| 含 URL/path？ | **否**（RT-11：签名不绑定目标 URL，同一 body+sig 可重放到任意可达路径）|
| body 内有无 transactionId / message id？ | **默认没有**。RT-8：bridge 层去重不能依赖 transactionId，除非经 `_passthrough.body` 显式注入 |
| bulk 的 transactionId 粒度 | per-event（每 event 独立生成/校验唯一；bulk 内不共享同一 id）|

## 1. 签名算法与密钥来源

`packages/providers/src/lib/chat/chat-webhook/chat-webhook.provider.ts`：

- `chat-webhook.provider.ts:74-75`：`const body = this.createBody(data.body); const hmacValue = this.computeHmac(body, hmacSecretKey);`
- `chat-webhook.provider.ts:99-101`：`createBody(options) = JSON.stringify(options)` —— **签名对象就是序列化后的 body 字符串**。
- `chat-webhook.provider.ts:103-110`：`computeHmac = crypto.createHmac('sha256', secretKey).update(payload, 'utf-8').digest('hex')` —— **SHA256、hex 小写、无前缀**（不是 `sha256=` 前缀的 Slack 风格）。
- `chat-webhook.provider.ts:70-73`：密钥取值优先级 = **per-message 覆盖** `data.body.hmacSecretKey`（来自 workflow 代码里 provider 配置，发送前从 body 中 `delete`）> **集成级** `this.config.hmacSecretKey`。
- 集成级密钥来源：`libs/application-generic/src/factories/chat/handlers/chat-webhook.handler.ts:12-18` —— `buildProvider(credentials)` 里 `hmacSecretKey: credentials.secretKey`。即 Novu 后台 ChatWebhook 集成凭证的 **Secret Key 字段**。
- 无密钥时行为：`chat-webhook.provider.ts:104-107` —— `secretKey` 为空则 `computeHmac` 返回 `undefined`，请求仍发出，但 **`X-Novu-Signature` header 为 `String(undefined)`**（`chat-webhook.provider.ts:80-84` 直接展开进 headers）。bridge 侧必须把缺失/非法签名一律拒绝，不能只比对的「有就验」。

## 2. 签名入参（RT-11 判断点）

`X-Novu-Signature` 的值 = `HMAC-SHA256-hex(JSON.stringify(body), secretKey)`，**不含**：

- 时间戳（无 `t=` 段、无签名头拼接时间戳，`chat-webhook.provider.ts:77-85` headers 里只有 `X-Novu-Signature` 一个签名相关 header）
- 请求方法 / URL / path / query（`computeHmac` 入参只有 body 字符串）

传输层不改变被签字节：provider 把**已序列化的字符串**传给 `safeOutboundJsonRequest`，`packages/shared/src/utils/safe-outbound-http.ts:159-175` 只对 object 重新 stringify，字符串 body 原样透传（`safe-outbound-http.ts:290-292` `req.end(body)`）。因此 **bridge 侧对「收到的 raw body 字节」重算 HMAC 即可与 header 严格比对**，无需自行重新序列化（切勿 `JSON.parse` 再 `JSON.stringify` 后比对——键序/空白差异会误判）。

被签 body 的默认构成（`chat-webhook.provider.ts:41-49` + `packages/providers/src/base.provider.ts:51-91` transform 三层 merge，优先级低→高）：

```jsonc
{
  "content": "<渲染后消息内容>",
  "webhookUrl": "<完整 webhook URL（含 token 路径段）>",  // 注意：URL 本身在 body 里
  "channel": "<endpoint.channel，如 'chat-webhook'>",
  "phoneNumber": "<可选>",
  // + workflow 代码里 provider(...) 的已知字段
  // + _passthrough.body 透传字段（overrides 也可注入 headers/query，一并随请求发出但不进 HMAC 之外的校验）
}
```

`hmacSecretKey` 若走 per-message 覆盖，会在签名计算前从 body 删除（`chat-webhook.provider.ts:71-73`），**不会出现在送达 body 里**。

## 3. 时间戳 / 防重放

**无任何时间性入参** → 签名对同一 body 永久有效。防重放窗口完全由 bridge 自建（见契约快照的 nonce 设计）。RT-11 的「URL 绑定」担忧属实：截获的 body+sig 可原样重放；但由于 `webhookUrl` 本身在被签 body 内，**换目标 URL 重放会破坏签名**（改 body 即失效），风险收敛为「同 URL 原样重放」。

## 4. bulk trigger 的 transactionId 粒度（RT-8 去重键依据）

- 生成：`apps/api/src/app/events/usecases/parse-event-request/parse-event-request.usecase.ts:93` —— `transactionId = command.transactionId || generateTransactionId()`；`apps/api/src/app/shared/helpers/generate-transaction-id.ts:3-5` —— `txn_<objectId>`（每 event 独立）。
- bulk 逐 event 透传：`apps/api/src/app/events/usecases/process-bulk-trigger/process-bulk-trigger.usecase.ts:47-67` —— 每个 `event.transactionId` 单独传给 `ParseEventRequest`，**bulk 内不共享**；未提供则每 event 各自生成新 id。
- 唯一性/去重语义：`libs/application-generic/src/usecases/trigger-event/trigger-event.usecase.ts:390-402` —— 同一 environment 内 transactionId 已存在于 job 表即报错（官方 DTO 文档也写明"same transactionId sent again, the trigger is ignored"，`apps/api/src/app/events/dtos/trigger-event-request.dto.ts:335-341`）。即 transactionId 是 **Novu 侧消费去重键**，retention 依 billing tier。
- **关键**：transactionId 止步于 Novu 内部，`chat-webhook` 送达 bridge 的默认 body（§2 构成）**不含 transactionId、不含 message id**。bridge 若要 event 级幂等，需在 trigger 时经 `_passthrough.body`（SDK `provider(..., { body: {...} })` 透传）显式带上业务幂等键。

## 5. 契约快照（Task 6 实现以此为准，不得凭假设）

### 5.0 投递路径契约（生产接线 2026-08-18 实测钉死，triggerBulk 实现依据）

> 引擎 `web/lib/push/novu-client.ts triggerBulk` 的逐 event overrides 由此节决定，
> 契约测试见 `web/lib/push/__tests__/novu-client.test.ts`。

- **webhookUrl 解析优先级**（`apps/api/src/app/events/usecases/send-message-chat/send-message-chat.usecase.ts:533`）：
  `overrides.providers['chat-webhook'].webhookUrl || payload.webhookUrl || subscriber.credentials.webhookUrl`。
  生产取第一路：trigger 时逐 event 注入完整 bridge URL（基址 + bridge_token 路径段），
  不依赖 subscriber credential（避免换 token 要同步 Novu subscriber）。
- **engine 字段透传必须走 `_passthrough.body`**（`packages/providers/src/base.provider.ts:51-91` transform）：
  `overrides.providers['chat-webhook']._passthrough.body` 的键**不做 camelCase 变换**、
  原样进入送达 body；而放在 override 顶层的 `engine_sig` 会被 transform 成 `engineSig`（签名串对不上，双层验签必挂）。
  payload 里的 `engine_sig` 等字段**不会**自动流入送达 body（§2 的默认构成里没有 payload 键）。
- 因此引擎逐 event 构造（`novu-client.ts`）：
  `overrides.providers['chat-webhook'] = { webhookUrl: '<base>/<bridge_token>', _passthrough: { body: { engine_sig, txn_id, subscriber_id, engine_content } } }`。
- workflow 模板代码（`provider(...)` 步骤）**不需要**（也不应）再配置 webhookUrl —— 以 event 级注入为准。

### 5.1 bridge 验签伪代码（按实测构造）

```text
# 入：rawBodyBytes（原始请求体字节，勿 re-serialize）、headers
sig = headers["x-novu-signature"]          # 单一 header，hex 字符串，无前缀
if sig is missing or not /^[0-9a-f]{64}$/: REJECT 401
expected = hmac_sha256_hex(rawBodyBytes, INTEGRATION_SECRET_KEY)   # secretKey = Novu 集成 Secret Key
if !constant_time_equal(sig, expected):    REJECT 401
# 通过后：JSON.parse(rawBodyBytes) 取 content / webhookUrl / channel / _passthrough 注入字段
# 注意：若 workflow 侧配置了 per-message hmacSecretKey，secret 会换 —— 生产约定只用集成级 secretKey，
# 不使用 per-message 覆盖（bridge 无法得知 per-message secret）
```

### 5.2 nonce / 幂等键设计结论

- 签名无时间戳、无 nonce → bridge 必须自建幂等层。
- **nonce 键须含 token 路径段**：`webhookUrl`（含 token）虽在被签 body 内，但 URL 段本身是唯一可用的「通道身份」。推荐幂等键 = `sha256(rawBodyBytes)`（天然覆盖 content + webhookUrl + 透传字段），TTL 建议 ≥ Novu worker 重试窗口（默认重试策略下取 24h 足够保守）。
- 若业务需要 event 级精确去重（RT-8）：在 trigger SDK 侧经 `_passthrough.body` 注入业务幂等键（如 `dedupKey`），bridge 从解析后的 body 读取并以其为幂等键；**不得假设 body 里有 transactionId**。
- 重放残留风险（已收敛）：同 URL 原样重放，由上述 sha256(rawBody) 幂等键吸收。

### 5.3 显式保留待验证项（RT-13 口径）

- Novu 云/自托管版本的 worker **重试次数与间隔**未从源码逐条核出（影响 nonce TTL 下限），实现时取 24h 保守值即可，不阻塞 Task 6。
- `_passthrough.headers`/`query` 会随请求送达但**不参与 HMAC 之外的一致性校验**——bridge 不应依赖 headers/query 携带业务字段。

> 后续实现以本快照为准；如与线上行为不符，以实测为准并回改本文档。
