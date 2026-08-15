# 数据分析平台完整架构文档

> **重要：所有代码实现必须严格按照此架构执行。任何架构变更必须先征得用户同意并更新此文档后再执行。**
>
> **本文档为唯一架构文档**；原 `architecture-data-collect.md` 已并入（数据采集见 §五、智能问数鉴权见 §4.2）。

---

## 系统总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          数据分析平台架构                                     │
│                          data.shanhaiyiguo.com                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户访问                                                                    │
│  ├── PC 端：企微桌面 / 浏览器                                                │
│  └── 移动端：企微 App                                                        │
│       │                                                                     │
│       ▼                                                                     │
│  nginx 网关（80/443）                                                        │
│  ├── SSL/TLS（Let's Encrypt）                                               │
│  ├── 反向代理                                                                │
│  └── 静态资源                                                                │
│       │                                                                     │
│       ├──► Next.js web（3000）                                               │
│       ├──► InsForge API（7130）                                              │
│       └──► OpenClaw Gateway（18789）                                         │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      核心服务层                                      │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  InsForge 栈                                                        │   │
│  │  ├── postgres（5432）        → PostgreSQL 数据库                    │   │
│  │  ├── postgrest（3000）       → REST API 自动生成                    │   │
│  │  ├── insforge（7130）        → 管理服务 + Edge Function 管理        │   │
│  │  └── deno（7133）            → Edge Function 运行时                 │   │
│  │                                                                     │   │
│  │  数据处理                                                           │   │
│  │  ├── duckdb（9000）          → 三角色服务（转换/计算/查询）          │   │
│  │                                                                     │   │
│  │  前端                                                               │   │
│  │  ├── web（3000）             → Next.js 应用                         │   │
│  │                                                                     │   │
│  │  Agent                                                              │   │
│  │  ├── openclaw（18789）       → 智能助手 + 自然语言查询              │   │
│  │                                                                     │   │
│  │  统一身份（2026-08-08，详见 §6）                                       │   │
│  │  └── OIDC client             → 接控制面 Casdoor（身份层，§6.1）      │   │
│  │                                  sso.shanhaiyiguo.com（控制面部署）  │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      外部服务                                        │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  数据源                                                             │   │
│  │  ├── 乐檬 API                 → 销售数据采集                        │   │
│  │  ├── 美团 API                 → 待接入                              │   │
│  │  ├── 饿了么 API               → 待接入                              │   │
│  │                                                                     │   │
│  │  企业微信                                                           │   │
│  │  ├── OAuth → Casdoor(WeCom provider) → 用户登录（身份层，§6.1）     │   │
│  │  ├── 通讯录 API               → 部门/用户同步                       │   │
│  │  └── 消息推送                 → 告警通知                            │   │
│  │                                                                     │   │
│  │  天翼云 OOS                                                          │   │
│  │  ├── Parquet 存储             → 明细数据归档                        │   │
│  │  └── 内网 endpoint             → 加速访问                            │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、InsForge 核心栈

### 1.1 PostgreSQL（postgres:5432）

**职责**：核心数据存储

**主要表结构**：

| 表名 | 用途 | 数据量 |
|------|------|--------|
| `reports` | 报表定义 | 几十条 |
| `data_files` | 数据文件元数据 | 几百条 |
| `data_sources` | 数据源配置 | 几十条 |
| `auth_credentials` | 数据源凭证（AES加密） | 几十条 |
| `collect_tasks` | 采集任务配置 | 几十条 |
| `collect_logs` | 采集执行日志 | 几千条/天 |
| `org_users` | 企业微信用户 | 几百条 |
| `org_departments` | 企业微信部门 | 几十条 |
| `data_permissions` | 数据权限配置 | 几十条 |
| `report_daily_sales` | 每日门店销售汇总 | 几百条/天 |
| `report_daily_category` | 每日品类汇总 | 几十条/天 |
| `report_weekly_trend` | 周趋势汇总 | 几百条/周 |
| `dim_item` | 商品主数据（双品牌，PK `system_book_code`+`item_num`，is_active 软删除） | 4万+ |
| `dim_item_ext` | 商品扩展（人工二次维护，采集永不碰） | 按需 |
| `item_scenario_names` | 商品场景命名映射 | 按需 |
| `canonical_product` | 跨品牌合并视图（按 `item_code` 自动聚合） | 2.5万 |
| `dim_branch` | 门店主数据（双品牌，PK `system_book_code`+`branch_num`=API system_id=明细 branch_num，is_active 软删除；**派生 `branch_number`=`sbc`-`branch_num` 全局唯一开发键**，2026-07-28） | 385 |
| `dim_branch_ext` | 门店扩展（单店级人工维护，采集永不碰） | 按需 |
| `dim_region` | 统一战区维表（品牌无关，PK `region_name`；war_zone 空→自动派生，填→覆盖） | ~20 |
| `dim_war_zone` | 战区维度（考核范围单一事实源，PK `war_zone`；`is_assessed`=东/南/西/中四战区，2026-07-29） | 8 |
| `branch_full` | 门店+战区视图（dim_branch JOIN dim_region；war_zone 统一两品牌） | 385 |

> **主数据（商品+门店）·2026-07-10**：
> - **商品**：`dim_item` 取代已废弃的 `lemeng_items`。关联键 = `item_num`（明细↔档案，实测一致）；跨品牌合并键 = `item_code`（`canonical_product` 视图按它自动聚合，双品牌 ~59% 同码合并）。采集写 base 列 + raw JSONB，扩展进独立表 `dim_item_ext`（采集绝不覆盖）。
> - **门店**：`dim_branch` 门店键 = **`(system_book_code, branch_num)` 复合**（或派生 `branch_number`=`sbc`-`branch_num`，全局唯一）。⚠️ **`branch_num` 跨账套重复（128 个共享、对应不同物理店）、非全局唯一，禁止单独 join/去重/做 PK**。`branch_num`= 明细 branch_num（实测一致）。战区 = `dim_region` 统一维表（region_name→war_zone，**两品牌合并统一管理**：东部66/西部63/南部59/中部52 + 广西/贵州宣威大区）。`dim_region.war_zone` 空→`derive_war_zone(region_name)` 按前缀派生，填→覆盖（改一处、两品牌同区域门店全生效）。门店级扩展→`dim_branch_ext`。门店→品牌归属由 `system_book_code` 决定（3120=熊喵、64188=品品甜），目标管理继承自维表、不出品牌选择器。详见 `docs/superpowers/specs/2026-07-28-store-brand-dimension-reform-design.md`。
> - 两张主数据均按 CLAUDE.md「采集任务数据完整性规则」：按品牌对账、拉取完整、upsert 失败检测、is_active 软删除、失败→collect_fail 告警。设计详见 `docs/superpowers/specs/2026-07-10-report-master-data-design.md`。

**权限模型**：
- Role：`anon`（匿名）、`authenticated`（已登录）、`admin`（管理员）
- RLS：行级安全策略，按部门过滤数据

**连接方式**：
```bash
# SSH 到服务器后
docker exec deploy-postgres-1 psql -U postgres -d insforge
```

---

### 1.2 PostgREST（postgrest:3000）

**职责**：自动 REST API 生成

**工作原理**：
- 读取 PostgreSQL schema
- 自动生成 REST API
- JWT 鉴权 → RLS 策略生效

**API 示例**：
```
GET  /reports                 → 查询报表列表
GET  /reports?id=eq.xxx       → 查询指定报表
POST /collect_logs            → 写入采集日志
```

**鉴权**：
- Header：`Authorization: Bearer <JWT>`
- JWT payload 包含：`sub`（用户ID）、`role`、`departments`（部门列表）

---

### 1.3 InsForge（insforge:7130）

**职责**：管理服务 + Edge Function 管理

**核心功能**：
- 用户/权限管理
- Edge Function CRUD
- Secret 管理
- Storage 管理
- Realtime pub/sub

**端口**：
- 内网：`insforge:7130`
- 外网：通过 nginx 反向代理

**管理界面**：仅管理员可访问（`ADMIN_USERIDS` 白名单）

---

### 1.4 Deno Runtime（deno:7133）

**职责**：Edge Function 运行时

**特性**：
- Deno 环境（CommonJS 模式）
- 60s 超时限制
- Secrets 通过 InsForge API 注入

**已部署 Function**：
| Function | 用途 | 状态 |
|----------|------|------|
| `wecom-oauth` | 企微登录 | ✅ |
| `wecom-sync-contacts` | 通讯录同步 | ✅ |

> 定时调度由 web 端 `web/lib/scheduler.ts` 承担（instrumentation 自启动 + node-cron），不使用 edge function。
> 曾有的 `functions/scheduler` 因用 ik_ key 当 Bearer 查 PostgREST（只认 JWT）必 401、长期失能，已于 2026-07-05 移除。

**注意事项**：
- `Deno.env.get()` 只能读取 function secrets，不能读取 docker-compose env
- 更新 function 后需清理缓存：
  ```bash
  docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno
  ```

---

## 二、数据处理层

### 2.1 DuckDB 服务（duckdb:9000）

**职责**：三角色数据处理服务

```
┌─────────────────────────────────────────────────────────────────┐
│  DuckDB :memory:                                                │
│  端口：9000（内网）                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  角色 1：数据转换                                                │
│  端点：POST /transform（全量覆盖）/ POST /merge（增量合并）       │
│  ├── 输入：JSON 明细数据 + 配置                                  │
│  ├── 处理：校验、去重、分片                                       │
│  ├── 输出：Parquet 写入 OOS                                      │
│  └── 状态：✅ 已实现                                             │
│                                                                 │
│  角色 2：计算引擎                                                 │
│  端点：POST /compute                                             │
│  ├── 输入：报表类型 + 日期范围                                    │
│  ├── 处理：read_parquet(OOS) → 聚合计算                          │
│  ├── 输出：结果写入 PostgreSQL                                   │
│  ├── 配置驱动：report_definitions 表定义报表                     │
│  ├── 新增报表：INSERT 配置 → 立即可用（无需改代码）              │
│  ├── GET /reports：查询可用报表列表                              │
│  └── 状态：✅ 已实现                                             │
│                                                                 │
│  角色 3：个性化查询                                               │
│  端点：POST /query                                               │
│  ├── 输入：SQL（OpenClaw 生成）                                   │
│  ├── 处理：网关建权限视图（行+列脱敏）→ read_parquet → 执行（见 §4.2）                       │
│  ├── 输出：查询结果                                               │
│  ├── 鉴权：✅ 已设计（见 §4.2）                                  │
│  └── 状态：⏳ 待实现                                             │
│                                                                 │
│  其他端点：                                                      │
│  ├── GET /health → 健康检查                                     │
│  └── GET /schema → OOS 文件列表                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**S3 配置**：
- Endpoint：`http://xinan-1-internal.zos.ctyun.cn`（内网）
- Bucket：`lemeng-datasource`

**注意事项**：
- 所有列使用 VARCHAR（避免 BigInt 类型混合）
- `CAST(COUNT(*) AS INTEGER)` 避免 BigInt 返回
- 代码在镜像内，修改后需重建镜像

---

## 三、前端层

### 3.1 Next.js Web（web:3000）

**职责**：前端应用 + API Routes

**主要页面**：

| 路径 | 用途 | 鉴权 |
|------|------|------|
| `/login` | 登录页 | 无 |
| `/auth/callback` | 企微回调 | 无 |
| `/` | PC 首页/报表列表 | JWT |
| `/reports/:id` | 报表详情 | JWT |
| `/mobile` | 移动首页 | JWT |
| `/admin/*` | 管理后台 | admin 白名单 |

**API Routes**：

| 路径 | 用途 | 鉴权 |
|------|------|------|
| `/api/admin/collect-lemeng` | 乐檬采集触发 | admin |
| `/api/admin/collect-tasks` | 任务管理 | admin |
| `/api/admin/scheduler/reload` | 调度器管理 | admin |
| `/api/auth/logout` | 登出 | JWT |

**环境变量**：

| 变量 | 用途 |
|------|------|
| `INSFORGE_API_BASE` | InsForge API 地址 |
| `INSFORGE_API_KEY` | anon_key |
| `LEMENG_SECRET_KEY` | 乐檬签名密钥 |
| `DUCKDB_URL` | DuckDB 服务地址 |
| `WECOM_*` | 企微配置 |

