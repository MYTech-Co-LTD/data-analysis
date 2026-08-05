# C1 compute 层收口 + 自动重算设计

日期：2026-08-05
状态：brainstorming design 已获批（段1收口架构 + 段2 c1.ts 对账+自动重算），待用户 review 后 writing-plans
上位规划：`docs/superpowers/specs/2026-08-05-data-accuracy-guard-overall-design.md`（子系统②compute 层）
基线 spec：`docs/superpowers/specs/2026-08-03-data-accuracy-semantic-layer-design.md`（C1 设计意图）

## Context

C1（明细 parquet ↔ 聚合表 SUM 一致）当前**三套并行**，互不重叠、口径不一、都没自动重算、两套没进 qa_logs：

| 实现 | 位置 | 频率 | 粒度 | 容差 | qa_logs | 自动重算 |
|---|---|---|---|---|---|---|
| A. reconcile-check.js | scripts/（主机 cron 09:10） | 每日 | 日×品牌 amt+profit | 0.01 | ❌ | ❌ |
| B. reconcile_table_consistency RPC | scheduler 09:07 | 每日 | 单日总量 amount | 1 元 | reconcile_daily_results（非 qa_logs） | ❌ |
| C. /api/admin/reconcile-check route | 手动/周 | 周 | count 单向 | - | ❌ | ❌ |

缺口：C1 差异只告警不修复；硬编码未配置驱动；三套重叠浪费。本 spec 收口为一套配置驱动的 `c1-runner`（复刻 C0 模式）+ C1 diff 自动 `/compute` 重算。

## 一、收口架构（复刻 C0 模式）

**新建**：
- `web/lib/qa/c1.ts` --核心对账逻辑（明细 duck vs 聚合 pg，按 sbc|bizday，amt+profit）
- `web/lib/qa/c1-runner.ts` --遍历 detailSources，注入 `qa-runner.ts:runDailyQa`（L250 旁，同 C0 注入点）+ `qa-run/route.ts`
- `detail-sources.json` 每源补 `report_type` 字段（retail->daily_sales, delivery->daily_delivery, wholesale->daily_wholesale）--C1 diff->/compute 重算映射

**保留**：scheduler 09:07 `registerDailySourceReconcileJob`（`reconcile_table_consistency` RPC + `reconcile_daily_results` 表）作**粗筛**--单日总量 1 元容差快速兜底，c1-runner 做精确品牌×日对账（0.01 容差 + 自动重算）。两层互补。

**删/下线**：
1. `scripts/reconcile-check.js` --删（查询迁进 detail-sources 配置驱动）
2. `scripts/cron-reconcile.sh` --删（09:10 归入 09:15 qa job）
3. `web/app/api/admin/reconcile-check/route.ts` --下线（C0 c0-runner 已覆盖 count 对账）

## 二、c1.ts 核心对账逻辑

**输入**：`DetailSource`（glob/agg_table/agg_metric[]/brand_expr/detail_date_expr/tolerance/report_type）+ 窗口日期 `[from, to]`

**明细端（duckdb HTTP）**--用 detail-sources 字段构建：
```sql
SELECT ${brand_expr} AS sbc, ${detail_date_expr} AS bizday,
       SUM(${agg_metric.detail}) AS detail_sum
FROM read_parquet('${glob}')
WHERE ${detail_date_expr} BETWEEN ${from_compact} AND ${to_compact}
GROUP BY sbc, bizday
```

**聚合端（pg）**--用 agg_table + agg_metric：
```sql
SELECT system_book_code AS sbc, to_char(biz_date,'YYYYMMDD') AS bizday,
       SUM(${agg_metric.agg}) AS agg_sum
FROM ${agg_table}
WHERE biz_date BETWEEN ${from} AND ${to}
GROUP BY sbc, bizday
```

**对账**：按 `sbc|bizday` join，逐 `agg_metric`（amt + profit 各一）算 `diff = detail_sum - agg_sum`，`|diff| > tolerance` = mismatch。输出 `CheckResult{status, detail: 差异行[{sbc,bizday,metric,detail_sum,agg_sum,diff}]}`。

**brand_expr 口径**：用 detail-sources 的 `brand_expr`（regexp_extract from filename，与 retail/delivery 一致）。wholesale 的 64188 由 filename 提取（`wholesale_detail/64188/`），**不需 dim_branch JOIN**（reconcile-check.js 的 CASE 是历史复杂化，regexp_extract 够用）。

**复用 d1.ts 基础设施**：`buildDayGlob(src, dayCompact)`（按 glob_date_format 构建单日 glob）、`duckQuery(duckUrl, apiKey, sql)`（DuckDB HTTP 执行器）。

