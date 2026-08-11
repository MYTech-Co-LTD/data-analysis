# 数据分析平台 模块化 + 插件化 重构评估与设计提案

> 状态：设计提案（v1，评审稿）· 2026-08-11
> 范围：只做分析与设计，不涉及任何功能代码改动。本文件是新提议的唯一权威文档；落地前需按
> `docs/architecture.md` §十二（架构变更流程）评审通过，并将最终决策回写 architecture.md。
> 目标读者：后续并行实现阶段的架构 owner / 各模块 agent。

---

## 1. 现状评估

### 1.1 系统形态（部署拓扑与代码布局）

平台由 4 类部署单元 + 1 个构建期工具组成（详见 `docs/architecture.md`）：

| 单元 | 位置 | 运行时 | 说明 |
|---|---|---|---|
| 前端/调度宿主 | `web/`（Next.js 16 + TS） | Node（单容器） | App Router + 服务端 `node-cron` 调度器 + admin/mobile |
| Edge Functions | `functions/*/index.js\|ts`（10 个） | InsForge Deno 运行时 | 采集/企微/问数网关，**单文件部署，无法 require 共享模块** |
| DuckDB 数据处理 | `services/server.js` | Node（独立容器） | `/transform /merge /compute /query /carry-dims /derive-dim-customer` |
| 语义层生成器 | `services/semantic-generator/` | Node（构建期，非线上服务） | 读 `metric_registry` 产出 `report_*_gen` 视图 SQL |
| 智能体插件 | `openclaw/*-plugin/` | OpenClaw 运行时 | 已用 `definePluginEntry` + `openclaw.plugin.json` 的插件模式 |
| 数据库 | `database/migrations/`（171 个幂等迁移） | PostgreSQL | RLS + 视图 + 注册表（`metric_registry` / `datasets` / `monitor_rules`） |

> 注：当前**不是** pnpm workspace——无根 `package.json`、无 `pnpm-workspace.yaml`，`web/`/`services/`/`openclaw/*` 各自独立 `package.json`（web 用 npm lock）。这本身是"多包但无共享机制"的现状，与本次模块化目标直接相关（见 §4 基础设施建议）。

### 1.2 主数据流

```
乐檬 API ──► web/lib/collect*.ts（scheduler 内跑）──► duckdb /transform|/merge ──► OOS parquet
                                                                                    │
            ┌───────────────────────────────────────────────────────────┐
            ▼                                                           │ /compute
    web/lib/qa（C0~C6/D1/D2 对账）──► qa_logs                          ▼
    web/lib/monitor（规则评估）──────► 告警 ──► wecom-notify     report_daily_*（PG 汇总）
                                                                        │
            semantic-generator（构建期）◄── metric_registry / view-configs
                                                                        ▼
            web/report-center getters ◄── report_*_gen 视图（PostgREST/RLS）
                                                                        │
            openclaw plugins ──► functions/agent-query ──► duckdb /query + PostgREST execute_sql_rls
```

### 1.3 已有的"模块化种子"（要继承，不要推翻）

- **monitor**（`web/lib/monitor/`）：已有 `CheckType → Evaluator` 注册表 + `EvalDeps` 依赖注入 + 每规则异常隔离——已是"宿主+插件"形态。
- **QA**（`web/lib/qa/`）：`CheckType` 驱动、JSON 契约（`detail-sources.json` / `qa-checks.json`）、runner 按类型分文件——配置驱动。
- **semantic-generator**：AST 化口径 + `view-configs` 数据驱动 + "铁律"约束——是**唯一已经独立成包、自带测试、契约清晰**的模块，可直接作为"插件化"范本。
- **openclaw plugins**：已有 `definePluginEntry` + `openclaw.plugin.json` manifest + contracts 声明——运行时插件机制的现成参照。
- **report-center**（`web/lib/report-center/` + `web/components/report-center/`）：按板块分 getter/组件文件，`GetterResult<T>` 统一返回契约，`Promise.allSettled` 单模块失败不挂整页。

### 1.4 主要耦合点与扩展痛点

