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
  scope: { target_window: true, assessed_war_zone: true },
  total_row: true,
  dim_table: 'dim_brand',
  aliases: {
    distribution_amount: 'delivery_amount',
    distribution_profit: 'delivery_profit',
    distribution_margin: 'delivery_margin',
  },
};
