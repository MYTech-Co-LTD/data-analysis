# Novu 统一推送平台接入设计（自部署 + AI 配置 + 权限感知变量）

> 状态：设计待审 · 2026-08-15
> 范围：控制面自部署 Novu 社区版作为系统级统一推送平台；企微投递走自建 wecom-bridge（零 fork）；配置由 OpenClaw agent 经 REST API 完成（中文对话即配置）；权限感知变量引擎在 data-analysis 侧。
> 关联：[[2026-08-15-permission-three-layer-design]]（前置：scope resolver）、[[2026-07-11-report-trigger-timed-apps-design]]（C4 run_as 机制被本设计泛化）、架构文档 §7.1.1（wecom-notify 转型兜底腿）

---

## 1. 选型结论与验证依据（2026-08-15 全链路源码验证）

**选定 Novu 自部署社区版**。备选全部否决，关键证据：

| 候选 | 否决原因（实证） |
|---|---|
| Message-Push-Nest | 企微仅 text/markdown（无卡片）；失败重试/防轰炸零实现；无触发机制；发送 token 可逆混淆 |
| fork/freeze Novu 汉化 | dashboard 无 i18n 框架；十万行级 monorev 永久自养；核心需求仍需自建 |
| headless + 自建中文壳 | 中文 UI 照建 + 6 容器照养 + 双真相源，成本最高 |
| 纯自建薄版 | UI 设计能力是团队短板；长期编排需求确定 |

**Novu 关键验证事实**（本地栈已实测：建账号→建工作流→变量自动提取全通）：
- 社区版 compose 仅 6 容器（api/worker/ws/dashboard/redis/mongodb），无 MinIO；MIT 覆盖核心。
- 多 org 无 EE guard（`POST /v1/organizations`，一系统一 org）；trigger 鉴权 = env ApiKey（`Authorization: ApiKey` 前缀）。
- 管理面 API 用 dashboard JWT + 请求头 `novu-environment-id`（JWT 30 天过期）。
- **bulk trigger ≤100 event 各带 payload + 收件人**（`/v1/events/trigger/bulk`）——per-scope 分组发送的正解。
- 变量从模板 Handlebars AST 反解析（无变量目录概念）→ 字典必须留 data-analysis。
- 企微无原生 provider；`chat-webhook` 可配 per-subscriber webhookUrl → 连自建桥。
- Dashboard CE 仅 email/password（OIDC 是 EE 私有包）；英文无 i18n——**已被"agent 配置 + 巡检用沉浸式翻译"化解**。
- 企微 `ws:3.19.0` 镜像未发布（上游疏漏），部署统一用 `latest` 或验证过的具体 tag。

## 2. 目标架构

```
┌─ 配置面（中文）───────────────────────────────────────┐
│ 员工/管理员 ↔ OpenClaw（企微，中文对话）                 │
│   → push-admin plugin（照抄 data-query-plugin 模式：     │
│     definePluginEntry + factory + requesterSenderId）    │
│   → Novu REST API / data-analysis 渲染引擎               │
└───────────────────────────────────────────────────────┘
┌─ data-analysis（智能层，核心资产）──────────────────────┐
│ 触发源：monitor_rules 阈值 / scheduler 定时 / agent 即时  │
│ push_variables 注册表（口径/单位/scope 维度/最小权限）     │
│ 渲染引擎：收件人 → resolve_scope 分组 → 带权限查语义视图   │
│           → 算值 → bulk trigger（一组一 event）           │
└───────────────────────────────────────────────────────┘
┌─ Novu（控制面 113.249.101.33，黑盒运行）────────────────┐
│ org: data-analysis（env prod ApiKey → web 容器）          │
│ Handlebars 模板 · 防轰炸/摘要 · 审计 · 未来 org 即插       │
│   → chat-webhook → wecom-bridge（自建，零 fork）→ 企微 App B │
└───────────────────────────────────────────────────────┘
wecom-notify（edge function）保留：InsForge-down 告警兜底腿（§8.1）
```

