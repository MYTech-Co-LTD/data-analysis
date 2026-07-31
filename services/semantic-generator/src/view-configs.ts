import type { ViewConfig } from './types.js';

/**
 * 品牌×指标表视图配置（对应 report_brand_metric_v 112/113）
 * 迁移 P1：用生成器产出 report_brand_metric_gen
 *
 * 注意：品牌视图的 delivery 实际是 distribution（3120 配送 + 64188 品品甜批发），
 * 用 distribution_amount/profit（derived）而非 base delivery_amount/profit。
 */
export const brandMetricView: ViewConfig = {
  view_name: 'report_brand_metric_gen',
  metrics: [
    'sale_amount',             // 销售金额（base）
    'distribution_amount',     // 配送金额 = delivery_amount + wholesale_pp_amount
    'distribution_profit',     // 配送毛利 = delivery_profit + wholesale_pp_profit（成本敏感）
    'delivery_sale_ratio',     // 配销比 = distribution_amount / sale_amount（rate）
  ],
  dim_code: 'brand',
  levels: ['brand'],
  target_metric_codes: [],
};