**P0 —— `web/lib/scheduler.ts`（1160 行）是"上帝模块"**
- 一个文件编排：5 类采集（retail/delivery/wholesale/items/branches）、`triggerCompute`、4 个 monitor bucket、QA（`runQaChecks`/`runC0`/`runC1`/`runProgressGuard`）、通讯录同步、carry-dims、dim-customer、target-close、每日对账。
- 直接 import 19 个模块（collect*/qa*/monitor*/notify/scheduler-lock），且通过 `globalThis` 状态 + 防重入锁 + 水位线实现细节纠缠。
- 后果：新增一个"定时任务"必然改这个文件 → **多 agent 并行开发时这里是必争之地**；任何行为回归影响全部采集链路。

**P1 —— Edge Function 单文件、样板代码重复**
- 5 个 function（`wecom-oauth`/`wecom-oidc-callback`/`wecom-push`/`cleanup-blacklist`/`agent-query`）各自**内联复制** `b64url` + `signJwt`（HS256）与 CORS/json 助手（约 30 行/份）。
- `wecom-oauth`（157 行）与 `wecom-oidc-callback`（135 行）几乎同构；`agent-query`（342 行）内置 3 组硬编码回退常量 + 注册表读取逻辑。
- 根因：InsForge 单文件部署模型禁止运行时共享模块。后果：改 JWT 实现要同步 5 处；新增 function 必须复制粘贴样板。

**P1 —— 契约双份复制、靠注释约定同步**
- `web/lib/qa/config/detail-sources.json` 与 `services/semantic-generator/src/detail-sources.json` **字节级相同**；`qa-types.ts` 双份（仅注释差异）。QA 侧注释明说"镜像，避免跨包 TS import"。
- 后果：改一处忘另一处即静默漂移，QA 与生成器口径悄悄不一致；CI 无漂移检查。

**P1 —— report-center 板块靠"页面手动编排"，新增板块 = 改 4 处**
- `web/app/reports/targets/[id]/page.tsx` 手动 `Promise.allSettled` 7 个 getter，再把每个 `GetterResult` 逐个 props 传进 `DesktopDashboard`/`MobileDashboard`（两套组件签名同步维护）。
- 新增一个板块（如新报表）必须同时改：getter + 桌面组件 + 移动组件 + 页面编排 + 生成器 view-configs + 迁移——**6 处横切，跨 lib/components/app 三层**。

**P1 —— 数据源采集器硬编码**
- `functions/collect-lemeng/index.js` 硬编码 `ALL_BRANCH_NUMS`（约 200 个门店号）；`web/lib/collect*.ts` 每个源一套独立函数，无统一 `Collector` 接口。
- 后果：接入美团/饿了么（架构文档 §十一 已列为"待讨论"）只能再造一套 collect 文件 + function + 迁移，无法复用对账/补采/水位线/监控框架。

**P2 —— 部署是全量单发**
- GHA：quality（lint/tsc/function-check）→ rsync 全部 → `deploy.sh`（migrate 全部 + functions 全部 + 服务器 build 前端 + compose up）。任何模块的改动都会触发全量部署与全量前端构建；前端构建是链路上最慢一环。

**P2 —— `functions/mcp` 是占位实现**
- 返回 mock 数据 + TODO，与真实链路（openclaw 插件 + `agent-query` 网关）功能重叠，属死代码/误导性契约。

---

## 2. 目标与成功标准

### 2.1 要解决什么

1. **并行开发互不阻塞**：模块边界清晰、接口冻结，多个 agent 可同时开发不同模块，合并冲突可预测、可接受。
2. **扩展新能力是"加目录/加文件"，不是"改核心"**：新数据源、新报表板块、新定时任务、新 QA/监控检查，都通过注册/配置接入，核心文件（scheduler、dashboard 页面、部署脚本）不再被改动。
3. **消除样板与契约漂移**：function 共享代码只写一份；QA 契约单源；接口以"类型 + JSON schema"形式固化并被 CI 校验。
4. **可独立测试、独立验证**：每个模块可脱离真实 DB/网络跑单测（DI 注入 fake）；CI 能指出哪个模块挂了。

### 2.2 成功标准（可度量）