**定时调度**（`lib/scheduler.ts`，node-cron，Asia/Shanghai）：
- **自初始化**：server 启动时 `web/instrumentation.ts` 的 `register()` 调 `ensureSchedulerInitialized`（带退避重试），web 容器重启后 cron 不再静默停止；首次 `/api/admin` 调用兜底
- **防重入**：`runningTasks` 集合（globalThis 跨 chunk 单例），并发触发跳过
- **任务配置**：`collect_tasks` 表（schedule_cron / enabled / params / 运行时水位线 watermark）
- **零售明细两模式**：
  - 全量（full）：新一天 / 距上次全量≥55min / 无水位线 → count → 全部分页 → `/transform` 覆盖 all.parquet（每小时核对一次）
  - 增量（incremental）：其余每 5 分钟 → count → 若总数 > 水位线则从上次页（重叠 1 页）续采尾部 → `/merge` 合并去重写回
- **水位线 watermark**（写回 params）：`{ date, last_count, last_full_ts }`；仅落盘成功才推进 last_count，失败保持旧值下次多重叠；跨天 date≠今天 → 自动 full

---

### 3.2 nginx 网关

**职责**：SSL/TLS + 反向代理

**配置**：
- Let's Encrypt 自动证书
- 反向代理到 web:3000、insforge:7130、openclaw:18789
- 静态资源缓存

**企微可信域名验证**：
- `/WW_verify_*.txt` 文件

---

## 四、智能助手层

### 4.1 OpenClaw（openclaw:18789）

**职责**：Agent 服务 + 自然语言查询

**核心功能**：
- 自然语言意图解析
- SQL 生成
- 调用 DuckDB /query 执行查询
- 返回自然语言回答

**端口**：
- 内网：`openclaw:18789`
- 外网：通过 nginx 反向代理（仅管理员）

**配置**：
- Gateway token 认证
- wishub API key（模型提供商）

**集成方式**：
```
用户提问 → OpenClaw（skill 约束 SQL 书写 + tool 调用网关）
         → agent-query 网关（认证 + 授权 + 拼权限视图）
         → DuckDB /query 或 PostgreSQL（详见 §4.2）
```

### 4.2 智能问数查询与鉴权架构（已设计 + 已验证，2026-07-05）

对标业界 Text-to-SQL 治理共识（RLS + 身份注入 session + 永不信任 LLM）。权限作用于**数据范围（行级）+ 敏感列（列级）**，不限定"能问什么"，保留自由分析能力。

**完整链路：**
```
企微用户提问（FromUserId = wecom_id）
   ↓
OpenClaw（企微 channel 已接通 + DeepSeek-V4-Flash）
   ├─ skill：明细视图 schema + 汇总表清单 + DuckDB 语法 + 书写规范（"查 retail_detail 视图，不 read_parquet"）
   └─ tool query_retail_data（详见 §4.3）：POST 网关 {sql, userId=toolContext.requesterSenderId, agent_api_key}
   ↓
agent-query 网关 function（functions/agent-query，新建）
   ├─ ① 认证：AGENT_API_KEY（插件↔网关共享密钥）；userId 用于 ② 授权解析 perms（非认证）
   ├─ ② 授权：查 perms = { branch_nums, can_see_cost, hidden_columns }
   │         （底座=branch_nums；区域/人员映射后填；MVP 全量占位 ["*"]）
   ├─ ③ SQL 白名单：只 SELECT / 禁 read_parquet 与写操作 / 强制 LIMIT
   ├─ ④ 拼权限视图：行 WHERE branch_num IN (...) + 列 CASE 脱敏成本组
   ├─ ⑤ 跨引擎编排（若 JOIN 涉及 PG 维表）：用用户 JWT 查 PostgREST（走 RLS）→ 注入 DuckDB 临时表
   └─ ⑥ 审计：写 agent_query_logs（006 已建）
   ↓
DuckDB /query〔改造：每请求独立连接 + AGENT_API_KEY〕
   ├─ 独立连接 → 临时视图跨连接隔离（已实测）
   ├─ 一次提交「CREATE TEMP VIEW retail_detail AS <权限定义>; <LLM SQL>」（多语句，已实测）
   └─ 执行 → 返回（权限硬编码进视图，绕不过）
```

**行级权限（底座 = branch_nums 门店）：**
- DuckDB：权限视图 `WHERE branch_num IN ('54','127',...)`（branch_num 是 VARCHAR，已实测）
- PostgreSQL：汇总表 RLS 用 `request.jwt.claims.branch_nums`（claim 由网关代签短时 JWT 注入，复用 wecom-oauth 的 signJwt + JWT_SECRET）
- 区域/人员维度：后填。映射到 branch_nums 集合后自动生效，**不改架构**

**列级脱敏（成本/毛利成组，防反算）：**
- 敏感组：`item_cost_price` / `order_detail_cost` / `cost` / `profit` / `sale_profit_rate`；汇总侧 `total_profit`
- DuckDB：视图 SELECT 列表 `CASE WHEN {{can_see_cost}} THEN col ELSE NULL END`（已实测）
- PostgreSQL：claim 视图 `CASE WHEN current_setting('request.jwt.claims.can_see_cost')::bool THEN col ELSE NULL END`
- **必须成组脱敏**：只藏 `profit` 不藏 `sale_profit_rate`，可被 `profit = sale_money × sale_profit_rate` 反算

**agent-query 网关职责（`functions/agent-query/`，新建）：**
认证 → 授权（查 perms）→ SQL 白名单 → 拼权限视图 → 跨引擎搬运编排 → 审计。

**DuckDB /query 改造点（`services/server.js`）：**
- 每请求独立连接：`const c = db.connect()` + 内部 `SET s3_*`（新连接不继承 s3，已实测）→ 临时视图随连接天然隔离，无污染无 race
- `AGENT_API_KEY` 校验 + docker 网络隔离（仅网关容器可访问 9000）
- 多语句一次提交（`conn.all` 支持分号，已实测）

**三层 JOIN 策略：**

| JOIN 场景 | 策略 | 权限保障 |
|---|---|---|
| DuckDB 内多表（明细↔明细） | 即席 | 各表建权限视图，行 branch_nums + 列成本组脱敏（成本列来源数据注册表 `dataset_columns.is_sensitive`，§4.3） |
| PostgreSQL 内多表 | 即席 | RLS 全覆盖 |
| 跨引擎·PG 小维表 JOIN DuckDB 明细 | 即席·小表搬运 | 网关用用户 JWT 查 PG（走 RLS）→ Appender 注入 DuckDB 临时表 → DuckDB 内 JOIN |
| 跨引擎·两边大事实表 | 物化 | `/compute` 后台预算成宽表落 PG |

> **小表搬运而非 DuckDB federated**：federated 用固定服务账号连 PG、不注入 JWT claim → 绕过 RLS；搬运由网关先用用户身份查 PG（权限真实），再把已过滤子集喂给 DuckDB。约束：小表搬、大表留。已实测：JOIN 下行泄露=0、成本列全 NULL。

**验证状态（2026-07-05 服务器实测）：**
- ✅ read_parquet glob 跨品牌/日期、全 VARCHAR、CASE 列脱敏、多语句分号提交、`db.connect()` 跨连接隔离、跨引擎小表搬运 JOIN（行/列权限在 JOIN 下均 hold）
- ✅ OpenClaw 企微 channel 已接通（日志实况：ZhangDuo 真实提问）、框架成熟（tool/skill/plugin/cron）
- ✅ PG RLS + PostgREST jwt.claims（005 在跑）、网关代签 JWT（wecom-oauth 在跑）
- ⏳ PG 嵌套 claim 列脱敏视图（`request.jwt.claims.can_see_cost`）：机制标准，实现时验
- ⏳ DeepSeek-V4-Flash SQL 质量：靠 skill 优化（搁置实测）

**MVP 范围：**
- 开：DuckDB 明细自由探索（权限视图）+ PG 汇总表查询（RLS）+ 跨引擎小维表搬运 JOIN
- 不开：即席跨引擎大表 JOIN（走 `/compute` 物化）
- 后填：门店/区域/人员 → branch_nums 映射（perms 数据，不动架构）

### 4.3 OpenClaw 消费侧：全局 tool-plugin + skill + 可信 userid 注入（已实测 2026-07-05）

§4.2 的网关已就绪；本节定义**消费侧**——OpenClaw 如何让所有企微用户开箱即问、且每次查询按其身份走后端鉴权（全局生效、用户零配置、不靠 LLM 传 userId）。

**架构选型（探针实测确认）：native tool-plugin，非远程 MCP server。**
- OpenClaw 把企微可信 userid 注入 **native plugin tool 的 `toolContext.requesterSenderId`**（探针实测：用户张铎 → `requesterSenderId="ZhangDuo"`；同上下文还有 `messageChannel="wecom"`、`sessionKey="agent:main:wecom:default:direct:zhangduo"`、`deliveryContext.to="wecom:ZhangDuo"`、`sandboxed`）。
- **核心不把 sender 透传给 `mcp.servers`**（`x-openclaw-*` header 全表无 userid；`x-openclaw-wecom-userid` 是 wecom 插件专给自己 MCP server 加的）。故 query tool **必须**是 native plugin，不能是远程 MCP。
- `defineToolPlugin` 简单 `execute(params, config, {api,signal,toolCallId,onUpdate})` 第三参 context **无 sender**；**必须用 factory 形式**才能拿 `toolContext.requesterSenderId`。
- **注册形式（实测定稿）**：`definePluginEntry`（from `openclaw/plugin-sdk/plugin-entry`）+ `api.registerTool(factory, {name:"query_retail_data"})`，且 **factory 的 return 必须带 `name`**（`return {name, description, parameters, execute}`）。name 只放第二参数 → 静态 `inspect` 有 names 但运行时报 `plugin tool is malformed: missing non-empty name` → 工具**间歇对模型不可用** → 模型不调工具直接编造数据。factory 每 turn 跑，`ctx.requesterSenderId` 当轮可得。

**组件（`openclaw/data-query-plugin/`，入仓 + `openclaw plugins install -l` link 安装）：**
- `package.json`（`openclaw.extensions:["./dist/index.js"]`）+ `openclaw.plugin.json`（`id`、`contracts.tools:["query_retail_data","list_datasets"]`、`activation.onStartup:true`）+ `dist/index.js`（手写源码；`dist/` 被 .gitignore 覆盖，`git add -f` 强制入库）。
- `dist/index.js`：`definePluginEntry`（from `openclaw/plugin-sdk/plugin-entry`）+ factory 注册两个工具：① `query_retail_data(sql)`（execute 读 `toolContext.requesterSenderId` + `process.env.AGENT_API_KEY`，POST `http://insforge:7130/functions/agent-query` body `{sql, userId, agent_api_key}`）；② `list_datasets()`（POST 同网关 `mode:"dictionary"` 拉活字典）。
- `skills/retail-query/SKILL.md`：**纯规则**（绝不编造/忠于原话/日期标注/一问一查/成本列无权限=NULL）+ 明细vs汇总决策 + 引导「会话首查前调 `list_datasets` 看可用表/列」。**不再硬编码列清单/成本组/报表清单**——改由 `list_datasets` 活字典提供。

**🆕 数据注册中心 = 取数知识单一事实源（迁移 031，2026-07-10）：**
- `datasets`（name/engine[kind duckdb_view|pg_table]/source/kind[fact|summary|dim]/is_realtime/columns_typed/date_column/carry_enabled/exposed）+ `dataset_columns`（列 + `is_sensitive` 成本组 + `join_to` 关联提示）+ RPC `get_data_dictionary()`。
- **双侧运行时实时消费**（取代原先 SKILL.md + agent-query 两处硬编码）：① **引擎侧** `agent-query` 的 glob/成本列/PG 路由表改读注册表（60s 缓存，读失败回退旧硬编码值兜底，绝不线下）；路由按 `engine`（pg_table→PG）。② **LLM 侧** `list_datasets` 工具每轮拉活字典。
- **自动感知**：新增维表/报表 = `datasets` 插一行 → 两侧下一轮即见，**不改 markdown、内容变更不重部署**（插件/function 各只一次性改动）。
- 退役臆想占位 `data_sources_meta`（REVOKE 写，同 `lemeng_items` 教训）。报表聚合定义仍归 `report_definitions`（B 不重建，只在字典曝光 summary 类）。维表 `carry_enabled=false`（直接查询 OK；JOIN 进明细待 C 子系统接小表搬运后翻 true）。

