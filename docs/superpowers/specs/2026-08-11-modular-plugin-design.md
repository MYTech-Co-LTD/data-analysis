# 数据分析平台 模块化 + 插件化 重构设计 spec

> 状态：设计 spec（v1，评审稿）· 2026-08-11
> 范围：**只做分析与设计，不涉及任何功能代码改动、不改业务逻辑。**
> 来源：本 spec 由 codex 初稿（`docs/design/modular-plugin-proposal.md`）+ Claude 现状核实合并而成。Claude 对初稿的全部现状断言逐条实测，修正 1 处失实、补报 1 处漏报（见 §1.5、§1.6）。
> 目标读者：后续实现阶段的架构 owner / 各模块 agent。
> 流程终点：本 spec 写完 → 用户 review → **走 `docs/architecture.md` §十二架构评审** → 评审通过后才进 writing-plans 制定实现计划。**不自动进实现。**

---

## 0. 背景与定位

平台已运行多个采集/报表/QA/监控子系统，代码量增长到 web 侧约 20K 行。痛点集中在「新增能力要改核心文件」「多 agent 并行必争 scheduler/页面」「契约双份靠注释同步」。本 spec 给出模块化+插件化的选型、目录规范、迁移路径与并行切分原则。

**本 spec 是全景蓝图**，覆盖 P0–P5 六阶段。后续每个阶段进入 writing-plans 时各自再细化成可执行计划；本 spec 不承诺排期。

**与 CLAUDE.md 架构铁律的关系**：本提案不改变 `docs/architecture.md` 的服务拆分、数据流向、技术栈、存储方案（§十二红线均不触碰），只改变「代码组织 + 部署脚本内部实现」。生成器铁律（§10.10）与采集完整性五要素保持不变（见 §附）。

---

## 1. 现状评估

### 1.1 系统形态（部署拓扑与代码布局）

| 单元 | 位置 | 运行时 | 说明 |
|---|---|---|---|
| 前端/调度宿主 | `web/`（Next.js 16 + TS） | Node（单容器） | App Router + 服务端 `node-cron` 调度器 + admin/mobile |
| Edge Functions | `functions/*/index.js\|ts`（10 个） | InsForge Deno 运行时 | 采集/企微/问数网关，**单文件部署，无法 require 共享模块** |
| DuckDB 数据处理 | `services/server.js` | Node（独立容器） | `/transform /merge /compute /query /carry-dims /derive-dim-customer` |
| 语义层生成器 | `services/semantic-generator/` | Node（构建期，非线上服务） | 读 `metric_registry` 产出 `report_*_gen` 视图 SQL |
| 智能体插件 | `openclaw/*-plugin/` | OpenClaw 运行时 | 已用 `definePluginEntry` + `openclaw.plugin.json` 的插件模式 |
| 数据库 | `database/migrations/`（171 个幂等迁移） | PostgreSQL | RLS + 视图 + 注册表（`metric_registry` / `datasets` / `monitor_rules`） |

> 当前**不是** pnpm workspace——无根 `package.json`、无 `pnpm-workspace.yaml`，`web/`/`services/`/`openclaw/*` 各自独立 `package.json`（web 用 `package-lock.json` = npm）。这是「多包但无共享机制」的现状，与本次模块化目标直接相关（见 §4.5）。

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

### 1.3 已有的「模块化种子」（要继承，不要推翻）

- **monitor**（`web/lib/monitor/`）：已有 `CheckType → Evaluator` 注册表（`evaluators/index.ts` + collect-fail/collect-stall/service-down/token-expire）+ `EvalDeps` 依赖注入 + 每规则异常隔离——已是「宿主+插件」形态。
- **QA**（`web/lib/qa/`）：`CheckType` 驱动、JSON 契约（`detail-sources.json` / `qa-checks.json`）、runner 按类型分文件——配置驱动。
- **semantic-generator**：AST 化口径 + `view-configs` 数据驱动 + 「铁律」约束——是**唯一已经独立成包（自带 `package.json` + 10 个测试文件）、契约清晰**的模块，可直接作为「插件化」范本。
- **openclaw plugins**：已有 `definePluginEntry` + `openclaw.plugin.json` manifest + contracts 声明——运行时插件机制的现成参照。
- **report-center**（`web/lib/report-center/` + `web/components/report-center/`）：按板块分 getter/组件文件，`GetterResult<T>` 统一返回契约，`Promise.allSettled` 单模块失败不挂整页。

