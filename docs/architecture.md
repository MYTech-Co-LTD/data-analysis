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

> 上表仅列核心表。另有 `report_daily_delivery` / `report_daily_wholesale` / `report_daily_item_sales` / `report_daily_item_outbound` / `report_daily_wholesale_customer` / `report_weekly_trend`（§10.5/§10.9 聚合表）、`targets` / `target_snapshots`（目标）、`metric_registry` / `metric_sources` / `dimensions`（语义层）、`datasets` / `dataset_columns`（数据注册中心 §4.3）、`monitor_rules` / `monitor_alerts` / `external_request_logs` / `qa_logs` / `collect_stall`（§8.1 监控/QA）、`dim_customer` / `dim_brand`、`retail_query_user_perms`（§4.3 按人 override）等。**完整 schema 单一事实源 = `database/migrations/`（172 个幂等迁移，`migrate.sh` 每次部署全量重跑）**，本表不再逐一维护。

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

**已部署 Function**（`functions/` 目录，10 个 + `_shared` 打包共享）：
| Function | 用途 | 状态 |
|----------|------|------|
| `wecom-oidc-callback` | Casdoor OIDC 回调→自签 PostgREST JWT（登录主链路，§6.1） | ✅ |
| `wecom-sync-contacts` | 通讯录全量同步（每日 03:17 兜底，§7.1.2） | ✅ |
| `wecom-notify` | 统一消息通知（App B，§7.1.1） | ✅ |
| `wecom-push` | 企微主动推送 | ✅ |
| `agent-query` | 智能问数网关（认证/授权/白名单/权限视图/审计，§4.2） | ✅ |
| `collect-lemeng` | **历史遗留**：现行乐檬采集在 `web/lib/collectors/lemeng`（P1 collectors registry，jobs/collect 分发），本 function 无调用方；`collect_tasks.function_slug` 仅作任务类型标识（如 qa progress-guard 用它筛选销售明细任务） | 🗄 遗留保留 |
| `encrypt-credentials` | 数据源凭证加密存储 | ✅ |
| `cleanup-blacklist` | 黑名单清理 | ✅ |
| `mcp` | InsForge MCP 接入 | ✅ |
| `wecom-oauth` | **已退役**：登录职责由 Casdoor provider + `wecom-oidc-callback` 取代（§6.1）；文件保留仅作历史参考，`signJwt` 已抽到 `functions/_shared/jwt.ts`（agent-query 复用的是 `_shared`，非本文件） | 🔒 退役保留 |

> `_shared/`：Edge Function 共享打包层（jwt.ts / cors.ts，agent-query 等 `require("../_shared/...")`），属 P3 模块化产物（§九 2026-08-11）。

> 定时调度由 web 端 jobs registry（`web/lib/scheduler.ts` 宿主 + `web/lib/jobs/*`，instrumentation 自启动 + node-cron）承担，不使用 edge function。
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
│  端点：POST /query                                                │
│  ├── 输入：SQL（OpenClaw 生成）                                   │
│  ├── 处理：网关建权限视图（行+列脱敏）→ read_parquet → 执行（见 §4.2）                       │
│  ├── 输出：查询结果                                               │
│  ├── 鉴权：AGENT_API_KEY（仅网关可调）+ 每请求独立连接隔离临时视图  │
│  └── 状态：✅ 已实现（2026-07-05 上线，§4.2）                     │
│                                                                 │
│  其他端点：                                                      │
│  ├── GET /health → 健康检查                                     │
│  ├── GET /schema → OOS 文件列表                                 │
│  ├── POST /carry-dims → 维表物化 parquet（C3，§4.4；cron 04:33 兜底 + 变更回调） │
│  ├── POST /derive-dim-customer → 批发客户维表派生（3120）        │
│  ├── POST /import → 数据导入                                    │
│  └── 鉴权：/query /transform /merge /compute /carry-dims 均校验 AGENT_API_KEY │
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

> 页面与路由随迭代增长较快，下表仅列骨架；**完整清单以代码为准**：页面 `web/app/**`（另有 `/admin/semantic` 语义层管理、`/admin/qa` QA 看板、`/admin/sources/monitor` 监控大盘、`/admin/targets` 目标管理、`/admin/branches`/`/admin/items`/`/admin/permissions`/`/admin/sources`、`/help` 等），API `web/app/api/**`（admin 下 20+ 路由：branches/brands/items/regions/permissions/data-sources/collect-*/collect-backfill/qa-*/semantic/targets/scheduler/reports 等）。

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

**定时调度**（架构现状 = **`web/lib/jobs/*` 注册表**，宿主 `web/lib/scheduler.ts`，node-cron，Asia/Shanghai，详见 §5.1）：
- **自初始化**：server 启动时 `web/instrumentation.ts` 的 `register()` 调 `ensureSchedulerInitialized`（带退避重试），web 容器重启后 cron 不再静默停止；首次 `/api/admin` 调用兜底
- **防重入**：`runningTasks`/`scheduledJobs`（globalThis 跨 chunk 单例），并发触发跳过
- **任务注册**：固定 job 在 `web/lib/jobs/registry.ts` 尾部追加（各目录 manifest 声明 schedule）；动态采集任务读 `collect_tasks` 表（schedule_cron / enabled / params / 运行时水位线 watermark）
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

### 4.2 智能问数查询与鉴权架构（✅ 已实现并部署，2026-07-05）

> 本节为设计存档；实现以 `functions/agent-query/` + `services/server.js` 现状为准。

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
   ├─ ① 认证：AGENT_API_KEY（插件↔网关共享密钥；agent-query token 化已裁推迟独立排期——
   │         client_credentials + JWKS 服务身份模式由 push-admin 先验证，AGENT_API_KEY 降级开关保留，§4.3）
   ├─ ② 授权：get_user_perms（PERMS_INPUT 感知，§6.2）查 data_permissions 逐维合成
   │         perms = { branch_nums, brands, categories, can_see_cost }（角色∪部门 UNION → 个人 override）
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

**行级权限（底座 = branch_nums 门店，§6.2）：**
- DuckDB：权限视图 `WHERE branch_num IN ('54','127',...)`（branch_num 是 VARCHAR，已实测）
  - ⚠️ **已知限制（以代码为准如实记录）**：明细 parquet 无 `system_book_code` 列（品牌只在文件路径里，§10.9 brand 取自 `regexp_extract(filename,...)`），故 DuckDB 行级过滤只能用 `branch_num` 单键，无法区分品牌。`branch_num` 跨账套重复（§1.1 门店键铁律，128 个共享），perms 被授权某品牌共享号门店时，另一品牌同号门店的行也会被放行。网关侧 PG 路径走真 RLS 不受影响。如需根治：需先在 /transform 物化 sbc 列再改复合过滤（架构变更，待立项）。
- PostgreSQL：汇总表 RLS 用 `request.jwt.claims.branch_nums`（claim 由网关代签短时 JWT 注入，复用 `_shared/jwt.ts` 的 signJwt + JWT_SECRET）
- brands/categories 维在语义层/视图侧过滤；数据源已收编 `data_permissions` 单表（167），网关只消费 `get_user_perms` 结果
- **演进（2026-08-16 IAM 标准化，W 轴；2026-08-18 门店范围唯一真相）**：门店范围**唯一真相 = `范围|X` 资源**（挂 permission.resources → `expandScopeResources` → `data_scope.branch_nums`；**废除组织架构 Group tree 挂组推导**，无范围资源 = 空集 deny，B1 fail-close）；`data_permissions` 双氧期保留，W5 DB 级写关闭、W6 sunset。消费点（get_user_perms / RLS）机制不变，输入源切换（PERMS_INPUT 同模式）

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
- ⏳ DeepSeek-V4-Flash SQL 质量：靠 skill 优化（搁置实测）
- ✅ PG 列级脱敏：未采用独立的 `report_*_v` claim 视图路线（C0 原设计），实际由生成视图模板统一注入（§10.10 权限过滤：permFilterFact/permFilterTarget + maskCost，迁移 155 已 DROP 旧手写视图）；agent-query PG 路径改查生成视图 + 注册表 costColumns 应用层兜底

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
- **按人鉴权**：userId 由 OpenClaw 从企微可信注入，用户端零配置；改权限=走 `/admin/permissions` 页面（写库 + 落 `permission_audit`），不动 OpenClaw。**授权数据源 = `data_permissions` 单表（role/dept/user 三 subject）**：167 已把部门权限列 + 老按人表收编进本表（`org_departments` 权限列、`retail_query_user_perms` 已退役），`get_user_perms` 逐维合成（基底 = 角色∪部门并集 → 个人 user 行按字段覆盖，详见 §6.2）。个人授权用于不在任何已同步部门里的用户（如 YangWei——bot 企微应用通讯录可见范围只到总经办，同步拉不到他；且给他部门设权限会波及同事，不是"单独开"）。安全模型（2026-08-13 修订，对齐迁移 167 F1）：`data_permissions`/`permission_audit` 已 GRANT anon/authenticated 全 CRUD，管理 API 经 PostgREST 直写。**信任边界 = PostgREST 仅内网可达（无宿主机端口映射）+ 管理 API 层 `requireAdmin` 验签强鉴权（access_token HS256 验签 + sub==wecom_userid）+ 读路径 `get_user_perms` RPC 透视**。 **运维约束：SQL 直改不落 `permission_audit` 审计，权限变更一律走管理页面 `/admin/permissions`。**
- **信任边界演进（2026-08-16 IAM 标准化，spec `docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`）**：授权语义上收 Casdoor——**组织架构中心化 = Casdoor Group tree**（本地 `org_departments`/`org_users` 降级**只读投影**，不再承担真相，§6.1/§7.1.2）；`data_permissions` 进入双氧期（W5 DB 级写关闭 → W6 sunset，§6.2）。信任边界新增两组件，均以 org admin 级服务账号调 Casdoor 原生 HTTP API（不 fork）：① **组同步器（唯一自写组件）**——Casdoor 原生 wecom syncer 只同步用户（`GetOriginalGroups` 返回空带 TODO，源码验证），组织架构上收必须自写；**单通道 = 企微部门树复刻（2026-08-17 用户裁定修订：组织架构严格按企微——企微无门店层部门，Casdoor 即不建门店组；原「门店树=diff 驱动 dim_branch」双通道设计与 388 门店组树已废弃拆除）**、先父后子（根组 parent=anchor `shanhai`+isTopGroup）+ 每日父链完整性校验（父链断裂 → 原生 `GetUserFullGroupPath` error → 整组登录崩）。**门店数据视野映射 = `范围|X` 资源唯一真相（2026-08-18 用户裁定）**：门店范围只从 `范围|X` 资源（permission.resources）读取——`范围|全店`/战区包名/`branch_number`/门店中文名 → `expandScopeResources`（读 `maps_branch_group` + `dim_branch`，`resolveScopeKeys` 解析，`collapseFullStore` 全店收敛 `'*'`）；**无范围资源 = `branch_nums: []` = B1 空集 deny（fail-close，堵「漏配即放行」）**。组织架构（企微部门组 → maps 推导，`expandGroupsToBranches`/`resolveGroupBranches`）已废除，仅目录/审计用途。② **resource 同步 adapter**——catalog（`web/lib/capability-catalog.ts` 单真相，§6.4）→ Casdoor `add-resource`（注意：**当前 Casdoor 版 field_validation_filter 禁 `/?:#&%=+;` 含冒号——含 `:` 的 catalog key 实际注册被拒，仅 permission.resources 通道可用，adapter 待修**）**resource 注册走 Casdoor 原生 API**。Casdoor UI 手配仅限 catalog ∪ `*` 内，非 catalog key 被校验器 fail-close 拒绝。以上两条与既有「PostgREST 内网 + requireAdmin 验签 + RPC 透视」边界叠加，不替代。
- **不千人千面**：权限数据在 DB，OpenClaw 侧零用户态；`AGENT_API_KEY` 留 openclaw 容器 env（`openclaw/.env`，compose `env_file` 注入），用户/LLM 均不可见。