| # | 指标 | 当前 | 目标 |
|---|---|---|---|
| S1 | 新增 1 个定时任务需要改动的核心文件数 | 1（scheduler.ts 内新增分支） | 0（仅新增 job 目录 + 注册表追加 1 行） |
| S2 | 新增 1 个报表板块需要横切的文件层数 | 3 层 × 多文件 | 1 层（板块目录内）+ 注册表追加 |
| S3 | 新增 1 个数据源（如美团） | 复制整套 collect + function + 迁移 | 新增 collector 插件 + 源配置 |
| S4 | function 共享逻辑（JWT/CORS）源码份数 | 5 | 1（构建期打包注入） |
| S5 | 契约（qa-types / detail-sources / qa-checks）来源数 | 2 | 1（CI 校验无漂移） |
| S6 | 单模块测试可离线跑（vitest，无 DB/网络） | 部分（collect/qa/monitor 已有） | 全部模块 |
| S7 | 并行 agent 合并冲突率 | 高（scheduler/页面为公共区） | 冲突仅限"注册表追加行"级别 |

---

## 3. 候选方案

> 三个方案不是互斥的取舍，而是"插件化深度"的谱系。推荐方案在 §4，落在 A 与 B-lite 之间。

### 方案 A：目录即模块 + 注册表/契约模式（轻量模块化）

**模块/插件边界**
- 保持现有部署单元（web / functions / services / openclaw / database）不变，在其内部建立统一目录规范：
  - `web/lib/collectors/<source>/`（每数据源一个目录，统一 `Collector` 接口）
  - `web/lib/jobs/<job>/`（每定时任务一个目录，统一 `JobManifest`）
  - `web/lib/report-center/boards/<board>/`（每板块：getter + 组件 + 契约）
  - `web/lib/qa/checks/<check>/`（每检查一个目录，已基本是）
  - `web/lib/monitor/evaluators/<type>/`（已基本是）
  - `functions/<name>/`（每个 function 一个插件；共享代码构建期打包，见下）
  - `services/semantic-generator/src/view-configs/<view>.ts`（已基本是）
- **插件机制（代码级 + manifest 约定，无运行时动态加载）**：
  - 核心（scheduler / dashboard 页面 / deploy 脚本）只依赖**契约包**（`web/lib/contracts`）与**注册表**（`*Registry.ts` / `*.json`）。
  - 插件通过"在注册表追加一条记录"自我声明（monitor 已有此模式：`evaluators/index.ts`）。
  - Function 共享代码：新增构建期 esbuild bundle 步骤，把 `functions/_shared/`（jwt/cors/wecom-client/postgrest-client）打进每个 function 单文件，**不改 InsForge 单文件部署模型**；每个 function 加 `function.json` manifest（声明 secrets、schedule、输入/输出契约），`deploy-functions.sh` 按 manifest 生成部署配置。
- **依赖方向**：`core ──► contracts ◄── plugins`；插件间禁止互相 import；plugins 只能依赖 contracts 与 `_shared/`。

**Trade-off**
- 优点：风险最低、可完全增量（每步都是"搬文件 + 冻结接口"，行为不变）；不引入新框架、不增加运维单元；直接复用 monitor/QA/semantic 已验证的模式；S1~S7 大部分可达。
- 缺点：插件是"代码级"而非"运行时动态加载"，新增能力仍需改代码（但只改插件目录，不改核心）；需要自律（依赖方向靠 lint 规则与 review 维护，而非框架强制）；`web/` 内部仍是单包，路径别名 `@/` 使模块边界偏软。

### 方案 B：运行时插件宿主（真正的插件框架）

**模块/插件边界**
- 引入显式宿主：
  - **Job 宿主**：`web/lib/jobs/host.ts` 加载 `jobs/*/manifest` 注册 cron（替代 scheduler 手写分支）。
  - **Board 宿主**：`web/app/reports/targets/[id]` 改为"板块注册表驱动渲染"（`boards` 数组 → 渲染器），板块可声明 `server getter` + `client component` + `mobile/desktop` 双形态 + 菜单项。
  - **Collector 宿主**：`web/lib/collectors/host.ts` 按 `source.kind` 分发。
  - **Function 宿主**：InsForge 单文件模型无法运行时加载，仍走"构建期 bundle + manifest"，但 manifest 字段更完整（权限/输入 schema/输出 schema），部署脚本按 manifest 校验。
