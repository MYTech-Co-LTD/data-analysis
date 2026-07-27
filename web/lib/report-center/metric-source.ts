// web/lib/report-center/metric-source.ts
// metric_code → 趋势数据源映射。outbound 走 delivery+wholesale 双查前端合并。
export type MetricCode = "sale" | "delivery" | "outbound_amt" | "outbound_profit";

export interface MetricMeta {
  code: MetricCode;
  label: string;          // 中文标签
  unit: string;           // 单位（元/万）
  trendTable: "report_daily_sales" | "report_daily_delivery" | "report_daily_wholesale";
  trendValueCol: string;  // 累计字段
  // outbound 由 delivery+wholesale 合成，需两个源
  secondaryTable?: "report_daily_wholesale";
  secondaryValueCol?: string;
  // 品类过滤（outbound 只计 水果/标品耗材；sale/delivery 全部）
  categoryIn?: string[];
}

export const METRICS: Record<MetricCode, MetricMeta> = {
  sale:            { code:"sale",            label:"销售",         unit:"元", trendTable:"report_daily_sales",    trendValueCol:"total_sale" },
  delivery:        { code:"delivery",         label:"配送",         unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money" },
  outbound_amt:    { code:"outbound_amt",     label:"出库金额",     unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_money", categoryIn:["水果","标品耗材"] },
  outbound_profit: { code:"outbound_profit",  label:"出库毛利",     unit:"元", trendTable:"report_daily_delivery", trendValueCol:"profit_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_profit", categoryIn:["水果","标品耗材"] },
};

export const METRIC_ORDER: MetricCode[] = ["sale","delivery","outbound_amt","outbound_profit"];
