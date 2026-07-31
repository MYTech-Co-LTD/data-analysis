// 语义层类型：从 metric_registry / metric_sources 读出的 typed 视图

export type MeasureType = 'base' | 'derived';
export type Agg = 'SUM' | 'COUNT_DISTINCT' | 'AVG' | 'MAX' | 'MIN' | null;

export interface Metric {
  metric_code: string;
  name: string;
  description: string | null;
  business_formula: string | null;
  measure_type: MeasureType;
  fact_table: string | null;
  value_column: string | null;
  agg: Agg;
  formula: string | null;
  depends_on: string[];
  additive: boolean;
  cost_sensitive: boolean;
  unit: string;
  data_ready: boolean;
  enabled: boolean;
}

export interface MetricSource {
  metric_code: string;
  source_table: string;
  source_column: string | null;
  source_filter: string | null;
  note: string | null;
}

// 维度层级：生成器按 hierarchy 配置产出多级 UNION ALL 视图（照手写视图 120 三级结构）
export interface HierarchyLevel {
  level: string;                // 'store' | 'sub_region' | 'region'
  grain: string[];              // 该级分组键，如 ['system_book_code','branch_num']（store 级必含复合门店键）
  target_breakdown: string;     // target_metric_values 的 breakdown_level，如 'store' | 'region_l2' | 'war_zone'
  rollup_from?: string;         // 父级 actual 从哪级 rollup（叶级无；父级如 'store'）
  is_leaf: boolean;
  columns: { out: string; expr: string }[]; // 输出维度列映射（如 {out:'war_zone', expr:'first_level_region'}）
}

// 视图配置：生成器按配置产出 report_*_gen.sql。P0 无配置（空跑），P1 起填充。
export interface ViewScope {
  target_window: boolean;       // true: base 数据按 active total target 的日期窗口过滤
  assessed_war_zone: boolean;   // true: base 数据按 is_assessed_war_zone 过滤（dim_branch join）
}

export interface ViewConfig {
  view_name: string;            // report_brand_metric_gen
  metrics: string[];            // metric_code 列表
  dim_code: string | null;      // 维度（brand/branch/item/customer），null=无下钻
  levels: string[];             // 维度层级 level_code 列表
  target_metric_codes: string[];// 哪些 metric_code 需 join target_metric_values（取目标值）
  scope?: ViewScope;            // 数据范围约束（日期窗口 + 考核战区）
  total_row?: boolean;          // true: 末尾 UNION ALL 合计行（SUM rollup）
  dim_table?: string | null;    // 维度维表（如 dim_brand）cross-join 保证空品牌也出现
  aliases?: Record<string, string>; // metric_code → 输出列名（如 distribution_amount→delivery_amount）
  hierarchy?: HierarchyLevel[]; // 维度层级（存在时走 generateHierarchyView，产多级 UNION ALL 视图）
}