### 1.4 主要耦合点与扩展痛点

**P0 —— `web/lib/scheduler.ts`（1160 行）是「上帝模块」**
- 一个文件编排：5 类采集（retail/delivery/wholesale/items/branches）、`triggerCompute`、4 个 monitor bucket、QA（`runQaChecks`/`runC0`/`runC1`/`runProgressGuard`）、通讯录同步、carry-dims、dim-customer、target-close、每日对账。
- 直接 import **19 个模块**，且通过 `globalThis.__schedulerState`（跨 chunk 单例）+ 防重入锁（`tryAcquireLock`）+ 水位线实现细节纠缠。
- 后果：新增一个「定时任务」必然改这个文件 → **多 agent 并行开发时这里是必争之地**；任何行为回归影响全部采集链路。

**P1 —— Edge Function 单文件、样板代码重复**
- **5 个 function**（`wecom-oauth`/`wecom-oidc-callback`/`wecom-push`/`cleanup-blacklist`/`agent-query`）各自**内联复制** `b64url` + `signJwt`（HS256）与 CORS/json 助手（agent-query 8 处、cleanup/wecom-oauth 6 处、oidc-callback 8 处、wecom-push 6 处命中 `signJwt`/`b64url`）。
- `wecom-oauth`（157 行）与 `wecom-oidc-callback`（135 行）几乎同构；`agent-query`（342 行）内置 3 组硬编码回退常量 + 注册表读取逻辑。
- 根因：InsForge 单文件部署模型禁止运行时共享模块。后果：改 JWT 实现要同步 5 处；新增 function 必须复制粘贴样板。

**P1 —— 契约双份（三处）复制、靠注释约定同步**
- `detail-sources.json`：`web/lib/qa/config/` 与 `services/semantic-generator/src/` 双份，**字节级相同**。
- `qa-checks.json`：同样双份，**字节级相同**（初稿漏报，本 spec 补报）。
- `qa-types.ts`（web 侧文件名为 `web/lib/qa/types.ts`）：双份，**已实质漂移**（见 §1.6）。
- 后果：改一处忘另一处即静默漂移；CI 无漂移检查。

**P1 —— report-center 板块靠「页面手动编排」，新增板块 = 改多处**
- `web/app/reports/targets/[id]/page.tsx` 手动 `Promise.allSettled` 7 个 getter，再把每个 `GetterResult` 逐个 props 传进 `DesktopDashboard`/`MobileDashboard`（两套组件签名同步维护）。
- 新增一个板块必须同时改：getter + 桌面组件 + 移动组件 + 页面编排 + 生成器 view-configs + 迁移——多层横切，跨 lib/components/app 三层。

**P1 —— 数据源采集器硬编码**
- `functions/collect-lemeng/index.js`（414 行）硬编码 `ALL_BRANCH_NUMS`（line 18 数组）；`web/lib/collect*.ts` 每个源一套独立函数，无统一 `Collector` 接口。
- 后果：接入美团/饿了么（架构文档 §十一 已列为「待讨论」）只能再造一套 collect 文件 + function + 迁移，无法复用对账/补采/水位线/监控框架。

**P2 —— 部署是全量单发**
- GHA：quality（lint/tsc/function-check）→ rsync 全部 → `deploy.sh`（migrate 全部 + functions 全部 + 服务器 build 前端 + compose up）。任何模块的改动都触发全量部署与全量前端构建；前端构建是链路上最慢一环。

**P2 —— `functions/mcp`（204 行）是占位实现**
- 3 处 `TODO: 验证 Token/权限并查询…`，返回未完成的占位逻辑，与真实链路（openclaw 插件 + `agent-query` 网关）功能重叠，属死代码/误导性契约。

### 1.5 现状断言核实表（Claude 梳理新增——证据）

> 对 codex 初稿的全部现状断言逐条实测，结论：**下表 10 组断言中 8 组精确属实，1 组失实（qa-types 漂移程度），1 组漏报（qa-checks 双份）**。方案推荐的地基扎实。

