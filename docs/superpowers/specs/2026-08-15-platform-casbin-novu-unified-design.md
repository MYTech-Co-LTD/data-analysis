# 平台级权限接入 Casdoor casbin + Novu 统一推送中心设计

日期：2026-08-15
状态：已获用户逐节确认（方案 A + 全部修订），待 spec 评审
关联：[[2026-08-13-permission-refactor-design]]（数据范围层已完成的前置）、`docs/architecture.md` §6（鉴权分层）、casdoor-infra `docs/2026-08-10-openclaw-casdoor-ab.md` 方案 B（服务级认证 token 化）、casdoor-infra `docs/2026-08-11-casdoor-company-platform-design.md`（公司平台蓝图）

---

## 0. 已确认决策总表（本轮对话逐项定案）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | casbin 承载边界 | 功能授权进 Casdoor Permission（casbin），数据范围留本地（08-13 已完成的 `data_permissions`） |
| D2 | 人→角色归属 | **Casdoor 配**（张三→战区总在 Casdoor UI 配）；角色→数据范围在 data-analysis 配 |
| D3 | 通讯录与 Casdoor | **薄同步必做**：企微建户 provisioning + 离职禁用 + dept_role_mapping 自动角色写入 Casdoor |
| D4 | 推送平台 | Novu 自部署社区版（控制面 113.249.101.33），org=`shanhai`（山海租户） |
| D5 | 企微投递 | chat-webhook provider（官方自定义桥机制）+ 自建 wecom-bridge（web api route），**不自研 provider 不 fork** |
| D6 | 推送配置入口 | AI 对话配置为主（OpenClaw push-admin 插件），不自建中文模板 UI |
| D7 | 切换范围 | **只切业务推送**（订阅/定时/agent 推送走 Novu）；系统告警留 wecom-notify 不动；wecom-push 退役 |
| D8 | OpenClaw 身份统一 | push-admin 新链路天生用 Casdoor client_credentials JWT；**agent-query token 化纳入本期**（U8） |
| D9 | permissions 生效延迟 | 随自签 JWT（7 天）生效，管理类低频操作可接受，本期不做实时校验 |

## 1. 权限模型：帽子 × 座位 × 口径

**一句话分工**：Casdoor 管「身份 + 戴什么帽子（角色）」；通讯录管「坐在哪（部门归属）」；data-analysis 管「每顶帽子/每个座位能看什么字段和数据」。

```
① 身份层（不动）        Casdoor OIDC（企微 provider）→ wecom_id
② 角色/功能层（改造）   Casdoor：人→角色（casbin UI 配）
                        角色×资源(功能授权)：data-analysis:admin / :push:configure /
                        :push:broadcast / :dimensions:edit ...（三段式）
③ 数据范围层（已完成+输入源切换）
                        data_permissions（role/dept/user 三类 subject，四维：
                        branch_nums/brands/categories/can_see_cost）→ get_user_perms
                        → claims → RLS/视图过滤（执行点零改动）
```

### 1.1 casbin 做不了的事（源码验证，设计边界）

casbin 是单次判定引擎，无 policy→SQL：做不了行级数据过滤、给不出"门店清单"数据集。数据范围永不进 IdP。

### 1.2 "部门总只看自己部门"的合成机制（核心例子）

```
Casdoor：张三 → 角色 dept_head（casbin 只挂身份）
本地①通讯录：张三 ∈ 西南战区部门
本地②部门行：西南战区 → 15 家店
本地③角色行：dept_head → can_see_cost=true，门店维 NULL
合成 = ③（字段能力）× ①②（门店范围）：西南 15 家店、全字段
李四同为 dept_head ∩ 华东 → 华东 12 家店（同一角色，无需按战区复制）
```

角色行语义：**门店维 NULL = 跟随部门**；需要固定清单的角色（boss）直接配 `['*']`。

### 1.3 Casdoor 侧配置（shanhai org）