**🆕 OpenClaw 统一身份链路（2026-08-15 spec；push-admin 插件先行，agent-query 随 U8 切换）：**
- **双身份**：服务身份 = Casdoor `client_credentials` 短时 JWT（60s 前置刷新），**scope 仅 `openclaw:query` / `openclaw:push`（永不含 admin）**——query 侧数据仍走请求者 scope，服务身份冒充不能提权；人员身份 = body.userId（wecom_id，来自可信 requesterSenderId 注入）。
- **web 侧 JWKS 验签单实现**：`web/lib/token-verify.ts`（iss/aud/exp/scope 一处实现，push API 与 agent-query 共用；JWKS 缓存 ≥24h；拉取失败 fail-close + page 告警）。
- **混淆代理人防护（A6）**：审计双标识（服务身份 + 声称 userId）；10min 跨 ≥3 userId → 告警 + **默认拒绝**；高危操作（broadcast / 含 cost 变量）要求 userId 通讯录 active；secret 不落库不进 git。
- **降级开关**：`AGENT_API_KEY` 共享密钥路径保留（token 化切换期回退用，U8 裁决推迟）。

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

**C3 carry 维表（物化 parquet）**【✅ 已实现】：维表 dim_*(+ext) → duckdb-service `/carry-dims`（**pgPool 读 → DuckDB COPY parquet S3，全程不 attach、DuckDB 不连 PG**）→ 查询侧 read_parquet 维表 parquet，明细按需 JOIN 维表。**定时（cron 04:33 兜底，`web/lib/jobs/carry-dims`）+ 变更回调双触发**，对齐通讯录同步模式。维表 `carry_enabled` 已翻 true；agent-query 查询侧已消费 dim parquet（含敏感列脱敏，§4.2）。否决 attach（绕过 report_* 风险）与 pg_duckdb（见下）。

**C4 定时应用（触发判定本地化 + run_push 引擎闸，2026-08-15 改写）**：OpenClaw cron turn **天生不带身份**（requesterSenderId 只来自 inbound，源码证实；现存「建水3店业绩」cron 已踩坑禁用）。解法在我们可控层：
- **run_as 反查（问数 cron）**：`scheduled_reports(cron_job_id → run_as=创建者)` 绑定，后端可信会话写入。plugin 的 query_retail_data 在 requesterSenderId 空时透传 `cronSessionKey=ctx.sessionKey`（cron turn 的 sessionKey 含 `cron:<jobid>:`），agent-query parse job_id 反查 run_as → get_user_perms → 裁剪+脱敏。run_as **不在 LLM 参数**（query_retail_data.parameters 只有 sql）、钉死=创建者。
- **run_push 引擎闸（推送出口，§7.4）**：触发判定永在本地（scheduler jobs 注册表 / OpenClaw push-admin），推送出口统一收口 **run_push 渲染引擎（web/lib/push/，唯一入口）+ 引擎闸兜底**——收件人必须结构化 selector（LLM 手写收件人拒）、全员 selector 需 `push:broadcast`（**绕插件直调引擎同样拒**）、订阅定时触发按 owner 实时再校验 `push:configure`（全员订阅加验 broadcast）且在职，撤权/离职 → 订阅自动暂停（标 paused+告警）。「配置不是会话，撤权必须能收回配置」。
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

> **架构现状（P1 模块化，§九 2026-08-11）**：采集与定时任务已重构为 **`web/lib/jobs/*` 注册表架构**（`registry.ts` 尾部追加式登记，各 job 目录自带 `manifest.ts` 声明 `schedule`）；动态采集任务（`collect_tasks` 每行）经 `collectManifest(task)` 工厂注册。固定 job 节奏（Asia/Shanghai）：contact-sync 03:17 / dim-customer 04:20 / carry-dims 04:33 / target-close 05:10 / source-reconcile 09:07 / qa-full 09:15 / daily-reconcile 02:00,12:00,19:00 / monitor（分桶）+ 动态 collect_tasks（零售明细 8–24 点，迁移 166 修正；旧迁移 013 曾注释 8-24 实写 8-23）。采集器实现在 `web/lib/collectors/*`；手动触发仍走 `/api/admin/collect-lemeng` 等 API Route。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  定时触发（node-cron，jobs registry）                                   │
│  └── 零售明细：8–24 点每 5 分钟增量 + 每小时全量核对                  │
│       │                                                                 │
│       ▼                                                                 │
│  Next.js API Route（手动触发）                                         │
│  ├── /api/admin/collect-lemeng                                          │
│  ├── 调用乐檬 API（分页拉取，web/lib/jobs/collect/manifest.ts）        │
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

### 6.0 真相源总表（2026-08-16 IAM 标准化：Casdoor 主导三分流）

> spec：`docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`（revision-2 终稿；对 08-15 spec「真相源划分」的升级替换——凡与本表冲突处以本表为准，08-15 未提级条款全部继承）。
> **关键变化一句话**：08-15 的「数据范围留在本地 `data_permissions`」演进为「**Casdoor 主导三分流**」；「人→部门：企微通讯录」演进为「**Casdoor Group tree 中心化**」。其余全部继承。

| 数据 | Source of Truth | 合法写入口 | 对 08-15 的变化 |
|---|---|---|---|
| 人是谁 | Casdoor | 企微 provider / JIT / 薄同步建户 | 不变 |
| 组织架构（部门/区域/门店组） | **Casdoor Group tree** | Casdoor UI + 组同步器（auto） | **★ 中心化：原「企微通讯录→org_departments」**；本地表降级只读投影 |
| 职位（Role） | Casdoor | Casdoor UI（manual，唯一写者；薄同步 2026-08-18 起不再写角色） | 不变；闭环经 Group 挂 Role |
| 能力点（功能资源） | Casdoor Permission + resource 表 | Casdoor UI / **catalog 同步 adapter**（§6.4） | **★ 新增 catalog 动态发现** |
| 数据范围-静态枚举（品牌/品类/字段） | **Casdoor resource** | catalog 同步 adapter | **★ 原 `data_permissions` 各维内** |
| 数据范围-动态门店 | **`范围|X` 资源**（permission.resources） | Casdoor UI 挂资源 | **★ 原 `data_permissions.branch_nums` 内；2026-08-18 废除 Group 归属推导** |
| 数据范围-临时例外 | **已废除**（2026-08-18：例外体系废除，临时授权改用 `范围\|X` 资源） | — | `temporary_grants` 表冻结（历史） |
| 人→角色（本地视图） | 持久投影 `role_codes`（非真相源） | 只被写穿 | 不变（sunset 时点继承） |
| 本地 `org_departments`/`org_users` | **缓存投影（非真相源）** | 只读消费 | **★ 降级：不再被写**（W2/W4 切换） |

### 6.1 登录流程（帽子×座位×口径分层，2026-08-15 平台级权限改造；座位/口径层 2026-08-16 IAM 标准化演进）