## 3. 详细设计

### 3.1 部署（控制面）

- `docker/community/docker-compose.yml`（已验证 6 容器）；控制面磁盘已清理（可用 26G）。
- Dashboard 不暴露公网：内网/VPN 访问 + email/password + `DISABLE_USER_REGISTRATION`。账号仅 2-3 个平台管理员。
- 网络：data-analysis 机（出口 113.249.120.84）→ 控制面（113.249.101.33）api 端口放行；走公网则套 HTTPS（ApiKey 鉴权本身强，但不裸 HTTP）。
- 监控：`service_down` 探活目标加 Novu api/dashboard；Novu 挂 → wecom-notify 直发兜底。

### 3.2 wecom-bridge（零 fork 投递，新 edge function 或 web api route）

```
Novu chat-webhook provider（credentials: SecretKey 做 HMAC）
  → POST https://<bridge>/wecom?userid=<wecom_id>
     （per-subscriber webhookUrl，subscriber.channels.credentials 存储）
  → 桥：验 X-Novu-Signature → 取 content → 套企微 markdown 格式
     → App B message/send（复用 wecom-notify 的 token/发送逻辑）
```
- 限制：仅文本/markdown 级内容（`content` 渲染后字符串）；卡片需求出现时走上游 PR 原生 provider（bridge 过渡，纯新增文件纪律）。
- 各件人解析：query 的 `userid`（可信来源：Novu 存储，非用户输入）。

### 3.3 push_variables 注册表（新迁移，指标数据准备层核心）

```sql
CREATE TABLE push_variables (
  var_code TEXT PRIMARY KEY,            -- achievement_rate
  name TEXT NOT NULL,                   -- 目标达成率
  description TEXT,                     -- 口径说明（agent 配置时读这个向用户解释）
  unit VARCHAR(20),                     -- '%' / '元' / NULL
  query_def JSONB NOT NULL,             -- 视图/指标引用 + 过滤（引用 metric_registry 口径）
  scope_dim VARCHAR(20) NOT NULL,       -- 'brand'|'war_zone'|'region'|'branch'|'total'
  min_required_scope JSONB,             -- 引用此变量所需最小权限（can_see_cost 等）
  is_sensitive BOOLEAN DEFAULT FALSE,   -- 成本组变量：收件人 can_see_cost=false 渲染为占位符
  enabled BOOLEAN DEFAULT TRUE
);
```
- 单一事实源；新增变量 = INSERT 一行（同 datasets 模式），agent 与引擎双侧消费。
- 字典同步到 Novu：**不做**（Novu 无变量目录概念）。改为 workflow `description` 贴字典表 + 契约测试锁对齐（见 3.6）。

### 3.4 渲染引擎（web/lib/push/）

```
run_push(template_code, recipients_selector, trigger_ctx):
 ① 收件人解析：selector(角色/部门/个人) → wecom_id 列表
 ② 逐人 resolve_scope（权限三层 spec 的统一 resolver）→ 按 scope 分组去重
 ③ 每组：以该 scope 的 claims 查语义视图（复用 claim_match_or_star + can_see_cost 脱敏）
    → 算出该组全部变量值（is_sensitive 且无权限 → 渲染为 "***"）
 ④ POST /v1/events/trigger/bulk：一组一 event（to=该组 subscriberId 列表，
    payload=该组变量值）；workflow identifier 从 trigger_ctx 取
 ⑤ 记 push_trigger_logs（trigger 调用审计；发送明细审计用 Novu Activity）
```
- **安全不变量**：变量只来自注册表（禁任意 SQL）；值按**收件人** scope 计算（非配置者/运行者）；投递目标来自任务表/选择器，LLM 不可指定收件人；同 scope 缓存一次查询。
- 定时/阈值触发仍走 monitor_rules + scheduler（Novu 不反查业务库）；`scheduled_reports` C4 的 run_as 机制被"收件人级 scope 分组"泛化取代。