- Roles：`admin` + 业务 5 角色（boss/zone_manager/manager/buyer/finance，码 = `data_permissions.subject_id`，契约测试锁一致）。
- Permissions：资源 `data-analysis:<模块>:<动作>` × 角色 × allow；临时授权用自带有效期字段。
- Agent Application：`openclaw-gateway`（category=Agent，GrantTypes 加 `client_credentials`，custom scopes：`openclaw:query` / `openclaw:push`）——照 casdoor-infra 方案 B §3.3。
- 种子配置落 casdoor-infra `init/`。

### 1.4 通讯录薄同步（新增，挂进现有 wecom-sync-contacts 链）

- **建户**：通讯录同步时，新员工若 Casdoor 无户 → 调 Casdoor API provisioning（解决「未登录先配角色」）。
- **自动角色**：dept_role_mapping 部门→角色映射逻辑保留本地维护，赋值动作改为**写入 Casdoor**（多部门取 priority 最高）。
- **离职**：通讯录移除 → Casdoor 用户 disable。
- 本地 `org_users.role_id` 降级为只读镜像（过渡期），验证一致后移除。

### 1.5 data-analysis 侧改造

1. **登录链路**（`functions/wecom-oidc-callback`）：换 userinfo 后 ①拉用户 Casdoor roles（OIDC token 带 roles claim 优先，否则 API 查——U2 先验证）②roles 作为 get_user_perms 输入（替代 org_users.role_id）③功能 permissions 数组进自签 JWT claims。claims 其余结构不动。
2. **门禁切换**：`requireAdmin` → 查 claims `data-analysis:admin`（ADMIN_USERIDS 保留启动兜底）；前端 `visible_panels` 改由 permissions 映射，契约单源 `web/lib/contracts`。
3. **get_user_perms**：签名加 roles 入参，合成逻辑（Casdoor roles 行 ∪ 部门基底 + 个人逐维覆盖）不变，RLS/视图/契约测试零改动。

### 1.6 日常配置操作总表

| 场景 | 去哪配 |
|---|---|
| 张三升战区总 | Casdoor：加进 zone_manager 角色 |
| 战区总能看哪些店/字段 | data-analysis `/admin/permissions` 角色 tab |
| 部门=哪些店 | 同页部门 tab |
| 个人 override | 同页用户 tab |
| 新增敏感指标 | `/admin/semantic` 标 cost_sensitive（什么算敏感）；权限页控谁能看 |

## 2. 推送智能层（千人千面核心，全在本地可信侧）

### 2.1 `push_variables` 注册表（新迁移，白名单控制暴露面）

```sql
CREATE TABLE push_variables (
  var_code    TEXT PRIMARY KEY,          -- 'sale_amount' / 'achievement_rate'
  name        TEXT NOT NULL,             -- agent 配置时念给用户听
  metric_code TEXT REFERENCES metric_registry,  -- 口径复用语义层（AST），不另造
  scope_dim   VARCHAR(20) NOT NULL,      -- 'total'|'brand'|'war_zone'|'region'|'branch'
  extra_filter JSONB,                    -- 可选维度过滤（引用 dimensions 注册）
  unit        VARCHAR(20),               -- 默认取 metric_registry.unit
  enabled     BOOLEAN DEFAULT TRUE
);
```

敏感性不单列：读 `metric_registry.cost_sensitive`（单一事实源）。新指标可推 = INSERT 一行。

### 2.2 渲染引擎 `web/lib/push/`（唯一入口 `run_push`）

```
run_push(workflow_id, recipients_selector, trigger_ctx):
① 收件人解析：selector（角色/部门/个人/全员）→ wecom_id 列表
   —— selector 是存库结构化定义；LLM/配置者不能自由手写收件人
② 逐人 get_user_perms → scope 签名 → 相同签名合并分组（一次查询服务一组）
③ 每组：以该组 claims 签短时 JWT → 查语义视图算全部变量值
   —— cost_sensitive 且组内 can_see_cost=false → "***"
④ Novu bulk trigger：一组一 event（to=组内 wecom_id，payload=变量值；>100 event 分批）
⑤ push_trigger_logs 审计（触发者/分组/变量快照）
```

安全不变量：变量只来自注册表（禁任意 SQL）；值按**收件人** scope 算；全员 selector 需 `push:broadcast`。

