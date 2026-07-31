# 语义层构建期生成器接线设计

**日期**：2026-07-31
**状态**：已确认，待实现
**前置**：metric_registry（076-122）、metric_sources（080）、dimensions/dimension_levels、`/admin/semantic` 管理后台（只读）、双轨对账机制（07-22 设计）
**关联**：
- 取代 `2026-07-29-region-breakdown-semantic-refactor.md` 的「文档型真相源」措辞（本设计回归 07-22 初衷，补建生成器）
- `2026-07-22-semantic-layer-design.md`（原设计含 generate_drilldown_view，未落地）
- `2026-07-26-generator-multisource-design.md`（多源生成器）
- CLAUDE.md「语义层」「门店键铁律」「部署流程」「PostgREST schema 缓存」坑

---

## 1. 背景与目标

### 1.1 现状（2026-07-31 排查结论）

报表中心 5 个看板的指标**全部硬编码**，无一引用语义层 `metric_registry`：

- 前端 `web/lib/report-center/metric-source.ts` 自写 `METRICS` 表（label/trendTable/trendValueCol/categoryIn 全写死），metric_code 走老 `metric_definitions`（sale/delivery/outbound_amt/outbound_profit），与 `metric_registry` 的 code（sale_amount/...）对不上。
- 5 张视图（`report_achievement_v` / `report_brand_metric_v` / `report_category_summary_v` / `report_region_breakdown_v` / 前端 `ratio.ts`）各自手写聚合/率/脱敏 SQL，口径散落。
- **6 个孤儿指标**在看板里用，语义层根本没定义：`delivery_margin` / `profit_rate` / `daily_amount` / `daily_profit` / `daily_profit_margin` / `remaining_daily_profit_target`。
- `metric_registry`（24 指标）只有 `/admin/semantic/*` 管理后台读，是"只写不读"摆设。

### 1.2 历史决策轨迹

- **07-22** `semantic-layer-design.md` 设计了构建期生成器 `generate_drilldown_view()` + 三层校验，但**只 YAGNI 了"运行时动态引擎"**（理由：RLS/security_invoker 兼容、可审计、避免外部重型服务）。
- 07-22 生成器**未落地**，07-29 `region-breakdown-semantic-refactor.md` 被迫把 metric_registry 降级为「文档型真相源，视图照实现」。
- 本设计**回归 07-22 初衷**，补建构建期生成器——不碰 07-22 的任何 YAGNI（运行时动态引擎仍不做）。

### 1.3 目标

1. **约束**：加报表只能加 registry 行 + 跑生成器，杜绝视图 SQL 自由发挥。
2. **准确性**：口径单一来源（registry），三层校验自动抓聚合错（尤其 rollup 不变性）。
3. **排查容易**：产物是静态视图 SQL 文件，可 EXPLAIN、可双轨对账、可 git diff。
4. **不破坏安全链**：产物静态视图，100% 继承 security_invoker + RLS + claim 注入。

### 1.4 非目标（YAGNI）

- 不做运行时动态 SQL 引擎（07-22 已 YAGNI，理由仍成立）。
- 不迁 `target_metric_values` 已存的 metric_code（sale/delivery/outbound_*）——数据迁移风险大、收益低。
- 不迁未被报表引用的视图（distribution/outbound drill 备用视图未上线不生成）。
- 生成器不做"任意 formula 解释器"——只支持两类模式（additive 聚合 / 窗口派生）。

---

## 2. 生成器形态与产物（B2：Node/TS 脚本 + 产物入 git）

| 维度 | 选型 |
|---|---|
| 形态 | Node/TS 脚本 `services/semantic-generator/`，读 `metric_registry` + `metric_sources` + `dimensions` |
| 产物 | `database/generated/report_*_gen.sql`（DROP+CREATE，幂等）+ `report_*_audit.sql`（rollup 校验视图） |
| 入仓 | 产物提交进 git，PR diff 可 review |
| 部署 | migrate.sh 扫 `database/generated/*.sql`（与 `migrations/` 同幂等机制） |
| 本地 | `npm run gen-views` 产出 + 本地 DB EXPLAIN + 双轨 diff |

**选 Node/TS 而非 PG plpgsql 函数**的理由（对齐"可审计、排查容易"）：
1. 产物进 git，口径改动 PR 可见、可回滚。
2. 排查看静态 SQL 文件，不 SSH 查 DB。
3. 校验逻辑（EXPLAIN/rollup/diff）在 TS 里比 plpgsql 易写。
4. 复用仓库已有 TS 栈（services/）。

