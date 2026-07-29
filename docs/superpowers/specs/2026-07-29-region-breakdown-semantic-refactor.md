# 门店零售/配送数据报表（region_breakdown）语义层重构

**日期**：2026-07-29
**状态**：已确认，待实现
**范围**：仅重构「门店零售/配送数据报表」这一张卡片（`RegionDrillTable`）的数据层；不改卡片 UI、不动报表中心其它部分。
**关联**：`2026-07-29-brand-metric-table-design.md`（口径一致）、CLAUDE.md「语义层」「门店键铁律」。

---

## 1. 问题（已实测确认）

`report_region_breakdown_v`（卡片数据源）三个 bug：

1. **目标平摊（下钻不准根因）**：store 级 `sale_target = 总目标 / count(考核门店)`（每家店显示同一个平均目标）；region 级 `sale_target = 总目标`（整桶）。**完全没用 `target_metric_values` 里按 store/region_l2/war_zone 分解的真实目标**（目标管理改革已建好、迁移115 自动重算）。
2. **delivery 口径漏品品甜**：只用 `report_daily_delivery`（3120 调拨），品品甜门店配送（wholesale 收货方）= 0。与品牌表/KPI 口径不一致。
3. **公式 ad-hoc**：sale_rate / daily_sale / remaining_daily 等写死在视图，不在 `metric_registry`，无单一真相源。

## 2. 语义层先行：metric_registry 定义（真相源）

metric_registry 是文档型真相源（无运行时引擎，视图照实现）。新增以下派生指标（depends_on 链清晰），作为本报表公式的权威定义：

| metric_code | measure_type | formula | depends_on |
|---|---|---|---|
| `sale_target` | base | fact_table=target_metric_values, value_column=target_value, agg=SUM (metric_code='sale', 对应分解级) | [] |
| `delivery_target` | base | fact_table=target_metric_values, value_column=target_value, agg=SUM (metric_code='delivery') | [] |
| `sale_rate` | derived | sale_amount / sale_target | ["sale_amount","sale_target"] |
| `delivery_rate` | derived | delivery_amount / delivery_target | ["delivery_amount","delivery_target"] |
| `daily_sale` | derived | sale_amount 当天（biz_date=已过最后一天=LEAST(current_date,end_date)） | ["sale_amount"] |
| `daily_delivery` | derived | delivery_amount 当天（同上） | ["delivery_amount"] |
| `remaining_daily_sale` | derived | (sale_target - sale_amount) / nullif(total_days - days_elapsed, 0) | ["sale_target","sale_amount"] |
| `remaining_daily_delivery` | derived | (delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0) | ["delivery_target","delivery_amount"] |

其中 `delivery_amount`（本报表口径）= 调拨(report_daily_delivery, 3120 门店) + 品品甜批发(report_daily_wholesale_customer, 64188 收货方门店)。与品牌表 `report_brand_metric_v`、KPI `report_achievement_v`（迁移118）一致。

> 已有 base：sale_amount(retail_detail.sale_money)、delivery_amount、wholesale。本报表的 delivery_amount 是"门店配送口径"（调拨+品品甜批发），与 outbound(出库) 不同——在 formula/business_formula 里写清。

## 3. 重做 report_region_breakdown_v

**数据源**（窗口内、考核4战区、双品牌）：
- 销售实际：`report_daily_sales` by (system_book_code, branch_num)。
- 配送实际：`report_daily_delivery`(3120 门店) + `report_daily_wholesale_customer`(64188 门店，client_name→dim_branch 64188 by branch_name 复合键) ——品品甜门店配送走批发。
- 目标（三级真实分解）：`target_metric_values` join `targets`，按 breakdown_level='store'/'region_l2'/'war_zone' 取 sale/delivery target。

**三级结构**（与 dim_branch 一致）：
- 大区 = first_level_region(war_zone) ← war_zone 级目标
- 小区 = second_level_region(region_l2) ← region_l2 级目标
- 门店 = (system_book_code, branch_num) ← store 级目标

**关键修复**：
1. **目标用真实分解值**：store 行用 store 级 target_metric_values；region_l2 行用 region_l2 级；war_zone 行用 war_zone 级。不再平摊/整桶。（各级目标和由 115 自动重算 = 门店和，自洽。）
2. **delivery 含品品甜批发**：品品甜门店配送 = 其 wholesale_customer 金额（收货方匹配）。
3. **公式照 metric_registry 实现**：rate = actual/target；daily = 当天 actual；remaining = (target-actual)/剩余天数。

**目标对齐窗口**：target_id 取 active total 目标；各级目标都挂在该 total 下（parent_target_id）。

## 4. 不做（YAGNI）

- 不改卡片 UI（RegionDrillTable 组件不变，列/交互照旧）。
- 不改报表中心其它卡片（KPI/品牌表/类别出库）。
- 不引入运行时指标解析引擎（metric_registry 维持文档型真相源；视图照实现）。
- 不改目标管理页（目标数据已对）。

## 5. 验证

- 各级目标和 = 总目标（war_zone 和 = region_l2 和 = store 和 = total），与品牌表 sale_target 一致。
- 品品甜门店配送 > 0（走 wholesale）。
- 抽查 1-2 家门店：sale_target = 目标管理页该店目标；sale_actual = report_daily_sales 该店窗口和。
- 卡片三级展开，目标和完成率合理（不再全部一样/整桶）。

## 6. 影响

- 改 `metric_registry`（加 8 个派生指标定义，迁移）。
- 重建视图 `report_region_breakdown_v`（迁移，DROP+CREATE）。
- 部署后 restart postgrest（视图变更）。
- 属语义/数据层，不改前端、不改数据流架构。
