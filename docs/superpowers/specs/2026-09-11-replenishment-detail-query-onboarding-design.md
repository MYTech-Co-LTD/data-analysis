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

## 数据契约（交付其他系统）

| # | 要求 | 理由 |
|---|---|---|
| 1 | **全量回补到 2026-07-01**，且**旧分区不删**（每日全窗口快照覆盖写，同 alipay 管线模式） | 与现有报表体系同期；否则跨期问答静默少算 |
| 2 | **保留原始 `state_name`，管线侧不过滤** | 管线预过滤会把口径焊死在管线里，改口径要重跑历史 |
| 3 | **保留 `company_id`** | 行级权限的唯一依据 |
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
  SELECT <"* REPLACE (脱敏列)" 或 "*"（无敏感列时）>
  FROM read_parquet('<source>', union_by_name=true)
) t
WHERE <scope_key_expr> IN (<授权复合键集合>)      -- 未授权 → WHERE 1=0
```

配套六点：

- **fail-close**：`kind='fact'` 且 `scope_key_expr IS NULL` → 不建视图、不进白名单（**不是**「不过滤」）。与 CLAUDE.md「空集 = deny」一贯。
- **`REPLACE()` 空集退化**：敏感列为空时必须退化成 `SELECT *`——`SELECT * REPLACE ()` 是非法 SQL（dimCarry 现有写法同款处理）。
- **跳过已硬编码的视图名**：`retail_detail` / `outbound_detail` 即使被注册也**不得**由通用路径重建（它们有 union/内联 join 的定制逻辑）。
- **allowedTables 由注册表派生**（已硬编码的两个仍显式保留），不再手写维护。
- **表达式校验**：单表达式、禁 `;`/子查询/DDL 关键字，且**必须引用本数据集至少一列**（防被写成常量使行过滤失效）。校验失败 → 不建视图 + 记日志（fail-close）。
- **敏感列按数据集分别读**：现只读 `retail_detail` 的 `is_sensitive`，改为逐数据集读取。

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

- `system_book_code`（= 原 `company_id`，**改名为硬要求**：`assertBranchJoin` 字面量匹配 `system_book_code`，不认 `sbc`/`company_id`）
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

| 规则 | check_type | 判据 | 严重度 |
|---|---|---|---|
| 分区到达 | `data_freshness` | 昨日 `<账套>/<昨日>/all.parquet` 不存在 | high |
| 行数异常 | `data_integrity` | 昨日行数 vs 近 7 日中位数偏离 > 50% | high |
| 覆盖完整性 | 两条规则均须**按账套各配一行** | 禁止看合计——会被另一账套掩盖 | — |

`monitor_rules.threshold` 示例：`{"dataset":"replenishment_detail","source_glob":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet","accounts":["3120","64188"],"lookback_days":1,"median_window":7,"deviation_pct":50}`

实现要点：
- **分区存在性 = 用 DuckDB 读该路径**（`services/server.js` 的 `/query`，现成 S3 凭证）：`SELECT count(*) FROM read_parquet('<source 代入日期>')` —— 抛错或 0 = 缺失。web 容器无 boto3，DuckDB 服务即现成的 OSS 出口（`web/lib/jobs/reconcile/manifest.ts` 的 `duckdbParquetSum` 同款手法）。
- `EvalDeps` 需新增一个依赖（如 `duckdbQuery(sql)`）+ runtime 注入 + 测试 fake；这是本方案唯一有粘性的改动面。
- **冷启动保护**：样本 < 3 天时只做到达检查，不做行数比较（防历史回补期误报）。
- 告警走 monitor 现成通道（`web/lib/monitor/notify.ts`，企微），复用抑制窗口。
- ⚠️ **不要**加进 `web/lib/qa/config/detail-sources.json`：那是「明细 vs 聚合表」对账链（C1），补货没有聚合表，硬套会失败。

## 权限验证（冒烟断言）

| 断言 | 期望 |
|---|---|
| 空授权（claims `branch_nums=[]`） | 0 行（`WHERE 1=0`，非「不过滤」） |
| 单账套单店授权 | 只见该账套该店，**同名 `branch_num` 的另一账套门店不串** |
| 全量授权（`["*"]`） | 两账套全量 |
| `scope_key_expr` 缺失的 fact 数据集 | 不进白名单、SELECT 被拒（fail-close） |
| 表达式引用不到本数据集列 / 含 `;` | 拒绝构建 |
| 无敏感列的 fact 数据集 | 视图正常构建（`REPLACE()` 空集退化生效），金额列不受影响 |
| `retail_detail` / `outbound_detail` | 通用路径不介入，行为与改造前逐字节一致 |

## 准确性验收（关键判据）

同一问题在 OpenClaw 与 **Lemeng 要货单页面**比数，**要求分毫一致**（对齐 `sale_date=8/27 标品耗材 159,244.65` 那种分毫级冒烟标准）。对账维度：`账套 × 日期 × 金额/行数`。

## 实现清单

1. **`docs/architecture.md` §4.3 / §8.1 更新**（架构先行，先落地）
2. 迁移 `212_registry_fact_scope.sql`：`datasets.scope_key_expr` 列 + 注释
3. 迁移 `213_replenishment_detail_registry.sql`：`datasets` 行 + `dataset_columns` 列描述 + 两条 `monitor_rules`
4. `functions/agent-query/index.js`：`loadRegistry` 读 `scope_key_expr` + 逐数据集敏感列；`runDuckdb` 通用 fact 视图构建（含表达式校验、`REPLACE()` 空集退化、硬编码视图名跳过）；`allowedTables` 由注册表派生
5. `web/lib/monitor/`：`evaluators/data-freshness.ts` + `data-integrity.ts`，注册进 `EVALUATORS`，`EvalDeps` 加 `duckdbQuery` 并接 runtime
6. `openclaw/data-query-plugin/skills/retail-query/SKILL.md`：⑫补货模板
7. 测试：`web/lib/agent-query/__tests__/` 扩 `validateSql`/表达式校验单测；`web/lib/monitor/evaluators/__tests__/` 加两个 evaluator 单测；三类身份权限冒烟；分毫级准确性冒烟
8. 部署后 `docker compose restart postgrest` 刷 schema 缓存（新增列，仓库已知坑）

## 回滚

- **字典**：`DELETE FROM datasets WHERE name='replenishment_detail'`（级联删列描述）
- **网关**：`scope_key_expr` 列保留无害（对 `IS NULL` 即不建视图）；如需完全回退，还原 `allowedTables` 写死版本
- **守护**：`UPDATE monitor_rules SET enabled=false WHERE check_type IN ('data_freshness','data_integrity')`
- **数据本身零改动**（视图为查询时实时构建，无物化存储）

## 依赖与待办

- ⏳ **阻塞项**：其他系统回补历史到 2026-07-01 并确认「旧分区不删」——回补完成前，字典须标注可用范围（`8/25` 起、`9/5` 后连续），防跨期静默少算
- ⏳ 关联调出单号（可选）→ 决定能否做「要货 vs 实发」满足率
- ⏳ `quantity` ↔ `use_quantity` 换算说明（决定「补货量」默认列）
- 📌 顺带记：`outbound_detail` 暴露的是 `sbc` 而非 `system_book_code`，与守卫的字面量要求不同名（现因 ON 子句里出现 `dim_branch.system_book_code` 而恰好通过）——不在本次范围，留作后续一致性议题