### 3.5 push-admin agent 插件（openclaw/push-admin-plugin/）

照抄 data-query-plugin 模式（definePluginEntry + factory + requesterSenderId + API key）。工具面：

| 工具 | 作用 | 鉴权 |
|---|---|---|
| `list_push_variables()` | 拉注册表活字典（agent 向用户解释变量含义） | 所有登录用户 |
| `create_push_workflow(名称, 模板描述, 变量列表)` | 建模板（结构化参数→Novu API），description 自动贴变量字典 | 授权规则见下 |
| `update_push_workflow(...)` | 改模板 | 同上 + 创建者或 admin |
| `push_now(workflow, 收件人选择器)` | 走渲染引擎即时发送 | 同上 |
| `check_push_status(时间范围)` | 查发送审计（Novu Activity） | 创建者或 admin |

**授权规则**（依赖权限三层 spec）：
- 配置者只能向自己 scope 内收件人组推送；模板只能引用 `min_required_scope ⊆ 配置者 scope` 的变量；
- 全员范围推送需 `data-analysis:push:broadcast` 资源（admin 级）；
- 插件侧校验 + 渲染引擎侧兜底双闸（插件被绕过时引擎仍按注册表/收件人 scope 执行）。
- 管理面 JWT（30 天）：由 web 侧薄 admin-service 封装代换 token，插件只持 env ApiKey 与内部服务地址。

### 3.6 契约测试（防模板/注册表漂移）

- 定时 job：拉 Novu workflow 定义（API）→ Handlebars 解析 `{{payload.X}}` 集合 → 与 push_variables 对比：模板用未注册变量 = 红（拼错/私加）；注册未用 = 提示清理。
- 失败走 collect_fail 告警通道。

## 4. 实施步骤

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| N1 | 控制面部署 Novu + 网络 + 探活 | 权限 spec P1（scope resolver 可并行） | dashboard 内网可访；trigger API 打通 |
| N2 | wecom-bridge + chat-webhook 渠道配置 | N1 | 测试 subscriber 收到企微消息 |
| N3 | push_variables 迁移 + 契约测试 | 权限 P1 | 注册表 CRUD + 漂移检测红绿 |
| N4 | 渲染引擎 + bulk trigger + 达标率日报端到端 | N2/N3 + 权限 P2 | CEO/战区总/督导三角色收不同值（脱敏正确） |
| N5 | push-admin 插件 + 授权双闸 | N4 + 权限 P3 | 中文对话建模板并推送；越权推送被拒 |
| N6 | 事件源接入（monitor/scheduler 双通道）+ wecom-notify 兜底演练 | N4 | Novu down 时告警仍达 |

## 5. 非目标

- 不 fork/不改动 Novu 任何核心代码（bridge 是外围服务；原生 provider 仅走上游 PR + 纯新增纪律）。
- 不依赖 Novu 云 Copilot / 不买 EE。
- 不迁移定时调度到 Novu（业务触发永在本地）。
- 不做内容多语言（全员中文）。
- 多系统接入（第 2+ 个 org）触发时再做，接入动作 = 注册 org + 发 env ApiKey。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 上游 CE 功能缩水 / ws 镜像 tag 断档 | 固定已验证 tag；升级前跑 N4 验收集；最坏退路=渲染引擎保留、投递切 wecom-notify（智能层资产不丢） |
| 两机公网链路安全 | HTTPS + ApiKey + IP 白名单；或申请同 VPC |
| bridge 仅文本/markdown | 接受；卡片需求出现时上游 PR（issue #4493 挂牌多年，实现有合并可能） |
| agent 配置越权 | 双闸：插件校验 + 引擎按收件人 scope 兜底 |
| bulk ≤100 event 上限 | 分批调用（当前收件人量级 < 100/组） |