- **插件机制**：`PluginManifest`（id/name/version/contracts/lifecycle）——直接对齐 openclaw 的 `openclaw.plugin.json` + `definePluginEntry` 模式；web 侧用同构的 TS 注册（`registerJob()` / `registerBoard()`），manifest 数据与代码同位。
- **依赖方向**：插件只依赖 `contracts` 与宿主提供的 `PluginContext`（DI：db client / duck / notify / logger / env），核心依赖方向 `host ──► PluginContext ◄── plugin`，宿主对插件零静态 import（用注册表运行时解析）。

**Trade-off**
- 优点：扩展性最强——第三方或新 agent 可以"只交付一个插件目录 + manifest"接入，无需碰宿主；运行时隔离（单插件崩溃不影响宿主，monitor 已示范）；插件契约可版本化。
- 缺点：框架成本（宿主、生命周期、错误处理、上下文注入都要设计实现）；过度设计风险（当前 2 品牌单一客户、agent 都是"自己人"，运行时动态加载价值有限）；web 是 Next.js SSR，运行时插件加载与 RSC/类型安全有摩擦（动态组件注册要小心 server/client 边界）；迁移量最大。

### 方案 C：服务化拆分（独立部署单元）

**模块/插件边界**
- 把 scheduler / QA / monitor / collect 从 web 容器拆为独立服务/独立容器（如独立 cron worker、独立 QA 服务），通过 HTTP/事件（PG 通知）通信；web 只做展示与 API 网关。
- 插件 = 服务内模块，服务间契约 = OpenAPI/消息 schema。

**Trade-off**
- 优点：隔离最强——多 agent 并行开发零文件冲突（各自独立 repo 或独立目录 + 独立部署）、独立扩缩容、独立故障域；CI 可精确到服务。
- 缺点：运维成本最高（更多容器、更多部署环节、更多密钥/网络面）；与当前"单 web 容器承载调度"的部署模型冲突，迁移成本最大；与 InsForge 生态（function 即部署单元）不匹配，会绕过平台本身的价值；对本项目规模（2 品牌、单客户、约 20K 行 web 代码）明显过度。

---

## 4. 推荐方案：A + B-lite（契约先行的轻量模块化 + 注册表插件）

### 4.1 选型理由

1. **项目已有 60% 的雏形**：monitor（evaluator 注册表 + DI）、QA（配置驱动）、semantic-generator（独立契约包）、openclaw（manifest 插件）——A 只是把这些已验证模式**统一成一套规范并补上缺口**，不是发明新架构。
2. **规模决定深度**：~20K 行 web、单客户双品牌、agent 团队小。B 的运行时框架收益在此规模下是负的；C 的运维成本不可接受。A+B-lite 拿 B 的 **manifest 约定**（一份 `PluginManifest` 规范 + 注册表），但**不引入运行时动态加载**（注册表在构建/启动期静态解析，类型安全、SSR 友好、可被 lint/CI 检查）。
3. **契约先行正好服务"多 agent 并行"**：先冻结 `contracts`，后续 agent 只消费不修改，冲突面被压到"注册表追加行"，这是 §6 并行切分的前提。
4. **不改变部署模型**：web 单容器、functions 单文件、semantic-generator 构建期——生产拓扑零变化，迁移可随时停在任何阶段。

### 4.2 目标模块边界（落地目录规范）