> spec：`docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md`（§6.2 数据范围合成 / §6.4 casbin 功能授权层 配套）；**演进：`docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`（revision-2——座位层 Group tree 中心化 / 口径层三分流 / 能力点 catalog，§6.0/§6.4/§6.5）**。
>
> **核心原则——四层模型：帽子 × 座位 × 口径**：
> ```
> ① 身份层（不动）      Casdoor OIDC（企微 provider）→ wecom_id（JIT 建户）
> ② 帽子层（改造）      Casdoor：人→角色（UI 人工，Casdoor 单写者；薄同步不写角色）
>                       角色×功能资源：data-analysis:<模块>:<动作>（casbin Permission，§6.4）
> ③ 座位层（W2 上收）   Casdoor Group tree 中心化（部门树 + 区域-门店树，组同步器，§7.1.2）
>                       org_departments / org_users 降级只读投影（不再被写）
> ④ 口径层（二分流，2026-08-18 例外废除后）    品牌/品类/字段 → Casdoor resource；**门店 → `范围|X` 资源**（expandScopeResources 展开；废除 Group 挂组推导与例外体系）
>                       临时例外 → temporary_grants RT 实查（§6.5）
>                       data_permissions 双氧期 → W5 写关闭 → W6 sunset（§6.2）
>                       → get_user_perms（PERMS_INPUT 感知读 role_codes 镜像或 role_id 折 code）
>                       → claims（W3 扩 groups/data_scope/fields/catalog_v）→ RLS/视图过滤
> ```
>
> - **身份+帽子层（Casdoor 统一）**：Casdoor（`sso.shanhaiyiguo.com`，控制面独立部署）持有企微 WeCom provider，负责"这人是谁（`wecom_id`）+ SSO 会话 + 人→角色（帽子）+ 角色×功能授权（casbin Permission）"。后续每接一个系统只需在 Casdoor 注册一个 OIDC client，不重复对接企微 API。
> - **座位层（2026-08-16 中心化；2026-08-18 定位收缩）**：组织架构单一真相源 = **Casdoor Group tree**（部门树，§7.1.2 组同步器）；本地 `org_departments`/`org_users` 降级**只读缓存投影**。**本节定位 = 组织目录**（谁在哪个部门，目录/审计用途）——**不再推导门店数据范围**（2026-08-18 废除组织架构推导；门店范围唯一真相 = `范围|X` 资源，见口径层）。`groups` claim 带完整路径精确数组（禁中文 label 进判定）。
> - **口径层（2026-08-16 三分流）**：静态枚举（品牌/品类/字段）→ Casdoor resource；动态门店（~250）→ Group tree 挂组表达（**不 resource 化门店**：门店是"过滤值"非"能力点"，policy 行数=门店数×授权组合数）；临时例外 → app `temporary_grants`（RT 实查，不折叠进 claims，§6.5）。`data_permissions` 目标 **sunset**（W5 DB 级写关闭、W6 删表；双氧期保留作回滚保险）。`get_user_perms` 按 `PERMS_INPUT=casdoor|legacy` 感知输入源（casdoor 模式读 `org_users.role_codes` 镜像；legacy 模式按 `role_id` 折 code），结果**自签 PostgREST JWT**（`JWT_SECRET` / RLS 策略 / pgrst_pre_request 执行点不变；claims 结构 W3 扩 `groups`/`data_scope`/`fields`/`catalog_v` 新段 + 顶层旧 key 双氧保留至 W6，§6.2）。
> - **Casdoor 单点口径（裁决-2，SLO 化）**：Casdoor 故障时**存量会话零影响**（数据面/引擎不依赖 Casdoor）+ **新登录恢复 <2-4h**（SLO 化而非热备）+ **page 告警**；break-glass 凭证 best-effort 并行验证，通过后升冷备。

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
│  座位+口径层（data-analysis 自签 JWT）                                    │
│  web callback → functions/wecom-oidc-callback：                         │
│  ├── Casdoor code → /token → /userinfo（sub=wecom_id）                  │
│  ├── 拉 roles（roles claim 优先；API 查兜底，>2s 降级本次不带角色+告警）│
│  ├── upsert org_users + 登录写穿镜像（role_codes + casdoor_synced_at） │
│  ├── 查 get_user_perms（PERMS_INPUT 感知；四维 + 角色 UI 字段，§6.2）   │
│  └── 自签 PostgREST JWT（claims 八字段 + roles + permissions，7 天）    │
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

**claims 契约扩展（W3，2026-08-16 IAM 标准化；与 U2 登录切换同一发布窗）**：claims 构建 function（`functions/wecom-oidc-callback`）在既有字段（sub/org/roles/permissions + role_code/visible_panels/default_landing/default_metric/departments，08-15 八字段全保留）之上**新增四段**——`groups`（用户挂组完整路径精确数组；Casdoor 原生 `useGroupPathInToken` 后 token 自带，或 get-account 读 `user.Groups`；「get-user-groups」路由不存在禁止调用）、`data_scope`（brands/categories/branch_nums，由 resource 判定 + **`范围|X` 资源展开派生**（2026-08-18 废除 groups 叶子展开/组织架构推导）；**段存在但空 = authorized ∅ = deny，不收敛 `["*"]`**）、`fields`（掩码开关，如 `{cost:true}`）、`catalog_v`（代码/部署版本戳，只做 key 级按需 fail-close，不做全局版本拒绝）。**顶层旧 key 双氧保留至 W6 不删**（072/114 扁平化下旧 key 变 NULL 会致既有 RLS 静默全放）；新 claims 顶层旧 key 值 = 全维非空镜像。`permissions` 值从四维维度 key 迁移为 `data-analysis:*` 资源串 + `push:` 裸 key（B2/H4）。例外门店**不折叠进 claims**（`temporary_grants` RT 实查，§6.5）。

**WeCom provider 双模式**（Casdoor provider 级 `method` 是单值，故配两个 provider 都指向 App A）：
- `wecom_silent`（Silent）：企微内静默（`snsapi_base`）。App A 登录凭证（`WECOM_CORP_ID` / `WECOM_AGENT_ID` / `WECOM_SECRET`）已挪入 Casdoor 此 provider，`functions/wecom-oauth` 的登录职责由 `functions/wecom-oidc-callback` 取代。
- `wecom_scan`（Normal）：PC 外部扫码。

> `functions/wecom-oauth` 已退役（登录职责由 Casdoor provider + `functions/wecom-oidc-callback` 取代）。其 `signJwt` 已抽到 `functions/_shared/jwt.ts`，`agent-query` 网关复用的是 `_shared` 版本；文件保留仅作历史参考。
>
> 端到端企微登录验证待部署后进行（Casdoor WeCom provider 源码已实测 + postgres 部署已验证；公网 `sso` 域名 + 企微可信域名配置属部署后验证）。

**薄同步链（2026-08-15 spec，U1 起；2026-08-18 收缩——仅同步「人 + 组织架构」，角色写入全删；单写者原则，挂 §7.1.2 通讯录同步链）：**

```
企微回调（实时增量）+ 每日 03:17 全量（兜底）
   → Casdoor-first 写：provisioning（JIT 建户）/ 离职 disable / 组对账（部门组补挂）
   → 写镜像 org_users.role_codes（仅登录/drift 回写；casdoor_writer 现全量 manual）
   → 写 Casdoor 失败 → sync_outbox（幂等键 wecom_id+action+day）→ 下次同步先清 outbox
每日 drift 三向对账：
   diff1（Casdoor−企微）= Casdoor 手工配置 → 回写镜像标 manual，永不反向覆盖
   diff2（企微−Casdoor）= 写失败 → outbox 重放，>48h 页级告警
   diff3（Casdoor−镜像）= 镜像滞后 → 回写，24h 未收敛告警（直接影响 run_push 分组正确性）
```

- **单写者**：**角色归属全量 manual（Casdoor UI 人工配置，唯一写者）**——auto 角色写入（`dept_role_mapping` 推导、`derive-roles.ts`、`assignRoles`）已随 2026-08-18 收缩删除；`casdoor_writer` 现存值即 manual/disabled 两种（生产实测 45 个 active 用户全 manual）。既有本地角色写者（152 refresh cron / `/api/admin/permissions/users` PUT 的 role 字段）U1 起收编/冻结。
- **动作分顺序落地**：① 离职四 sink 最先（安全刚需，§7.1.2）；② provisioning 先 JIT 建户（角色人工配，Casdoor UI）。
- **输入源切换（U2，最高风险独占窗口）**：`PERMS_INPUT=casdoor|legacy` 配置开关（秒级回滚不发版）；shadow 对账门禁 = 预期差异白名单（drift manual 集派生，逐条人工确认）+ 非预期差异双清零；切换执行瞬间重跑增量 diff=0；回滚预案含 Casdoor→legacy 角色回放脚本。

### 6.2 数据权限合成与 PostgreSQL RLS 鉴权（2026-08-15 改写：subject_id=code + role_codes 持久投影 + 多角色 UNION）

```
组织架构：Casdoor Group tree（W2 影子同步 → W4 消费侧切；本地 org_departments/org_users = 只读投影）
     ↓
登录时自签 JWT 携带 departments + 数据范围 claims（双氧期：顶层旧 key + W3 起 data_scope/groups/fields 新段）+ roles/permissions（§6.1）
     ↓
PostgREST 请求带 Authorization: Bearer <JWT>
     ↓
PostgreSQL RLS 策略（执行点机制不变；W3 起新增策略分支，见下）
     ↓
数据库层强制隔离
```

> RLS 策略族沿用现状零改动：部门成员策略 `WHERE departments ?| current_setting('request.jwt.claims.departments')` 与四维 claims 策略（`branch_nums` / `can_see_cost` 等，§6.3/§4.2）都消费自签 JWT claims，claims 结构不变故策略不动。
>
> **策略分支（W3，迁移 179——空集=deny 的 enforce 层）**：新 RLS 判定先看 `request.jwt.claims.data_scope` 形状——**段存在（非 NULL；114 顶层扁平化下可 `::jsonb ->>'branch_nums'` 定位、以 IS NOT NULL 区分新旧 claims）→ 读 data_scope 各维，空段 = deny；缺失 → 回退 legacy 顶层 key（走 `claim_match_or_star`）**。分支本身即新旧 claims 的形状鉴别器，与 072 语义天然隔离；W4 切走后删回退支。**严禁对 data_scope 空段用 `claim_match_or_star`**（其空数组/NULL→true 全放——空集 deny 不能靠它执行）。legacy「空数组→`["*"]` 兜底」仅限无 data_scope 段的旧形状令牌（双氧期），W3 后在途旧形状令牌 ≤48h 短 TTL 压缩宽松窗口，W4 切走后移除。

**权限表**（`data_permissions` 单表授权 + 角色码契约）：