### 2.3 触发与切换清单

| 现有通道 | 处置 |
|---|---|
| scheduled_reports C4（OpenClaw cron） | 投递改走 run_push（run_as 被「收件人级分组」泛化取代） |
| wecom-push（@all 定时摘要） | 退役 |
| agent push_report | 改走 run_push |
| 系统告警（collect_fail/对账/QA/监控） | **不动**，继续 wecom-notify |

触发判定永在本地（scheduler/cron/agent），Novu 不反查业务库。

## 3. Novu 部署 + wecom-bridge

### 3.1 部署（控制面 113.249.101.33，/opt/novu）

- 社区版 compose 6 容器（api/worker/ws/dashboard/redis/mongodb），本地实测建号→建工作流→变量提取全通；镜像固定已验证 tag（ws tag 上游断档，统一策略）。
- org=`shanhai`（山海租户），env prod ApiKey 注入 data-analysis web 容器 env。
- Dashboard 不暴露公网（内网/VPN + 关注册）；两机链路 HTTPS + IP 白名单；探活入 `service_down`。
- 配置纳管 casdoor-infra `deploy/novu/`。

### 3.2 provider 结论（源码验证）

Novu provider 是**编译期静态注册**（enum + consts + 静态 export），无运行时插件钩子——自研 provider = fork（否决）。`chat-webhook` 是官方自定义桥机制（含 bridgeProviderData 透传设计），即官方扩展点：

```
Novu chat-webhook（HMAC SecretKey）
  → POST https://data.shanhaiyiguo.com/api/wecom-bridge?userid=<wecom_id>
     （per-subscriber webhookUrl，subscriber.channels.credentials 存储）
  → 桥：验 X-Novu-Signature → content 套企微 markdown → App B message/send
     （复用 wecom-notify 同款 token/发送逻辑）
```

- 桥放 **web api route**（raw body/公网可达 web 侧现成，避开 InsForge body 解析坑）。
- 内容仅文本/markdown；卡片需求出现走上游 PR 原生 provider（长期贡献，不冲突）。
- subscriber 由引擎首次触发时 `PUT /v1/subscribers` upsert（subscriberId=wecom_id）。

### 3.3 模板

Handlebars `{{payload.X}}` ↔ `push_variables.var_code`；workflow description 贴变量字典快照；漂移由契约测试锁（§5.3）。

## 4. push-admin 插件：Casdoor 三层鉴权

```
企微用户（中文对话）
  │ requesterSenderId = wecom_id
  ▼
OpenClaw push-admin 插件（照抄 data-query-plugin 模式）
  │ ① 服务身份：client_credentials 换短时 JWT（scope: openclaw:push，提前 60s 刷新）
  │ ② 人员身份：body.userId = wecom_id
  ▼
data-analysis web 内部 push API
  │ JWKS 验签（iss/aud/exp/scope）→ Casdoor Permission 闸（push:configure / push:broadcast，
  │   API 查 + 5min 缓存——agent 路径无 web 会话 JWT）
  │ → run_push 引擎闸兜底
  ▼
渲染引擎 → Novu
```

### 4.1 工具面

| 工具 | 作用 | 鉴权 |
|---|---|---|
| `list_push_variables()` | 拉注册表活字典，向用户解释口径/单位/敏感级 | 所有登录用户 |
| `create_push_workflow(名称, 模板描述, 变量列表)` | 建 Novu workflow，description 贴字典 | `push:configure` |
| `update_push_workflow(...)` | 改模板 | 同上 + 创建者或 admin |
| `create_push_schedule(workflow, selector, cron)` | 定时订阅（落本地表） | 同上 |
| `push_now(workflow, selector)` | 即时发送 | 同上；全员需 `push:broadcast` |
| `check_push_status(时间范围)` | 审计（Novu Activity + push_trigger_logs） | 创建者或 admin |

### 4.2 授权双闸 + 凭证