```
web/lib/
├── contracts/                    # ★ 单源契约包（新增，Phase 0）
│   ├── qa-types.ts               #   ← 从 web/lib/qa/types.ts 迁入（semantic-generator 同步引用）
│   ├── qa/                       #   ← detail-sources.json / qa-checks.json 单源
│   ├── monitor-types.ts
│   ├── collector-types.ts        #   ← 新：统一 Collector 接口
│   ├── job-types.ts              #   ← 新：JobManifest 接口
│   ├── board-types.ts            #   ← 新：BoardManifest 接口
│   └── report-view-contract.ts   #   ← 生成器 view-configs 的产出契约（视图名/列/level）
├── collectors/                   # 每个数据源一个目录（Phase 2）
│   ├── registry.ts               #   ← 注册表：kind → collector
│   ├── lemeng/                   #   ← 现有 collect*.ts 迁入（retail/delivery/wholesale/items/branches 拆子文件）
│   └── (meituan|eleme)/          #   ← 未来插件模板
├── jobs/                         # 每个定时任务一个目录（Phase 1）
│   ├── registry.ts               #   ← 注册表：id → manifest
│   ├── reconcile/                #   ← 每日对账（scheduler 提取）
│   ├── carry-dims/  dim-customer/  contact-sync/  target-close/
│   ├── monitor/                  #   ← monitor buckets 封装为 job
│   ├── qa/                       #   ← 每日/采集后 QA 封装为 job
│   └── collect/                  #   ← 采集任务执行（经 collector registry 分发）
├── report-center/
│   ├── boards/                   # 每个板块一个目录（Phase 4）
│   │   ├── registry.ts           #   ← 注册表：boardId → getter + component + mobile 形态
│   │   ├── kpi/  region/  category/  brand/  item-top/  supply-chain/  wholesale/
│   │   └── (future-board)/
│   ├── shared/                   #   ← GetterResult/okResult/errorResult/guard/ratio/…（现有散文件归拢）
├── scheduler.ts                  # 变薄：只做「加载 jobs registry + 并发控制/防重入锁」（Phase 1）
├── qa-runner.ts / monitor/       # 保留，但只依赖 contracts（Phase 0 起）
└── api.ts                        # 保留：唯一的 PostgREST 数据访问门面（getClient 已是门面，保持单点）

functions/
├── _shared/                      # 构建期共享源码（新增，Phase 3）
│   ├── jwt.ts  cors.ts  wecom-client.ts  postgrest-client.ts  registry.ts
├── <name>/
│   ├── index.js|ts               # 只含本 function 业务逻辑
│   └── function.json             # ★ manifest：secrets / schedule / 输入输出契约（新增）
scripts/deploy-functions.sh       # 改造：esbuild bundle _shared → 各 function；按 manifest 校验/部署

services/semantic-generator/src/
├── qa-types.ts / detail-sources.json / qa-checks.json   # 改为从 web/lib/contracts 单源导入/复制+CI 校验（Phase 0）
└── view-configs.ts               # 已是"视图插件"数据，保持；产出契约进 contracts（Phase 4 引用）
```

### 4.3 插件机制与契约（核心接口草案）

**Job 插件**（替代 scheduler 手写分支）：

```ts
// web/lib/contracts/job-types.ts（草案，Phase 1 冻结）
export interface JobManifest {
  id: string;                       // 全局唯一，注册表主键
  schedule?: string;                // cron 表达式；缺省 = 手动/事件触发
  dependsOn?: string[];             // 依赖的其它 job id
  run: (ctx: JobContext) => Promise<JobResult>;
}
export interface JobContext {       // 宿主注入，插件禁止自行建 client
  db: DbClient;                     // PostgREST/InsForge client 门面
  duck: (sql: string) => Promise<Row[]>;
  notify: (msg: NotifyInput) => Promise<void>;
  log: (taskId: string, level: string, msg: string) => Promise<void>;
  acquireLock: (key: string, ttlMs: number) => Promise<boolean>;
  now: () => Date;                  // 可注入时钟，便于测试
}
// 注册表追加式：web/lib/jobs/registry.ts 里一行
registerJob(reconcileJob);          // 新 job = 新目录 + 此处追加 1 行
```

**Collector 插件**（统一数据源接入）：

```ts
// web/lib/contracts/collector-types.ts（草案，Phase 2 冻结）
export interface Collector {
  kind: string;                     // 'lemeng' | 'meituan' | ...
  collectOnce(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult>;  // 返回完整性标志
  count?(ctx: CollectCtx, dates: string[]): Promise<number>;                    // C0 对账用
  sum?(ctx: CollectCtx, dates: string[]): Promise<number>;                      // P2a 金额对账用
}
// 注册表：collectors/registry.ts
export const COLLECTORS: Record<string, Collector> = { lemeng };
```

**Board 插件**（报告板块，替换页面手动编排）：

