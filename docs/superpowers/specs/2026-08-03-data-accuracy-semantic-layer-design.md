# 语义层数据准确性守护体系设计（L4 上游对账 + D 去重守护）

日期:2026-08-03
状态:已获用户确认(全链条体系化 / 自动巡检对账 / 上游对账收口语义层 / 硬收口配置驱动 / 四类触发 / 补 D 去重守护)

## 背景与现状断链

平台的数据链路:`乐檬源(API) → 采集(transform/merge) → parquet 明细(OOS) → compute 聚合(PG report_daily_*) → 语义层视图(report_*_gen) → 前端报表`。

已有的准确性机制分散且各有盲区:

| 层 | 已有机制 | 盲区 |
|---|---|---|
| 采集完整性 | CLAUDE.md 采集五条铁律;collect_logs;`/collect-backfill` 补采 | 仅看"库≥源"单向;不抓重复 |
| 明细↔聚合 | `scripts/reconcile-check.js`(每日 09:10 cron,retail/delivery/wholesale amt+profit) | **对重复是盲的**:transform 去重失败致明细翻倍时,compute 读同一份翻倍 parquet 聚合,两边同时翻倍,对账相等 PASS |
| 源API↔明细 | `/api/admin/reconcile-check`(周对账,仅 count) | 周频、手动、仅 count、单向 |
| 视图自洽 | 语义层 L3a `_audit` 视图(rollup 不变性) | 只查视图内部加总一致,不查视图↔上游聚合表一致 |
| 新旧视图 | L3b 双轨 SUM diff(迁移期) | 一次性,非运行期 |

**核心结论**:现有体系无任何"运行期数据重复守护";视图层缺"与上游聚合表对账";巡检工具散乱无统一入口。

## 目标

1. **全链条自动巡检对账**:上游=下游逐层比对,静默出错(翻倍/丢品牌/丢行/口径漂移)能被发现。
2. **D 去重守护**:补上唯一能抓"transform 去重失败→明细翻倍"的检查。
3. **收口语义层**:对账检查点、自然键、断言全部**配置驱动**,以语义层为单一配置源;删除 reconcile-check.js 硬编码查询。
4. **统一入口 + 四类触发**:每日定时 / 采集后自动 / 部署生成后自动 / 手动按需。
5. **口径回归**:改 metric_registry AST / view-configs 后契约测试重跑引用视图,防改动后静默回归。

## 检查类型体系

```
源API ─C0─ 明细parquet ─D1─ ─C1─ 聚合表 ─D2─ ─C2─ 语义层视图 ─C3─ 前端
       采集完整性     主键唯一  明细↔聚合     PK重复   视图↔聚合      rollup自洽
                                                    └─C4─ 口径回归(改动后)
```

| 代号 | 检查 | 执行端 | 防什么 | 来源 |
|---|---|---|---|---|
| **C0** | 源API count ↔ 明细 count(按日×品牌,**双向**:库<源=缺漏;库>源×(1+ε)=疑重) | duckdb + 源API | 采集缺漏 / 重复嫌疑 | 现周对账 route → 强化每日双向 |
| **C1** | 明细 parquet ↔ 聚合表(amt+profit,按日×品牌) | duckdb + PG | 聚合丢数据/漏算/glob 误匹配 | 现 reconcile-check.js → 收口 |
| **C2** | 视图 ↔ 聚合表(按 scope 过滤后 SUM 一致) | PG | 视图丢行/丢品牌/口径漂移 | **新增** |
| **C3** | 视图内部 rollup 自洽(战区和=小区和=门店和) | PG | 层级加总不一致 | 已有 L3a `_audit` |
| **C4** | 口径回归(改 AST/config 后契约测试重跑引用视图) | TS | 改动后静默回归 | 已有,扩展 |
| **D1** | 明细主键唯一性 `COUNT(*) vs COUNT(DISTINCT 自然键)` | duckdb | **transform 去重失败→明细翻倍**(reconcile 抓不到) | **新增·核心** |
| **D2** | 聚合表 PK 重复(biz_date,sbc,branch,cat 维度) | PG | 聚合写入重复 | **新增** |

**关键设计点:**

- **C0 双向**:现有周对账只看"库≥源"(单向),抓不了重复。改为 `库<源×(1-ε) → 缺漏`、`库>源×(1+ε) → 疑重`,双向告警。ε 建议 0.1(10% 容差),可配置。
- **D1 自然键**:retail=`(system_book_code, branch_num, order_no, order_detail_num)`;delivery/wholesale=`单号+明细行号`。**禁用 id 作自然键**——lemeng 分页每次重新生成 id,正是它让 `dedupe_key=['*']`(SELECT DISTINCT *)失效,致 60-120x 重复(实测坑)。自然键注册进配置,实施时用真实数据校验唯一性假设(同 key 出现两次以上才算重复,先看样本再定断言)。
- **C1 对重复是盲的**(明细/聚合同时翻倍时两边相等)→ **D1 必须独立存在**,不能依赖 C1 兜底。
- **D1/D2 指标**:`dupRatio = count(*) / count(distinct key)`,>1 即告警。聚合表直接查重复 PK 行数,>0 即告警。

