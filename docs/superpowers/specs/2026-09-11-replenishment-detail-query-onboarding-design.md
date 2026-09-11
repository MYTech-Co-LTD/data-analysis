# 补货(要货单)明细接入问数 —— 通用事实视图注册 + 数据集接入

> 迁移：`212_registry_fact_scope.sql`（通用 `scope_key_expr` 列）→ `213_replenishment_detail_registry.sql`（补货注册 + 守护规则）
> **次序不可颠倒**：列必须先于使用它的注册行存在，否则 212 之前跑 213 会报 unknown column
> 关联代码：`functions/agent-query/index.js`、`functions/_shared/sql-guards.ts`、`web/lib/monitor/`、`openclaw/data-query-plugin/skills/retail-query/SKILL.md`
> 架构文档：**须先更新 `docs/architecture.md` §4.3 / §8.1**（本变更属架构变更，仓库 CLAUDE.md 规则）
> 数据契约承接方：其他系统（duckle 管线）
> 日期：2026-09-11

## 背景

补货（要货单）明细由**其他系统的 duckle 管线**写入 OSS，但 OpenClaw 目前**一行都查不到**。

问数链路是**四道闸**，插 `datasets` 行只过第一道：

| 闸 | 现状（`replenishment_detail`） |
|---|---|
| ① 字典 `datasets`/`dataset_columns` | ❌ 无注册行 |
| ② SQL 白名单 `validateSql` 正向白名单 | ❌ 不在 `allowedTables` → `forbidden_table` |
| ③ DuckDB 视图构建 | ❌ **网关无此视图**；通用建视图只覆盖维表（`kind=dim AND carry_enabled`），两个事实表硬编码在 `index.js:254-293` |
| ④ 行级权限 + 列脱敏 | ❌ 未声明门店键表达式 |

206 迁移已记录过同类事故：数据集 `exposed=TRUE` 但网关没建视图 → 模型误试后被白名单拒 → 转而自由发挥。**本设计不留这个中间态**。

## 数据实况（2026-09-11 实探）

```
s3://lemeng-datasource/duckle/lemeng/replenishment_detail/<账套>/<YYYY-MM-DD>/all.parquet
```

不在 Lemeng 原生 `lemeng/` 前缀下，是 duckle 管线产物。实测 16 个分区 = {3120, 64188} × {8/25, 9/5…9/11}，**全部于 2026-09-11 06:31/07:11 被重写**（→ 每次跑全窗口覆盖写）。规模：3120 = 3,772 行 / 64188 = 1,094 行，单日分区 10–27 KB。

一行 = **补货单（要货单）商品行**。关键列：

| 组 | 列 |
|---|---|
| 账套 | `company_id`（3120 / 64188，实测与路径账套 **100% 一致**） |
| 要货门店 | `branch_num`(BIGINT) / `branch_code` / `branch_name` |
| 出货方 | `out_branch_num`=**99 管理中心**（与 `transfer_detail.distribution_branch_num` 同值） |
| 单据 | `order_no`（`YH3120…`/`YH64188…` 带账套前缀）、`order_type`=要货单、`state_name` |
| 时间 | `business_date`（全时间戳）、`create_time`、`audit_time` |
| 商品 | `item_num` / `item_code` / `item_name` / `item_spec` / `item_unit` |
| 数量 | `quantity`（基本单位）、`use_quantity` + `use_unit`（件） |
| 金额 | `total_money`（单头）、`subtotal`（行） |

## 四个准确性坑（实测，全部须解）

1. **历史只有 8 天、中间断 10 天**：仅 `8/25` + `9/5~9/11`，`8/26–9/4` 空白。要货单不可能连续 10 天为零 → 管线覆盖问题。**后果：跨期问答静默少算且不自知**。
2. **门店键跨账套重复**：实测 **25 个 `branch_num` 两账套都有**（指向不同物理门店）→ 必须 `(system_book_code, branch_num)` 复合（门店键铁律）。
3. **状态口径四态**：`state_name` ∈ {`制单` / `制单|审核` / `制单|作废` / `制单|审核|作废`}。作废 24+50=**74 行**，未审核 281+103=**384 行**。口径不定死则同一问题两次答两个数。
4. **`total_money` 是单头金额、逐行重复**（实测恒等于该单 `sum(subtotal)`）→ **行级 SUM 整单翻倍**，与 2026-08-27 出库翻倍同类事故。