---

## 3. registry 完整化（生成器输入契约）

### 3.1 补齐孤儿指标 + 缺失的 target 度量

119 只注册了 `sale_target` / `delivery_target`；类别表还需 `outbound_amount_target` / `outbound_profit_target`（prof­it_rate / remaining_daily_profit_target 依赖），一并补上。

**新增 target 度量（base，fact_table=target_metric_values）**：

| metric_code | formula（结构化） | source_filter |
|---|---|---|
| `outbound_amount_target` | `SUM(target_value)` | `metric_code='outbound_amt'` |
| `outbound_profit_target` | `SUM(target_value)` | `metric_code='outbound_profit'` |

**6 个孤儿指标（derived）**：

| metric_code | formula | depends_on |
|---|---|---|
| `delivery_margin` | `delivery_profit / delivery_amount` | ["delivery_profit","delivery_amount"] |
| `profit_rate` | `outbound_profit / outbound_profit_target` | ["outbound_profit","outbound_profit_target"] |
| `daily_amount` | `outbound_amount FILTER(biz_date=latest_day)` | ["outbound_amount"] |
| `daily_profit` | `outbound_profit FILTER(biz_date=latest_day)` | ["outbound_profit"] |
| `daily_profit_margin` | `daily_profit / daily_amount` | ["daily_profit","daily_amount"] |
| `remaining_daily_profit_target` | `(outbound_profit_target - outbound_profit) / nullif(remaining_days, 0)` | ["outbound_profit","outbound_profit_target"] |

> `remaining_days` 是 target 窗口上下文列（total_days - days_elapsed），非 metric；窗口逻辑由生成器按 measure_type+depends_on 套，formula 字段保持声明式。

### 3.2 结构化 source_filter（硬前置）

`sale_target` / `delivery_target`（119）的 `fact_table=target_metric_values`，但"WHERE metric_code='sale'"只写在 description，生成器读不到。必须给这些 target 度量补 `metric_sources` 行，把过滤结构化进 `source_filter`：

```
sale_target          → metric_sources(target_metric_values, target_value, "metric_code='sale'")
delivery_target      → ... "metric_code='delivery'"
outbound_amt target  → ... "metric_code='outbound_amt'"
outbound_profit target → ... "metric_code='outbound_profit'"
```

6 孤儿里凡取 target 的（profit_rate / remaining_daily_profit_target）也补 source 行。**无结构化 source_filter，生成器不工作。**

### 3.3 metric_definitions 去留：保留作"目标存储 code 命名空间"

- `metric_definitions` 的 code（sale/delivery/outbound_amt/outbound_profit）是 `target_metric_values.metric_code` 列里**已存历史目标**的主键——迁它=数据迁移所有目标，YAGNI。
- 定位：`metric_definitions` = 目标存储 code 字典（target 录入用）；`metric_registry` = 口径真相源（生成器读）。两者经 `metric_sources.source_filter` 里 `metric_code='xxx'` 链接。
- 手写视图 JOIN metric_definitions 取显示名——迁到生成器后改读 registry.name；未迁旧视图保持原样，双轨期共存。

---

## 4. 生成器能力分层 + 视图迁移次序

### 4.1 两档能力

| 档 | 能力 | 覆盖指标 |
|---|---|---|
| **Tier 1（核心）** | base 聚合 by 维度层级 + additive derived（outbound=d+pp+ext）+ 率重算（margin=SUM(profit)/SUM(amount)）+ cost脱敏 CASE + target join（按 breakdown_level） | sale/delivery/outbound 的 target/actual/rate/margin、配销比 |
| **Tier 2（窗口派生）** | 在 Tier1 产物上叠 target 行上下文（total_days/days_elapsed/latest_day）→ `FILTER(biz_date=latest_day)` 取当日、`(target-actual)/nullif(remaining_days,0)` 取剩余日均 | daily_sale/delivery/amount/profit、remaining_daily_*、profit_rate、daily_profit_margin |

> registry 的 `formula` 字段保持纯度量式（`profit / amount`），窗口逻辑由生成器按 measure_type + depends_on 模式套——registry 是声明式口径，生成器是机制。