**可信 userid 流（全局 + 后端按人鉴权）：**
```
企微用户提问 → wecom channel（FromUserId，可信）
  → OpenClaw 每 turn 注入 toolContext.requesterSenderId（每用户每轮，非 LLM 传）
  → query_retail_data(sql) execute：senderId + AGENT_API_KEY（容器 env，不进 LLM）
  → POST agent-query 网关 {sql, userId=senderId, agent_api_key}
  → 网关 get_user_perms(userId) → 行/列过滤 → 返回
```
- **全局**：插件 `activation.onStartup` + 装入即进 `plugins.allow` → 所有企微用户开箱可用，无需逐人配。
- **按人鉴权**：userId 由 OpenClaw 从企微可信注入，用户端零配置；改权限=改 DB，不动 OpenClaw。**两层权限（迁移 015 部门制 + 迁移 016 按人 override）**：
  - ① **部门制（默认）**：`org_departments.branch_nums/can_see_cost`，`get_user_perms` 按用户部门聚合（并集 / 任一 true）。
  - ② **按人 override（优先）**：`retail_query_user_perms(wecom_id, branch_nums, can_see_cost)`，`get_user_perms` **先查它、命中即用**（优先于部门聚合），用于不在任何已同步部门里的个人授权（如 YangWei——bot 企微应用通讯录可见范围只到总经办，同步拉不到他；且给他部门设权限会波及同事，不是"单独开"）。表无 RLS/GRANT，仅经 SECURITY DEFINER 的 `get_user_perms` RPC 可读，不对 PostgREST 直接暴露。
- **不千人千面**：权限数据在 DB，OpenClaw 侧零用户态；`AGENT_API_KEY` 留 openclaw 容器 env（`openclaw/.env`，compose `env_file` 注入），用户/LLM 均不可见。

**网络**：openclaw 容器在 `deploy_insforge-network`，直连 `insforge:7130`（内网，已实测 http=302），网关 URL 用 `http://insforge:7130/functions/agent-query`（不走公网/nginx）。

**部署注意（探针踩坑）**：`openclaw plugins install -l <path>` link 安装会写 `openclaw.json` 的 `plugins.{entries,allow,load.paths}` + 需重启容器加载；卸载 `uninstall --force` 会残留 `load.paths` 指向已删目录 → 配置无效、gateway 崩溃循环。卸后必须清 `load.paths` 或 `openclaw doctor --fix`。openclaw/ 目录 **GHA 不部署**（rsync 只推 web/scripts/database/deploy/functions/services），插件改动走手动 SSH（scp 到 `openclaw/state/plugins/` + `install -l` + restart）。

**实测运维要点（2026-07-05 落地）：**
- **wecom_mcp 拦截（已修）**：wecom 插件注册了通用 MCP 代理工具 `wecom_mcp`（调企微后台 MCP Server）。模型会把 `query_retail_data` 误当 `wecom_mcp` 的 category/method → `846610 unsupported mcp biz type` → 疯狂重试（曾致 10 分钟卡死）。skill 写"禁止 wecom_mcp"不可靠（模型非确定性）。**根治：`openclaw.json` 加 `tools.deny:["wecom_mcp"]` 硬禁**（wecom_mcp 是 tool，禁它不影响 wecom channel 收发消息）。
- **编造铁律（写进 SKILL.md）**：数据机器人头号风险是模型编造看似真实的数据。skill 最高铁律：「数据只能来自工具返回；工具没调/报错/空/无权限时必须如实说，**绝对禁止编造数字**」。malformed 导致工具不可用时模型会幻觉作答——这是触发该铁律的根因之一。
- **🔴 插件 execute 签名（端到端阻塞坑，2026-07-05 实测）**：OpenClaw 调 native plugin tool 的签名是 **`execute(toolCallId, params, signal, onUpdate)`**——**第一个参数是 toolCallId（id 字符串），第二个才是模型传的参数对象**（runtime `agent-tools.before-tool-call.js:1510`、内置工具全是 `execute(_id, params)`）。写插件**必须从第二个参数取值**：`execute: (toolCallId, params) => ...`。若误用 `(args) =>`，会把 toolCallId 当 params → 参数恒 undefined → 网关收空 body 每次必现 `missing sql/userId`（曾两度误判为模型编造，实为签名错位吃掉了模型已正确传入的 SQL）。
- **AGENT_API_KEY 注入**：openclaw 容器经 compose `environment: AGENT_API_KEY: ${AGENT_API_KEY:-}` + `AGENT_QUERY_URL` 注入，与 function secret 同源（deploy/.env）。
- **主动通知出口（统一，`openclaw/notify-plugin/`）**：OpenClaw 主动发通知经 native tool `send_notify({content, title?, touser?, msgtype?})` + `notify` skill → POST `wecom-notify` → App B 发送（§7.1.1）。plugin factory 注入 `AGENT_API_KEY` + 解析 `@sender` 收件人（复用核心注入的 `requesterSenderId`）；对话回复仍走 App C channel。
- **汇总表滞后（已临时补，定时聚合待做）**：`report_daily_sales` 等靠 `/compute`（`services/server.js`，按 `report_definitions` 配置）**按需手动**聚合、无定时任务，曾卡在 7/2 → 明细 retail_detail 实时但汇总滞后 → bot 误报"今天无数据"。skill 已注明 retail_detail 实时、汇总有延迟。/compute 定时聚合待做。
- **模型延迟**：DeepSeek-V4-Flash 经 wishub 单次 1-12s + 一个排名问题跑十几轮往返（疑似推理模型），数据查询场景偏慢；换非推理快模型才能根治。

**🟢 已修复：共享 session 跨用户数据泄漏（session.dmScope 隔离）**

**根因**：OpenClaw 的 DM 会话作用域 `session.dmScope` 默认 `main`——所有 wecom 私聊消息塌缩进同一个共享 session `agent:main:main`（这是 OpenClaw **文档化的默认行为，非 bug**；其安全文档明确警告：多用户 bot 必须改）。wecom 插件虽传 per-user sessionKey，核心按 `dmScope=main` 全部塌缩。实测 `sessions.json` 仅 `agent:main:main` 一个 key，`usageFamilySessionIds` 把 7 个 trajectory 文件（多用户消息 + 工具返回交错、含真实店名）捆成一个共享族。无权限用户 YangWei 的模型上下文里**真的出现**了全权限用户 ZhangDuo 查到的真实店名/数字，模型据此「编」出看似真实的排名。**网关层 RLS（§4.2）扛住了**（YangWei 网关侧 `user_not_found`、0 审计行）——**泄漏在 agent session 层**，上下文串台，网关挡不住。

**修复**：`session.dmScope` 设为 **`per-channel-peer`**（每个 channel+sender 一个独立 session；OpenClaw 安全文档针对「multiple people can DM the bot」场景的推荐值）。合法值：`main`（共享，默认/泄漏源）/ `per-peer`（每 sender 跨同类型 channel 一个）/ `per-channel-peer`（每 channel+sender 一个，**本场景用**）/ `per-account-channel-peer`（多账号再加 account 维度）。prod 改法：`openclaw config set session.dmScope per-channel-peer` → 重启 openclaw → 清掉被污染的旧 `agent:main:main` session（整 `sessions/` 目录隔离备份后清空，让每用户从干净状态开始；注：`sessions cleanup --fix-dm-scope` 是反向——回 `main` 时清 peer-keyed 行，不适用本方向，故整目录隔离）。

**不影响**：可信 userid 注入（`requesterSenderId`）+ §4.2 网关 RLS 是独立机制，dmScope 只管 agent 上下文分组、不改鉴权——每用户仍被网关按自己权限过滤/拒绝。可选加固：policy `ingress.session.requireDmScope=per-channel-peer` 防回退（`policy.md`）。

### 4.4 子系统 C：报表自动触发 + 问数权限闭环 + 定时应用 + carry（2026-07-11 设计）

spec：`docs/superpowers/specs/2026-07-11-report-trigger-timed-apps-design.md`。承接 A（主数据）、B（数据注册中心）。四块 + 双身份模型：

**user/service 双身份模型**：面向人的数据出口**永远带用户 perms**（OpenClaw 透传 requesterSenderId / 定时应用绑定的 run_as）；服务身份（serviceJwt，sub=agent-query，无 perms claim）只**算+写**（/compute 写 report_*、carry-dims 导出维表、读字典、写审计），**绝不直接当给人看敏感数据的出口**——只产出全量聚合/维表，再被权限裁剪。

**C0 列级闭环（补 §4.2 的 ⏳）**：report_* 原只有行级 RLS、列级成本裸奔（total_profit 对 can_see_cost=false 可见）。补安全视图 `report_*_v`（成本列按 `current_setting('request.jwt.claims.can_see_cost')` CASE 脱敏），原表收回 anon/authenticated SELECT，agent-query PG 路径改查 `_v` + B 的 costColumns 应用层兜底。明细侧维持 view builder CASE（现状）。

**C1 采集后自动 /compute（补上文「/compute 定时聚合待做」）**：scheduler retail 分支 `verified=success/partial` 后按 `params.dates` 调 duckdb-service /compute（daily_sales/category 用采集范围；weekly_trend 滚动 8 周 upsert 幂等）。**service 身份**，算全量写 report_*、查询时裁剪——无身份矛盾。失败不阻塞采集（parquet 已落），记 compute_logs + 接 collect_fail 告警。

**C2 取数路由（纯引导）**：SKILL.md 加优先级规则（能命中 report_* 汇总就别扫 retail_detail 明细），复用 B 的 list_datasets。不做网关自动重写（YAGNI）。

**C3 carry 维表（物化 parquet）**：维表 dim_*(+ext) → duckdb-service `/carry-dims`（**pgPool 读 → DuckDB COPY parquet S3，全程不 attach、DuckDB 不连 PG**）→ 查询侧 read_parquet 维表 parquet，明细按需 JOIN 维表。**定时（scheduler cron 兜底）+ 变更回调（采集维表后 / ext 编辑后）双触发**，对齐通讯录同步（§4.3 registerContactSyncJob）模式。维表 `carry_enabled` 翻 true。否决 attach（绕过 report_* 风险）与 pg_duckdb（见下）。

**C4 定时应用（OpenClaw cron + run_as + 模板/SQL 分层）**：OpenClaw cron turn **天生不带身份**（requesterSenderId 只来自 inbound，源码证实；现存「建水3店业绩」cron 已踩坑禁用）。解法在我们可控层：
- **run_as 反查**：`scheduled_reports(cron_job_id → run_as=创建者)` 绑定，后端可信会话写入。plugin 的 query_retail_data 在 requesterSenderId 空时透传 `cronSessionKey=ctx.sessionKey`（cron turn 的 sessionKey 含 `cron:<jobid>:`），agent-query parse job_id 反查 run_as → get_user_perms → 裁剪+脱敏。run_as **不在 LLM 参数**（query_retail_data.parameters 只有 sql）、钉死=创建者、scheduled_reports RLS + CHECK——三道闸封死提权。
- **模板优先/SQL 兜底**：mode=template（系统内置模板参数化 SQL 读 report_*_v，按 run_as 自动 RLS+_v 裁剪，LLM 不碰数字）/ mode=sql（LLM 写 SQL 兜底，受"绝不编造"约束）。`push_report` 强制用表里 delivery_to（堵 LLM 篡改推送目标）。

**评估否决 pg_duckdb（PG 连 DuckDB 统一引擎）**：本地容器实测——谓词下推✅（read_parquet 视图 + WHERE，scan 只读匹配行），但 read_parquet 走 DuckDB 引擎**读不到 PG GUC**（视图里 `current_setting('request.jwt.claims.*')` 报 `unrecognized configuration parameter`；纯 current_setting 查询能行只是 pg_duckdb 转发回 PG，一旦和 read_parquet 混合就读不到），列级/行级安全还是要 agent-query 应用层拼 claim（同现状），没简化权限；且生产 PG15 无现成 pg_duckdb 镜像、要动核心库。否决，carry 走物化。

---

## 五、数据采集系统

**数据源与采集任务架构（两层）：**

```
数据源（data_sources）          ← 持有鉴权：token / appid+secret（按 auth_type）
│   粒度 = (外部系统, 品牌)
├── 乐檬-3120（auth_type=bearer，token 的 company_id=3120，~5 天有效）
│   ├── 采集任务：商品档案采集     ← 共用上层 token
│   └── 采集任务：销售订单明细采集 ← 共用上层 token
├── 乐檬-64188（auth_type=bearer，token 的 company_id=64188）
│   └── 采集任务：销售订单明细采集 ← 共用上层 token
└── 金蝶（未来，auth_type=kingdee，credential_data 存 appid/secret）
    └── 采集任务：…                ← 共用上层鉴权
```