## 已核事实（无需其他系统改）

- **分区可靠**：`path_date == date(business_date)` **0 例外** → 行级裁剪可依赖
- **唯一键可靠**：`(order_no, item_num)` 全局唯一、无跨分区重复；`order_no` 带账套前缀，两账套不撞
- **商品档案 100% 配得上**：3120 `452/452`、64188 `339/339` 命中 `dim_item(system_book_code, item_num)`（`dim_item.item_num` 为 VARCHAR）
- **金额自洽**：`total_money ≡ sum(subtotal)`
- 命名已是 `all.parquet`，`*/*/all.parquet` glob 不踩「全表+分片重复读」
- 数据在 `lemeng-datasource` 桶内，**DuckDB 服务现成凭证可用，无凭据改动**
- **列名/类型的真值**（2026-09-11 在服务器 DuckDB 上对**真实 parquet** 实测）：账套列真名是 **`company_id`**（VARCHAR），
  **parquet 里没有 `system_book_code` 列**；`branch_num` / `out_branch_num` / `item_num` 是 **BIGINT**；`quantity`/`use_quantity`/`subtotal` 是 DOUBLE；其余为 VARCHAR。
  20 个注册列名与真实列**逐一对应**，唯一的改名就是账套列（由 `source_name` 映射解决）。
- **`||` 拼 BIGINT 可用**：`company_id || '-' || branch_num` 实测产出 `3120-1` / `3120-7` 形态（DuckDB 隐式转字符串），无需显式 CAST。
  该分区产出 86 个不同复合键（≈当日有要货的门店数），符合预期。
- ⚠️ **踩过的坑（本设计差点废掉的地方）**：把注册的 `scope_key_expr` **原样**对着真实 parquet 跑，
  第一版直接 `Binder Error: Referenced column "system_book_code" not found` → **视图建不起来、功能零可用**。
  这个错误在本机**测不出来**（本地 DuckDB 连不上内网 S3）。**故测试节必须包含「对真实 parquet 干跑一次视图 SQL」**，
  且它必须在**部署前**做（在服务器上用 DuckDB 直接跑，不必部署）。

## 数据契约（交付其他系统）

| # | 要求 | 理由 |
|---|---|---|
| 1 | **全量回补到 2026-07-01**，且**旧分区不删**（每日全窗口快照覆盖写，同 alipay 管线模式） | 与现有报表体系同期；否则跨期问答静默少算 |
| 2 | **保留原始 `state_name`，管线侧不过滤** | 管线预过滤会把口径焊死在管线里，改口径要重跑历史 |
| 3 | **保留账套列**（现名 `company_id`，值 3120/64188） | 行级权限的唯一依据。**不要求改名**——由消费侧 `source_name` 映射到平台的 `system_book_code`（见方案 2） |
| 4 | **保留 `order_no` / `item_num` / `business_date` 原值** | 唯一键 + 业务日锚 |
| 5 | 给出 `quantity` ↔ `use_quantity` ↔ `item_spec` 换算说明 | 两个数量口径需明确哪个是「补货量」 |
| 6 | 分区命名保持 `<账套>/<YYYY-MM-DD>/all.parquet` | 与 Lemeng 原生同构 |
| 7 | *（建议）* 暴露关联调出单号 | 有它才能算「要货 vs 实发」满足率；无则只能按 门店×商品×日 近似 |

管线侧验收对账（`账套 × 日期` 落分区行数 vs 源 total）由管线方出具结论；**消费侧另加守护**（见方案 3）兜底。

## 方案

### 1. 架构变更：注册表通用事实视图（`scope_key_expr`）

`datasets` 加一列：

```sql
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS scope_key_expr TEXT;
COMMENT ON COLUMN datasets.scope_key_expr IS
  '事实数据集的门店复合键 SQL 表达式（对本数据集输出列求值，产出归一形态 sbc-branch_num 用于行级权限裁剪）；为空=不可通用构建→ deny';
```

网关对 `engine='duckdb_view' AND kind='fact' AND scope_key_expr IS NOT NULL AND exposed` 的数据集统一构建：