> ⚠️ **迁移态（2026-08-16 IAM 标准化）**：`data_permissions` 进入**双氧期**——目标态 = 数据范围三分流（§6.0 真相源总表 / §6.5 例外表），本表 **W5 DB 级写关闭**（迁移 184：REVOKE/触发器禁写 + 直写注入测试红转绿；管理页只读仅是 UX 层，不等于单写者）、**W6 删表 sunset**（迁移 185；契约测试①同步替代为 roles ⊆ Group tree + role_codes 差分期望集，167 回滚脚本保留）。下文为双氧期 legacy 语义，消费侧 W4 起切 `data_scope`（§6.2 策略分支）。
- `data_permissions`：**唯一授权表**。`subject_type` ∈ `role`/`dept`/`user`；**role 行 `subject_id` = 角色 `code`**（P0a M-1 迁移统一，改前全员 perms 快照作 diff=0 门禁、显式反向迁移脚本回滚；`roles.code` 加 UNIQUE NOT NULL + 命名空间约束 `CHECK (code !~ '^[0-9]+$')`，防 code 与其它角色 `role_id::text` 错映射）；四维 `branch_nums`/`brands`/`categories`/`can_see_cost`，**NULL = 该维未配置**（不参与合成）、`["*"]` = 全放行；`expires_at` 临时授权（NULL=永久）。行贡献：role 行四维全可配；dept 行只配 `branch_nums`+`can_see_cost` 两维；user 行按需只配要覆盖的维。契约测试：`Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}` 双向 diff 空。
- **`org_users.role_codes TEXT[]` = 持久投影（非过渡产物）**：Casdoor「人→角色」真相源在本地库的物理载体——无会话路径（agent-query / run_push 推送引擎 / 权限页 preview）与「Casdoor 宕机数据面不受影响」都靠它；只被写穿（登录 / 薄同步 / drift 对账回写），不经业务 API 直写。`role_id` 旧单值列才是过渡列（U2 验收后两版本内删，sunset 发 issue；P0a 后 role 行按 code 匹配、用户角色经 roles join 折 code 一处实现，U2 后才读 role_codes 数组，中间无第三态）。
- **多角色 cardinality（冻结进契约测试）**：数据范围合成 = **UNION**（167「角色∪部门」的自然推广，内核零改动）；`can_see_cost` 任一 true 则 true、user 行显式 false 整体替换；UI 字段 = priority 最高角色（平级字母序）；**claims 单值 `role_code` = priority 最高角色 code**；selector 命中 = 任一角色命中；`get_user_perms` 签名冻结单入参、roles 解析内移。
- `permission_audit`：**数据范围面**审计（操作者/动作/主体 + payload_before/after）；仅经管理 API 写（页面操作自动落审计），SQL 直改绕不过审计。**角色面审计缺口（显式声明）**：人→角色（帽子）变更不落本地 `permission_audit`——其审计指向 **Casdoor 操作日志**；权限页用户 tab 角列为只读（role_codes + casdoor_synced_at + Casdoor 编辑深链），不提供本地角色写入。
- `roles`：角色 UI 档案（`default_landing`/`default_metric`/`visible_panels`/`is_active`）+ 具名授权包（`data_permissions` role 行）。
- `org_departments`：部门基础信息（企微同步）；权限列已随 167 收编进 `data_permissions`（dept 行）。
- **合成规则**（`get_user_perms`，登录时写入 claims）：基底 = 角色 ∪ 部门各维 UNION（忽略 NULL，过滤过期条目）→ 个人 override 某维非 NULL 则**按字段覆盖**；`can_see_cost` = 个人 user 行配了该维即**整体替换基底**（配 `false` 可显式收回）；兜底不变（claim 缺失 / 含 `"*"` → 放行，空数组兜底 `["*"]`——**该兜底仅限无 data_scope 段的旧形状令牌（双氧期）；W3 起新签发 claims 带 data_scope 段，段存在但空 = authorized ∅ = deny，不收敛 `["*"]`**，enforce 走上节策略分支，铁律见 CLAUDE.md「catalog 单真相纪律」）。引擎侧 strict wrapper 语义见 §7.4（未知用户 NULL fail-close，空集 ≠ NULL）。
- 智能问数 perms（`get_user_perms` 返回）= `{ branch_nums, brands, categories, can_see_cost }` + 角色 UI 字段：详见 §4.2

**数据范围持久投影（方案 A，2026-08-18 推送系统 IAM 适配；spec：`docs/superpowers/specs/2026-08-18-push-iam-adaptation-design.md`）**：`org_users.scope_resources TEXT[]` = **Casdoor 角色链范围资源键的持久投影**（非真相源，只被**登录 / 薄同步 / drift 对账**写穿，不经业务 API 直写）——把「角色」投影（`role_codes`）推广到「数据范围资源」，同款写穿/对账模型（§6.1 薄同步链）。**无会话链路（run_push / agent-query / preview）经 `get_user_perms` 解析此投影拿 `data_scope`，是唯一输入**（Casdoor 宕机数据面不受影响）。投影存**归一化原始资源键**（`data-analysis:branch:X`（X=`范围|` 后原值）/ `data-analysis:brand:*` / `category:*` / `field:*`；**裸 `*` 非投影键**）不存展开门店集（maps/dim_branch 变动可重解析，不写全表）。**`get_user_perms` 在 SQL 内解析投影键**产出**新形状 `{ data_scope:{brands,categories,branch_nums}, fields:{cost} }`**（语义对齐 claims.js `resolveScopeKeys` + `collapseFullStore`：`全店`→`['*']` 短路、覆盖全集→收敛 `['*']`、分区包/单店/中文名唯一命中、未知/歧义键 fail-close 空集 = deny、无 branch 资源 → `[]`）。**双形过渡**：过渡期 `get_user_perms` 同源同值输出旧顶层四维 + 新 `data_scope`/`fields`（M6 显式摘旧 key），消费端逐一迁新形状（**兜底恒 deny：`?? []` / `?? false`，禁 `|| ["*"]`**）。

**身份视图一致性总表（哪个消费端读哪份身份快照、多旧、怎么失效）：**

| 消费端 | 数据源 | TTL/时效 | 失效方式 |
|---|---|---|---|
| 自签 JWT claims | 登录时 Casdoor roles + get_user_perms | 7 天 | 到期；离职 blacklist by sub（web API 面） |
| org_users 镜像（role_codes） | Casdoor→写穿（Casdoor-first） | 软实时，允许短暂滞后 | drift job 纠正；diff3 24h 告警 |
| casbin Permission（agent 路径） | Casdoor API | 5min 缓存 + stale-while-revalidate | 过期且 Casdoor 不可达 → fail-close + 24h stale 宽限+告警 |
| OpenClaw 服务 JWT | client_credentials | 短时（60s 刷新） | client 撤销后 ≤60s+token 寿命（撤销即时性待 P0-V2b 验证） |
| Novu subscriber | run_push 引擎 upsert | 持久 | 离职动作 delete |
| token_blacklist | 本地 | 即时 | 离职按 sub 拉黑 |

### 6.3 DuckDB /query 鉴权

详见 §4.2「智能问数查询与鉴权架构」。

核心：网关按身份建**临时权限视图**（行 `branch_nums` + 列成本组脱敏），硬编码进视图定义；LLM 生成的 SQL 在视图上执行，引擎层强制、不可绕过。`/query` 改每请求独立连接实现视图隔离；PostgreSQL 侧走真 RLS（`request.jwt.claims.branch_nums`，网关代签短时 JWT 注入）。

### 6.4 casbin 功能授权层与能力点 catalog 与动态发现（2026-08-15 新增；2026-08-16 IAM 标准化扩展）

**功能授权（能做什么）与数据授权（能看哪些行/列）分家**：功能授权进 Casdoor casbin Permission（帽子层，§6.1）。数据授权目标态 = **二分流**（静态枚举→resource / **门店→`范围|X` 资源**（2026-08-18 演进，废除 Group 挂组推导与例外体系，无例外通道）；`data_permissions` 双氧期保留、W6 sunset（§6.2）——casbin 是单次判定引擎、无 policy→SQL。**门店范围 resource 化 = `范围|X` 粗粒度键**（`范围|全店`/战区包名/单店编号/门店名）挂 permission.resources，登录经 `expandScopeResources`（读 maps + dim_branch）展开成门店集——范围键数量 O(授权组合数) 而非 O(门店数×组合)，不逐店建 policy（原「不 resource 化门店」顾虑据此不成立，08-16 spec §5.2 有演进标注）。

- **资源三段式**：`data-analysis:<模块>:<动作>`（如 `data-analysis:admin`、`push:configure`、`push:broadcast`、`push:audit`）；角色×功能资源在 Casdoor UI 配；人→角色 = Casdoor UI 人工（manual，§6.1 单写者，薄同步不写角色）。
- **报表中心页面门禁（2026-08-18 方案 A）**：`/reports*` 区域入口统一由 **`gate:reports-center`**（`门禁|报表中心`，普通页面门禁能力）把关——middleware 对 `/reports*` **直接查 `gate:reports-center`**（hasGatePerm）。`view:reports`（经营总览）/`view:reports-targets`（目标达成）**已从 catalog 删除**（scan 排除 `/reports` 路由 + OVERRIDES/VIEW_GROUPS/claims 映射清除，消除「配了经营总览只进列表不进详情」的两道困惑）；VIEW_GROUPS 全量清空。看板可见性仍由 `view-board:*`（hasBoardPerm fail-close）单独裁决；门店数据仍由 `范围|X` 裁决。**进入报表中心 = 仅需 `门禁|报表中心`**；首页 `/`（目标列表 total 行）无 view 门禁，恒可见。
- **checkFeaturePerm 单模块**：`web/lib/feature-perm.ts` 单函数收口所有功能门禁（禁散落 `userid === '...'` 硬编码）——P0a 读 claims + BREAKGLASS；U2 后读 claims + casbin 实查。切 casbin 是 1 处切换，非 N 处 hunt-and-replace。
- **BREAKGLASS env**：`ADMIN_USERIDS` 常驻白名单 P0a 即收敛为 `BREAKGLASS_ADMINS` env（默认空；启用走兜底并写审计）——常驻白名单 = 永久 Casdoor 旁路，撤权不收口。
- **高危实查（裁决-1 已裁：启用，随 U2 生效）**：admin / `push:broadcast` / 临时授权类服务端实查（5min 缓存 + fail-close + 24h stale 宽限+告警）——这是 `JWT_SECRET` 自签 admin 的真兜底（RT-7）；低危（菜单/只读）维持 7 天随自签 JWT。

**能力点 catalog 与动态发现（2026-08-16 新增，spec §5.1）——功能能力点真相源 = catalog（代码）+ casbin Permission(resource) + 同步 adapter**：