- 插件闸：LLM 输出只含工具调用；工具内校验配置者 permissions；收件人必须结构化 selector。
- 引擎闸（兜底）：绕过插件直调引擎仍按收件人 scope + 白名单 + 广播权限校验。
- 插件只持 `CASDOOR_CLIENT_ID/SECRET`，**不持任何 Novu 凭证**（trigger 经 web push API 转发，Novu ApiKey 只进 web 容器）；dashboard JWT 由 web 薄 admin-service 代管。

## 5. 实施阶段 / 文档 / 测试

### 5.1 阶段（U1/U3 并行；U2 与 U3-U4 并行）

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| U1 统一身份地基 | Casdoor Agent app + Roles/Permissions + JWKS 验签共享件 + 薄同步（建户/自动角色/离职禁用） | — | curl 换 token/验签通；同步链三动作验证；契约测试锁角色码一致 |
| U2 登录链路 | wecom-oidc-callback 拉 roles/permissions 进 claims；get_user_perms 输入切 Casdoor roles；requireAdmin/菜单门禁切 casbin | U1 | 全员登录回归；数据范围新旧对账一致；admin 不发版可调 |
| U3 Novu 部署 | 控制面部署 + org=shanhai + 网络/HTTPS/探活 + 纳管 casdoor-infra | — | trigger API 通；探活入 service_down |
| U4 wecom-bridge | web api route 桥 + chat-webhook + subscriber upsert | U3 | 测试 subscriber 企微收消息 |
| U5 变量+引擎 | push_variables + run_push + push_trigger_logs + 契约测试 | U2/U4 | 三角色（CEO/战区总/督导）同模板收不同值、脱敏正确 |
| U6 push-admin | 插件（Casdoor JWT 全链路）+ web push API + 双闸 | U1/U5 | 中文对话建模板即推；越权被拒 |
| U7 业务推送切换 | scheduled_reports/push_report 改 run_push；wecom-push 退役 | U5 | 订阅走 Novu；告警仍 wecom-notify |
| U8 agent-query token 化 | data-query-plugin + agent-query 切 client_credentials JWT | U1（U6 已验证模式） | 问数全链路回归；吊销 client 即失效 |

### 5.2 架构文档更新（实施前完成，CLAUDE.md 铁律）

`docs/architecture.md`：§6 增补功能授权层（casbin）+ 帽子×座位×口径分层图 + 薄同步链；§7.1 增补 Novu 推送中心/wecom-bridge/渲染引擎数据流；§4.3 信任边界加 OpenClaw 统一身份链路（JWKS 验签 + scopes）。

### 5.3 测试策略（docs/testing-handbook.md 分层）

- 迁移幂等（MIGRATION_TEMPLATE：DROP+CREATE / ON CONFLICT）；
- 渲染引擎单测：scope 分组、成本脱敏、白名单拒绝（本地伪造 claims 参数化）；
- 契约测试：①Novu 模板 {{payload.X}} ⊆ push_variables（定时 job，红→collect_fail）②Casdoor 角色码 = data_permissions.subject_id；
- 端到端：U5/U6 三角色脱敏 + 越权拒绝；
- 安全终检：桥 HMAC 验签、JWKS 失败 fail-close、LLM 不能指定收件人、薄同步幂等。

### 5.4 非目标

不 fork/不自研 Novu provider；不迁系统告警；不做行级数据权限进 casbin；不动 RLS/生成器/DuckDB 权限视图；不买 EE/不用 Novu 云；不做内容多语言；第二系统接入 Novu 按需再做。

### 5.5 风险与对策

| 风险 | 对策 |
|---|---|
| Casdoor token 不带 roles claim | U2 先验证；回退=登录时 API 查（已设计） |
| 两机公网链路 | HTTPS + ApiKey + IP 白名单（或同 VPC） |
| Novu CE 缩水/tag 断档 | 固定已验证 tag；智能层资产本地不丢，最坏退 wecom-notify 投递 |
| agent-query 切换事故 | AGENT_API_KEY 降级开关 + 非高峰切换 + 回归清单 |
| 薄同步写 Casdoor 失败 | 同步任务失败计数 + collect_fail 告警；Casdoor 不可达不阻断本地通讯录同步 |
| bulk ≤100 event | 分批（当前量级 <100/组） |
| 角色码两侧漂移 | 契约测试锁死 |