```sql
CREATE OR REPLACE TEMP VIEW <name> AS
SELECT * FROM (
  SELECT <按 dataset_columns 显式投影；敏感列套 CASE WHEN <canSee> THEN col ELSE NULL END>
  FROM read_parquet('<source>', union_by_name=true)
) t
WHERE <scope_key_expr> IN (<授权复合键集合>)      -- 未授权 → WHERE 1=0
```

**投影由 `dataset_columns` 决定，不用 `SELECT *`**——这一点很关键：`SELECT *` 会把 parquet 里**全部**列暴露出去
（补货有 28 列，含我们要拿掉的 `total_money`）。改为显式投影后：
① `total_money` 只需**不注册**就自动从视图消失（无需额外机制）；② 不存在「无敏感列时 `SELECT * REPLACE ()` 非法 SQL」的问题；
③ `dataset_columns` 成为「这个数据集能看见哪些列」的单一事实源。**列注册为空 → 不构建视图（fail-close）**。

配套七点：

- **⚠️ 注册表读取必须隔离（否则误伤现有服务）**：`scope_key_expr` 与「逐数据集敏感列」走**独立请求 + 独立 try/catch**，
  **绝不加进 `loadRegistry` 现有 `datasets?select=...` 主查询**。原因：PostgREST 对 `select=` 里的未知列返 400，
  主查询一挂 → 整个 `loadRegistry` 走 fallback → **`pgTables` 退回只剩 3 张报表表** → 现有 `report_*_gen`
  查询从 PG **误路由到 DuckDB 而失败**。即「function 先于迁移上线」的窗口会打挂现有报表问答。
  隔离后：列缺失只让**新数据集**不可用（fail-close），碰不到 `pgTables`/`retailGlob`/`costColumns`。
- **fail-close**：`kind='fact'` 且 `scope_key_expr IS NULL` → 不建视图、不进白名单（**不是**「不过滤」）。与 CLAUDE.md「空集 = deny」一贯。
- **列投影 = `dataset_columns` 的注册列**（显式列出，非 `SELECT *`）：既要拿掉 `total_money`，也让「能看见哪些列」有单一事实源。注册列为空 → 不构建（fail-close）。
- **`dataset_columns.source_name`：源列名 → 视图列名映射**（2026-09-11 加，见下）。为空时 `source_name = name`（同名前缀），
  非空时投影为 `"<source_name>" AS "<name>"`。存在的理由：**平台口径名与外部管线的列名不一致是常态**，
  不该要求每个外部系统改名（那会把我们的字典耦合到别人的命名上）。补货的账套列即此例。
  注意 `scope_key_expr` 是在**投影后的视图列**上求值，所以它一律用**视图列名**（`system_book_code`），不用源列名。
- **跳过已硬编码的视图名**：`retail_detail` / `outbound_detail` 即使被注册也**不得**由通用路径重建（它们有 union/内联 join 的定制逻辑）。
- **allowedTables 由注册表派生**（已硬编码的两个仍显式保留），不再手写维护。
- **表达式校验三条**（校验失败 → 不建视图 + 记日志，fail-close）：
  ① 单表达式，禁 `;` / 子查询 / DDL 关键字；② **必须引用本数据集至少一列**——且**列名扫描必须在剥离字符串字面量之后进行**。
  ② 的「剥离字面量」是必需的，否则 `'branch_num' || '3120-7'` 这类表达式的列名只出现在字面量里，
  会被误判为合法，而它**折叠成常量** → `WHERE <常量> IN ('3120-7')` 恒真 → 被授权单店者看见整账套
  （2026-09-11 评审实证）。剥离后同一处理也顺带修掉「字面量含 `delete` 等禁词被误拒」的假阳性。
  ③ **窄授权冒烟必须验证「窄授权行集严格 ⊂ 全量行集」**——因为 ② **仍挡不住**「引用了真列、但把门店部分
  塌缩成单值」这一类（如 `system_book_code || '-7'`：剥离字面量后仍含 `system_book_code`，校验通过，
  但它对每行产出同一个值 → 任何被授权到 `3120-7` 的人看见 `3120` 全部门店）。
  **这类是本设计唯一残留的越权面，机械校验挡不住，只能靠冒烟断言守**（见验证节）。
  登记 `scope_key_expr` 时必须人工核一遍它确实同时用到了账套与门店两个部分。