| 初稿断言 | 实测 | 判定 |
|---|---|---|
| `scheduler.ts` 1160 行 / import 19 模块 | 1160 行 / 19 条 import | ✅ 精确 |
| scheduler 用 globalThis+防重入锁+水位线纠缠 | 36 处标记，`globalThis.__schedulerState` 跨 chunk 单例 | ✅ |
| 5 个 function 内联 JWT（oauth/oidc-callback/push/cleanup-blacklist/agent-query） | 精确命中 `signJwt`/`b64url` 的恰是这 5 个 | ✅ 精确 |
| wecom-oauth 157 / oidc-callback 135 / agent-query 342 行 | 157 / 135 / 342 | ✅ 精确 |
| functions 共 10 个 / `mcp` 占位+TODO / collect-lemeng 硬编码 `ALL_BRANCH_NUMS` | 10 个 / mcp 3 处 TODO / 数组在 line 18 | ✅ |
| `detail-sources.json` 字节级双份相同 | `diff` IDENTICAL | ✅ |
| monitor evaluator 注册表+DI / generator 独立成包+10 测试 / report-center 7 getter 手动 `allSettled` | 全部属实 | ✅ |
| 非 pnpm workspace（无根 package.json） | 根无 package.json/pnpm-workspace.yaml；web 用 npm lock | ✅ |
| **`qa-types.ts` 双份「仅注释差异」** | **29 行实质漂移（见 §1.6）** | ❌ **失实** |
| （初稿漏报）`qa-checks.json` 也双份 | IDENTICAL 双份 | ⚠️ 补报 |

### 1.6 契约漂移实测（已发生，非隐患）

初稿 §1.4 称 `qa-types.ts` 双份「仅注释差异」。实测 `diff web/lib/qa/types.ts` ↔ `services/semantic-generator/src/qa-types.ts` = **29 行实质差异**，三处分叉：

| 分叉 | web 侧 | generator 侧 | 单源合并方向（P0 执行） |
|---|---|---|---|
| `CheckType` 枚举 | 含 `'C6'` | **缺 C6** | **保留 C6**（web 侧 QA 已在用） |
| `sum_col?` 字段 | 无 | 有（长表 `actual_value`） | **保留 sum_col**（generator 长表口径需要） |
| `CheckResult` interface | 有（运行时结果） | 无 | 归入运行时类型，generator 不引用 |

即契约漂移**已经发生**。这把 P0「立即单源 + CI 漂移检查」从「防患于未然」升级为「止血」——单源前必须先按上表对齐，否则「单源」会顺手合并掉某侧已用字段（C6 或 sum_col），制造新 bug。

---

## 2. 目标与成功标准

### 2.1 要解决什么

1. **并行开发互不阻塞**：模块边界清晰、接口冻结，多个 agent 可同时开发不同模块，合并冲突可预测、可接受。
2. **扩展新能力是「加目录/加文件」，不是「改核心」**：新数据源、新报表板块、新定时任务、新 QA/监控检查，都通过注册/配置接入，核心文件（scheduler、dashboard 页面、部署脚本）不再被改动。
3. **消除样板与契约漂移**：function 共享代码只写一份；契约单源；接口以「类型 + JSON schema」固化并被 CI 校验。
4. **可独立测试、独立验证**：每个模块可脱离真实 DB/网络跑单测（DI 注入 fake）；CI 能指出哪个模块挂了。

### 2.2 成功标准（可度量）

| # | 指标 | 当前 | 目标 |
|---|---|---|---|
| S1 | 新增 1 个定时任务需要改动的核心文件数 | 1（scheduler.ts 内新增分支） | 0（仅新增 job 目录 + 注册表追加 1 行） |
| S2 | 新增 1 个报表板块需要横切的文件层数 | 3 层 × 多文件 | 1 层（板块目录内）+ 注册表追加 |
| S3 | 新增 1 个数据源（如美团） | 复制整套 collect + function + 迁移 | 新增 collector 插件 + 源配置 |
| S4 | function 共享逻辑（JWT/CORS）源码份数 | 5 | 1（构建期打包注入） |
| S5 | 契约（qa-types / detail-sources / qa-checks）来源数 | 2（且 qa-types 已漂移） | 1（CI 校验无漂移） |
| S6 | 单模块测试可离线跑（vitest，无 DB/网络） | 部分（collect/qa/monitor 已有） | 全部模块 |
| S7 | 并行 agent 合并冲突率 | 高（scheduler/页面为公共区） | 冲突仅限「注册表追加行」级别 |