```ts
// web/lib/contracts/board-types.ts（草案，Phase 4 冻结）
export interface BoardManifest<TRow> {
  id: string;
  serverGet: (targetId: number, opts: BoardCtx) => Promise<GetterResult<TRow>>; // SSR 取数
  Desktop: React.ComponentType<BoardProps<TRow>>;
  Mobile?: React.ComponentType<BoardProps<TRow>>;  // 缺省复用 Desktop 容器
  menuLabel?: string;
}
// dashboard 页：读 boards/registry 渲染（新增板块 = 新目录 + registry 追加 1 行）
```

**Function 插件**（manifest 驱动部署）：

```json
// functions/<name>/function.json（草案，Phase 3 冻结）
{
  "slug": "wecom-oauth",
  "runtime": "commonjs",
  "secrets": ["WECOM_CORP_ID", "WECOM_SECRET", "WECOM_AGENT_ID", "JWT_SIGNING_KEY"],
  "schedule": null,
  "contract": { "auth": "none|agent_api_key|...", "input": { "$schema": "..." } }
}
```

### 4.4 依赖方向规则（由 lint + review 强制）

1. `plugins ──► contracts`（单向）；`plugins` 之间**禁止** import。
2. `core（scheduler/host/dashboard/deploy）──► contracts + registry`；core 不 import 具体插件实现（只经注册表）。
3. `contracts` 是叶子包：不 import 任何业务模块（只依赖 `error.ts` 等基础工具，且尽量无依赖）。
4. 新增 lint 规则（eslint `import/no-restricted-paths` 或自定义 guard 脚本）：禁止 `web/lib/jobs/*` 之间互相 import、禁止 `report-center/boards/*` 之间互相 import；违反即 CI 失败。
5. `services/semantic-generator` 对 `web/lib/contracts` 的单向引用（Phase 0 用复制+CI 校验过渡，Phase 4 后可改为 workspace 引用）。

---

## 5. 迁移路径（分阶段、可增量、不破坏现有功能）

> 每阶段结束 = 可部署、行为不变（前后有 vitest + 对账日志验证）。任何阶段都可停下，不阻塞其它阶段。

| Phase | 内容 | 交付物 | 验证 | 预计 |
|---|---|---|---|---|
| **P0 契约基线** | 建 `web/lib/contracts/`；迁入 qa-types、detail-sources、qa-checks、monitor-types；`web/lib/qa` 与 `services/semantic-generator` 改为引用单源；加 CI 契约漂移检查（两文件 diff 非空即失败） | contracts 包 + CI 检查 | `npm run test` + 手工 diff 检查 | 1~2d |
| **P1 调度拆分** | `scheduler.ts` 1:1 提取为 `jobs/*`（**纯搬移，不改任何逻辑**）；`jobs/registry.ts` 按原注册顺序加载；scheduler.ts 只留加载+锁 | jobs/ + 薄 scheduler | 现有 collect/qa/monitor 测试 + 部署后采集日志对比 | 3~5d |
| **P2 采集器插件化** | 定义 `Collector` 接口；collect*.ts 归入 `collectors/lemeng/`（接口适配层，逻辑不动）；scheduler/collect job 改走 registry 分发 | collectors/ + registry | 三源采集 + C0 对账回归 | 3~5d |
| **P3 functions 打包 + manifest** | 提取 `functions/_shared/`（jwt/cors/wecom-client/postgrest-client）；`deploy-functions.sh` 加 esbuild bundle 步骤（**先试点 1 个 function，全绿再铺开**）；每个 function 补 `function.json`；去重 wecom-oauth/oidc-callback；废弃/重写 `functions/mcp` 占位（与 agent-query 对齐） | _shared/ + bundle 脚本 + manifests | `check-functions.sh` 扩展（bundle 后语法/契约校验）+ 线上 function 冒烟 | 5~7d |
| **P4 板块注册表** | 定义 `BoardManifest`；把 target 详情页的 7 板块逐一封装为 board（getter 迁入 board 目录、组件不变）；dashboard 页改为注册表驱动渲染（Desktop/Mobile 仍走同一 boards 注册表） | boards/ + 薄页面 | 现有 report-center 测试 + 页面视觉对比 | 5~7d |
| **P5 CI/部署演进** | 每模块独立 CI job（lint/test 按目录）；可选：部署拆步（migrate/function/web 独立 job、互不阻断）；新数据源/新板块走插件模板文档 | CI 重构 + `docs/design/plugin-authoring.md` | GHA 全绿 + 部署时长 | 3~5d |