- **catalog 单真相（H12，纪律同级铁律，已写入 CLAUDE.md）**：`capabilityCatalog` 只存在于 `web/lib/capability-catalog.ts`（+ scan 产出的 `capability-catalog.generated.ts` 输入）单副本；组成 = generated（scan 自动发现）+ overrides（人工只改展示属性/敏感标记，不增删 key）+ manual（门禁/品牌/品类等 scan 覆盖不到的）。**function（claims 构建器）只消费不内嵌复制 catalog 子集**——function-only 部署（SSH 直调，不触发 catalog scan）会制造漂移副本，属违规。新增视图/路由 = 改 view-configs / app 路由，catalog 由 scan 自动发现。
- **命名空间**：`data-analysis:view:<name>`（逐看板细粒度）/ `view-group:<name>`（授权组，§6.5）/ `field:<slug>`（敏感字段列掩码，现 cost）/ `brand:3120|64188` / `category:水果|标品|耗材`（数据范围静态枚举）/ `data-analysis:admin`（管理台门禁）。**`push:*` 是引擎裸 key 保持无前缀**（引擎字面量校验，加前缀将致恒 403；不入 catalog）。
- **动态发现闭环**：① 加路由/视图 → ② scan（`scripts/scan-capabilities.mjs`）→ catalog 草案（**只增不减**）→ ③ 部署钩子（GHA step）+ cron 对账双通道 → resource 同步 adapter → Casdoor `add-resource`（原生 API）→ ④ 管理员勾角色（或能力目录辅助页 `/admin/capabilities` 复制 key）→ ⑤ claims 重建 → 校验器放行 + `catalog_v` 更新 → 生效。
- **add-resource adapter 怪癖（H3）**：add-resource = 裸 Insert（PK=owner+name，重复即报错；GetResource 查表恒加 `/` 前缀）→ adapter 统一 `/` 前缀归一化写入、幂等 = 先查差集只插缺口、并发撞 PK → retry + 吞 duplicate；**只增改不删**（原生 delete 挂 Storage provider 无 Storage 不可用，与废弃清单回滚语义自洽）。含中文/冒号的 resource name 字符集行为列入 V2 源码验证；**同步失败不得静默跳过**——逐 key 显式反馈（成功/失败/重试），失败进对账红区。
- **废弃清单生命周期（H14/M2）**：闭环只增不减，下架不自动撤销。删除走 catalog 内 `deprecated` 集合（app 侧唯一载体，不入 Casdoor；owner=平台管理员）；校验器对废弃 key fail-close + 告警。驱逐判据（deprecated → removed）= 清单发布 ≥30 天 ∧ 审计确认无「具名 + 通配」引用 ∧ cron 对账红区清零，由平台管理员执行留痕。
- **通配残余（已知接受）**：持 `view:*`/`brand:*`/`category:*` 的角色对已下架 key **保留能力直至改 permission**——解析期校验（§6.1 catalog_v）只挡具体点名 key，通配本身 ∈ catalog ∪ `*` 合法通过。通配授权列入高风险清单（单独审计 + 24h 新资源 diff 观察）；审计「仍引用废弃 key」排查项必须含**通配持有者列表**（引用的是 `*` 非具名 key，按 key 审计显示不出）。
- **校验器（fail-close）**：只认 catalog ∪ `*`；未注册 key → 拒绝 + 告警（反向发现：配置了不存在的能力立刻报错）。请求具体 view K 时，claims 内通配展开匹配后的**具体 key 仍须 ∈ catalog ∪ deprecated**（解析结果粒度，堵「K 已驱逐但持通配者照常可用」）。

### 6.5 授权组 view-group 与例外表 temporary_grants（2026-08-16 IAM 标准化新增）

**授权组 view-group（易用层，细粒度的副作用治理）**——细粒度逐看板授权的管理员勾选成本高，授权组 = 一组 view 的 union 判定：

- **映射定义在 catalog（app 侧），不复制进 Casdoor policy**——Casdoor 只见组名 resource（勾选简单）；data-analysis 消费侧命中组名后展开成员判定（视图可见）。支持嵌套组 + `*` 兜底（继承 casbin Matcher）。
- **成员禁含通配**：`view-group:*` 兜底下新增能力自动扩权不可控；成员只允许具名 `view:*` key，且必须 ∈ catalog（校验器保证）。
- **环引用检测**：嵌套组 A→B→A 展开死循环 = 登录链路卡死；catalog 校验含环引用检测（红/绿测试）。
- **成员变更生效粒度**：显式声明（batch-enforce 重建挂 webhook 事件，或显式时效），测试覆盖「成员变更 → 声明粒度内生效」。

> **⚠️ 2026-08-18 用户裁定：例外体系（temporary_grants）已废除**——数据范围唯一真相 = `范围|X` 资源（§6.0/§6.4），**无例外通道**。pgrst_pre_request 的 x_grants 并集段、scope_match_v2 的 x_grants 分支已删除（迁移 197）；`temporary_grants` 表保留冻结（历史授权记录，不再消费）。带到期的临时授权一律改用 `范围|X` 资源（临时挂上、到期摘除）。下方为废除前设计，仅作历史参考。

**例外表 temporary_grants（已废除，2026-08-18 前设计）**——IAM 无到期语义（Casdoor 角色无过期），带到期的临时授权是 app 侧例外机制：

- **形态**：`temporary_grants(user_id, dim, value, expires_at, note)`；授权中心 UI（`/admin/permissions` 例外 tab）维护。**例外不折叠进 claims（B5 铁律）**——登录时折叠 = 撤销窗口拉到 token 寿命（7 天），禁止。
- **RT 实查（5min 缓存 TTL，命名钉死）**：实查段做 5min 缓存实查 temporary_grants——**健康态撤销 ≤5min 生效**；授权中心撤销/删除时**同步清该 sub 的例外 RT 缓存**（TTL 立即作废，不靠 TTL 兜底）。本地表降级 = DB 不可达 → fail-close（等同无例外），不产生 24h 窗口（裁决-1 的 24h stale 仅限远端实查场景）。
- **RT→RLS 通道（防实现倒退回折叠）**：例外门店集经 `pgrst_pre_request` **每请求并集进 request.jwt.claims 专用 claim 段**——天然覆盖 PostgREST 全通道（含直连 SQL/联邦查询）；middleware 快判同源。**禁止登录时折叠进 data_scope / 旧 key**。
- **授予面门禁**：授/撤例外需 `data-analysis:grant` 类 capability + 全量进 permission-audit + 单次授额上限（一店/维度到期天数上限）+ 双人复核可选配置——防「app 侧自授读店」通道。

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
| 业务推送投递（Novu 链路） | chat-webhook 回调 → `/api/wecom-bridge/<bridge_token>`（双层验签）→ `message/send` | App B（wecom-bridge，web api route；详见 §7.4） | 🆕 规划（2026-08-15 spec，未实施） |

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
- **软删除**：`org_users` / `org_departments` 加 `is_active BOOLEAN DEFAULT TRUE`，离职 / 删部门标 false 保留行（保历史 + 不破坏 `data_permissions` 的 user/dept subject 关联，登录拦已离职）。
- **secrets（注入 web 容器 compose env）**：`WECOM_TOKEN` / `WECOM_ENCODING_AES_KEY`（回调验证解密，企微后台「通讯录同步→API接口同步」生成）/ `WECOM_CORP_ID`（已有）/ `WECOM_OPS_SECRET`（user/get，App B）。route 经 `process.env` 读。
- **nginx 路由**：加 `location /api/wecom-contacts-webhook → web:3000`（前缀长于 `/api` 兜底，nginx 最长前缀匹配优先），否则 `/api` 兜底送到 insforge:7130 又踩 body 限制。
- **幂等 + 5s 超时**：upsert 与 `SET is_active` 天然幂等，企微重试安全；处理 < 600ms，5s 内必返。
- **回调 URL**：`https://data.shanhaiyiguo.com/api/wecom-contacts-webhook`（企微后台「通讯录同步」填，会先 GET 验证才允许保存）。
- **限**：依赖企微回调可达 + 企微「通讯录同步」功能已开启；回调漏的消息靠每日全量兜底（最长次日纠正）。`functions/wecom-contacts-webhook` 废弃（逻辑移至 web/api）。

**🆕 Casdoor 薄同步三动作 + 离职四 sink（2026-08-15 spec，U1 起，详见 §6.1 薄同步链）：**
- 同步链扩展为**薄同步（2026-08-18 收缩：仅同步人 + 组织架构）**：在 upsert 本地表之外向 Casdoor 写——① **provisioning**（JIT 建户，带部门组；角色人工配，Casdoor UI 唯一写者）；② **离职 disable**（Casdoor 新登录即时拦截）；③ **组对账**（`actionSyncGroups` 按企微部门补挂用户组）。**auto 角色写入（dept_role_mapping → assignRoles）已删除**（生产实测 0 auto 用户，角色归属全量 manual）。写 Casdoor 失败入 `sync_outbox`（幂等键 wecom_id+action+day）重放，>48h 页级告警；每日 drift 三向对账。
- **离职四 sink（收权分层，诚实口径）**：① web API 面——middleware `is_active` 软校验 + `token_blacklist` 按 sub 拉黑（**即时**）；② 推送面——run_push 存在性守卫 + 订阅 owner 再校验（**即时**）+ **Novu subscriber delete**（消除残留投递，§7.4）；③ Casdoor 新登录 disable（**即时**）；④ 数据面（PostgREST/RLS）——旧 7 天 JWT 继续有效，**最长 7 天窗口（裁决-4 已裁：接受，与现状等价非新债）**；即时化真执行点为 pgrst_pre_request 扩展，留作未来选项。

**组同步（2026-08-16 IAM 标准化，W2 起，spec §5.3；2026-08-18 收缩）——仅部门树，门店组树已废弃：**
- **用户同步走 Casdoor 原生 wecom syncer**（源码验证）；Casdoor 原生 `GetOriginalGroups/GetOriginalUserGroups` 返回空带 TODO（`object/syncer_wecom.go`）。
- **部门树单通道（2026-08-17 用户裁定 + 2026-08-18 落地）**：组织架构严格按企微——企微无门店层部门，Casdoor 即不建门店组；门店范围不依赖组织架构（`范围|X` 资源唯一真相）。**门店树组同步器 `web/lib/sync/group-sync.ts` 已删除**（零引用死代码）；用户挂组由薄同步 `actionSyncGroups`（`syncUserGroups`）按 `department_ids` 补挂维护（只增不删，防橡皮擦）。
- **建树先父后子（H1，硬约束）**：`ParentId` 存父 Name，父子链断裂（重命名/中断/先子后父）触发原生 `GetUserFullGroupPath` return error → **该组所有用户 JWT 签发失败、登录崩**——每日父链完整性校验 + 组树完整性指标（辅助页亮灯，fail 告警）。
- **门店自省映射 `maps_branch_group`**（迁移 178）：`(branch_number, group_id) UNIQUE`——`dim_branch` 与 Casdoor Group 双向可查；登记新店 = dim_branch 建档 + 同步器建 Group + 映射行（3 处一致，对账盯）。**门店键一律用 `branch_number`**（复合键铁律，CLAUDE.md）。映射只校验「门店→组」存在；「谁该挂哪组」靠独立期望源「人→门店」成员级对账（期望源≠org_departments 自投影，防循环自证）。
- **组类型三态（H13）**：门店叶子组 → 直映 branch_number；区域组 → 子孙门店叶子并集；部门/职能组 → 不参与 branch 展开。空集 = 空 scope 非 NULL（消费侧可区分）；未知组类型 → fail-close + 告警。
- **删除与审计**：删除限于同步器建的组（原生 Group 有子组/挂用户即拒删；门店停用 = isEnabled=false + 摘挂 + 打标，非真删）；同步器写操作带「自动化」标记与 Casdoor UI 人工勾挂区分，admin 自挂/挂改门店叶子组 = 高风险事件接入告警。
- **groups 投影（F9）**：写穿镜像 `org_users.groups`，供无会话路径（run_push 逐人 perms、agent-query）算门店行；消费侧 SQL 用 `jsonb @>`/`?` 精确匹配（禁前缀/LIKE），登记校验禁组名含分隔符。

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