## 三、C1 自动重算（diff -> /compute 单源单日 ≤3 次）

c1-runner 检出 mismatch 后：
1. 从差异行取 `{sbc, bizday}` + `src.report_type`（新字段）
2. `POST ${DUCKDB_URL}/compute { report_type, date_from: bizday(YYYY-MM-DD), date_to: bizday }`（server.js:520，DELETE-before-INSERT 幂等）
3. 重算后**重跑该源该日 C1** 验证收敛（diff->0）
4. **≤3 次**（仍 mismatch 放弃，status=fail 告警人工排查）
5. 写 qa_logs（status=pass/fail + diff + retry 次数）

**复用 triggerCompute 模式**（scheduler.ts:186）：同一 /compute 端点 + report_type。c1-runner 内置 retry 循环（≤3）。

## 四、detail-sources.json 扩展

每源补 `report_type` 字段（C1 diff -> /compute 映射）：
```json
{
  "name": "retail",
  "report_type": "daily_sales",
  ...
}
```
- retail -> daily_sales（target: report_daily_sales）
- delivery -> daily_delivery（target: report_daily_delivery）
- wholesale -> daily_wholesale（target: report_daily_wholesale）

**glob 统一**：收口以 detail-sources.json 为准（delivery/wholesale 的 `*/*`，非 reconcile-check.js 的 `**`）。

**配置同步**：services 源 + web 副本字节同步（config-sync.test）。

## 五、四类触发

- **每日 09:15 qa job**：`runDailyQa`（L250 旁，同 C0 注入），全源 7 天窗口
- **采集后**：`executeTask` 末尾（scheduler.ts:660，D1+D2 之外追加 C1 受影响源当日）--补齐 spec 2026-08-03"采集后跑受影响源 C0/D1/C1"设计
- **手动**：`/api/admin/qa-run?check=C1:<source>`
- gen-views 后：不适用（C1 是数据层）

## 六、关键文件
- 新建：`web/lib/qa/c1.ts`、`web/lib/qa/c1-runner.ts`
- 改：`web/lib/qa-runner.ts`（注入 C1，同 C0 模式）、`web/app/api/admin/qa-run/route.ts`（同步注入）、`services/semantic-generator/src/detail-sources.json` + `web/lib/qa/config/detail-sources.json`（加 report_type）、`web/lib/scheduler.ts`（executeTask 采集后追加 C1）
- 删：`scripts/reconcile-check.js`、`scripts/cron-reconcile.sh`、`web/app/api/admin/reconcile-check/route.ts`
- 保留：`scheduler.ts registerDailySourceReconcileJob`（09:07 粗筛）、`reconcile_table_consistency` RPC、`reconcile_daily_results` 表

## 七、验证
- c1.ts 单测：mock duck/pg 返回，验证 amt+profit 对账 + diff 判定（照 c0.ts/d1.ts 模式）
- c1-runner 单测：遍历 detailSources + 自动重算 retry ≤3（mock /compute）
- 部署后：手动造差异（改某聚合表一行）-> 跑 C1 -> 确认检出 + 自动重算收敛 + qa_logs 记录
- 回归：09:07 粗筛仍跑（reconcile_daily_results）；删 reconcile-check.js 后主机 crontab 无 09:10

## 八、避开/后续
- **item 级行数对账**（report_daily_item_*）：item 级无 branch_num/考核过滤，口径不同，留后续
- **C0 每日双向**（spec P1）：c0-runner 已落地每日，C1 收口不涉
- **wholesale brand_expr dim_branch JOIN**：确认 regexp_extract 够（64188 由 filename），若实测有误再补
- **采集后 C1 性能**：采集后跑 C1 增加延迟（duck parquet 读 + pg 查），若影响采集节奏可只跑受影响源当日（非全 7 天）

## 九、收口动作清单（实施时）
1. detail-sources.json 加 report_type（3 源）+ 同步 web 副本
2. 新建 c1.ts（对账逻辑）+ c1-runner.ts（遍历 + 注入 + 自动重算 retry）
3. qa-runner.ts + qa-run/route.ts 注入 C1（同 C0）
4. scheduler.ts executeTask 采集后追加 C1
5. 删 scripts/reconcile-check.js + scripts/cron-reconcile.sh
6. 下线 web/app/api/admin/reconcile-check/route.ts
7. 主机 crontab 删 09:10（若 GHA 部署不管主机 cron，需 SSH 手动删）
8. 部署 + 验证