- **鉴权归属数据源**：一个 (系统, 品牌) 组合 = 一个数据源，其下所有采集任务共用该源唯一 token。杜绝「同系统拆多源、各存一份 token」导致的一活一死。
- **品牌(company)由 token 决定，非请求参数**：写在 JWT 的 `company_id` claim 里；换品牌 = 换 token（重新登录）。
- **branch_nums 传空 = 该品牌全部门店**：`[]` 返回当前 token(company) 维度全量（实测 3120=13118、64188=8134/天）。
- **多品牌 token 可同时有效**：实测切换品牌不互顶。
- **scheduler 读凭证**：按 `collect_tasks.source_id` 取 `auth_credentials`，同源任务自然共用。
- **过期时间自动派生（2026-07-09）**：`auth_credentials.expires_at` 不再手填，由 token 的 JWT `exp` claim 在保存凭证时（`web/app/api/admin/data-sources/[id]/credentials/route.ts`）自动解码派生；`token_expire` 监控独立现解 JWT `exp`、不依赖此列（双保险）。非 JWT 源（api_key/basic）无 `exp`，该列留空（本就不过期）。
- **扩展约定**：新增源类型（金蝶等）时，scheduler 按 `data_source.auth_type` 分派鉴权方式。

### 5.1 采集流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  定时触发（node-cron）                                                   │
│  └── 凌晨 2:00                                                          │
│       │                                                                 │
│       ▼                                                                 │
│  Next.js API Route                                                       │
│  ├── /api/admin/collect-lemeng                                          │
│  ├── 调用乐檬 API（分页拉取）                                            │
│  ├── 扁平化嵌套数据                                                      │
│       │                                                                 │
│       ▼                                                                 │
│  DuckDB /transform                                                       │
│  ├── 校验必填字段                                                        │
│  ├── 去重（order_no + order_detail_num）                                 │
│  ├── 按门店分片                                                          │
│  ├── 写入 OOS Parquet                                                   │
│       │                                                                 │
│       ├──► DuckDB /compute（自动触发）                                   │
│       │        │                                                        │
│       │        └──► PostgreSQL 汇总表                                    │
│       │                                                                 │
│       └──► 写入 collect_logs                                            │
│                                                                         │
│  对账重试：3 次                                                          │
│  ├── 不完整 → 5秒后重试                                                  │
│  ├── 3次均失败 → 企微告警                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 数据存储分层

| 层级 | 存储 | 数据 | 查询频率 |
|------|------|------|----------|
| **冷数据** | OOS Parquet | 明细数据（几万条/天） | 低（按需） |
| **热数据** | PostgreSQL | 汇总结果（几百条/天） | 高（分钟级） |

---

## 六、鉴权系统

### 6.1 登录流程（身份/权限分层，2026-08-08 架构变更）

> **核心原则——身份层与数据权限层分离**：
> - **身份层（Casdoor 统一）**：Casdoor（`sso.shanhaiyiguo.com`，独立子域名，复用现有 postgres）作为统一身份 IdP，持有企微 WeCom provider，负责"这人是谁（`wecom_id`）+ SSO 会话"。后续每接一个系统只需在 Casdoor 注册一个 OIDC client，不重复对接企微 API。
> - **数据权限层（data-analysis 自签）**：data-analysis 拿到 `wecom_id` 后，自查本地 `org_users` / `get_user_perms`（`departments`、`branch_nums`、`can_see_cost`），**自签 PostgREST JWT**（复用现有 `signJwt` + `JWT_SECRET`）。
> - **零改动**：`JWT_SECRET`、PostgREST 验签、PostgreSQL RLS 策略、权限表全部不变。这些是 data-analysis 特有的细粒度数据权限（非标准身份字段，塞不进任何标准 IdP 的 token），故必须保留在自签 JWT 里。

```
┌─────────────────────────────────────────────────────────────────────────┐
│  身份层（Casdoor，sso.shanhaiyiguo.com）                                  │
│  用户访问 → middleware 检查 cookie，无 → 跳 Casdoor /authorize            │
│  Casdoor 检查自身 SSO 会话：                                             │
│  ├── 有会话 → 静默回调（不再碰企微，跨系统 SSO 体现）                     │
│  └── 无会话 → 跳企微 WeCom provider：                                    │
│        ├── 企微内（Silent / snsapi_base 静默）                           │
│        └── PC 外（Normal / 扫码）                                        │
│      → Casdoor 建/更用户（wecom_id）→ 建 Casdoor 会话                     │
│  → 回调 data.shanhaiyiguo.com/auth/callback?code=<Casdoor code>          │
│       │                                                                 │
│       ▼                                                                 │
│  数据权限层（data-analysis 自签 JWT）                                    │
│  web callback → functions/wecom-oidc-callback：                         │
│  ├── Casdoor code → /token → /userinfo（sub=wecom_id）                  │
│  ├── upsert org_users                                                   │
│  ├── 查 get_user_perms（branch_nums / can_see_cost 等）                 │
│  └── 自签 PostgREST JWT（现状 claims 结构 + JWT_SECRET，不变）           │
│       │                                                                 │
│       ▼                                                                 │
│  callback 页面                                                           │
│  ├── 写 httpOnly cookie（insforge_access_token）                        │
│  └── 写 localStorage（userid 展示）                                      │
│       │                                                                 │
│       ▼                                                                 │
│  middleware 检查 cookie → 有则继续访问                                    │
│  后续 PostgREST 请求：验 JWT_SECRET（不变）→ RLS（不变）                  │
└─────────────────────────────────────────────────────────────────────────┘
```

**WeCom provider 双模式**（Casdoor provider 级 `method` 是单值，故配两个 provider 都指向 App A）：
- `wecom_silent`（Silent）：企微内静默（`snsapi_base`）。App A 登录凭证（`WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET`）已挪入 Casdoor 此 provider，`functions/wecom-oauth` 的登录职责由 `functions/wecom-oidc-callback` 取代。
- `wecom_scan`（Normal）：PC 外部扫码。

> `functions/wecom-oauth` 的 `signJwt` 能力仍被 `agent-query` 网关复用（§4.2），文件保留不删。
>
> 端到端企微登录验证待部署后进行（Casdoor WeCom provider 源码已实测 + postgres 部署已验证；公网 `sso` 域名 + 企微可信域名配置属部署后验证）。

### 6.2 PostgreSQL RLS 鉴权

```
企微通讯录同步 → 用户归属部门
     ↓
登录时 JWT 携带 departments 字段
     ↓
PostgREST 请求带 Authorization: Bearer <JWT>
     ↓
PostgreSQL RLS 策略
     ↓
WHERE departments ?| current_setting('request.jwt.claims.departments')
     ↓
数据库层强制隔离
```

**权限表**：
- `org_users`：用户信息 + department_ids（+ wecom_id 企微映射）
- `org_departments`：部门信息 + branch_nums（可访问门店，**智能问数权限底座**）+ allowed_regions/data_scope（006 预留）
- `data_permissions`：部门权限配置（通用 ABAC，待启用）
- 智能问数 perms = `{ branch_nums, can_see_cost }`：详见 §4.2

### 6.3 DuckDB /query 鉴权

详见 §4.2「智能问数查询与鉴权架构」。

核心：网关按身份建**临时权限视图**（行 `branch_nums` + 列成本组脱敏），硬编码进视图定义；LLM 生成的 SQL 在视图上执行，引擎层强制、不可绕过。`/query` 改每请求独立连接实现视图隔离；PostgreSQL 侧走真 RLS（`request.jwt.claims.branch_nums`，网关代签短时 JWT 注入）。

---

## 七、外部服务集成

### 7.1 企业微信（三应用隔离，2026-07-07）

同一 corp（`ww8252c1eee248867c`）下三个自建应用，职责隔离：

| 应用 | 可见范围 | 用途 | secret |
|---|---|---|---|
| **App A · 报表应用**（Agent 1000008） | 仅有权限的人 | OAuth 登录（**凭证迁 Casdoor WeCom provider，§6.1**）+ 报表页展示（软门禁） | `WECOM_SECRET`（已挪 Casdoor provider；本仓 `deploy-functions.sh` 不再注入登录用） |
| **App B · 同步/通知应用**（新建） | **全部成员** + 通讯录读取 | ① 通讯录全量同步 ② 统一消息通知 | `WECOM_OPS_SECRET` / `WECOM_OPS_AGENT_ID` |
| **App C · OpenClaw bot** | 按需 | OpenClaw 对话 channel（收发 DM） | openclaw 容器 env（不在 web 管辖） |

- App A 可见范围 = 报表授权人，作报表访问软门禁；App B 全员可见 + 通讯录读取权限（同步全量的**前提**，否则 `department/list`、`user/list` 只返可见范围子集）。
- **App B「企业可信 IP」必须加服务器出口 IP**（新建应用默认空，2026-07-07 踩坑）：否则 `department/list`、`user/list`、`message/send` 从服务器调全报 `errcode 60020 not allow to access from your ip`（通讯录同步 + 统一通知都吃这个限制，App A 早加过所以无感）。当前服务器出口 IP `113.249.120.84`。**加新企微应用必做**。
- 历史 `WECOM_CONTACTS_SECRET` 已废（代码从未读取，死配置已清）。

**功能矩阵：**
| 功能 | API | 走哪个应用 | 状态 |
|------|-----|-----------|------|
| 登录 OAuth | `/cgi-bin/oauth2/authorize` | App A（经 Casdoor WeCom provider，§6.1） | ✅ |
| 用户信息 | `/cgi-bin/auth/getuserinfo` | App A（经 Casdoor WeCom provider，§6.1） | ✅ |
| 通讯录全量同步（兜底） | `/cgi-bin/department/list`、`/cgi-bin/user/list` | App B | ✅（每日 03:17 全量兜底，详见 §7.1.2） |
| 通讯录实时同步 | `change_contact` 回调（create/update/delete_user、create/update/delete_party） | **通讯录同步功能（非应用）** | 🆕 `web/app/api/wecom-contacts-webhook/route.ts`（详见 §7.1.2） |
| 消息通知（统一） | `/cgi-bin/message/send` | App B（`functions/wecom-notify`） | ✅ |
| OpenClaw 对话 | 回调收消息 + 主动消息 | App C | ✅ |

> 2026-08-08 起：登录 OAuth + 用户信息两条由 Casdoor 的 WeCom provider 调用（凭证挪入 Casdoor），data-analysis 不再直连企微登录 API；App B / App C 调用方不变。

### 7.1.1 统一消息通知服务（`functions/wecom-notify`，2026-07-07）

所有系统告警/通知收口到一个 edge function，用 App B 发送。凭据（App B secret）单点存于 function secret。

```
web（scheduler / collect-lemeng）─┐  AGENT_API_KEY   ┌─────────────────┐  WECOM_OPS_SECRET  ┌─────────┐
OpenClaw（主动通知）──────────────┴─ POST /functions/wecom-notify ─►│ gettoken(App B) │─────────────────────►│ 企微 App B│ → 员工
                                  {agent_api_key, content, title?,   │ message/send    │                     └─────────┘
                                   touser?, msgtype?}                └─────────────────┘
```

- **接口**：`POST /functions/wecom-notify`，body `{ agent_api_key, msgtype, content?, title?, url?, touser?, articles?, template_card?, mentioned_list? }`，鉴权 `agent_api_key === AGENT_API_KEY`。`msgtype` 支持 `text`（可 @）/ `markdown` / `textcard`（可点击）/ `news`（图文，带图）/ `template_card`（模板卡片，含 text_notice/news_notice/button_interaction/vote_interaction/multiple_interaction）—— 覆盖企微应用消息全部常用类型；`image/voice/video/file/mpnews` 不支持（需 media 上传流水线，带图改用 `news.picurl`）。
- **默认收件人**：secret `NOTIFY_DEFAULT_TUSERS`（`|` 分隔），替代历史写死的单 `ZhangDuo`。
- **调用方**：web `notifyWecom`（薄客户端，经 `@insforge/sdk` invoke）、OpenClaw 主动通知（复用 `AGENT_API_KEY`）。
- **限**：token 每次现取（告警量低，可接受）；InsForge 挂则告警发不出（其挂即大故障）。

### 7.1.2 通讯录实时同步（回调 + 兜底全量，2026-07-08）

全量拉取延迟大（且此前无自动调度）；企微"邀请→微信昵称→实名"等字段漂移需实时纠正。**单一机制都不够**：回调可能丢消息、且 `update_user` 不保证覆盖所有字段变更；全量有延迟。故采用**回调（实时增量）+ 每日全量（兜底自愈）双轨**，互为补偿。

