# 品牌×指标表 设计

**日期**：2026-07-29
**状态**：已确认，待实现
**前置**：报表 Phase 2 数据层（item/customer 聚合表 + wholesale_customer 品牌按收货方）、门店键改革（品牌=system_book_code）、品品甜目标已重录
**关联**：`2026-07-21-report-center-redesign-design.md`（报表中心）、`2026-07-28-store-brand-dimension-reform-design.md`

---

## 1. 目标

KPI 卡下方加一张**品牌×指标表**（你最初要的）：行 熊喵鲜生(3120)/品品甜(64188)/合计，列 销售目标/销售金额/销售完成率/配送金额/配送毛利/配送毛利率。PC + 移动双端。数据层就绪后，两品牌全列可算（含品品甜配送=wholesale 收货方）。

## 2. 视图 report_brand_metric_v

按 active total 目标窗口，每品牌一行 + 合计行。`target_id` 列供前端 `.eq` 过滤（照 region_breakdown_v 模式）。

**销售列**（两品牌同源）：
- 销售目标 = 该 total 下 store 级 sale 目标按 `system_book_code` SUM（targets join target_metric_values，breakdown_level='store'）。
- 销售金额 = `report_daily_sales.total_sale` 按 sbc，窗口内 SUM。
- 销售完成率 = 金额 / (目标 × 已过天数/总天数)（时间进度调整，对齐 report_achievement_v achievement_rate）。

**配送列**（品牌异源——核心）：
- 熊喵(3120) 配送金额/毛利 = `report_daily_delivery.out_money/profit_money`（3120）。
- 品品甜(64188) 配送金额/毛利 = `report_daily_wholesale_customer.wholesale_amount/profit`（system_book_code='64188'，收货方）。
- 两源 UNION ALL，按 (target_id, system_book_code) 归并。
- 配送毛利率 = 配送毛利/配送金额（逐行重算，不 SUM）。

**合计行**：UNION ALL 一行（system_book_code='合计'），各指标 = 两品牌 SUM（rate/margin 重算不 SUM）。

**成本脱敏**：配送毛利/毛利率按 `can_see_cost` claim CASE 脱敏（无权限 NULL，照 report_achievement_v 列脱敏模式）；销售毛利本表不展示（仅配送毛利）。

## 3. 前端

- `web/lib/report-center/brand-metric.ts`：`getBrandMetric(targetId)` 读 `report_brand_metric_v` `.eq('target_id')`，返 `BrandMetricRow[]`（含合计行）。
- `web/components/report-center/brand-metric-table.tsx`：表格组件。照 DESIGN.md：tabular-nums、完成率三色（≥1绿/≥0.8琥珀/<0.8红）、禁 emoji、合计行加粗/浅灰、每组件 ⬇Excel/🖼图片/🔗分享（复用现有 chart-actions）。
- 接入 `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx`：KpiCards 下方加 `<BrandMetricTable>`；`page.tsx` 的 `Promise.all` 加 `getBrandMetric(targetId)`。

## 4. 口径

- 完成率=时间进度调整（与 KPI 卡/region_drill 一致）；颜色按绝对达成率三色。
- 配送按收货方（品品甜=wholesale 客户端门店，对齐 daily_wholesale/066）。
- margin 用原值不反算。
- 品牌=system_book_code（3120熊喵/64188品品甜，dim_brand）。

## 5. 权限/RLS

- 视图经 PostgREST 查询，走 report_daily_*/wholesale_customer 的品牌级 RLS（用户 branch_nums→品牌派生，已在数据层建好）。
- 成本脱敏在视图层 CASE（can_see_cost claim）。

## 6. 不做（YAGNI）

- 不做品牌级出库列（本表聚焦销售+配送；出库在类别报表/品牌表后续扩展）。
- 不改 KPI 卡（已改名，本轮只加表）。
- 不做品牌下钻（本表是汇总，下钻在门店报表）。

## 7. 影响

- 新视图 `report_brand_metric_v`（迁移）+ 前端组件 + lib + 接入。
- 加视图后 `docker compose restart postgrest`。
- 属呈现层，不改数据流；architecture.md §报表体系 增补品牌×指标表说明。