---

## 3. 候选方案

> 三个方案是「插件化深度」的谱系。推荐方案在 §4，落在 A 与 B-lite 之间。Claude 梳理后确认：方案空间完备，无遗漏的第四选项值得引入。

### 方案 A：目录即模块 + 注册表/契约模式（轻量模块化）

- 保持现有部署单元不变，在其内部建立统一目录规范（`collectors/<source>/`、`jobs/<job>/`、`report-center/boards/<board>/`、`functions/<name>/` 等）。
- **插件机制（代码级 + manifest 约定，无运行时动态加载）**：核心（scheduler / dashboard / deploy）只依赖契约包 + 注册表；插件通过「在注册表追加一条记录」自我声明。Function 共享代码走构建期 esbuild bundle（`functions/_shared/` 打进每个单文件），不改 InsForge 单文件部署模型。
- **依赖方向**：`core ──► contracts ◄── plugins`；插件间禁止互相 import。
- 优点：风险最低、可完全增量；不引入新框架/运维单元；直接复用 monitor/QA/semantic 已验证模式。缺点：插件是代码级非运行时动态加载；需自律（lint + review 维护依赖方向）。

### 方案 B：运行时插件宿主（真正的插件框架）

- 引入显式宿主（Job 宿主 / Board 宿主 / Collector 宿主 / Function 宿主），`PluginManifest`（id/name/version/contracts/lifecycle），对齐 openclaw 的 `openclaw.plugin.json` + `definePluginEntry`。宿主对插件零静态 import（注册表运行时解析）。
- 优点：扩展性最强，单插件崩溃不影响宿主，插件契约可版本化。缺点：框架成本高；当前规模下运行时动态加载价值有限；Next.js SSR 与动态组件注册有 server/client 边界摩擦；迁移量最大。

### 方案 C：服务化拆分（独立部署单元）

- 把 scheduler / QA / monitor / collect 从 web 容器拆为独立服务/容器，通过 HTTP/事件通信。
- 优点：隔离最强、独立扩缩容、独立故障域。缺点：运维成本最高；与「单 web 容器承载调度」的部署模型冲突；绕过 InsForge 生态价值；对本项目规模明显过度。

---

## 4. 推荐方案：A + B-lite（契约先行的轻量模块化 + 注册表插件）

### 4.1 选型理由

1. **项目已有 60% 的雏形**：monitor/QA/semantic-generator/openclaw 都已示范了注册表/配置/manifest 模式——A 只是把这些已验证模式统一成一套规范并补上缺口。
2. **规模决定深度**：~20K 行 web、单客户双品牌、agent 团队小。B 的运行时框架收益在此规模下是负的；C 的运维成本不可接受。A+B-lite 拿 B 的 **manifest 约定**（一份 `PluginManifest` 规范 + 注册表），但**不引入运行时动态加载**（注册表在构建/启动期静态解析，类型安全、SSR 友好、可被 lint/CI 检查）。
3. **契约先行正好服务「多 agent 并行」**：先冻结 `contracts`，后续 agent 只消费不修改，冲突面被压到「注册表追加行」。
4. **不改变部署模型**：web 单容器、functions 单文件、semantic-generator 构建期——生产拓扑零变化，迁移可随时停在任何阶段。
5. **梳理加固**：qa-types 已漂移的发现只影响 P0 紧迫性，不动摇选型——反而证明「契约单源 + CI 校验」是当务之急。

### 4.2 目标模块边界（落地目录规范）

