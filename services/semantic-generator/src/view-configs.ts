import type { ViewConfig } from './types.js';

/**
 * 品牌×指标表视图配置（对应 report_brand_metric_v 113）
 * 迁移 P1：用生成器产出 report_brand_metric_gen
 *
 * 口径对齐 113：
 * - scope: active total target 日期窗口 + is_assessed_war_zone 考核战区过滤
 * - delivery 实为 distribution（3120 配送 + 64188 品品甜批发），列别名保留 delivery_*
 * - dim_brand cross-join 保证两品牌都出现；末尾 UNION ALL 合计行
 */
export const brandMetricView: ViewConfig = {
  view_name: 'report_brand_metric_gen',
  metrics: [
    'sale_amount',          // 销售金额（base）
    'sale_target',          // 销售目标（target_metric_values）
    'sale_rate',            // 销售完成率 = sale_amount / sale_target
    'distribution_amount',  // 配送金额 = delivery + wholesale_pp
    'distribution_profit',  // 配送毛利（成本敏感）
    'distribution_margin',  // 配送毛利率 = distribution_profit / distribution_amount（成本敏感）
  ],
  dim_code: 'brand',
  levels: ['brand'],
  target_metric_codes: ['sale_target'],
  scope: { target_window: true, assessed_war_zone: true, target_status: ['active', 'closed'] },
  total_row: true,
  dim_table: 'dim_brand',
  aliases: {
    distribution_amount: 'delivery_amount',
    distribution_profit: 'delivery_profit',
    distribution_margin: 'delivery_margin',
  },
};

/**
 * 类别汇总视图配置（Task 6：目标管理改造）
 * 生成 report_category_summary_gen 视图，供目标管理模块使用
 *
 * 口径说明：
 * - 类别分解目标：targets 表按 category breakdown 分解的子目标
 * - 实际值：report_daily_delivery + report_daily_wholesale 按 category_group 聚合
 * - scope: active total target 日期窗口（不限制考核战区）
 * - 对齐手写视图 095：直接生成SQL，不依赖复杂的AST翻译
 *
 * 反自由发挥约束（迁移 133）：
 * - 类别值从配置读取（不硬编码在生成器）
 * - 表名从 metric_sources 读取（delivery_amount → delivery, wholesale_amount → wholesale）
 * - 指标码从 metric_registry 读取（outbound_amount/profit = delivery + wholesale）
 */
export const categorySummaryView: ViewConfig = {
  view_name: 'report_category_summary_gen',
  dim_code: 'category',
  metrics: ['outbound_amount', 'outbound_profit'],  // derived 指标（delivery + wholesale）
  levels: [],
  target_metric_codes: [],
  scope: { target_window: true, target_status: ['active', 'closed'] },
  total_row: true,
  target_breakdown: 'category',
  categories: ['水果', '标品', '耗材'],  // 类别值列表（配置驱动，不硬编码）
};

/**
 * 门店下钻视图配置（对应 report_region_breakdown_v 120）
 * 三级层级：region(战区) → sub_region(二级区域) → store(门店)
 *
 * 口径对齐 120：
 * - targets 表按 breakdown_level 分解（store/region_l2/war_zone）给各级 target
 * - actual 从叶级 store 聚合后 rollup 到父级（SUM additive + MAX 窗口）
 * - rate/remaining 非累加，在 final SELECT 重算（不 SUM）
 *
 * 关键：dim_branch 列为 first_level_region/second_level_region（非 war_zone/region_l2），
 *   故 leaf.columns 的 expr 必须用 dim_branch 真实列名；同时通过 out='war_zone'/'region_l2'
 *   暴露桥接列供父级 rollup GROUP BY（targets 表列名）。前端列名（region_code 等）
 *   通过同 column 的另一 out 暴露。
 *
 * 输出列对齐前端 RegionBreakdownRow（web/lib/report-center/region-breakdown.ts）：
 *   target_id, level, parent_code, region_code, region_name, sub_region_code, sub_region_name,
 *   branch_num, branch_name, sale_target, sale_actual, sale_rate, delivery_target, delivery_actual,
 *   delivery_rate, daily_sale, daily_delivery, remaining_daily_sale_target, remaining_daily_delivery_target.
 *   另含 war_zone/region_l2 两列 rollup 桥接（前端忽略，不破坏 interface 断言）。
 */
export const regionBreakdownView: ViewConfig = {
  view_name: 'report_region_breakdown_gen',
  metrics: [
    'sale_amount',          // → sale_actual（alias）
    'sale_target',
    'sale_rate',
    'daily_sale',
    'distribution_amount',  // → delivery_actual（alias；配送=调拨+品品甜批发，对齐120）
    'delivery_target',
    'delivery_rate',        // = distribution_amount / delivery_target（127 已改 distribution 口径）
    'daily_delivery',       // = distribution_amount FILTER(latest_day)（127 已改）
    'remaining_daily_sale',       // → remaining_daily_sale_target（alias）
    'remaining_daily_delivery',   // → remaining_daily_delivery_target（alias）
  ],
  dim_code: 'branch',
  levels: ['store', 'sub_region', 'region'],
  target_metric_codes: ['sale_target', 'delivery_target'],
  scope: { target_window: true, assessed_war_zone: true, target_status: ['active', 'closed'] },
  aliases: {
    sale_amount: 'sale_actual',
    distribution_amount: 'delivery_actual',
    remaining_daily_sale: 'remaining_daily_sale_target',
    remaining_daily_delivery: 'remaining_daily_delivery_target',
  },
  hierarchy: [
    {
      level: 'region',
      grain: ['war_zone'],
      target_breakdown: 'war_zone',
      rollup_from: 'store',
      is_leaf: false,
      parent_expr: null,        // 顶级：parent_code = NULL（照 120 wz_rows）
      columns: [
        { out: 'region_code', expr: 'war_zone' },
        { out: 'region_name', expr: 'war_zone' },
      ],
    },
    {
      level: 'sub_region',
      grain: ['war_zone', 'region_l2'],
      target_breakdown: 'region_l2',
      rollup_from: 'store',
      is_leaf: false,
      parent_expr: 'war_zone',
      columns: [
        { out: 'region_code', expr: 'war_zone' },
        { out: 'region_name', expr: 'war_zone' },
        { out: 'sub_region_code', expr: 'region_l2' },
        { out: 'sub_region_name', expr: 'region_l2' },
      ],
    },
    {
      level: 'store',
      grain: ['system_book_code', 'branch_num'],   // 复合门店键
      target_breakdown: 'store',
      is_leaf: true,
      parent_expr: 'region_l2',
      columns: [
        // 前端输出列（expr = dim_branch 真实列名）
        { out: 'region_code', expr: 'first_level_region' },
        { out: 'region_name', expr: 'first_level_region' },
        { out: 'sub_region_code', expr: 'second_level_region' },
        { out: 'sub_region_name', expr: 'second_level_region' },
        { out: 'branch_num', expr: 'branch_num' },
        { out: 'branch_name', expr: 'branch_name' },
        // rollup 桥接列：父级 grain GROUP BY 依赖（out = targets 表列名）
        { out: 'war_zone', expr: 'first_level_region' },
        { out: 'region_l2', expr: 'second_level_region' },
      ],
    },
  ],
};