> ⚠️ **回调接收走 web/api，不走 InsForge function**（2026-07-08 踩坑）：InsForge gateway(7130) 对 function 请求 body 按 content-type 协商，**raw text/XML 被吞成 `{}`**（仅 JSON 正常），所有 function 共用此 gateway。企微通讯录回调是 XML，经 function 收不到事件。故回调接收用 `web/app/api/wecom-contacts-webhook/route.ts`（Next.js Route Handler，标准 Web Request API 读 raw body）。详见 memory `insforge-function-body-limit`。

```
企微通讯录变更（入职/离职/改部门/部门变更）
   │ POST 加密XML（msg_signature + timestamp + nonce + <Encrypt>）   Token / EncodingAESKey
   ▼                                                                  仅企微与系统知晓
https://data.shanhaiyiguo.com/api/wecom-contacts-webhook   ← nginx location → web:3000（不经 InsForge）
   │ web/app/api/wecom-contacts-webhook/route.ts（Next.js Route Handler, Node runtime）
   ├─ GET  企微 URL 验证：校签名 → AES 解密 echostr → 返明文
   ├─ POST 事件：await request.text() 读 raw XML → 校签名 → AES 解密 → 解析 → 按 ChangeType 分派：
   │     create/update_user  → user/get(userid) 拉权威快照 → upsert org_users(is_active=true)
   │     delete_user         → org_users SET is_active=false（人已删，无法 get）
   │     create/update_party → upsert org_departments
   │     delete_party        → org_departments SET is_active=false
   │   5s 内返 "success"
   ▼
org_users / org_departments（is_active 软删除）— web 经 @insforge/sdk + ANON_KEY 写（不签 JWT，web 可信服务端）

每日 03:17（web instrumentation cron）
   ▼
functions/wecom-sync-contacts（兜底全量；JSON 调用，不受 body 限制）
   全量 user/list → upsert + 按"企微现状"对齐 is_active（企微没有的人标离职）→ 纠正一切回调漏的漂移
```

- **加解密**（企微 WXBizMsgCrypt 协议，Node `crypto.subtle`）：AES key = `base64decode(EncodingAESKey+"=")`（32B），IV = key 前 16B，AES-256-CBC（`subtle.decrypt` **已自动去 PKCS7 padding，勿再手动 unpad**——2026-07-08 踩坑）；解密结构 `16B随机 + 4B长度 + msg + receiveid`，校验 receiveid == `WECOM_CORP_ID` 防伪造；签名 `sha1(sort([token,timestamp,nonce,encrypt]))` == msg_signature。POST body 是 `text/xml`，`request.text()` 读 raw + 手解析。
- **回调只当通知，字段以 `user/get` 快照为准**：`update_user` 回调只带变化字段且不保证触发（典型如"微信昵称→实名"），故 create/update_user 一律补 `user/get(userid)` 拉全量再 upsert。`delete_user` 例外（直接软删）。
- **name 一致性**：name 永远以最新同步值 upsert 覆盖，不区分昵称/实名（判断不可靠）；全量快照是最终一致性来源，纠正回调漏的一切字段漂移。
- **软删除**：`org_users` / `org_departments` 加 `is_active BOOLEAN DEFAULT TRUE`，离职 / 删部门标 false 保留行（保历史 + 不破坏 `retail_query_user_perms` 关联，登录拦已离职）。
- **secrets（注入 web 容器 compose env）**：`WECOM_TOKEN` / `WECOM_ENCODING_AES_KEY`（回调验证解密，企微后台「通讯录同步→API接口同步」生成）/ `WECOM_CORP_ID`（已有）/ `WECOM_OPS_SECRET`（user/get，App B）。route 经 `process.env` 读。
- **nginx 路由**：加 `location /api/wecom-contacts-webhook → web:3000`（前缀长于 `/api` 兜底，nginx 最长前缀匹配优先），否则 `/api` 兜底送到 insforge:7130 又踩 body 限制。
- **幂等 + 5s 超时**：upsert 与 `SET is_active` 天然幂等，企微重试安全；处理 < 600ms，5s 内必返。
- **回调 URL**：`https://data.shanhaiyiguo.com/api/wecom-contacts-webhook`（企微后台「通讯录同步」填，会先 GET 验证才允许保存）。
- **限**：依赖企微回调可达 + 企微「通讯录同步」功能已开启；回调漏的消息靠每日全量兜底（最长次日纠正）。`functions/wecom-contacts-webhook` 废弃（逻辑移至 web/api）。

### 7.2 乐檬数据源

**API 地址**：`https://sharef.lemengcloud.com`

**签名算法**：
```
SHA256(auth + timestamp + nonce + branch_nums + scope_ids + SECRET_KEY + url + body + SECRET_KEY)
```

**Secret Key**：`LEMENG_SECRET_KEY`

**采集接口**：
| 接口 | 用途 |
|------|------|
| `/earth-gateway/.../findposorderdetail` | 订单明细 |
| `/earth-gateway/.../countposorderdetail` | 订单计数 |

### 7.3 天翼云 OOS

**配置**：
- Endpoint（内网）：`http://xinan-1-internal.zos.ctyun.cn`
- Endpoint（外网）：`http://xinan-1.zos.ctyun.cn`
- Bucket：`lemeng-datasource`
- Access Key：`OOS_ACCESS_KEY`
- Secret Key：`OOS_SECRET_KEY`

**存储结构**（按品牌 company_id 分区）：
```
lemeng-datasource/
└── lemeng/retail_detail/{company_id}/{date}/   ← company_id 从 token payload 解出
    ├── all.parquet              → 该品牌当日全部明细（权威文件）
    ├── branch_num_*.parquet     → 门店分片
    └── _quarantine.parquet      → 校验异常数据
```
- 按品牌分区：各品牌采集各写各的文件，杜绝跨品牌 /merge 写竞争、order_no 跨品牌歧义
- 跨品牌查询用 glob：`read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/{date}/all.parquet')`
- 历史数据（2026-07-04 的 3120）曾写在无 company_id 的旧路径，已迁移或由下次全量核对重写

---

## 八、运维与监控

### 8.1 监控告警体系（2026-07-08 设计，详见 `docs/superpowers/specs/2026-07-08-monitoring-system-design.md`）

**引擎拓扑**：复用 web 端 node-cron（`web/lib/scheduler.ts`），新增「监控扫描」调度，不新增容器/function。扫描按 check_type 自然节奏分桶：每分钟 `service_down` / 每 5 分钟 `collect_fail`·`request_fail`·`token_expire` / 每小时 `data_freshness`·`contact_sync` / 每日 `data_integrity`。防重入复用 scheduler 现有 globalThis 锁。

**数据模型**（新表）：
- `monitor_rules`：规则定义（check_type 枚举 + target + threshold(jsonb) + severity + touser + template + suppress_window + enabled）。
- `monitor_alerts`：告警状态/事件（`alert_key` UNIQUE → 同问题一行；status active/resolved；first/last_seen；occurrence_count；last_notify_at；context）。降噪与恢复核心。
- `external_request_logs`：`callLemengApi` 每次调用埋点，`request_fail` 数据源（>7 天清理）。
- ⚠️ 前置修复：`collect_logs` 加 `duration_ms`/`response_summary`（现代码写这两列但表没有，写入静默失败、大盘耗时列恒空）。

**七个 check_type**（每个一个纯函数 evaluator：读数据源 → 比 threshold → 产出 firing/alert_key/context）：
| check_type | 数据源 | 触发 |
|---|---|---|
| `token_expire` | `auth_credentials` JWT，解 payload `exp` | 剩余 < before_hours；token 缺失/无法解析也 firing（evaluator 给 `message` 覆盖模板，避免静默"恢复"致盲） |
| `collect_fail` | `collect_logs` | 连续失败 ≥ consecutive |
| `request_fail` | `external_request_logs` | 窗口失败率 > failure_rate |
| `service_down` | 主动探活 web/duckdb/insforge/postgres/deno/openclaw（应用级，5s 超时） | 任一不可达 |
| `data_freshness` | PG 汇总表 + DuckDB parquet 最新日期 | 距今 > stale_hours |
| `data_integrity` | DuckDB 明细 count vs PG 汇总 | 差异率 > diff_rate |
| `contact_sync` | `org_users.updated_at` + 回调最近时间 | 距上次同步 > max_age_hours |

**告警生命周期**：firing → upsert `monitor_alerts`(active) + `occurrence_count++`；`suppress_window`（默认 30min）内不重复发；问题消失 → 转 resolved + 发「已恢复」。规则改阈值/收件人/模板/级别/开关走表，不发版。

**通知出口（主 + 兜底）**：
- 主通道：复用 `functions/wecom-notify`（App B，凭据单点；web 薄客户端 `lib/notify.ts` → `notifyWecom()`）。
- **兜底通道（关键）**：`service_down` 探到 InsForge 不可达时，wecom-notify 也发不出（它跑在 InsForge 上）→ web `notifyWecomDirect()` 用 `WECOM_OPS_SECRET` 直连企微 `message/send` 绕开 InsForge。仅此一条路径直连。
- InsForge 不可达 = 大故障，兜底通道是唯一能让外界知道它挂了的手段。

**只读大盘**：新建 `/admin/monitor`（实时活跃告警 + 事件流 + 7 类健康灯 + 采集日志），走 PostgREST 只读。

**v1 非目标**：任意表达式规则引擎、规则 CRUD UI、值班/升级/静默时段、指标时序存储、自愈。

### 8.2 日志查看

```bash
# InsForge 日志
docker logs deploy-insforge-1 --tail 50

# DuckDB 日志
docker logs deploy-duckdb-1 --tail 50

# Web 日志
docker logs deploy-web-1 --tail 50

# Deno 日志
docker logs deploy-deno-1 --tail 50
```

### 8.3 常用运维命令

```bash
# 重启服务
docker compose restart <service>

# 清理 Deno 缓存（更新 function）
docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno

# 数据库操作
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "<SQL>"
```

---

## 九、已确认的架构决策

| 决策项 | 确认结果 | 确认日期 |
|--------|---------|---------|
| InsForge 核心栈部署 | docker-compose 编排 | 早期 |
| PostgREST 自动 API | 已启用 | 早期 |
| DuckDB 单服务三角色 | 转换/计算/查询 | 2026-07-04 |
| 定时调度位置 | node-cron（Next.js 内） | 2026-07-04 |
| 采集逻辑位置 | Next.js API Route | 早期 |
| 明细数据存储 | OOS Parquet（60天） | 2026-07-04 |
| 汇总数据存储 | PostgreSQL | 2026-07-04 |
| 报表查询 | PostgreSQL + PostgREST | 2026-07-04 |
| PostgreSQL 鉴权 | RLS + 部门 ID | 早期 |
| DuckDB /query 鉴权 | 权限视图（行+列脱敏）+ 每请求独立连接 | 2026-07-05 |
| OpenClaw 集成 | skill+tool → agent-query 网关 → /query | 2026-07-05 |
| 跨引擎 JOIN 策略 | 同引擎即席 / 跨引擎小表搬运 / 大表物化 | 2026-07-05 |
| 鉴权归属 | 数据源层（同源任务共用一 token），非任务层 | 2026-07-04 |
| 数据源粒度 | (外部系统, 品牌)。乐檬每品牌一个数据源 | 2026-07-04 |
| 品牌(company)归属 | 由 token 的 JWT `company_id` 决定，非请求参数 | 2026-07-04 |
| 多品牌 token 共存 | 已实测：切换品牌不互顶 | 2026-07-04 |
| branch_nums 取值 | 传空 `[]` = 该品牌全部门店 | 2026-07-04 |
| OOS 存储 | 按品牌分区 `retail_detail/{company_id}/{date}/` | 2026-07-04 |
| 零售明细采集模式 | 当天数据、8-24 点每 5 分钟增量 + 每小时全量核对 | 2026-07-04 |
| scheduler 自初始化 | instrumentation `register()` 启动时初始化（globalThis 单例） | 2026-07-04 |
| 企微应用拓扑 | 三应用隔离：报表/同步通知/bot 各一 | 2026-07-07 |
| 统一通知服务 | edge function `wecom-notify`（App B，凭据单点） | 2026-07-07 |
| 监控告警体系 | 复用 web node-cron + 结构化规则表(monitor_rules) + 状态表(monitor_alerts)；7 个 check_type；wecom-notify 主通道 + web 直连企微兜底(InsForge-down) | 2026-07-08 |
| 统一身份 IdP | Casdoor（独立子域名 `sso.shanhaiyiguo.com`，WeCom Internal provider 双模式 Silent+Normal）；App A 登录凭证挪入 Casdoor provider | 2026-08-08 |
| 身份/权限分层 | Casdoor 管身份（`wecom_id`）+ SSO 会话；data-analysis 拿 `wecom_id` 后自查 `perms` 自签 PostgREST JWT（`JWT_SECRET` / RLS / 权限表不变） | 2026-08-08 |
| Casdoor 独立化 | Casdoor 从 data-analysis 寄生迁到控制面（113.249.101.33 `/opt/casdoor`，独立 docker compose + **独立 postgres**），成平台级身份基础设施；data-analysis 退化为普通 OIDC client；Caddy 反代 sso 域名（specs/2026-08-09-casdoor-independent-design.md） | 2026-08-09 |
| 代码组织规范 | A+B-lite：目录即模块（collectors/jobs/report-center-boards）+ 尾部追加式注册表 + 契约单源（web/lib/contracts）；不引入运行时插件框架、不拆服务、不改部署拓扑。P0–P5 分阶段（spec `docs/superpowers/specs/2026-08-11-modular-plugin-design.md`，评审 `docs/design/modular-plugin-architecture-review.md`） | 2026-08-11 |
| 语义层 Cube 全替代 | Cube headless 成为查询引擎与语义定义唯一手写层（schema YAML，git）；metric_registry 冻结新增、生成器按"物化上移 + 退役清单"退出（四硬口径移 /compute 跑批）。**已确认的三条让步**：报表可用性绑 Cube 常驻（迁移期保留视图逃生通道）；报表路径行级权限由 RLS 上移至 securityContext（data_scopes 同源，RLS 退守 PostgREST 管理路径）；QA 围绕 /v1/sql + 对账 diff 重建。spec `docs/superpowers/specs/2026-08-15-semantic-query-middleware-design.md`（v2）。关联同日权限三层、Novu 推送平台两 spec | 2026-08-15 |