- **② 的边界要说清：`stripSqlLiterals` 是「尽力而为」的剥离，不是 SQL 词法分析器**。
  已覆盖普通单引号串（含 `''` 转义）、块注释 `/* */`、行注释 `--`、DuckDB dollar-quoted `$$…$$`/`$tag$…$tag$`、
  `E'…'` 反斜杠转义串（后三者为 2026-09-11 复审实证的绕过形态，已补）。
  **不再继续往下加固**：任何「完整字面量剥离」都会陷入 SQL 词法的长尾，而机械校验从来不是本设计的**权威**控制——
  权威控制是两条：① `scope_key_expr` 只能由**受审查的迁移**写入（非用户/LLM 可控），
  ② 窄授权冒烟断言（见验证节）。校验器只是让写错的注册值**尽快失败**，不是安全保证。
- **敏感列按数据集分别读**：现只读 `retail_detail` 的 `is_sensitive`，改为逐数据集读取（走上面的独立请求）。
- **构建仍「全量构建」不改行为**：现有实现每查询无条件构建全部权限视图（含 147 分区的 `retail_detail`），
  本设计沿用该模式（不做「按 SQL 命中懒构建」的优化，避免改变存量行为）。代价：每查询成本 O(#数据集)，
  当前 1 个新数据集可忽略；**若将来注册量变大再单独优化**（记为已知扩展性上限）。

**边界**：仅对「注册表声明的通用 fact」生效，本次是**增量能力，不重构存量**。

**收益**：新增任何明细数据 = 插 `datasets` + `dataset_columns` 两行，**零代码**，兑现 architecture.md §4.3 已承诺的能力。
**代价**：动的是安全关键路径（行过滤 + 列脱敏），故配单测与三类身份的权限冒烟（见验证节）。

### 2. 补货数据集注册

`datasets` 一行：

```
name            = replenishment_detail
display_name    = 补货明细(要货单)
engine          = duckdb_view      kind = fact
source          = s3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet
scope_key_expr  = regexp_replace(system_book_code || '-' || branch_num, '^([0-9]+)-0+([0-9]+)$', '\1-\2')
date_column     = business_date
```

**视图暴露列**（28 列收成）：

- `system_book_code`（**平台口径名**；parquet 里的源列叫 `company_id`，由注册表 `source_name` 映射投影而来，见下）
  —— `assertBranchJoin` 是字面量匹配，只认 `system_book_code`，不认 `sbc`/`company_id`，所以视图**必须**暴露这个名字
- `branch_num` / `branch_name`、`out_branch_num` / `out_branch_name`
- `order_no` / `order_type` / `state_name`
- `business_date` / `create_time` / `audit_time`
- `item_num` / `item_code` / `item_name` / `item_spec` / `item_unit`
- `quantity` / `use_quantity` / `use_unit`
- `subtotal`
- **`total_money` 不暴露**（逐行重复的单头金额）。字典 `subtotal` 描述写明「单头金额 = 按 `order_no` 分组 `SUM(subtotal)`」。

**权限**：补货无成本/毛利列 → 无敏感列、无需列脱敏；行级走 `scope_key_expr`。
**口径承载**：视图保留 `state_name` 原值（全量可见），默认口径「只算已审核生效（`state_name='制单|审核'`）」由 SKILL.md **补货模板**硬编码承载，与现有「套模板填参」哲学一致。

SKILL.md 模板库新增⑫补货模板（要点）：
- 过滤 `WHERE state_name = '制单|审核'`（模板硬编码，勿改）
- 金额用 `SUM(subtotal)`，**禁用 `total_money`**（视图已不暴露，此条为双保险）
- 日期过滤用 `substr(business_date,1,10)`（该列是时间戳）
- 商品 join 必须 `dim_item.system_book_code + item_num` 复合（或用 `item_code` 单独作键）
- 门店键必须 `system_book_code + branch_num` 复合

### 3. 到达与完整性守护（本次一并做）

10 天断档是人工挖出来的，**消费侧必须自己发现**。

**落点**：`web/lib/monitor/` 的 evaluator 体系。`web/lib/monitor/types.ts` 的 `CheckType` **已预声明 `data_freshness` / `data_integrity` 但从未实现**（`evaluators/index.ts` 注释「其余待填」）——本次正是它的用途，不新造类型。

**节奏由现成桶决定，不由规则选**（`runtime.ts` / `jobs/monitor/manifest.ts` 已接线）：

| 规则 | check_type | 桶（节奏） | 判据 | 严重度 |
|---|---|---|---|---|
| 分区到达 | `data_freshness`（**复用**） | `runHourlyBucket`（**每小时**） | 昨日 `<账套>/<昨日>/all.parquet` 不存在 | high |
| 行数异常 | `data_volume`（**新增**） | `runDailyBucket`（**每日 03:00**） | 昨日行数 vs 近 7 日中位数偏离 > 50% | high |
| 覆盖完整性 | 两条规则均须**按账套各配一行** | — | 禁止看合计——会被另一账套掩盖 | — |

**check_type 语义裁定（2026-09-11，人决策）**：§8.1 的 `check_type` 清单表格里，`data_freshness` / `data_integrity`
两行**早已声明但从未实现，且声明的是与我们不同的机制**——`data_freshness` = 「距今 > `stale_hours`」、
`data_integrity` = 「明细 count vs PG 汇总 差异率」（后者并注明「部分职能由 QA 体系承担」，
`web/lib/qa/config/detail-sources.json` + C1 链在真实承担）。裁定：

- `data_freshness` **复用** —— 它本就意为「数据够不够新」，我们的分区到达检查是它的一个具体实例。
  须把表格该行的「数据源/触发」**拓宽**为兼容两种含义。
- 行数异常**新增 `data_volume`** —— 它相对中位数偏离是另一根轴（数据量异常），
  用 `data_integrity` 的名字会**覆盖一个已有归属的架构槽位**。`data_integrity` 保持 ⏳ 未实现不动。
- 新类型必须挂进 `runDailyBucket`（`runScan` 只加载桶内 `checkTypes` 的规则，不挂桶 = 规则永不被评估 = 静默失效）。

**部署次序安全**：`runScan` 对「无 evaluator 的规则」是 `console.warn` + `continue`（per-rule `try/catch` 双层隔离），
所以**规则可以先于 evaluator 落库**——只会 warn 跳过它自己，不会拖垮同轮的 `contact_sync` 等既有规则。**不动调度**。

`monitor_rules.threshold` 示例（**键名以迁移 `213` 实际落地的为准**；`target` = `'<dataset>:<账套>'`，
账套经 `{account}` 代入 glob——**没有** `accounts` 数组，每账套一条规则）：

```json
{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1,"median_window":7,"deviation_pct":50,"min_samples":3}
```

实现要点：
- **分区存在性 = 用 DuckDB 读该路径**（`services/server.js` 的 `/query`，现成 S3 凭证）：`SELECT count(*) FROM read_parquet('<source 代入日期>')` —— 抛错或 0 = 缺失。web 容器无 boto3，DuckDB 服务即现成的 OSS 出口（`web/lib/jobs/reconcile/manifest.ts` 的 `duckdbParquetSum` 同款手法）。
- `EvalDeps` 需新增一个依赖（如 `duckdbQuery(sql)`）+ runtime 注入 + 测试 fake；这是本方案唯一有粘性的改动面。
- **冷启动保护**：样本 < 3 天时只做到达检查，不做行数比较（防历史回补期误报）。
- 告警走 monitor 现成通道（`web/lib/monitor/notify.ts`，企微），复用抑制窗口。
- ⚠️ **不要**加进 `web/lib/qa/config/detail-sources.json`：那是「明细 vs 聚合表」对账链（C1），补货没有聚合表，硬套会失败。

## 对现有服务的影响面（blast radius）

| 面 | 影响 | 依据 |
|---|---|---|
| OSS 数据 / 其他系统的管线 | **零影响**（全程只读，不写不删，无物化） | 视图查询时实时构建 |
| `retail_detail` / `outbound_detail` | ⚠️ **条件性零影响**（见下方说明）：仅当**全部新注册数据集的源都能正常解析**时才零影响；任一 fact 视图在 DuckDB 侧失败（如将来某次注册写了 parquet 里不存在的列，或源前缀消失）→ **会连带打挂全部 DuckDB 查询，包括 `retail_detail` / `outbound_detail`** | 通用路径显式跳过这两个名字、仍走原硬编码分支，**只保证不改这两条视图的 SQL 文本**；但 `runDuckdb` 把 `viewSql + userSelect` 拼成**一条** SQL 一次提交（`functions/agent-query/index.js`，DuckDB 侧也是整串执行 `services/server.js` `/query`），而 `CREATE OR REPLACE TEMP VIEW` 是**连接级**的。JS 侧 `try/catch`（构建期 `buildFactViewSql` 抛错）只覆盖 JS 抛错，**盖不住 DuckDB 执行期失败**——后者让整个请求 500，`userSelect` 根本没机会跑 |
| ↳ 配套门禁（**永久约束**） | **每条新注册必须过「真实 parquet 干跑」**：在注册生效前，用真实 OSS 数据在当前代码上验证视图能建、行过滤真的收窄。纯单测/JS 层校验**不足以**证明 DuckDB 执行期可用 | 上一条的爆炸半径是「全部 DuckDB 查询」，不允许用「没报错」当通过 |
| 监控既有告警（`collect_fail` / `token_expire` / `service_down` …） | **零影响** | `engine.ts` `runScan` 双层隔离：无 evaluator 的规则 `warn + continue`；每条规则独立 `try/catch`。规则先于 evaluator 落库也安全 |
| 监控调度（4 个桶的 cron） | **不动** | `data_freshness`/`data_integrity` 的桶早已接线在跑，只是桶内无规则 |
| `get_data_dictionary()` | **零影响** | 显式列清单，加列不影响 |
| 权限总面 | **只增不放** | 只新增一张模型可查的表；不放宽任何现有表权限。新表行过滤**失败方向是「少给」**（表达式写坏 → 匹配不上 → 0 行） |
| **`web/lib/monitor/types.ts` 的 `EvalDeps`** | ⚠️ **有粘性**：新增必填 `duckdbQuery` 依赖 → **现有 evaluator 测试的 fake 会编译报错**，需机械补 3~4 个测试文件 | 唯一触及存量文件的改动面。`AGENT_API_KEY` 已在 `lib/jobs/env.ts`，DuckDB 出口现成 |
| **SKILL.md 提示词** | ⚠️ 轻微：加⑫补货模板会改变给模型的提示词 | 补货/要货的指标词与现有（销售/配送/出库/毛利）不重叠 → 模板匹配分低，误套风险小 |
| 查询延迟 | 可忽略 | 沿用现有「每查询无条件构建全部权限视图」模式（已含 147 分区的 `retail_detail`）；新增 1 个小数据集（16 小文件）。**已知扩展性上限**：注册量变大需再优化 |

### 部署次序（必须遵守，否则误伤现有服务）

1. `docs/architecture.md` 更新
2. **`agent-query` function 先上**（对 `scope_key_expr` 缺失**容错**：独立请求 + fail-close；此步不动任何存量行为）
3. 迁移 `212`（加列）
4. **`restart postgrest`** 刷 schema 缓存（否则新列不可见 → 新数据集静默不可用；注意是静默降级，不是报错）
5. 迁移 `213`（注册行 → 字典立刻可见；此时 function 已能建视图，**不留「能看见但查不了」的窗口**）
6. monitor evaluator 上线（**可在 213 之前或之后**——`runScan` 对缺 evaluator 的规则是 warn + skip）

> 次序 2→5 是为规避两类真实故障：① function 先上而 `select=` 带未知列 → `pgTables` 走 fallback → **现有报表问答挂**（已用「独立请求」设计消除）；② 注册行先上而 function 未上 → 模型看见表却撞 `forbidden_table` → **转而自由发挥**（206 迁移记录过的失败模式）。

## 权限验证（冒烟断言）

| 断言 | 期望 |
|---|---|
| 空授权（claims `branch_nums=[]`） | 0 行（`WHERE 1=0`，非「不过滤」） |
| 单账套单店授权 | 只见该账套该店，**同名 `branch_num` 的另一账套门店不串** |
| 全量授权（`["*"]`） | 两账套全量 |
| **窄授权行集严格 ⊂ 全量行集** | **防表达式塌缩成单值越权**（如 `system_book_code || '-7'`）——本设计唯一越权风险面 |
| `scope_key_expr` 缺失的 fact 数据集 | 不进白名单、SELECT 被拒（fail-close） |
| 表达式引用不到本数据集列 / 含 `;` | 拒绝构建 |
| 无敏感列的 fact 数据集 | 视图按注册列正常构建，金额列不受影响 |
| **未注册的列（如 `total_money`）** | 查它 → DuckDB 报 column not found（视图里压根没有），即「拿掉」生效 |
| `retail_detail` / `outbound_detail` | 通用路径不介入，行为与改造前逐字节一致 |
| 注册表主查询故障（模拟 400） | 走 fallback 且 **`pgTables` 仍为报表表全集**（路由不退化） |

## 准确性验收（关键判据）

同一问题在 OpenClaw 与 **Lemeng 要货单页面**比数，**要求分毫一致**（对齐 `sale_date=8/27 标品耗材 159,244.65` 那种分毫级冒烟标准）。对账维度：`账套 × 日期 × 金额/行数`。

## 实现清单

1. **`docs/architecture.md` §4.3 / §8.1 更新**（架构先行，先落地）
2. 迁移 `212_registry_fact_scope.sql`：`datasets.scope_key_expr` 列 + 注释
3. 迁移 `213_replenishment_detail_registry.sql`：`datasets` 行 + `dataset_columns` 列描述 + **四条** `monitor_rules`（`data_freshness` 与 `data_volume` 各 2 条 = 每账套各一条，3120/64188）
4. `functions/_shared/fact-view.ts`（新增纯函数，供单测锁定）+ `functions/agent-query/index.js` 接线：`loadRegistry` **以独立请求 + 独立 try/catch** 读 `scope_key_expr` 与逐数据集列（**不得并入主 `datasets?select=`**）；`runDuckdb` 通用 fact 视图构建（含表达式三条校验、按注册列投影、硬编码视图名跳过）；`allowedTables` 由注册表派生
5. `web/lib/monitor/`：`evaluators/data-freshness.ts` + `data-volume.ts`（**不是 `data-integrity`**，见 §方案3 语义裁定），注册进 `EVALUATORS`；`CheckType` 联合新增 `data_volume` 并挂进 `runDailyBucket`；`EvalDeps` 加必填 `duckdbQuery` 并在 `runtime.ts` `buildDeps` 注入 —— ⚠️ 存量 evaluator 测试 fake 需同步补该字段（机械，3~4 文件）
6. `openclaw/data-query-plugin/skills/retail-query/SKILL.md`：⑫补货模板
7. 测试：`web/lib/agent-query/__tests__/` 扩 `validateSql`/表达式校验单测；`web/lib/monitor/evaluators/__tests__/` 加两个 evaluator 单测；三类身份权限冒烟；分毫级准确性冒烟
8. 部署后 `docker compose restart postgrest` 刷 schema 缓存（新增列，仓库已知坑）

## 回滚

- **字典**：`DELETE FROM datasets WHERE name='replenishment_detail'`（级联删列描述）
- **网关**：`scope_key_expr` 列保留无害（对 `IS NULL` 即不建视图）；如需完全回退，还原 `allowedTables` 写死版本
- **守护**：`UPDATE monitor_rules SET enabled=false WHERE check_type IN ('data_freshness','data_volume')`
  —— ⚠️ **此杠杆只在下次部署前有效**：`scripts/migrate.sh` 每次部署全量重跑全部迁移，
  而迁移 213 的 `ON CONFLICT DO UPDATE` 会刷新该行。**因此 213 的 `DO UPDATE` 有意不带 `enabled=TRUE`**，
  让这个抑制在重跑后仍保留；若要**永久**停用，则需改迁移（或删除规则行）——见 213 头注释。
- **数据本身零改动**（视图为查询时实时构建，无物化存储）

## 依赖与待办

- ⏳ **阻塞项**：其他系统回补历史到 2026-07-01 并确认「旧分区不删」——回补完成前，字典须标注可用范围（`8/25` 起、`9/5` 后连续），防跨期静默少算
- ⏳ 关联调出单号（可选）→ 决定能否做「要货 vs 实发」满足率
- ⏳ `quantity` ↔ `use_quantity` 换算说明（决定「补货量」默认列）
- 📌 顺带记：`outbound_detail` 暴露的是 `sbc` 而非 `system_book_code`，与守卫的字面量要求不同名（现因 ON 子句里出现 `dim_branch.system_book_code` 而恰好通过）——不在本次范围，留作后续一致性议题