```
web/lib/
├── contracts/                    # ★ 单源契约包（新增，Phase 0）
│   ├── qa-types.ts               #   ← 从 web/lib/qa/types.ts 迁入（含 C6 + sum_col 合并；CheckResult 归运行时类型）
│   ├── qa/                       #   ← detail-sources.json / qa-checks.json 单源（两份皆迁入）
│   ├── monitor-types.ts
│   ├── collector-types.ts        #   ← 新：统一 Collector 接口
│   ├── job-types.ts              #   ← 新：JobManifest 接口
│   ├── board-types.ts            #   ← 新：BoardManifest 接口
│   └── report-view-contract.ts   #   ← 生成器 view-configs 的产出契约（视图名/列/level）
├── collectors/                   # 每个数据源一个目录（Phase 2）
│   ├── registry.ts               #   ← 注册表：kind → collector
│   ├── lemeng/                   #   ← 现有 collect*.ts 迁入
│   └── (meituan|eleme)/          #   ← 未来插件模板
├── jobs/                         # 每个定时任务一个目录（Phase 1）
│   ├── registry.ts               #   ← 注册表：id → manifest
│   ├── reconcile/ carry-dims/ dim-customer/ contact-sync/ target-close/
│   ├── monitor/  qa/  collect/
├── report-center/
│   ├── boards/                   # 每个板块一个目录（Phase 4）
│   │   ├── registry.ts
│   │   └── kpi/ region/ category/ brand/ item-top/ supply-chain/ wholesale/
│   └── shared/                   #   ← GetterResult/okResult/errorResult/guard/ratio/…
├── scheduler.ts                  # 变薄：只做「加载 jobs registry + 并发控制/防重入锁」（Phase 1）
├── qa-runner.ts / monitor/       # 保留，但只依赖 contracts
└── api.ts                        # 保留：唯一的 PostgREST 数据访问门面

functions/
├── _shared/                      # 构建期共享源码（新增，Phase 3）
│   └── jwt.ts cors.ts wecom-client.ts postgrest-client.ts registry.ts
├── <name>/
│   ├── index.js|ts               # 只含本 function 业务逻辑
│   └── function.json             # ★ manifest：secrets / schedule / 输入输出契约
└── scripts/deploy-functions.sh   # 改造：esbuild bundle _shared → 各 function；按 manifest 校验/部署

services/semantic-generator/src/
├── qa-types.ts / detail-sources.json / qa-checks.json   # 改为从 web/lib/contracts 单源（复制+CI 校验过渡，见 §4.5）
└── view-configs.ts               # 保持；产出契约进 contracts（Phase 4 引用）
```

### 4.3 插件机制与契约（核心接口草案）

> 以下为接口设计草案（类型签名属设计产物，非实现），各 Phase 冻结前可调。

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
// CollectResult 必须含完整性五要素字段：fetchComplete / upsertFailures / verified / 软删除标志 / 告警联动
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
3. `contracts` 是叶子包：不 import 任何业务模块。
4. 新增 lint 规则（eslint `import/no-restricted-paths` 或自定义 guard 脚本）：禁止 `web/lib/jobs/*` 之间互相 import、禁止 `report-center/boards/*` 之间互相 import；违反即 CI 失败。
5. `services/semantic-generator` 对 `web/lib/contracts` 的单向引用（Phase 0 用复制+CI 校验过渡，Phase 4 后可改为 workspace 引用，见 §4.5）。

### 4.5 pnpm workspace 两案（P0 启动前评估，现不拍板）

契约单源的「跨包共享」有两种实现，本 spec 两案都列，**留待 P0 启动前评估**，不在现阶段拍板：

| | 方案 A：复制 + CI 守（保守） | 方案 B：升 pnpm workspace（彻底） |
|---|---|---|
| 做法 | `contracts` 单源在 `web/lib/contracts/`；semantic-generator 构建前从单源复制所需文件；CI 跑 `diff` 非空即失败 | 把 web 升为 pnpm workspace 根，`contracts` 作为内部包被 generator 直接 import |
| 优点 | 零迁移风险：web 仍 npm（`package-lock.json` 不动）、不动 Next.js 构建（规避 `next build` 跨包 JSON 坑）、不动部署 | 真正单源引用，无复制步骤，IDE 跨包跳转 |
| 风险 | 复制步骤是新的构建环节（需脚本化 + CI 守） | 需迁移 web `npm→pnpm` lock + 验证 Next.js 构建（memory 记 `next build 无法打包 web 根外 JSON` 坑） + 验证 GHA 部署链路 |
| 推荐 | **默认推荐**（与提案过渡态一致） | 仅当 P0 评估确认 Next 构建兼容时采用 |

---

## 5. 迁移路径（分阶段、可增量、不破坏现有功能）