## 机制设计

### 配置层(硬收口核心)——语义层新增两个配置模块

`services/semantic-generator/src/detail-sources.ts`:注册每张明细的自然键 + 聚合表映射,替代 reconcile-check.js 硬编码:

```ts
{
  name: 'retail',                                    // 检查名(同 collect_tasks 口径)
  glob: 's3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet',  // 严格 all.parquet,防 glob 通配翻倍
  natural_key: ['system_book_code','branch_num','order_no','order_detail_num'],  // D1 用
  agg_table: 'report_daily_sales',                   // C1/D2 用
  agg_key: ['system_book_code','branch_num','biz_date'],
  agg_metric: [
    { detail: 'sale_money',  agg: 'total_sale'   },
    { detail: 'profit',      agg: 'total_profit' },
  ],                                                // C1 用(明细列→聚合列)
  brand_expr: "regexp_extract(filename,'retail_detail/([0-9]+)/',1)",   // 按品牌
  api_count: { fn: 'countRetailApi' },              // C0 用(web/lib/collect 已有)
  tolerance: 0.01,                                  // 金额容差(元),可覆盖
}
```

`services/semantic-generator/src/qa-checks.ts`:`viewAssertions`——每张视图的上游断言。**断言参考 SQL 独立手写(不经生成器 AST 翻译),保证与视图口径相互独立**——否则两处共享同一 bug,断言失去意义。默认可从 view-configs + metric_sources 派生候选,人工确认后固化。

```ts
{
  view: 'report_brand_metric_gen',
  checks: [
    {
      metric: 'sale_amount',                         // 视图输出列
      ref_sql: `SELECT COALESCE(SUM(total_sale),0) FROM report_daily_sales
                WHERE biz_date BETWEEN tgt.start_date AND tgt.latest_day
                  AND is_assessed_war_zone(...)`,    // 独立重算,不信任视图逻辑
      tolerance: 0.01,
    },
    // ...
  ],
}
```

### 生成器扩展

`runGenerator` 产视图时,为每张视图同时产一个 **`_qa` 对账视图**(PG SQL,静态入 git,DROP+CREATE 幂等,同 L3a `_audit` 模式)。C2/C3 断言是静态产物,可 review 可回滚。EXPLAIN 失败不产文件(L2 既有逻辑扩展)。

### QA 运行器

统一执行核心,`scripts/qa-run.ts`(CLI)+ `/api/admin/qa-run/route.ts`(web)共用:

- 读语义层配置(detail-sources + qa-checks + view-configs)
- 按类型执行:
  - PG 断言:查 `_qa`/`_audit` 视图(C2/C3)
  - duckdb HTTP:跑 D1/C1 查询(从 detail-sources 生成)+ C0 明细侧 count
  - 源 API:C0 经 web route 上下文调 `lib/collect` 的 count 函数(countRetailApi/countDeliveryApi/countWholesaleApi,已有)
  - TS:C4 契约测试
- 结果统一记 `qa_logs`;失败 → 企微告警(复用 wecom-notify)
- 支持单检查运行:`qa-run --check=retail` / `qa-run --check=report_brand_metric_gen`(排查用)

### 四类触发(同一入口)

```
每日定时 cron ──────┐
采集后 scheduler 回调 ─┤→ qa-run / api/admin/qa-run → qa_logs → 企微告警
gen-views 后自动 ─────┤
手动按需(管理端按钮) ──┘
```

- **每日定时**:`scripts/cron-reconcile.sh` 改调 `qa-run --full`(保留 09:10 时机,采集+compute 之后)。
- **采集后自动**:scheduler `triggerCompute()` 成功后追加调用 qa-run(可只跑受影响 detail-sources 的 C0/D1/C1,减少开销)。
- **gen-views 后自动**:生成器跑完自动跑 C2/C3/C4(部署/生成后防回归)。
- **手动按需**:管理端触发任意单检查。

### 收口动作

1. **删除 `scripts/reconcile-check.js` 硬编码查询**——retail/delivery/wholesale 三表查询迁移进 `detail-sources.ts`,执行逻辑由 qa-run 承接。
2. `scripts/cron-reconcile.sh` → 调 `qa-run --full`。
3. `/api/admin/reconcile-check` 周对账 count 检查 → 并入 C0(每日双向);原 route 下线或改调 qa-run。
4. 架构文档 §10.10 更新:三层校验(L1/L2/L3)扩展为 **L4 上游对账(含 D 去重守护)**,语义层配置成为全链路对账单一配置源。

## 数据模型