### 7.4 Novu 统一推送中心（2026-08-15 设计；2026-08-20 已上线含多消息类型呈现层）

spec：`docs/superpowers/specs/2026-08-15-novu-push-platform-design.md` + IAM 适配 `2026-08-18-push-iam-adaptation-design.md`。**业务推送**（订阅/定时/agent 推送）统一切换到 Novu；**系统告警留 `wecom-notify` 不动**（§7.1.1）；wecom-push 退役（停 cron 不删码，一键回退）。

**拓扑与链路（控制面 113.249.101.33，与 Casdoor 同机 26G 盘）：**

```
触发判定（永在本地：web/lib/jobs 注册表 scheduler / OpenClaw push-admin 插件）
  → run_push 渲染引擎（web/lib/push/，唯一入口）：
      selector 解析 → 悬空守卫 → 存在性守卫 → 数据就绪守卫
      → 逐人实时 get_user_perms（PERMS_INPUT 感知，不消费 7 天 JWT claims）
      → scope 签名分组（四维 canonical JSON，can_see_cost 必入签名）→ 每组短时 JWT（≤10min）代签
      → 查语义视图算变量（数值变量= 代签 JWT 查 report_achievement_gen 聚合 actual/target，
        RLS 按组 scope 裁剪——§12.1 取值，取不到=变量跳过不渲染；URL 变量= /report/<view>?jwt=…；
        cost_sensitive × 组 can_see_cost=false → 脱敏）
      → NovuGateway.triggerBulk（≤100/批，txnId 贯穿）
  → Novu 社区版（org=shanhai 山海租户；dumb pipe，不反查业务库）
  → chat-webhook（官方扩展点；不 fork 不自研 provider）
  → wecom-bridge（web api route `/api/wecom-bridge/<bridge_token>`，双层验签）
  → 企微 App B message/send（共享 wecom 发送库，双运行时副本+契约测试）
降级：Novu 连续失败 → 自动回退 wecom-notify 直投——走同一引擎渲染的分组产物，只换投递通道
```

- **代签 JWT 形状（2026-08-18 推送 IAM 适配，方案 A）**：`generateScopedJwt` 每组短时代签 JWT（≤10min）payload = `{ role:'authenticated', data_scope:{brands,categories,branch_nums}, fields:{cost}, departments, iat, exp }`——**内嵌 `data_scope`/`fields`，与登录 claims 同形状（§6.1）**，RLS（scope_match_v2）读 `data_scope` 段放行；**移除**旧顶层 `branch_nums`/`brands`/`categories`/`can_see_cost`/`scope`（无消费方，185 已摘）。scope 签名（scope-signature.ts）数据源 = 解析后的 `data_scope` + `fields.cost`，canonical 四维 key 不变。数据来源 = 逐人实时 `get_user_perms` 读 `scope_resources` 投影解析（§6.2），不消费 7 天 JWT claims。

- **变量注册表**：`push_variables`（var_code PK / metric_code REFERENCES metric_registry / scope_dim / extra_filter JSONB）；口径复用 `metric_registry`（AST），**生成器零改动**——新可推指标 = INSERT 一行；extra_filter 写入校验**禁裸 `branch_num`**（门店键铁律）。
- **呈现层 preset（2026-08-20 平台能力；同日两连踩更正）**：`push_message_presets` 按 workflow 配置消息形态（msgtype = text/markdown/textcard/news/template_card + 字段模板，支持 `{{var}}` 插值；template_card 支持 `card_json` 完整 card 对象深度插值，203）→ 引擎渲染成 `message_content`（JSON 契约）进 payload → Novu content 固定 `{{{message_content}}}` → bridge 按 content JSON 的 `msgtype` dispatch 到企微对应消息体，纯文本走 markdown（疑似 JSON 契约却 parse 失败 → 告警日志 + markdown 降级，不静默）。改卡片样式/消息类型 = 改 preset 行，不动 Novu 模板与代码。**Novu 模板两条铁律（2026-08-20 生产两连踩）**：① 渲染上下文是 payload 平铺（worker `getCompilePayload`），`{{payload.X}}` 恒渲染空串；② `CompileTemplateUsecase` 用原生 Handlebars，双花括号 `{{X}}` 会 HTML 转义（`"`→`&quot;`）破坏 JSON 契约——**必须 triple-stash `{{{X}}}` 且变量在 step template.variables 声明**。**消息形态统一裁定（2026-08-20）：推送消息统一 `template_card` `news_notice`**（card_action 短链跳 `/reports/targets`，企微会话自带权限，避开 1024B URL 限制）；字段限制实测：markdown content≤2048B 且无内联图；textcard url 必填；news picurl≤2048B url；template_card card_action.url≤1024B（JWT 长链超限→用短链）；多区域独立跳转 = card_action + quote_area/image_text_area/horizontal[type=1] 各自 url。速查：`docs/ops/wecom-message-capabilities.md`。
- **横幅渲染（2026-08-20 方案 C 起步 → 2026-08-21 升级为报表数据横幅，推送时数据驱动 + 对象存储）**：template_card `news_notice` 的 `card_image` 由静态占位图升级为**报表中心风格动态横幅**——内容 = 目标看板第一页数据：KPI 卡片（销售达成/出库/出库毛利等 4 指标）+ 品牌指标（3120 熊喵 / 64188 品品甜 / 合计）+ 门店战区表（东/南/西/中 4 战区各指标的数值行），保留报表页样式（深蓝主色 + 达成三色 + tabular-nums）。
  - **数据流（推送时预渲染，值不落 URL）**：推送触发 → 引擎用组代签 JWT（≤10min，RLS 按 scope 裁剪，§6.1/§12.1）查 3 个语义视图（`report_achievement_gen` target_level=total、`report_brand_metric_gen`、`report_region_breakdown_gen` region 级）→ 拼 SVG（1080×480，aspect 2.25，@font-face 内嵌 Noto Sans SC 子集扩展——品牌/战区名为 dim 表有限串）→ sharp 渲染 PNG → **PutObject 写天翼云 OOS 私有桶 `push-assets/banner/<uuid>.png`**（S3 兼容，web 容器已注入 `S3_ENDPOINT/OOS_ACCESS_KEY/OOS_SECRET_KEY/OOS_BUCKET`）→ `card_image.url` = 签名短 URL `https://data.shanhaiyiguo.com/api/push/banner?k=<uuid>&sig=HMAC-SHA256`（值不落 URL，避开中文名 URL 编码超 1024B）→ 企微无会话抓图 → GET 路由验签 → **S3 GetObject 读回 PNG** → 返回。
  - **可配置变量**：注册为 `push_variables` 变量码 `report_banner`（默认 preset `scheduled-report-card` 的 `card_image.url` 由占位图升级为 `{{report_banner}}`）——自定义推送模板可显式引用，引擎渲染时若模板未引用则跳过预渲染（不浪费对象存储写入）。
  - **鉴权/暴露面**：企微抓图无 cookie 会话，URL 带 HMAC-SHA256 签名（JWT_SECRET 派生 secret，key=sha256(JWT_SECRET+":push-banner")），签名覆盖 `(k, 过期时间)`。桶保持**私有**（RLS 保护业务数据，禁止 public-read/可遍历/可转发），读回只经签名路由。banner 数据 = 报表页同一批视图数据（同 scope 裁剪），**无新增暴露面**。对象键含 uuid，防遍历猜号。
  - **TTL/清理**：对象存 7 天，定时任务（`jobs/` 注册表，每日）清扫过期 `push-assets/banner/` 对象。
  - **中文渲染**：SVG `@font-face` data URI 内嵌 Noto Sans SC 子集（OFL 协议，商用合规）——生产 alpine 容器无 CJK 字体也不依赖系统字体，SVG 自包含，dev/prod 像素一致，零 Dockerfile 改动（已验证 sharp 可渲染中文字体）。
  - **依赖**：sharp（web 显式直接依赖 0.34.5）+ `@aws-sdk/client-s3`（已依赖，duckdb carry-dims 同款）。进程内不再缓存 PNG（对象存储即缓存），仅字体资产常驻。
  - **影响面**：改 web/（引擎报表变量解析 + SVG 布局扩展 + S3 写入/读回 + 路由改 S3 读回 + 字体子集扩展 + push_variables 注册 `report_banner` + 迁移 203 种子 preset 改 `{{report_banner}}` + TTL 清扫 job）——无新表/无 function/无 nginx 改动（`/api/push` 已由网关代理到 web:3000）。GHA 完整部署。
- **Novu 能力使用边界（2026-08-20 用户裁定：Novu = 投递通道 + 聚合编排器，不是通知中心）**。结构性原因：Novu 设计假设是「一个模板 × N 个 subscriber × 同内容」，而我们是**逐人 data_scope 分组渲染**（同一篇日报每人数值/链接不同），内容必须在引擎侧渲染好逐组 trigger——broadcast/Topics/In-App 天然不适用。边界清单：
  - ✅ **在用**：chat-webhook + per-subscriber webhookUrl override（逐人 bridge 路由）、bulk trigger、Handlebars 渲染（退化为一个变量 `{{{message_content}}}` 透传，呈现全收 DB preset——Novu 里配得越少黑盒越少）、management/messages API、5xx 自动重试。
  - 🔜 **按需启用**：Digest 消息聚合（monitor_rules 告警接入时用于告警风暴聚合——近期最值钱的闲置能力）；多渠道兜底（bridge 502 连续失败 → workflow 条件步骤切邮件渠道补发）；Analytics dashboard（自部署自带，发送量/成功率趋势）。
  - ❌ **明确不用**（无场景，不为用而用）：In-App 收件箱（企微即收件箱）、Broadcast（全员同内容——我们有 broadcastPerm 闸+分组渲染，必须逐组）、Topics（selector 查库已覆盖）、i18n、Tenants、Preferences（暂无自助退订需求，出现再评）。
  - **模板侧不变量**：workflow 保持单 step 单变量（`{{{message_content}}}` + variables 声明），不在 Novu 里加步骤/条件/多渠道编排，除非走了上面 🔜 项的正式裁定。