### 4.2 迁移次序（由简到难，每步双轨 diff=0 才切前端）

| 序 | 看板 | 视图 | 档 | 理由 |
|---|---|---|---|---|
| ① | 配销比 | 前端 `ratio.ts` | T1 | 最简：前端函数→读 registry `delivery_sale_ratio` 定义。零视图风险 |
| ② | 品牌×指标表 | `report_brand_metric_v` | T1 | 纯 additive+rate+margin+cost脱敏，验证 Tier1 全链路 + 脱敏路径 |
| ③ | 门店下钻表 | `report_region_breakdown_v` | T1+T2 | 已有 07-29 spec 待实现，真实三级目标。T1 先上，T2 跟上 |
| ④ | KPI 卡片 | `report_achievement_v` | T1 | 结构同②，被最多页面引用放后 |
| ⑤ | 类别出库表 | `report_category_summary_v` | T1+T2 | 最复杂（利润完成率+当日毛利+剩余日均利润），最后啃 |

**每步规则**：产出 `report_*_gen` 与旧 `report_*_v` 并行 → 双轨对账各列 SUM diff=0 + rollup audit 空 → 前端 `.from()` 切 `_gen` → 下线旧视图。diff≠0 不切。

---

## 5. 校验机制与部署集成

### 5.1 三层校验落点

| 层 | 何时 | 做什么 | 阻断 |
|---|---|---|---|
| **L1 静态** `validate_semantic_registry()`（078） | migrate 后 | base fact_table 存在、derived depends_on 闭环、维度 join_key 在表；**补：产物 metric_code 全在 registry** | 阻断部署 |
| **L2 生成时 EXPLAIN**（新） | 生成脚本跑完每张产物后 | 对每张 `report_*_gen.sql` 跑 EXPLAIN——语法/字段/类型；校验 additive=false 未被直接 SUM | 阻断部署（失败不产文件） |
| **L3a rollup 不变性**（产出 `_audit` 视图） | 运行期查询 | 战区和=小区和=门店和=total；diff≠0 返非零行 | 告警（collect_logs → 企微），不阻断 |
| **L3b 双轨对账** | 每步迁移期 | 各列 SUM `report_*_gen` vs `report_*_v` diff=0 | 阻断前端切换 / 下线旧视图 |

L1/L2 阻断**部署**，L3a 阻断**运行期信任**，L3b 阻断**下线旧视图**——各管一段不重叠。

### 5.2 部署集成（GHA 不改逻辑，加扫描 + restart）

**本地/开发**：
```
改 metric_registry/metric_sources 迁移 → npm run gen-views
  → 读 registry+sources → 产出 database/generated/report_*_gen.sql + _audit.sql
  → 本地 DB EXPLAIN（L2）+ 双轨 diff（L3b）
  → git add 产物，提交
```

**GHA 部署**（现有 step 1-3 不变，加）：
- migrate.sh 扫 `database/migrations/*.sql` + `database/generated/*.sql`（同幂等）。
- migrate 跑完 → `validate_semantic_registry()`（L1）。
- step 4 后加 `docker compose restart postgrest`（刷 schema 缓存，视图变更必需——CLAUDE.md 已记此坑，现有 GHA 不保证重启，生成器产物是新增视图**必须**显式加）。

### 5.3 失败处理

- 生成器 EXPLAIN 失败 → 不产 SQL 文件、本地报错、git 无新文件 → 部署期跑不到坏 SQL。
- L3a rollup diff≠0 → `_audit` 非零行 → collect_logs `failed` → collect_fail 企微告警（复用现有监控链）。
- L3b 双轨 diff≠0 → 前端不切、旧视图不下线；排查生成器 vs 手写口径差异。

---

## 6. 测试策略（按 testing-handbook 选层）

| 层 | 测什么 | 怎么测 |
|---|---|---|
| 生成器单测 | registry→SQL 转换正确：additive 不被直接 SUM、率用 SUM(profit)/SUM(amount)、cost_sensitive 套 CASE、窗口派生套 latest_day FILTER | Node 单测 `services/semantic-generator/__tests__/`，喂 fixture registry 断言产出 SQL 片段 |
| L2 EXPLAIN | 产物 SQL 语法/字段/类型 | 集成在 `gen-views`，对真 DB EXPLAIN |
| L3a rollup | 层级加总自洽 | `_audit` 视图返零行；CI 查询断言空 |
| L3b 双轨 diff | 新 vs 旧各列 SUM=0 | 每步迁移前手动跑对账脚本 |
| RLS / cost脱敏 | 无 can_see_cost claim → 毛利列 NULL；branch_nums claim → 只见本店 | 伪造 JWT claim（testing-handbook §2），对 `_gen` 视图跑 SELECT |