---

## 十、配置驱动的报表系统

### 10.1 设计理念

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         新增报表对比                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  旧方式（硬编码）                                                        │
│  新增报表 → 修改 server.js → docker build → push → 部署  ❌             │
│  耗时：10-20 分钟                                                        │
│                                                                         │
│  新方式（配置驱动）                                                      │
│  新增报表 → INSERT report_definitions → 立即生效         ✅             │
│  耗时：1 分钟                                                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 10.2 report_definitions 表结构

```sql
CREATE TABLE report_definitions (
    id SERIAL PRIMARY KEY,
    report_type VARCHAR(50) UNIQUE NOT NULL,    -- API 参数标识
    name VARCHAR(100) NOT NULL,                  -- 中文名称
    target_table VARCHAR(100) NOT NULL,          -- PostgreSQL 目标表
    source_pattern VARCHAR(200) NOT NULL,        -- S3 数据源路径
    sql_template TEXT NOT NULL,                  -- 聚合 SQL（支持占位符）
    field_mapping JSONB NOT NULL,                -- 字段映射 + 类型转换
    date_column VARCHAR(100),                    -- 数据源日期列
    date_format VARCHAR(20) DEFAULT 'YYYYMMDD',  -- 日期格式
    conflict_keys JSONB DEFAULT '[]',            -- UPSERT 冲突键
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 10.3 占位符系统

| 占位符 | 替换内容 | 示例 |
|--------|---------|------|
| `{{source_pattern}}` | 数据源路径 | `s3://lemeng-datasource/lemeng/retail_detail/**/*.parquet` |
| `{{date_column}}` | 日期列名 | `order_detail_bizday` |
| `{{date_from}}` | 开始日期（YYYY-MM-DD） | `2026-07-02` |
| `{{date_to}}` | 结束日期（YYYY-MM-DD） | `2026-07-02` |
| `{{date_from_compact}}` | 紧凑开始日期 | `20260702` |
| `{{date_to_compact}}` | 紧凑结束日期 | `20260702` |

### 10.4 字段映射格式

```json
{
  "parquet_column": {
    "pg_column": "pg_column_name",           -- PostgreSQL 列名
    "type": "VARCHAR|INTEGER|DECIMAL(12,2)", -- 类型（可选）
    "transform": "YYYYMMDD_to_YYYY-MM-DD"    -- 转换函数（可选）
  }
}
```

### 10.5 已配置报表

| report_type | 名称 | 目标表 | 状态 |
|-------------|------|--------|------|
| daily_sales | 每日门店销售汇总 | report_daily_sales | ✅ |
| daily_category | 每日门店品类汇总 | report_daily_category | ✅ |
| weekly_trend | 周销售趋势汇总 | report_weekly_trend | ✅ |

### 10.6 新增报表示例

**前提：先创建目标表**

```sql
CREATE TABLE report_daily_supplier (
    biz_date DATE NOT NULL,
    supplier_name VARCHAR(100) NOT NULL,
    total_sale DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (biz_date, supplier_name)
);
```

**插入报表配置**

```sql
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, conflict_keys
) VALUES (
    'daily_supplier',
    '每日供应商汇总',
    'report_daily_supplier',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    -- SQL 模板（$SQL$ 避免转义）
    $SQL$
    SELECT
        order_detail_bizday as biz_date_raw,
        supplier_name,
        CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale
    FROM read_parquet('{{source_pattern}}')
    WHERE order_detail_bizday BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
      AND supplier_name IS NOT NULL
    GROUP BY order_detail_bizday, supplier_name
    $SQL$,
    -- 字段映射
    '{"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},
      "supplier_name":{"pg_column":"supplier_name"},
      "total_sale":{"pg_column":"total_sale","type":"DECIMAL(12,2)"}}'::jsonb,
    'order_detail_bizday',
    '["biz_date","supplier_name"]'::jsonb
);
```

**立即可用**

```bash
POST /compute {"report_type":"daily_supplier","date_from":"2026-07-02","date_to":"2026-07-02"}
```

### 10.7 端点说明

| 端点 | 方法 | 功能 |
|------|------|------|
| `/reports` | GET | 查询可用报表列表 |
| `/compute` | POST | 执行报表计算（从配置读取） |

### 10.8 目标与达成子系统（Bottom-Up 流程，2026-08-01 重构）

**创建流程（Bottom-Up）**：

```
新建目标（仅名称+时间）
    ↓
门店分解（手填→自动汇总到总目标）
    ↓
品类分解（校验：出库总 ≥ 门店配送汇总）
    ↓
完成（两类分解独立，无强依赖）
```

**核心改动（相比旧版）**：
- **新建目标简化**：只填名称+时间，不预填总目标值（Task 3）
- **门店分解自动汇总**：各门店目标值自动 SUM→total，total 不可手填（现有逻辑）
- **品类分解新增校验**：出库总目标 ≥ 门店配送汇总（Task 4），不满足报错提示
- **类别子目标独立存储**：`targets` 表新增 `category` 列（三类：水果/标品/耗材），品类分解行单独存储

**两类分解独立共存**：

| 板块 | 分解维度 | 指标 | 校验 |
|------|---------|------|------|
| 门店板块 | `branch_num` | `sale`/`delivery` | 子目标 SUM = 总目标（现有） |
| 总部板块 | `category` | `outbound_amt`/`outbound_profit` | 出库总 ≥ 门店配送汇总（Task 4） |

**targets 表关键字段**：
- `id` — 主键
- `name` — 目标名称（必填）
- `start_date`/`end_date` — 时间范围（必填）
- `system_book_code` — 品牌（默认 '3120'，从 dim_branch 继承）
- `category` TEXT — 品类分解值（'水果'/'标品'/'耗材'），门店分解行与总目标行为 NULL
- `branch_num` TEXT — 门店分解值，品类分解行与总目标行为 NULL
- `target_type` TEXT NOT NULL DEFAULT 'store' — 'hq'/'store'（历史字段，保留兼容）
- UNIQUE `(system_book_code, target_type, branch_num, category, start_date, end_date)`

**指标口径**（`metric_registry` AST 定义，迁移 124）：

| metric_code | 名称 | 口径（formula_ast） |
|---|---|---|
| `sale` | 销售 | `SUM(report_daily_sales.total_sale)` |
| `delivery` | 配送 | `SUM(report_daily_delivery.delivery_amount)` |
| `outbound_amt` | 出库金额 | `SUM(delivery_amount) + SUM(wholesale_amount)` |
| `outbound_profit` | 出库毛利 | `SUM(delivery_profit) + SUM(wholesale_profit)` |

**品类分组**：三类（水果=生鲜、标品=标品+废弃档案+广西柳州、耗材=包装耗材+运费/仓储），映射 `dim_item.category_l1`（见迁移 067）。

**RPC**（SECURITY DEFINER）：
- `upsert_target_total(p_name,p_start,p_end,p_by)` — 新建目标（仅名称+时间，Task 3 简化）
- `upsert_target_breakdown(p_parent_id,p_rows,p_by)` — 门店分解（rows:[{branch_num,metrics}]，自动 SUM→total）
- `upsert_hq_category_breakdown(p_parent_id,p_rows,p_by)` — 品类分解（rows:[{category,metrics}]，校验 outbound ≥ delivery）
- `check_breakdown_balance(p_parent_id)` — 校验子和=总（两类通用）

**类别汇总视图**（`report_category_summary_gen`，生成器产出，见 §10.10）：按品牌×类别×月聚合 `outbound_amt`/`outbound_profit`，由 `services/semantic-generator/src/hierarchy.ts` 生成，符合反自由发挥约束。

**权威术语表**：
- sale = 销售（门店维度）
- delivery = 配送（门店维度）；**不再叫"出库"**
- wholesale = 批发
- outbound_amt = 出库金额（= 配送 + 批发，总部总仓全部出货）
- outbound_profit = 出库毛利
- 配销比 = 配送/销售

### 10.10 视图生成器（构建期，2026-07-31）

> **⚠️ 退役计划（2026-08-15，spec 待合并）**：本节所述生成器进入退役流程——metric_registry 冻结新增，新指标一律直写 Cube schema（`docs/superpowers/specs/2026-08-15-semantic-query-middleware-design.md` §6 退役清单）。四个硬口径（目标范围 join / lateral_pick / FULL JOIN 合并 / closed 快照）逐步物化上移到 /compute 后，对应生成视图删除；清单清空即下线生成器与 database/generated。退役完成前本节铁律继续有效。

spec：`docs/superpowers/specs/2026-07-31-semantic-layer-generator-wiring-design.md`。回归 07-22 初衷补建构建期生成器（**取代 07-29 的「文档型真相源」措辞**——metric_registry 从"文档型"升级为"构建期生成器输入"）。