- **双向白名单**：data 机（出口 113.249.120.84）↔ 控制面；Novu API 白名单仅接受 data IP（CE 是否原生支持 IP allowlist 待 V1b 验证，否则前置 nginx 限流）；wireguard 隧道 P0-V4 评估（不可行退双向白名单）。
- **探活方向从 data 侧发起**（挂 monitor/probe evaluators）——控制面单机不能自证存活。
- **容量 gate / TTL / 备份 / 水位**：上线前磁盘余量 ≥8G + RAM 实测（栈常驻 2-4G，与 Casdoor 同机）；镜像经天翼云仓搬运（跨境拉取不通）；mongodb TTL 索引 90 天；磁盘水位 80% 告警；workflow 定义每日 export 落对象存储（mongodump 仅磁盘充裕时加做）。
- **txnId 数据流（可解释性骨干）**：run_push 每次触发生成 txnId → `push_trigger_logs`（元数据：txnId/触发者/selector 定义/分组数/收件人清单/**scope 签名明文**/变量 code 清单/skipped 记录）+ `push_trigger_payloads`（值快照，TTL 7 天；读取需 `push:audit` 且读取者 scope ⊇ 分组 scope，不满足只见哈希）→ Novu payload → bridge 日志 → 降级路径——「触发成功没人收到」三方可拼。幂等与补发：合法补发=新 txnId；防重复靠 bridge nonce（键=(token, body hash)，封跨 token 移植重放，TTL 1h）+ Novu subscriber transactionId。
- **引擎签名层 engine_sig（伪造链断点，RT-2）**：bridge token 与 Novu SecretKey 同存 Novu 侧 = 攻破 Novu 得完整伪造链（可伪造数值钓鱼）。故引擎每条 trigger payload 内嵌 `engine_sig = HMAC-SHA256(txnId + subscriberId + content_digest, ENGINE_BRIDGE_SECRET)`；`ENGINE_BRIDGE_SECRET` 只存 web/bridge 侧（**Novu 不知**）；bridge 验签顺序：① `X-Novu-Signature`（Novu 身份）→ ② `engine_sig`（**引擎身份**）。攻破 Novu 只能重放历史合法消息（nonce 挡），不能伪造新消息。
- **推送面鉴权（push-admin 三层）**：企微 requesterSenderId → OpenClaw push-admin 插件（服务身份 client_credentials JWT + 人员身份 body.userId）→ web 内部 push API（JWKS 验签 → Casdoor Permission 闸 `push:configure`/`push:broadcast`）→ run_push 引擎闸兜底（§4.4 C4）；收件人必须结构化 selector（首期 dept/person 子集）。

---

## 八、运维与监控

### 8.1 监控告警体系（2026-07-08 设计，详见 `docs/superpowers/specs/2026-07-08-monitoring-system-design.md`）

**引擎拓扑**：复用 web 端 node-cron（`web/lib/scheduler.ts`），新增「监控扫描」调度，不新增容器/function。扫描按 check_type 自然节奏分桶：每分钟 `service_down` / 每 5 分钟 `collect_fail`·`request_fail`·`token_expire` / 每小时 `data_freshness`·`contact_sync` / 每日 `data_integrity`。防重入复用 scheduler 现有 globalThis 锁。

**数据模型**（新表）：
- `monitor_rules`：规则定义（check_type 枚举 + target + threshold(jsonb) + severity + touser + template + suppress_window + enabled）。
- `monitor_alerts`：告警状态/事件（`alert_key` UNIQUE → 同问题一行；status active/resolved；first/last_seen；occurrence_count；last_notify_at；context）。降噪与恢复核心。
- `external_request_logs`：`callLemengApi` 每次调用埋点，`request_fail` 数据源（>7 天清理）。
- ⚠️ 前置修复：`collect_logs` 加 `duration_ms`/`response_summary`（现代码写这两列但表没有，写入静默失败、大盘耗时列恒空）。

**check_type 清单（实现状态以 `web/lib/monitor/evaluators/` 为准，2026-08 审计）**（每个一个纯函数 evaluator：读数据源 → 比 threshold → 产出 firing/alert_key/context）：
| check_type | 数据源 | 触发 | 状态 |
|---|---|---|---|
| `token_expire` | `auth_credentials` JWT，解 payload `exp` | 剩余 < before_hours；token 缺失/无法解析也 firing（evaluator 给 `message` 覆盖模板，避免静默"恢复"致盲） | ✅ 已实现 |
| `collect_fail` | `collect_logs` | 连续失败 ≥ consecutive | ✅ 已实现 |
| `service_down` | 主动探活 web/duckdb/insforge/postgres/deno/openclaw（应用级，5s 超时） | 任一不可达 | ✅ 已实现 |
| `collect_stall`（🆕 迁移 165，设计清单外新增） | `collect_tasks.last_run_at`（rule.target = task_id） | enabled=true 且 now - last_run_at > 阈值（采集卡死/未跑） | ✅ 已实现 |
| `request_fail` | `external_request_logs` | 窗口失败率 > failure_rate | ⏳ 未实现 |
| `data_freshness` | PG 汇总表 + DuckDB parquet 最新日期 | 距今 > stale_hours | ⏳ 未实现 |
| `data_integrity` | DuckDB 明细 count vs PG 汇总 | 差异率 > diff_rate | ⏳ 未实现（部分职能由 QA 体系承担，§10.10 L4） |
| `contact_sync` | `org_users.updated_at` + 回调最近时间 | 距上次同步 > max_age_hours | ⏳ 未实现 |

**告警生命周期**：firing → upsert `monitor_alerts`(active) + `occurrence_count++`；`suppress_window`（默认 30min）内不重复发；问题消失 → 转 resolved + 发「已恢复」。规则改阈值/收件人/模板/级别/开关走表，不发版。

**通知出口（主 + 兜底）**：
- 主通道：复用 `functions/wecom-notify`（App B，凭据单点；web 薄客户端 `lib/notify.ts` → `notifyWecom()`）。
- **兜底通道（关键）**：`service_down` 探到 InsForge 不可达时，wecom-notify 也发不出（它跑在 InsForge 上）→ web `notifyWecomDirect()` 用 `WECOM_OPS_SECRET` 直连企微 `message/send` 绕开 InsForge。仅此一条路径直连。
- InsForge 不可达 = 大故障，兜底通道是唯一能让外界知道它挂了的手段。

**只读大盘**：已上线 **`/admin/sources/monitor`**（实时活跃告警 + 事件流 + 健康灯 + 采集日志），走 PostgREST 只读。

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
| 身份/权限分层 | Casdoor 管身份（`wecom_id`）+ SSO 会话；data-analysis 拿 `wecom_id` 后本地合成 `perms` 自签 PostgREST JWT（`JWT_SECRET` / RLS / 权限表不变）——2026-08-15 起细化为帽子×座位×口径四层（§6.1） | 2026-08-08 |
| Casdoor 独立化 | Casdoor 从 data-analysis 寄生迁到控制面（113.249.101.33 `/opt/casdoor`，独立 docker compose + **独立 postgres**），成平台级身份基础设施；data-analysis 退化为普通 OIDC client；Caddy 反代 sso 域名（specs/2026-08-09-casdoor-independent-design.md） | 2026-08-09 |
| 代码组织规范 | A+B-lite：目录即模块（collectors/jobs/report-center-boards）+ 尾部追加式注册表 + 契约单源（web/lib/contracts）；不引入运行时插件框架、不拆服务、不改部署拓扑。P0–P5 分阶段（spec `docs/superpowers/specs/2026-08-11-modular-plugin-design.md`，评审 `docs/design/modular-plugin-architecture-review.md`） | 2026-08-11 |
| 语义层 Cube 全替代 | Cube headless 成为查询引擎与语义定义唯一手写层（schema YAML，git）；metric_registry 冻结新增、生成器按"物化上移 + 退役清单"退出（四硬口径移 /compute 跑批）。**已确认的三条让步**：报表可用性绑 Cube 常驻（迁移期保留视图逃生通道）；报表路径行级权限由 RLS 上移至 securityContext（data_scopes 同源，RLS 退守 PostgREST 管理路径）；QA 围绕 /v1/sql + 对账 diff 重建。spec `docs/superpowers/specs/2026-08-15-semantic-query-middleware-design.md`（v2）。关联同日权限三层、Novu 推送平台两 spec | 2026-08-15 |
| 功能授权进 Casdoor casbin（D1/D2） | casbin 只管功能授权（资源三段式 `data-analysis:<模块>:<动作>`，§6.4）；人→角色在 Casdoor 配（UI 人工+薄同步 auto 单写者）；角色码两侧契约锁定（role 行 subject_id=code）；数据范围留 `data_permissions`，RLS/视图/claims/pgrst_pre_request 执行点零改动。spec `docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md` | 2026-08-15 |
| 通讯录薄同步（D3） | Casdoor 三动作（provisioning JIT 建户 / auto 角色写入 / 离职 disable）挂 wecom-sync-contacts 链；`casdoor_writer` 单写者 + `sync_outbox` 幂等重放 + 每日 drift 三向对账（§6.1/§7.1.2）；本地角色写者 U1 起收编/冻结 | 2026-08-15 |
| Novu 自部署统一推送中心（D4/D5/D7） | 社区版、控制面 113.249.101.33、org=shanhai；企微投递 = chat-webhook 官方扩展点 + 自建 wecom-bridge（web api route，双层验签）；只切业务推送（系统告警留 wecom-notify），wecom-push 退役（停 cron 不删码）；不 fork 不自研 provider（§7.4） | 2026-08-15 |
| 推送配置入口（D6） | push-admin = OpenClaw 中文对话自助配置（插件模式，照 data-query-plugin），不自建中文模板 UI；工具面 4 个（list/create_workflow/create_schedule/push_now） | 2026-08-15 |
| 服务身份链路（D8，裁决-3 调整） | push-admin 走 Casdoor client_credentials 短时 JWT（scope 仅 openclaw:*，永不含 admin）+ web 侧 JWKS 验签；agent-query token 化（U8）**推迟独立排期**——模式由 U6 验证、切换延后；过渡防护（A6 审计异常检测+AGENT_API_KEY 轮换 runbook）随引擎首发，AGENT_API_KEY 降级开关保留 | 2026-08-15 |
| permissions 生效时效（D9，裁决-1 细化） | 低危（菜单/只读）随自签 JWT 7 天；**高危实查已裁启用**——admin/push:broadcast/临时授权类服务端实查（5min 缓存 + fail-close + 24h stale 宽限），随 U2 生效（§6.4）；BREAKGLASS_ADMINS env 替代常驻白名单（默认空） | 2026-08-15 |
| Casdoor 单点口径（裁决-2） | SLO 化：存量会话零影响 + 新登录恢复 <2-4h + page 告警；break-glass 凭证 best-effort 并行验证，通过后升冷备（§6.1） | 2026-08-15 |
| 数据面离职窗口（裁决-4） | 接受 7 天 JWT 窗口（与现状等价非新债）；web API/推送/Casdoor 三面即时收权（离职四 sink，§7.1.2）；即时化执行点（pgrst_pre_request 扩展）留作未来选项 | 2026-08-15 |