不做：端到端 UI 回归每张表（双轨 diff=0 + `.from()` 切视图不动列名/列序，UI 行为不变）。

---

## 7. 分阶段交付（每阶段独立可验证可上线）

| 阶段 | 内容 | 验证标准 |
|---|---|---|
| **P0 地基** | 6 孤儿 + 2 outbound target 度量注册 + source_filter 结构化 + `services/semantic-generator/` 骨架 + `database/generated/` 目录 + migrate.sh 扫描 + GHA restart postgrest | L1 通过、生成器跑空产物 |
| **P1 Tier1 + 配销比 + 品牌表** | Tier1 生成器 + 迁①② | ② 双轨 diff=0、cost脱敏 RLS 测过 |
| **P2 下钻表** | Tier2 生成器 + 迁③（含 07-29 spec 真实三级目标） | 三级目标和=总、rollup audit 空、双轨 diff=0 |
| **P3 KPI 卡** | 迁④ | 双轨 diff=0、所有引用页切 `_gen` |
| **P4 类别表** | 迁⑤（最复杂窗口派生） | 双轨 diff=0、利润完成率/当日毛利口径对齐 |
| **P5 收口** | 下线全部旧手写 `report_*_v`、删 metric_definitions 未引用 code（保留目标存储 code）、架构文档更新 | 旧视图 DROP、`/admin/semantic` 全绿 |

每 P 独立交付、独立验证，中途停不留半成品（双轨期新旧视图都活）。P0 硬前置，P1-P4 可按节奏走。

---

## 8. 架构文档更新（CLAUDE.md 铁律：先文档后代码）

实现前先改 `docs/architecture.md` §10 语义层段：
1. metric_registry 定位从"文档型真相源"改为"**构建期生成器输入**"（回归 07-22 初衷）。
2. 加 §10.x「视图生成器」：形态（Node/TS + 产物入 git）、两档能力、三层校验、`database/generated/` 目录、GHA restart postgrest。
3. 标注 07-29 region-breakdown-semantic-refactor spec 的"文档型"措辞被本设计取代。
4. 更新 `metric_definitions` 定位为"目标存储 code 命名空间"。

---

## 9. 现状约束（实现须遵守，源自 CLAUDE.md）

1. 视图 `DROP VIEW IF EXISTS + CREATE VIEW`，禁 `CREATE OR REPLACE`（后迁移加列重跑报 cannot drop columns from view）。
2. migrate.sh 每次部署重跑全部迁移——所有 DDL 幂等。
3. 加表/加列后 `docker compose restart postgrest` 刷 schema 缓存（GHA 不保证，本设计显式加）。
4. 明细在 S3 parquet 不在 PG——明细级查询走 DuckDB /query，PostgREST 读不到；生成器产物的 base 度量读 PG 聚合表（report_daily_*）。
5. 视图脱敏用 `security_invoker=true` + 基表 GRANT，不能用 FORCE RLS（对 superuser owner 无效）。
6. 比率指标不能直接 SUM，须 `SUM(profit)/SUM(amount)` 重算——靠 `additive=false` 标记 + 生成器保证。
7. 门店键 = `(system_book_code, branch_num)` 复合，禁用 `branch_num` 单独 join/去重/PK。

---

## 10. 端到端价值示例（迁完后）

新增「出库商品 TOP20」报表：

**旧方式**：手写 sql_template → 建物化表 → 手写 180 行视图 → 注册 dataset → 前端写专用组件。口径可能抄错，4 处重复。

**新方式**：
1. `metric_registry` 加 `delivery_item_amount` / `delivery_item_profit`（base）+ `metric_sources` 行。
2. `npm run gen-views` → 生成器读 [指标 × item 维度] 产出 `report_product_delivery_top20_gen.sql`。
3. L2 EXPLAIN + L3a rollup audit + L3b 双轨对账自动跑，绿✓ 才上线。
4. 前端复用通用 DataTable。

口径单一来源、视图自动生成、对账保证、前端不重复——约束、准确、排查容易三目标全中。
