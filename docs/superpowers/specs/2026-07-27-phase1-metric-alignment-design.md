# Phase 1 指标口径对齐 088 语义层 设计

> 日期：2026-07-27
> 性质：**数据正确性 hotfix**（DB 视图 SQL patch + 架构文档），前端无改动
> 口径已确认：CategorySummary 全口径 outbound + KpiCards delivery 去 wholesale

---

## 1. 背景

Phase 1 三个视图建于 088 指标重构**之前**。088 重新定义了 delivery/wholesale/outbound（metric_registry 语义层），但**没同步 patch 业务视图的 LATERAL/CTE**：

| 视图（迁移） | 组件 | 状态 |
|---|---|---|
| `report_region_breakdown_v`（073→091 修） | RegionDrillTable | ✅ 091 已修（按目标品牌） |
| `report_category_summary_v`（074） | CategorySummary | ❌ delivery 硬编码 `system_book_code='64188'`（表无数据→空）+ wholesale 仅 64188 门店 |
| `report_achievement_v`（070） | KpiCards 配送 | ⚠️ delivery LATERAL = `delivery UNION ALL wholesale`（含批发） |

088 后 generator 另生成了口径正确的新视图（`distribution_drill`/`outbound_drill`，前端未用），但手写视图（category/achievement/region）**不在 view-manifest**，手改安全、不会被覆盖。

**实测偏差**：CategorySummary 合计 400 万，实际应 ~1366 万（漏 delivery 820 万 + 外部批发 146 万），**漏 74%**。

---

## 2. 修复（2 迁移，对齐 088）

### 2.1 Fix 1：`095_category_summary_full_outbound.sql`

基于 074 改 2 个 CTE（其余 category_level/total_level 逻辑不变）：

**delivery_actuals**（去硬编码 64188，按目标品牌）：
```sql
SELECT tb.target_id, d.category_group AS category,
  SUM(d.out_money) AS sale_actual, SUM(d.profit_money) AS profit_actual, ...
FROM report_daily_delivery d
JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
WHERE (tb.system_book_code='ALL' OR d.system_book_code=tb.system_book_code)
  AND d.category_group IN ('水果','标品','耗材')
GROUP BY tb.target_id, d.category_group
```

**wholesale_actuals**（去硬编码 + 去 `branch_num!='64188'`，全门店+外部批发都算 outbound）：
```sql
SELECT tb.target_id, w.category_group AS category,
  SUM(w.wholesale_money) AS sale_actual, SUM(w.wholesale_profit) AS profit_actual, ...
FROM report_daily_wholesale w
JOIN target_base tb ON w.biz_date BETWEEN tb.start_date AND tb.end_date
WHERE (tb.system_book_code='ALL' OR w.system_book_code=tb.system_book_code)
  AND w.category_group IN ('水果','标品','耗材')
GROUP BY tb.target_id, w.category_group
```

幂等 DROP+CREATE，部署后 restart postgrest。

### 2.2 Fix 2：`096_achievement_delivery_pure.sql`

基于 070，**delivery LATERAL 去掉 `UNION ALL report_daily_wholesale`**，delivery_actual = SUM(report_daily_delivery.out_money) only：

```sql
LEFT JOIN LATERAL (
  SELECT SUM(d.out_money) AS delivery_actual, count(DISTINCT d.biz_date) AS delivery_days
  FROM report_daily_delivery d
  WHERE (t.system_book_code='ALL' OR d.system_book_code=t.system_book_code)
    AND d.biz_date BETWEEN t.start_date AND t.end_date
    AND (...考核战区/门店级过滤同原 070...)
) dl ON md.metric_code='delivery'
```

其余（sale/outbound LATERAL + progress_rate + freshness RPC + 三态达成）**不变**。DROP+CREATE 重写 070，restart postgrest。

---

## 3. 数据变化（修复后）

- **CategorySummary 合计**：400 万 → ~1366 万（delivery 820 + 门店批发 400 + 外部批发 146）
- **KpiCards 配送 actual**：下降（去掉 wholesale 部分，只 report_daily_delivery）
- KpiCards 出库（outbound）actual：**不变**（070 的 outbound LATERAL 本就 delivery+wholesale，只是 delivery LATERAL 单独修）

---

## 4. 验证（SSH 生产，部署后）

1. **095 后**：`SELECT sum(sale_actual) FROM report_category_summary_v WHERE category='合计'` ≈ 1.36 亿？→ 实际应 ~1366 万（按当前数据）
2. **095 交叉对账**：category_summary 合计 ≈ `report_outbound_drill_v` 同目标 `outbound_amount`（generator 口径对的视图，交叉验证一致）
3. **096 后**：KpiCards 配送 actual = `SELECT sum(out_money) FROM report_daily_delivery WHERE ...`（不含 wholesale）

---

## 5. 架构文档

更新 `docs/architecture.md §10.8`：补记 category_summary 全口径 outbound（delivery + wholesale_pp + wholesale_ext，按目标品牌）+ achievement delivery 仅 report_daily_delivery（对齐 088 语义层）。

---

## 6. 部署

迁移 095/096 走 GHA migrate（幂等 DROP+CREATE）+ restart postgrest（架构 §CLAUDE.md：加视图后须 restart postgrest 刷 schema 缓存）。前端无改动（视图字段接口不变）。

---

## 7. 不在范围

- generator 视图（distribution/outbound drill）体系治理（前端是否切过去）→ Phase 2 报表时再定
- report_region_breakdown_v（091 已修，不动）
- outbound LATERAL（070，口径本就对，不动）