> 以下为 **2026-08-16 IAM 标准化 spec**（`docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`，revision-2）已确认决策——D1-D8 编号**与上表 08-15 spec 的 D1-D9 是两套编号，勿混淆**；前三行为无编号原则确认（用户 2026-08-16 原则批准，spec 已确认决策节全量誊写）。实施 W 轴 W1-W6（§6.0/§6.4/§6.5）。

| 决策项 | 确认结果 | 确认日期 |
|--------|---------|---------|
| 看板分级细粒度（原则确认） | 逐看板 `view:*` 独立授权，不做组级大揽权；授权组（view-group）作为易用层可配可省（§6.5） | 2026-08-16 |
| 列级脱敏留扩展空间（原则确认） | `field:*` 统一命名 + 两步扩展法（catalog + 掩码配置），生成器不动（改述：生成器只接受 catalog 驱动输入，掩码消费位 = 非生成器运行时层，H7） | 2026-08-16 |
| catalog 动态发现机制（原则确认） | catalog 自动发现（代码派生）+ 部署钩子 + cron 对账 + 校验器（认 catalog∪`*`，未知 key 拒绝）双向通道（§6.4） | 2026-08-16 |
| 门店上收 Group tree（D1） | 每门店一组、人挂组；组织架构中心化 = Casdoor Group tree，本地 org 表降级只读投影（§6.0/§7.1.2 组同步器） | 2026-08-16 |
| 门店范围废除组织架构推导（2026-08-18） | 范围唯一真相 = `范围\|X` 资源（permission.resources，直接挂现有 permission）；无范围资源 = 空集 deny（B1 fail-close）；删 `expandGroupsToBranches`/`resolveGroupBranches`；组织目录（Group tree/组同步器/reconcile-groups 审计）保留仅目录用途 | 2026-08-18 |
| 薄同步收缩为仅同步人+组织架构（2026-08-18） | 删 auto 角色写入链路（`derive-roles.ts`/`assignRoles`/outbox `assign_role`）与门店树组同步器（`group-sync.ts`）；薄同步保留 provision（JIT 建户）/ disable（离职）/ 组对账（部门组补挂）；角色归属全量 manual（Casdoor UI 唯一写者，生产实测 0 auto 用户）；`wecom-sync-contacts` 的 `refresh_role_assignments` 调用已删（已部署）；`role_id` 过渡列停更——`get_user_perms` 本就走 casdoor-only（185 终版读 `role_codes`）不受影响；**push 按角色收件人已切 `roles.id→code→role_codes` 解析**；perm-shadow legacy 对比属过渡影子（W6 sunset 清） | 2026-08-18 |
| 报表中心页面门禁统一为 gate（2026-08-18 方案 A） | `/reports*` 入口由 `gate:reports-center` 单一把关（middleware hasGatePerm），不再按路径查 `view:reports`/`view:reports-targets`；**两 view key 已从 catalog/claims 删除**（scan 排除 /reports 路由、VIEW_GROUPS 清空，消除「经营总览/目标达成分开配」困惑）；看板 `view-board:*`、数据 `范围|X` 分层不变；middleware 门禁拒绝落首页显示提示条 | 2026-08-18 |
| data_permissions 全撤（D2） | 数据范围三分流后目标 sunset：W5 DB 级写关闭 → W6 删表（§6.2 迁移态）；只留例外表；回滚路径 = 例外表扩容，**不反向恢复四维表** | 2026-08-16 |
| 品牌/品类独立 resource 化（D3） | 静态枚举（品牌/品类/字段）→ Casdoor resource，不并入 `view:*` 判定（§6.4 命名空间） | 2026-08-16 |
| 授权组 view-group（D4） | 要（易用层）：catalog 内映射、Casdoor 只见组名 resource、成员禁通配 + 环引用检测（§6.5） | 2026-08-16 |
| 部署钩子 + cron 对账双通道同步（D5） | resource 同步双通道：GHA 部署钩子（scan→validate→sync）+ cron 对账兜底（§6.4 动态发现闭环） | 2026-08-16 |
| 变更传播 webhook 事件（D6） | Casdoor webhook 事件驱动（非轮询）；payload 只当「失效信号」，数据一律以 re-pull/对账为准；组变更 → 数据面 JWT 即时失效（token_blacklist by sub） | 2026-08-16 |
| 例外表放 app（D7） | IAM 无到期语义，temporary_grants 留 app 侧；RT 实查（5min 缓存）不折叠进 claims（§6.5，B5） | 2026-08-16 |
| 例外体系废除（2026-08-18） | temporary_grants 不再作为授权通道（pgrst_pre_request x_grants 段/scope_match_v2 x_grants 分支删，迁移 197）；表保留冻结历史；临时授权改用 `范围\|X` 资源（挂上到期摘除） | 2026-08-18 |
| casbin 实查默认开（D8） | 裁决-1 继承：高危实查（admin/push:broadcast/临时授权类）默认启用，shadow 一周 ±0 后转正，E2E 冒烟 | 2026-08-16 |

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

（report_definitions 实际 8 项，以 `database/migrations/` 为准：010 基础 3 项 + 058 配送/批发 2 项 + 108/109–111/157 商品/客户级 3 项）

| report_type | 名称 | 目标表 | 状态 |
|-------------|------|--------|------|
| daily_sales | 每日门店销售汇总 | report_daily_sales | ✅ |
| daily_category | 每日门店品类汇总 | report_daily_category | ✅ |
| weekly_trend | 周销售趋势汇总 | report_weekly_trend | ✅ |
| daily_delivery | 每日门店品类配送汇总 | report_daily_delivery | ✅（迁移 058） |
| daily_wholesale | 每日门店品类批发汇总 | report_daily_wholesale | ✅（迁移 058） |
| item_sales | 销售商品级汇总 | report_daily_item_sales | ✅（迁移 108，§10.9） |
| item_outbound | 出库商品级汇总 | report_daily_item_outbound | ✅（迁移 108/110/111/157） |
| wholesale_customer | 批发客户级汇总 | report_daily_wholesale_customer | ✅（迁移 108/109/110/111） |

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

**RPC 权限约束（2026-08-18 漏洞修复，迁移 198）**：`get_item_top_by_day`/`get_item_detail` 是**手写 SECURITY DEFINER RPC**（非生成器产物，不含生成器模板的 perm 过滤注入）——SECURITY DEFINER 以 owner(postgres) 身份执行会绕过基表 `report_rls_brand` 行级策略。函数体必须自带品牌维过滤 `scope_match_v2('brands', system_book_code)`（迁移 198 加）与成本掩码 `can_cost_visible()`（197 后标准读法，取代旧 `request.jwt.claims.can_see_cost` 顶层 key——已废弃恒 false 误掩）。口径约束与月榜视图 `report_item_breakdown_gen`（生成器产物，基表 RLS 自动生效）保持一致：**品牌粒度数据授权单位是「品牌」非「门店」，brands 授权才可见**。

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
| DuckDB /compute 端点 | ✅ 已实现 | 标准报表计算（8 项报表，§10.5） |
| PostgreSQL 汇总表 | ✅ 已创建 | report_daily_sales 等 |
| 采集后自动触发计算（C1） | ✅ 已实现 | `web/lib/jobs/collect/manifest.ts` triggerCompute，verified 后按 params.dates 调 /compute；个别采集器例外（先落明细后补汇总，见 manifest 注释） |
| DuckDB /query 鉴权 | ✅ 已实现 | server.js 每请求连接 + AGENT_API_KEY（/transform /merge /compute /carry-dims 同鉴权） |
| OpenClaw 集成 | ✅ 已实现 | agent-query 网关 + data-query-plugin（tool+skill）已上线（§4.2/§4.3） |
| 列级脱敏（成本组） | ✅ 已实现 | DuckDB 视图 CASE + 生成视图模板统一注入（§10.10 权限过滤；旧 claim 视图已由迁移 155 下线） |
| 跨引擎小表搬运 JOIN | ✅ 已实现（网关 PG 路径） | agent-query PG 路径：代签短时 JWT → execute_sql_rls 走 RLS |
| carry 维表物化（C3） | ✅ 已实现 | /carry-dims（cron 04:33 兜底 + 变更回调），agent-query 查询侧读 dim parquet |
| 美团数据源接入 | ⏳ 待讨论 | 架构待确认 |
| 饿了么数据源接入 | ⏳ 待讨论 | 架构待确认 |
| 监控告警体系 v1 | 🔶 部分实现 | 已实现 4/8：token_expire/collect_fail/service_down/collect_stall；未实现：request_fail/data_freshness/data_integrity/contact_sync（§8.1 状态表） |
| 监控待实现 4 项 evaluator | ⏳ 待排期 | §8.1；data_integrity 部分职能已由 QA 体系承担（§10.10 L4） |
| 模块化+插件化重构 | 🔶 进行中 | A+B-lite，P0–P5；P1（jobs/collectors 目录化+注册表）已落地，P3（function _shared 共享打包）已落地 |
| 语义层 Cube 全替代 | ⏳ spec 已确认待实施 | §九 2026-08-15；生成器退役清单见 §10.10 |

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