> 每阶段结束 = 可部署、行为不变（前后有 vitest + 对账日志验证）。任何阶段都可停下。

| Phase | 内容 | 交付物 | 验证 | 预计 |
|---|---|---|---|---|
| **P0 契约基线 + 止血** | ① 建 `web/lib/contracts/`；② **先按 §1.6 表对齐 qa-types**（C6 保留、sum_col 保留、CheckResult 归运行时）；③ 迁入 qa-types/detail-sources/**qa-checks**（三处全单源）；④ `web/lib/qa` 与 `services/semantic-generator` 改引用单源；⑤ 加 CI 契约漂移检查（三文件 diff 非空即失败）；⑥ pnpm workspace §4.5 评估定案 | contracts 包 + CI 检查 | `npm run test` + 三文件 diff 检查 + QA C0~C6 回归 | 1~2d |
| **P1 调度拆分** | `scheduler.ts` 1:1 提取为 `jobs/*`（**纯搬移，不改任何逻辑**）；`jobs/registry.ts` 按原注册顺序加载；scheduler.ts 只留加载+锁 | jobs/ + 薄 scheduler | 现有 collect/qa/monitor 测试 + 部署后采集日志对比 | 3~5d |
| **P2 采集器插件化** | 定义 `Collector` 接口；collect*.ts 归入 `collectors/lemeng/`（接口适配层，逻辑不动）；scheduler/collect job 改走 registry 分发 | collectors/ + registry | 三源采集 + C0 对账回归 | 3~5d |
| **P3 functions 打包 + manifest** | 提取 `functions/_shared/`（jwt/cors/wecom-client/postgrest-client）；`deploy-functions.sh` 加 esbuild bundle（**先试点 1 个 function，全绿再铺开**）；每个 function 补 `function.json`；去重 wecom-oauth/oidc-callback；废弃/重写 `functions/mcp` 占位（与 agent-query 对齐） | _shared/ + bundle 脚本 + manifests | `check-functions.sh` 扩展 + 线上 function 冒烟 | 5~7d |
| **P4 板块注册表** | 定义 `BoardManifest`；target 详情页 7 板块逐一封装为 board；dashboard 页改注册表驱动渲染（Desktop/Mobile 走同一 boards 注册表） | boards/ + 薄页面 | 现有 report-center 测试 + 页面视觉对比 | 5~7d |
| **P5 CI/部署演进** | 每模块独立 CI job；可选部署拆步（migrate/function/web 独立 job、互不阻断）；新数据源/新板块走插件模板文档 | CI 重构 + `docs/design/plugin-authoring.md` | GHA 全绿 + 部署时长 | 3~5d |

---

## 6. 并行切分（设计原则 + 可选排期）

> **定位**：本章是「多 agent 并行的设计原则 + 排期模板」，**不是立即执行承诺**。五原则是约束；Wave 划分是「若启动并行实现时的建议分工」。是否真启动各 Wave、谁参与，留实现阶段定。

### 6.1 并行化五原则

1. **契约先冻结，再放人**：P0 由**单一 agent（架构 owner）**完成并合入 main 后，才允许其它 agent 并行开工。后续 agent **只消费 `web/lib/contracts`，不得修改**；需要改契约 = 单独提 issue 走架构 owner review。
2. **文件级写不重叠（写集不相交）**：每个任务明确「我写哪些目录、哪些文件」，注册表文件（`jobs/registry.ts`、`collectors/registry.ts`、`boards/registry.ts`）是**唯一的公共追加点**，且只允许**尾部追加一行**。
3. **每个模块自带测试**：模块必须有 vitest 单测（DI 注入 fake db/duck/notify），无 DB/网络可跑。
4. **小步提交、独立合并**：每个模块 = 独立 PR/分支，粒度 ≤ 400 行新增（搬移类 ≤ 1000 行但必须标注「纯搬移」）；PR 按模块边界命名（`feat(collectors/meituan)`）。
5. **CI 与 guard 脚本兜底**：P0 之后立即上「契约漂移检查 + 依赖方向 lint」，破坏依赖方向的改动在 CI 即失败。

### 6.2 建议的并行批次（模板）

- **Wave 0（串行，架构 owner）**：P0 契约基线 + CI 检查 + 注册表骨架。唯一允许「只写共享文件」的批次。
- **Wave 1（3 agent 并行）**：jobs 拆分——A 写 `reconcile/carry-dims/target-close`、B 写 `contact-sync/dim-customer/monitor/qa/collect`、C 只读+guard 脚本。公共追加点 `jobs/registry.ts` 尾部追加。
- **Wave 2（2 agent 并行）**：functions——D 写 `_shared/` + `deploy-functions.sh` 改造 + 试点；E 写 `wecom-oauth/oidc-callback/wecom-push` 瘦身。
- **Wave 3（2~3 agent 并行）**：boards——F 写 `kpi/region/category`、G 写 `brand/item-top/supply-chain/wholesale`、H 改 page.tsx 注册表驱动（依赖 F/G 的 BoardManifest 契约冻结，不依赖实现完成）。

> 注册表「尾部追加」设计：多个 PR 各自在 registry 文件尾部追加行，git 通常能 auto-merge；冲突也只是行序，秒级解决。

### 6.3 合并协议

1. 分支命名：`feat/<module>/<thing>` / `refactor/<module>/<thing>`。
2. 合并顺序：先契约（Wave 0）→ Wave 1 → Wave 2 → Wave 3。
3. 每个 PR 必须：CI 绿（lint + tsc + test + 契约漂移 + guard）+ 无跨写集文件改动 + 若动 `web/lib/contracts` 需架构 owner 显式 approve（默认拒绝）。

---

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 契约双份（web/semantic-generator）**已漂移**（qa-types 29 行分叉，非隐患） | QA 与生成器口径不一致，C6/sum_col 单边存在 | P0 先按 §1.6 表对齐止血，再单源 + CI diff 检查 |
| scheduler 拆分成 jobs 时行为回归 | 采集/对账/告警链断裂，数据晚到漏告警 | 纯搬移不改逻辑；现有测试 + 部署后采集/对账日志对比；jobs 单测覆盖注册顺序 |
| functions bundle 改变部署产物 | 线上 function 不更新/报错 | 试点 1 个 function 全绿再铺开；`check-functions.sh` 加 bundle 后语法校验；保留旧部署脚本回退路径 |
| 注册表「追加行」冲突在多 PR 同时合入 | 行序冲突 | 尾部追加约定 + rebase 自动解决 |
| 板块化后页面渲染回归（RSC/SSR 边界） | 看板降级或报错 | 渲染器先用 1 个示例板块打通；每板块合入即视觉对比 + 现有 `Promise.allSettled` 降级语义保留 |
| 过度设计（B 方案诱惑） | 框架成本吞噬并行收益 | 只取 B 的 manifest 约定，不做运行时动态加载；依赖方向用 lint 而非框架强制 |
| 依赖方向纪律失守（插件互相 import） | 边界失效，冲突回潮 | `import/no-restricted-paths` + guard 脚本在 CI 强制 |
| pnpm workspace 升级（若选 §4.5 方案 B） | Next.js 构建破坏 / GHA 链路断裂 | P0 启动前评估；默认走方案 A（复制+CI 守）规避 |

**取舍总结**：本项目规模下，正确取舍是「用约定与 CI 换模块化，用注册表换插件化，不引入运行时框架、不拆服务」。若未来出现第三方插件市场或跨团队多租户，再评估升级到方案 B 的运行时宿主（`web/lib/jobs/host.ts` 已预留宿主接口，升级路径平坦）。

---

## 附：与现有约束的关系

- 本提案**不改变** `docs/architecture.md` 的服务拆分、数据流向、技术栈、存储方案（§十二红线均不触碰）；只改变「代码组织 + 部署脚本内部实现」。
- 生成器铁律（§10.10）保持不变：本提案的 `report-view-contract.ts` 只描述生成器**产出**的契约，不改变「新增指标=改 registry AST、新增视图=改 view-configs」的约束。
- 采集数据完整性五要素（CLAUDE.md）保持：Collector 接口把 `fetchComplete/upsertFailures/verified/软删除/告警联动` 作为 `CollectResult` 的强制字段，插件化不削弱完整性。
- **架构评审门槛**：本 spec 任何阶段进入实现前，须按 `docs/architecture.md` §十二 走架构变更流程评审通过。