**基础设施（可选，建议 P0 顺带）**：将 `web/` 提升为 pnpm workspace 单包（或引入根 workspace 管理 contracts），解决"多包无共享机制"——非必须，若引入须保持 Next.js 构建兼容。

---

## 6. 如何切分并行工作边界（多 agent 专用）

> 面向后续实现：codex 执行 / Claude Code 开发 / codex 审核，多分支并行后合并。以下规则是"合并冲突可预测"的关键。

### 6.1 并行化五原则

1. **契约先冻结，再放人**：P0 由**单一 agent（架构 owner）**完成并合入 main 后，才允许其它 agent 并行开工。后续 agent **只消费 `web/lib/contracts`，不得修改**；需要改契约 = 单独提 issue 走架构 owner review。
2. **文件级写不重叠（写集不相交）**：每个任务明确"我写哪些目录、哪些文件"，注册表文件（`jobs/registry.ts`、`collectors/registry.ts`、`boards/registry.ts`）是**唯一的公共追加点**，且只允许**尾部追加一行**。
3. **每个模块自带测试**：模块必须有 vitest 单测（DI 注入 fake db/duck/notify，见 §4.3 接口），在无 DB/网络下可跑。审核 agent 以"测试是否覆盖契约行为"为验收。
4. **小步提交、独立合并**：每个模块 = 独立 PR/分支，粒度 ≤ 400 行新增（搬移类 ≤ 1000 行但必须标注"纯搬移"）；PR 按模块边界命名（`feat(collectors/meituan)`）。
5. **CI 与 guard 脚本兜底**：P0 之后立即上"契约漂移检查 + 依赖方向 lint"，任何破坏依赖方向的改动在 CI 即失败，不靠 review 记忆。

### 6.2 建议的并行批次与分工

**Wave 0（串行，1 人 = 架构 owner）**：P0 契约基线 + CI 检查 + 注册表骨架。**这是唯一允许"只写共享文件"的批次。**

**Wave 1（3 个 agent 并行，写集两两不相交）**：

| Agent | 写集（独占） | 公共追加点 | 验收 |
|---|---|---|---|
| A（codex 执行） | `web/lib/jobs/reconcile/`、`carry-dims/`、`target-close/` | `jobs/registry.ts` 尾部追加 3 行 | jobs 单测 + 原 scheduler 行为对比 |
| B（Claude Code 开发） | `web/lib/jobs/contact-sync/`、`dim-customer/`、`monitor/`、`qa/`、`collect/` | `jobs/registry.ts` 尾部追加 5 行 | jobs 单测 + 原 scheduler 行为对比 |
| C（codex 审核） | 只读 + `scripts/guard-*.sh`（新增 guard 脚本本身） | 无 | guard 脚本在 CI 验证 A/B 的注册表合法性 |

> 注意：A/B 都追加 `jobs/registry.ts` → **同一行区段的追加冲突可自动合并**（git 对"各自在文件尾部追加"通常能 auto-merge；若冲突也只是行序问题，秒级解决）。这是把注册表设计成"尾部追加"的原因。

**Wave 2（2 个 agent 并行）**：

| Agent | 写集（独占） | 公共追加点 | 验收 |
|---|---|---|---|
| D（codex 执行） | `functions/_shared/` + `deploy-functions.sh` 改造 + 试点 function | 无（部署脚本改造与 E 不相交） | bundle 后 function 冒烟 |
| E（Claude Code 开发） | `functions/wecom-oauth/`、`wecom-oidc-callback/`、`wecom-push/` 瘦身（删内联样板，改引 _shared） | 各 function 自己的 `function.json` | check-functions.sh 通过 + 线上冒烟 |

**Wave 3（2~3 个 agent 并行）**：