`qa_logs` 表(迁移新增,幂等模板):

```sql
CREATE TABLE IF NOT EXISTS qa_logs (
  id         BIGSERIAL PRIMARY KEY,
  run_id     TEXT NOT NULL,
  trigger    TEXT NOT NULL,          -- 'cron' | 'collect' | 'deploy' | 'manual'
  check_type TEXT NOT NULL,          -- 'C0'..'C4' | 'D1' | 'D2'
  check_name TEXT NOT NULL,          -- 如 'retail' / 'report_brand_metric_gen'
  status     TEXT NOT NULL,          -- 'pass' | 'fail' | 'error'
  diff       NUMERIC,                -- 差异值(金额差 / dupRatio-1 / 重复行数)
  detail     JSONB,                  -- 差异明细(前 N 条不匹配行)
  run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, check_type, check_name)
);
CREATE INDEX IF NOT EXISTS idx_qa_logs_run_at ON qa_logs(run_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_logs_status ON qa_logs(status);
```

管理端只读列表页(最近 N 轮结果 + 失败项),不建复杂看板。

## 修复策略(分级,防告警风暴)

| 级别 | 检查 | 动作 |
|---|---|---|
| **自动修复** | C0 缺漏 | 自动调 `/collect-backfill` 补采(≤3 次/轮,与现有 dim_customer 兜底自动补跑同款模式) |
| **自动修复** | C1 差异 | 自动调 `/compute` 重算该日(≤3 次/轮) |
| **只告警** | D1/D2 重复 | **不自动删数据**——需人工确认自然键后再清 |
| **只告警** | C2/C3 视图问题 | 不自动重建视图(先查生成器/config 差异) |
| **阻断** | C4 口径回归 | 部署时契约测试红即停(既有) |

## 测试

- 生成器契约测试扩展:`_qa` 视图 SQL 快照 + 断言生成逻辑单测(照既有 perm-filter 契约测试模式)。
- detail-sources 注册正确性测试:自然键/聚合列与聚合表真实列对得上(防手滑写错列名)。
- C4 回归:改 metric_registry AST / view-configs 后,契约测试重跑所有引用该指标的视图(既有 ast.test/tier1.test/hierarchy.test 扩展)。

## 分阶段落地

### P0(核心新增,先上 D 去重守护 + C2)

1. 迁移建 `qa_logs` 表。
2. `detail-sources.ts` 注册 retail/delivery/wholesale 三张明细(自然键 + 聚合表映射)。
3. `qa-checks.ts` 声明首批 viewAssertions(品牌表/类别汇总/门店下钻/商品分解,视 EXPLAIN 可行性分批)。
4. 生成器扩展:`_qa` 对账视图产出。
5. `qa-run` 骨架 + `/api/admin/qa-run` route + 四类触发接入 + cron 收口。
6. **D1/D2 去重守护**上线(核心)。

### P1(收口强化)

1. C0 双向每日(替代周对账 route)。
2. C1 三表收口:reconcile-check.js 查询迁进 detail-sources,删硬编码。
3. 自动修复(补采 / compute 重算,≤3 次限流)。

### P2(回归加固)

1. C4 契约测试扩展 + `_qa` SQL 快照。
2. 管理端手动触发 + qa_logs 结果页。
3. 全视图 viewAssertions 补齐。

## 收口边界(YAGNI,明确不做)

- 不做数据血缘可视化(超出当前需求)。
- 不做运行时动态语义引擎(既有 YAGNI 决策,静态视图 SQL 入 git 可 review 可回滚)。
- **不自动删重复数据**(D1/D2 只告警,人工确认后清理)。
- 不做复杂数据质量看板/评分(只做 qa_logs 只读列表页)。

## 涉及文件

| 文件 | 动作 |
|---|---|
| `services/semantic-generator/src/detail-sources.ts` | 新增(明细自然键/聚合映射注册) |
| `services/semantic-generator/src/qa-checks.ts` | 新增(viewAssertions 断言参考 SQL) |
| `services/semantic-generator/src/generators/tier1.ts` / `hierarchy.ts` | 扩展(产 `_qa` 视图) |
| `services/semantic-generator/src/index.ts` | 扩展(gen-views 后触发 C2/C3/C4) |
| `scripts/qa-run.ts` | 新增(QA 运行器 CLI) |
| `web/app/api/admin/qa-run/route.ts` | 新增(手动/采集后触发) |
| `database/migrations/15X_qa_logs.sql` | 新增(qa_logs 表) |
| `scripts/reconcile-check.js` | 删除(查询迁 detail-sources) |
| `scripts/cron-reconcile.sh` | 改调 `qa-run --full` |
| `web/app/api/admin/reconcile-check/route.ts` | C0 收口后下线/改调 |
| `docs/architecture.md` §10.10 | 更新(三层校验 → L4 上游对账) |