- **形态**：Node/TS 脚本 `services/semantic-generator/`，读 `metric_registry`+`metric_sources`+`dimensions`，产出静态视图 SQL 到 `database/generated/`（入 git，可 review 可回滚）。
- **不做运行时动态引擎**（07-22 已 YAGNI，理由：RLS/security_invoker 兼容、可审计、避免外部重型服务）。
- **两档能力**：Tier1（base 聚合 + additive derived + 率重算 + cost脱敏 + target join + date grain 时间序列）；Tier2（窗口派生：daily/remaining/profit_rate）。
- **date grain（2026-08-02 架构扩展）**：`dim_code='date'` 支持 biz_date 时间序列 grain（行=日期）。date 维度无 dim_table（biz_date 是 fact 表列），target_window join 用 `BETWEEN start_date AND latest_day`（罗列至当日，非全周期 end_date）-- 用于外部批发客户出库日报等时间序列看板。属生成器能力扩展（新 dim_code），非某指标特殊处理，符合铁律第2条。
- **extra_grain（2026-08-02 架构扩展）**：`ViewConfig.extra_grain?: string[]` 支持 actual CTE 加额外 GROUP BY 列（如 `['s.biz_date']`），实现双 grain（如 日期 × 客户）。用于外部批发日报·日期下钻客户明细（`report_wholesale_daily_customer_gen`，dim_code='customer' + extra_grain biz_date，每行=该天该客户）。属通用能力扩展（非指标特殊处理），符合铁律第2条。避免手写 RPC drill-down（口径统一在 metric_registry）。**dateUpper 规则**：extra_grain 含 biz_date（时间序列双 grain，如客户×日期下钻）时，dateUpper 同 dim_code='date' 用 `tgt.latest_day` 上限（至当日，非全周期 end_date）--与主视图口径一致，避免下钻 SUM 与主视图因未来日期批发单提前录入而漂移。
- **lateral_pick（2026-08-02 架构扩展）**：`ViewConfig.dim_grain.lateral_pick?: { match: string; prefer_own: string }` 支持跨账套回退匹配的 dim join。默认 dim_grain join 是 `JOIN ${table} ON ${on}`（精确匹配，如 `(sbc, item_num)`）；当设 lateral_pick，生成器改发 `JOIN LATERAL (SELECT * FROM dim表 WHERE ${match} ORDER BY (${prefer_own}) DESC LIMIT 1) 别名 ON true`——**本账套优先、回退跨品牌**，保证每 fact 行恰好匹配 1 行 dim（LIMIT 1，防 item_num 跨品牌重叠致翻倍）。**用途**：`report_item_breakdown_gen` 的 64188 品品甜批发——品品甜是熊喵外部客户（[[brand-ledger-external-customer-semantics]]），批发记 64188 账、卖的是 3120 货（item_num 是 3120 货号），严 `(sbc,item_num)` join 对不上会被丢（实测 7 月丢 4.87M，致商品下钻合计≈品类看板 68%）。lateral_pick 让其回退到 dim_item(3120) 主档。**非回退场景不变**：3120 自身行本账套优先＝现状，无回归。属通用 join 能力扩展（flag 闸控，仅 item 视图启用），非指标特殊处理，符合铁律第2条。
- **dim_grain_override（2026-08-04 架构扩展）**：`ViewConfig.dim_grain_override?: Record<string, DimGrain>` 支持 per-source dim join 覆盖（key=source table）。生成器在 per-source CTE 循环内 `const dg = config.dim_grain_override?.[g.table] ?? config.dim_grain`，不同 source 用不同 dim join。**用途**：`report_item_breakdown_gen` 的 outbound 修正 lateral_pick 归错--110 把批发按**收货方**分配 sbc（64188），但 item_num 是发货方货号（3120）；当 64188 也有同名 item_num（不同商品，如 597：3120=红宝石柚活动果 25580、64188=云威月饼 83403）时，lateral_pick 本账套优先误选 64188 的同名不同商品（64188 批发 597 红宝石柚 8,927 被归到云威月饼 83403）。改用 parquet 的 `pos_item_code`（货来源编码，跨品牌合并键，全非空）join dim_item（`match: item_code = s.pos_item_code`），按货来源正确归商品。sale 不变（item_num 品牌内编号，本账套优先正确）。迁移 157 给 `report_daily_item_outbound` 加 `pos_item_code` 列 + 更新 `/compute` item_outbound sql_template 提取 `MAX(pos_item_code)`。属通用 per-source dim join 能力扩展（非指标特殊处理），符合铁律第2条。
- **权限过滤（2026-08-03 架构扩展）**：生成器模板统一注入行级权限过滤--所有 actual CTE 加 `claim_match_or_star('request.jwt.claims.brands', s.system_book_code) AND claim_match_or_star('request.jwt.claims.branch_nums', s.branch_num)`（经 `src/generators/perm.ts` 的 `permFilterFact`）；target CTE 用 `permFilterTarget`（`branch_num='ALL'` 汇总行恒可见，门店行按 claim 过滤）；hierarchy 的 dim 行（leaf_rows）同双维度过滤。列脱敏（`can_see_cost` CASE）为既有 maskCost 机制。语义照迁移 072 ⑫：claim 缺失/空/含 `"*"` -> 放行（零爆炸半径）。属模板级横切安全能力（同 maskCost 先例），新增视图自动继承，**禁止在 view-configs/metric_registry 写权限逻辑**。契约测试 `__tests__/perm-filter.test.ts` 卡死：任何 `database/generated/*.sql` 缺过滤即红。spec：`docs/superpowers/specs/2026-08-03-report-permission-lockdown-design.md`。
- **多 CTE FULL JOIN coalesce（2026-08-02 bug 修复）**：多源表视图（如 item 视图 sale=item_sales + outbound=item_outbound → 2 CTE → FULL OUTER JOIN）的 final SELECT，target_id/dim_key/extra/extra_grain/carry_cols 列须 `COALESCE(cte0.x, cte1.x)` 跨 CTE（单 CTE 时退化为 `firstCte.x`，回归不断）。修旧 bug：只从 firstCte 取键会丢另一侧 only 行——item 视图「有出库无销售」的商品（377 个/258 万）只在 cte1，旧实现 target_id/category_group 取 cte0 → NULL 被丢（致合计卡在 88%）。COALESCE 后两侧 only 行都保留，合计全额对齐。
- **三层校验**：L1 `validate_semantic_registry()`（静态，阻断部署）/ L2 生成时 EXPLAIN（阻断部署，失败不产文件）/ L3a rollup `_audit` 视图（运行期告警）/ L3b 双轨 SUM diff（阻断旧视图下线）。
- **L4 上游对账（2026-08-03 架构扩展）**：语义层配置成为全链路对账单一配置源。`detail-sources.json` 注册明细自然键/聚合表映射（D1 主键唯一性、D2 聚合 PK 重复、C1 明细↔聚合）；`qa-checks.json` 声明视图上游断言（C2 视图↔聚合表按 scope 过滤 SUM 一致），生成器为每视图产 `_qa` 对账视图（静态 SQL 入 database/generated，DROP+CREATE 幂等）。QA 运行器（web/lib/qa-runner.ts）编排 D1/D2/C1/C2/C3 并写 `qa_logs` + 企微告警。C0 源 API count↔明细 count 双向（库<源=缺漏、库>源×(1+ε)=疑重）。**去重守护不依赖 C1**——明细与聚合同时翻倍时 C1 对账相等 PASS，只有 D1 主键唯一性（COUNT(*) vs COUNT(DISTINCT 自然键)）能抓 transform 去重失败。改生成器/配置后 gen-views 自动跑 C2/C3/C4 防口径回归。**gen-views 即时 C3（2026-08-05 补）**：`runGenerator` 跑完即对 `report_region_breakdown_gen`（sale_actual/delivery_actual）+ `report_supply_chain_outbound_gen`（delivery_amount）跑 level 列 pivot（SUM(level='region') vs sub_region vs store，|diff|>0.01 报错，SQL 同 web/lib/qa/c3-runner.ts 语义内联于 index.ts，不跨包 import），与 C2 `_qa` 断言同为 gen 期即时校验，任一失败 `rollupFailures` 并入 `allFails` exit 1 阻断，防生成器改动致上下钻对不上（战区和=小区和=门店和）。**生成产物执行约定**：基视图 DROP 用 `CASCADE`（连带旧 `_qa` 依赖），`migrate.sh` 生成器产物按**字节序 LC_ALL=C** 执行（基视图 `.` < `_qa` 的 `_`）——locale 排序会把 `_qa` 排前导致基视图 DROP 被依赖阻塞（实测坑，2026-08-03）。
**目标窗口机制（2026-08-03 定稿）**：生成视图 `target_status` 统一 `'active'`——**只算未结束的 total 目标**（`tgt CTE: status IN ('active')`）。已结束目标由 `close_target` 固化进 `target_snapshots` + `target_snapshot_breakdowns`（看板模块全量 JSONB 快照），closed 目标看板读快照冻结值，生成视图**不再对 closed 目标实时重算**——避免重复聚合、避免定格目标随源数据晚到漂移。前端按 `target_id` 过滤视图输出行。视图 `target_status` 与 `qa-checks` 断言 ref_sql 的 status 子句必须一致（否则 C2 对账误报）。
**达成视图生成器（2026-08-03 语义层改造）**：`report_achievement_gen`（target×metric 矩阵：目标列表 + KPI）由独立生成器 `src/generators/achievement.ts` + 配置 `src/achievement-config.ts` 产出——替代手写 `report_achievement_v`。各指标 actual 计算是**配置数据**（SQL 片段引用 t=targets，sale/delivery/outbound 口径照迁移 118 total 级），生成器只做结构化组装（tgt 窗口 + metric CASE + closed 读 snapshot + 达成率/月进度），无业务字面量。前端只消费 `target_level='total'` 行。**权限过滤（2026-08-05 补）**：接入 perm 注入--actual CTE 经 config `factAlias`/占位符注入 `permFilterFact(alias, skipBranch)`（delivery 内嵌 wholesale_customer `w` 用 `skipBranch=true`），FULL JOIN（outbound `d` FULL JOIN `w`）用新增 `permFilterFullJoin`（COALESCE 取非空侧过滤），tgt CTE 加 `permFilterTarget`；closed 目标读 `target_snapshots`（service 全量定格）豁免行级过滤。**C2 对账接入（2026-08-05 补）**：achievement_gen 接入 `_qa` 产出——`qa-checks.json` 3 条断言（sale/delivery/outbound_amt，active 目标口径），长表 SUM `actual_value` WHERE `metric_code`+`status='active'`（closed snapshot 行排除），ref_sql 独立重算 active total 周期明细，gen 后即时断言（diff>0.01 即 exit 1），与其它视图 C2 覆盖对齐。
- **部署**：migrate.sh 扫 `database/migrations/*.sql` + `database/generated/*.sql`；`scripts/deploy.sh` 迁移后 `docker compose restart postgrest` 刷 schema 缓存（视图变更生效）。
- **迁移次序**：配销比 → 品牌表 → 下钻表 → KPI 卡 → 类别表（双轨 diff=0 才切前端、下线旧视图）。

**类别汇总表生成（`hierarchy.ts`，2026-08-01 AST 化重构）**：
- **产出视图**：`report_category_summary_gen`（品牌×类别×月聚合）
- **文件位置**：`src/generators/hierarchy.ts`（非 `src/hierarchy.ts`）
- **AST 驱动实现**：
  - 类别维度：`config.categories`（水果/标品/耗材），无硬编码字面量
  - 指标来源：`config.metrics` × `metric_registry.formula_ast`（`outbound_amt`/`outbound_profit`，迁移 124 已注册 AST）
  - 表名来源：`metric_sources`（delivery/wholesale），生成器从数据源元数据读取
  - 生成逻辑：读 AST → `astToSql` 递归翻译 → 聚合 SQL（纯 config/registry 驱动）
- **符合反自由发挥铁律**：
  - ✅ 生成器代码不含业务字面量（无 `'3120'`/`'水果'` 等硬编码）
  - ✅ 所有值从 config/registry 注入（`config.categories` / `config.metrics` / `metric_sources`）
  - ✅ 新增类别 = 改 config；新增指标 = 改 registry AST（不动生成器代码）
- **metric_definitions 定位调整**：保留作"目标存储 code 命名空间"（`target_metric_values.metric_code` 已存数据主键，不迁）；与 metric_registry 经 `metric_sources.source_filter` 里 `metric_code='xxx'` 链接。

#### 生成器约束铁律（反自由发挥，2026-08-01 AST 化）

生成器（`services/semantic-generator/`）已 AST 化：derived 口径从 `metric_registry.formula_ast`（JSONB AST）读，用 `astToSql` 递归翻译（纯 switch，无字符串解析/无正则）。**为防 AI 自由发挥塞口径，改生成器须守铁律**：

1. **生成器只读 AST + config，禁写指标口径**。`src/generators/*.ts` 不含 formula 解析/模式匹配/指标特殊处理分支（已删 expandAdditive/classifyDerived 等）。round/COALESCE 等格式在 `derivedExpr`（口径/格式分离）。
2. **新增指标 = 改 `metric_registry.formula_ast`（AST 数据）；新增视图 = 改 `view-configs.ts`**。**不改生成器代码**。改生成器 = 架构变更，须先确认 AST/config 能否覆盖。
3. **生成器代码禁业务字面量**（`report_daily_*`/`system_book_code`/`'3120'`/`'64188'`/`is_assessed` 等）--须在 config/registry 声明（L2 lint 强制）。
4. **改生成器前自问**：此改动是否对应一个 AST/config 新能力？若是在生成器加「某指标特殊处理」= 违规，应改 registry AST。
5. **校验兜底**：`validate_semantic_registry()` 校验 formula_ast 的 ref 闭环（metric_code 在 registry 或窗口列集合）；契约测试抓静默 NULL；生成器 `resolveRef` 遇未知 ref throw。
6. **权限过滤/脱敏只走模板**（`perm.ts` + `maskCost`）：新增视图不得手写 `claim_match_or_star`/`can_see_cost` 判断，由生成器统一注入；手写 = 违规（口径漂移 + 漏视图即越权）。