| Agent | 写集（独占） | 公共追加点 | 验收 |
|---|---|---|---|
| F（codex 执行） | `web/lib/report-center/boards/kpi/`、`region/`、`category/` | `boards/registry.ts` 追加 3 行 | 板块单测 + 页面视觉对比 |
| G（Claude Code 开发） | `web/lib/report-center/boards/brand/`、`item-top/`、`supply-chain/`、`wholesale/` | `boards/registry.ts` 追加 4 行 | 板块单测 + 页面视觉对比 |
| H（codex 审核） | `web/app/reports/targets/[id]/page.tsx` 改注册表驱动（**前提：F/G 的 registry 契约已冻结**） | 无 | 页面渲染回归 + F/G 板块全部显示 |

> Wave 3 依赖关系：H 的页面改造依赖 F/G 的 `BoardManifest` 契约（P4 开始时冻结），**不依赖 F/G 的板块实现完成**——H 先用 1 个示例板块打通渲染器，F/G 完成一个合一个，H 零阻塞。

### 6.3 合并协议

1. 分支命名：`feat/<module>/<thing>`，如 `feat/collectors/meituan`、`refactor/jobs/reconcile`。
2. 合并顺序：先契约（Wave 0）→ 再 Wave 1 → 再 Wave 2 → 再 Wave 3；同 Wave 内先合"注册表骨架/渲染器"（若有时序依赖），后合插件实现。
3. 每个 PR 必须满足：CI 绿（lint + tsc + test + 契约漂移 + guard 脚本）+ 无跨写集文件改动 + 若动 `web/lib/contracts` 需架构 owner 显式 approve（默认拒绝）。
4. 冲突预演：若两个 PR 都追加同一注册表，合第一个后第二个 rebase，git 对纯尾部追加自动解决；若手工解决也只动那一行，不扩散。

---

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 契约双份（web/semantic-generator）继续漂移 | QA 与生成器口径不一致，线上数据差异难排查 | P0 立即单源 + CI diff 检查（未迁移完前就上检查） |
| scheduler 拆分成 jobs 时行为回归 | 采集/对账/告警链断裂，数据晚到漏告警 | 纯搬移不改逻辑；现有测试 + 部署后 3 天采集/对账日志对比；jobs 单测覆盖注册顺序 |
| functions bundle 改变部署产物 | 线上 function 不更新/报错 | 试点 1 个 function 全绿再铺开；`check-functions.sh` 加 bundle 后语法校验；保留旧部署脚本回退路径 |
| 注册表"追加行"冲突在多个 PR 同时合入 | 行序冲突 | 尾部追加约定 + rebase 自动解决；冲突面被压到最小 |
| 板块化后页面渲染回归（RSC/SSR 边界） | 看板降级或报错 | 板块渲染器先用 1 个示例板块打通；每板块合入即视觉对比 + 现有 `Promise.allSettled` 降级语义保留 |
| 过度设计（B 方案诱惑） | 框架成本吞噬并行收益 | 只取 B 的 manifest 约定，不做运行时动态加载；依赖方向用 lint 而非框架强制 |
| 依赖方向纪律失守（插件互相 import） | 边界失效，冲突回潮 | `import/no-restricted-paths` + guard 脚本在 CI 强制执行 |
| 不引入 pnpm workspace | 共享包只能靠复制+CI 校验 | 接受为过渡态；P0 校验机制已覆盖；若后续多包共享需求变大再升级 workspace（可选） |

**取舍总结**：本项目规模下，正确取舍是"用约定与 CI 换模块化，用注册表换插件化，不引入运行时框架、不拆服务"。若未来出现第三方插件市场或跨团队多租户，再评估升级到方案 B 的运行时宿主（`web/lib/jobs/host.ts` 已预留宿主接口，升级路径平坦）。

---

## 附：与现有约束的关系

- 本提案**不改变** `docs/architecture.md` 的服务拆分、数据流向、技术栈、存储方案（§十二红线均不触碰）；只改变"代码组织 + 部署脚本内部实现"。
- 生成器铁律（§10.10）保持不变：本提案的 `report-view-contract.ts` 只描述生成器**产出**的契约，不改变"新增指标=改 registry AST、新增视图=改 view-configs"的约束。
- 采集数据完整性五要素（CLAUDE.md）保持：Collector 接口把 `fetchComplete/upsertFailures/verified/软删除/告警联动` 作为 `CollectResult` 的强制字段，插件化不削弱完整性。
