// 语义层数据质量守护配置类型（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
// detail-sources.json / qa-checks.json 的结构契约

export type CheckType = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'D1' | 'D2';
export type QaTrigger = 'cron' | 'collect' | 'deploy' | 'manual';

/** 明细源注册：D1 主键唯一性 / D2 聚合PK重复 / C1 明细↔聚合 的配置来源 */
export interface DetailSource {
  name: string;                          // 'retail' | 'delivery' | 'wholesale'
  report_type: string;                   // 聚合表对应的报表类型标识（daily_sales/daily_delivery/daily_wholesale）
  function_slug: string;                 // 对应采集 function（C0 参数查找用）
  glob: string;                          // 严格 all.parquet glob
  glob_date_format: 'iso' | 'compact';   // 日期目录格式：retail=YYYY-MM-DD(iso)，delivery/wholesale=YYYYMMDD(compact)
  natural_key: string[];                 // D1 用（业务键，禁用 id）
  agg_table: string;                     // C1/D2 用
  agg_key: string[];                     // D2 用（聚合表 PK 列）
  agg_metric: { detail: string; agg: string }[];  // C1 用（明细列→聚合列）
  brand_expr: string;                    // 品牌提取表达式（duckdb，引 filename）
  detail_date_expr: string;              // 明细日期 → YYYYMMDD 表达式
  api_count?: { fn: string; dates_iso: boolean };  // C0 用（web 侧映射）
  tolerance: number;                     // C1 金额容差（元）
}

/** 视图上游断言：C2 用（独立重算，不经生成器 AST，保证与视图口径相互独立） */
export interface ViewAssertion {
  view: string;                          // 视图名（report_*_gen）
  metric: string;                        // 视图输出列名（含 alias）；长表场景为 metric 标签
  view_sum_filter: string;               // 视图 SUM 过滤（排除合计行等）
  ref_sql: string;                       // 独立重算，返回单值 SUM
  tolerance: number;
  sum_col?: string;                      // 长表场景 SUM 列（默认 = metric）。achievement 长表（每行 target×metric）用 actual_value，metric 仅作标签
}