**反自由发挥全景**：L3（AST 化，生成器无解析逻辑）✅ + L1（validate AST ref 闭环）✅ + 契约测试 ✅；L2（config 化硬编码 + lint 禁字面量）待做。spec：`docs/superpowers/plans/2026-08-01-semantic-layer-anti-freelance.md`。

### 10.9 商品/客户级聚合层（Phase 2 数据层，2026-07-29）

spec：`docs/superpowers/specs/2026-07-29-report-phase2-data-layer-design.md`。在 §10.5 门店/品类级聚合之上补三层细粒度表，解锁品牌×指标表（品品甜配送）、商品 TOP20、出库下钻、批发客户等 Phase 2 报表板块。商品/客户级数据只在原始明细 parquet 有，**不能从现有 report_daily_* 派生**，必须新聚合。迁移 107（表）+ 108（report_definitions 3 项）。

**三张聚合表**（PK 均含 `biz_date + system_book_code`）：

| 表 | 粒度 | 关键列 | 源 parquet |
|----|------|--------|-----------|
| `report_daily_item_sales` | 品牌×商品×日 | `sale_amount` / `sale_profit` | `retail_detail` |
| `report_daily_item_outbound` | 品牌×商品×日 | `delivery_amount/profit` + `wholesale_amount/profit`（视图层合成为 outbound） | `transfer_detail` ∪ `wholesale_detail`（CTE `FULL JOIN`） |
| `report_daily_wholesale_customer` | 品牌×客户×日 | `wholesale_amount/profit` + `client_name` + `branch_num` | `wholesale_detail` |

**数据流**（与 §10.5 同节奏，零手动零陈旧）：

```
采集(cron) → 明细 parquet → scheduler C1 triggerCompute() →
/compute（DuckDB read_parquet 聚合）→ UPSERT PG → 报表视图查询
```

- **brand 取自 parquet 路径**（非明细字段）：`regexp_extract(filename,'<xxx_detail>/([0-9]+)/',1) AS system_book_code`（3120=熊喵、64188=品品甜）。
- **C1 自动化**：`web/lib/scheduler.ts` 的 `triggerCompute()` reports 数组追加 `item_sales / item_outbound / wholesale_customer` 3 项，采集 `verified=success/partial` 后按 `params.dates` 自动调 /compute；失败记 `compute_logs` + 企微告警，不阻塞采集（parquet 已落）。
- **写入幂等（陈旧清理）**：/compute 先 `DELETE WHERE biz_date BETWEEN from AND to` 清该日期范围旧行（`services/server.js` 已有此逻辑）再 UPSERT，天然覆盖无 stale 残留。

**品牌级 RLS + 成本脱敏**：三表粒度 = (品牌, 商品/客户) 无 `branch_num`，现有 `branch_nums` RLS 不适用。
- **行级（品牌可见）**：RLS policy 按 `system_book_code IN (用户 branch_nums 所属品牌)`——claim `branch_nums=['*']`/NULL → 全量；否则 `branch_nums` JOIN `dim_branch` 派生可见品牌集合（照 `report_daily_delivery` 模式，把 branch_num→品牌派生）。
- **列级（成本脱敏）**：profit 列（`sale_profit`/`delivery_profit`/`wholesale_profit`）在**报表视图层**按 `can_see_cost` claim 用 CASE 脱敏（照 `report_achievement_v` 模式），基表存全值。

**解锁报表板块**：品牌×指标表（品品甜配送来自 `report_daily_wholesale_customer.client_name`→64188 门店映射）+ 商品 TOP20（销售/出库）+ 出库商品下钻 + 批发客户报表。

**`report_brand_metric_v`（迁移 112/113，品牌×指标表视图）**：spec `docs/superpowers/specs/2026-07-29-brand-metric-table-design.md`。按 active total 目标窗口 CROSS JOIN `dim_brand` 出每品牌一行 + 合计行；销售来自 `targets`（store 分解）+ `report_daily_sales`，配送异源（3120=`report_daily_delivery`/64188=`report_daily_wholesale_customer.client_name`→`dim_branch.branch_name` 映射）；113 修复：`sale_rate=round(actual/target,4)` 绝对值（对齐 `report_achievement_v`/`region_breakdown_v`/`category_summary_v`，非时间进度调整）+ sale_target/sale_actual/delivery 四个 CTE 加 `is_assessed_war_zone(db.first_level_region)` EXISTS 过滤（仅考核战区，与 `report_achievement_v` 一致）+ delivery 3120 加 `system_book_code='3120'` 防御；成本列按 `can_see_cost` claim CASE 脱敏。

**完整性**：与现有 `report_daily_*` 同模式——`/compute` 用 `DELETE-before-INSERT` 清该日期范围旧行（覆盖写、无 stale 残留），全程记 `compute_logs`，`status=failed` 触发企微告警。**按品牌行数对账（聚合行数 ≥ parquet distinct(sbc, item_num/client_code, biz_date)）目前未实现**，作为后续增强；当前依赖 DELETE 覆盖 + 失败告警兜底，不做按维度行数比对（与 `report_daily_delivery/wholesale` 等既有聚合表一致）。

### 10.11 Phase 2 前端板块（2026-08-02）

spec：`docs/superpowers/specs/2026-08-02-report-phase2-frontend-boards-design.md`。在 §10.9 数据层之上挂 3 个看板板块到目标详情页（PC + 移动，`web/app/reports/targets/[id]/`）下方，紧随既有 KPI/品牌×指标/门店/类别表之后：

- **商品 TOP4 榜**（`ItemTopBoards`，`web/components/report-center/item-top-boards.tsx`）：销售/出库 × 月/日 2×2 网格 + 日期选择器；月榜从视图读、日榜走 `get_item_top_by_day(p_target_id, p_day)` RPC（视图无单日维度）；全品牌按 `item_code` 合并；行点击触发 `ItemDetailDrawer` 弹层（走 `get_item_detail(p_target_id, p_item_code)` RPC）。
- **出库商品下钻列表**（`ItemOutboundList`）：类 Excel 交叉表，top_category/item_brand/item_name 筛选 + 服务端分页（首页 server 预取，翻页走 `/api/admin/reports/item-list`）。
- **批发客户报表**（`WholesaleCustomerReport`）：3120 客户排行 + 累计占比 + 品品甜 KPI 卡 + 高亮品品甜客户行（`client_brand_code` 数据驱动识别，无字面量 `'64188'`，从 `dim_brand` 反查 `brand_name='品品甜'` 的 `system_book_code`）。

**生成器新能力**（§10.10）：`dim_grain`（actual CTE 粒度变换，支持商品级从品牌×商品聚合到 item_code 全品牌合并）/ `carry_cols`（携带原表列如 `item_name`/`category_name`，免去额外 JOIN）/ `extra_join`（补 LEFT JOIN 如 `dim_item` 取 `top_category`）/ `source_override`（覆盖 metric_sources 默认表名，支持 wholesale 客户视图切 `report_daily_wholesale_customer`）。**3 板块走 2 视图 + 2 RPC**：`report_item_breakdown_gen`（含 `sale_amount`+`outbound_amount`+`top_category`+`item_brand` 等携带列）+ `report_wholesale_customer_gen`（3120 客户排行）+ `get_item_top_by_day`/`get_item_detail` 2 RPC（迁移 141/142）。迁移 143 调 `report_item_breakdown_gen` 的 outbound 口径 `depends_on` 对齐（与 `outbound_amt` 同源）。**预取策略**：`page.tsx` 的 `Promise.all` 加 `getItemBreakdownTop` + `getItemOutboundListPage(targetId, 1, {})` + `getWholesaleCustomer`，首屏 SSR 同步出 3 板块；日榜切换/列表翻页/弹层走 client fetch。

**供应链出库层级报表 + 外部批发客户日报（2026-08-02，date grain 架构扩展）**：

2 新看板挂目标详情页（PC + 移动）：

- **供应链出库数据报表**（`SupplyChainOutboundTable`）：四级战区->二级区域->门店 三级下钻（参考 `RegionDrillTable` 交互），7 列（大区名称/出库金额/出库毛利/毛利率/当天出库金额/当天出库毛利/当天毛利率），末行门店合计，**门店行毛利率<12% 标红**。数据走 `report_supply_chain_outbound_gen` 视图（生成器产出，复用 `regionBreakdownView` 三级 hierarchy 模式），metrics: `distribution_amount`/`distribution_profit`/`distribution_margin` + `daily_distribution_amount`/`daily_distribution_profit`/`daily_distribution_margin`（迁移164新增当天指标），经 aliases 映射回 `delivery_*`/`daily_delivery_*` 列名（前端零改动）。**出库语义=distribution（2026-08-04 改，对齐 region_breakdown 配送报表）**：`delivery`（熊喵配送 `report_daily_delivery`）+ `wholesale_pp`（品牌甜门店批发 `report_daily_wholesale_customer` WHERE sbc=64188）两源按门店复合键合并，含品品甜；改前为纯 delivery（不含品品甜，与旁边配送报表口径不一致，品品甜配送无处可看）。当天=固定 `current_date`（closed 用 end_date，即 `tgt.latest_day`）。考核过滤 `is_assessed_war_zone`。
- **外部批发客户出库报表**（`WholesaleDailyTable`）：按日期序列（start_date ~ min(today, end_date)，每日一行），4 列（时间/出库金额/出库毛利/毛利率），**毛利率<0 标红**。数据走 `report_wholesale_daily_gen` 视图（生成器产出，**date grain**：`dim_code='date'`，行=biz_date），metrics: `wholesale_ext_amount`/`wholesale_ext_profit`（source_filter `system_book_code='3120'` = 除品品甜的外部批发，口径在 metric_sources 数据驱动）+ `wholesale_ext_margin`。target_window 用 `latest_day` 上限（罗列至当日）。

**生成器能力扩展（date grain，架构变更）**：
- `types.ts`：`DimCode` 加 `'date'`
- `tier1.ts`：`dimKey` 加 `dim_code === 'date' ? 'biz_date'`；date 维度 target_window join 用 `BETWEEN start_date AND tgt.latest_day`（非 end_date），date 无 dim_table（biz_date 是 fact 列，不 cross-join dim 表）
- **新 metric_registry 指标**（迁移）：`daily_delivery_profit`（derived, cost_sensitive, formula_ast = filter delivery_profit on biz_date=latest_day）/ `daily_delivery_margin`（derived = daily_delivery_profit/daily_delivery, cost_sensitive）/ `wholesale_ext_margin`（derived = wholesale_ext_profit/wholesale_ext_amount, cost_sensitive）
- **2 新 view-configs**：`supplyChainOutboundView`（dim_code='branch', 三级 hierarchy, delivery metrics + daily）+ `wholesaleDailyView`（dim_code='date', wholesale_ext metrics）
- 命名用目标起止日期范围（`{startM}月{startD}日-{endM}月{endD}日...`，跨月/非全月统一规则）

---

## 十一、待实现/待讨论

| 项目 | 状态 | 备注 |
|------|------|------|
| DuckDB /compute 端点 | ✅ 已实现 | 标准报表计算 |
| PostgreSQL 汇总表 | ✅ 已创建 | report_daily_sales 等 |
| 采集后自动触发计算 | ⏳ 待实现 | transform → compute |
| DuckDB /query 鉴权 | ✅ 已设计（§4.2） | 待实现：server.js 每请求连接 + AGENT_API_KEY |
| OpenClaw 集成 | ✅ 已设计（§4.2） | 待实现：agent-query 网关 + skill/tool 配置 |
| 列级脱敏（成本组） | ✅ 已设计（§4.2） | 待实现：视图 CASE + PG claim 视图 |
| 跨引擎小表搬运 JOIN | ✅ 已验证（§4.2） | 待实现：网关编排（Appender 注入临时表） |
| 美团数据源接入 | ⏳ 待讨论 | 架构待确认 |
| 饿了么数据源接入 | ⏳ 待讨论 | 架构待确认 |
| 监控告警体系 v1 | ✅ 已设计（§8.1） | 待实现：详见 `docs/superpowers/specs/2026-07-08-monitoring-system-design.md` |
| 模块化+插件化重构 | ✅ 已设计（spec 2026-08-11） | A+B-lite，P0–P5 分阶段；架构评审通过（D1–D6），P0 先行（契约止血+单源+CI） |

## 十二、架构变更流程

1. 发现需要变更的需求
2. 提出变更方案 + 方案对比 + 推荐理由
3. 征得用户同意
4. 更新此架构文档
5. 执行代码实现
6. 验证变更效果

**禁止行为**：
- 未更新架构文档直接修改代码
- 擅自改变服务拆分/数据流向
- 未经同意引入新技术栈/外部服务