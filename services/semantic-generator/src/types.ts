// 语义层类型：从 metric_registry / metric_sources 读出的 typed 视图

import type { Ast } from './ast.js';

export type MeasureType = 'base' | 'derived';
export type Agg = 'SUM' | 'COUNT_DISTINCT' | 'AVG' | 'MAX' | 'MIN' | null;
export type DimCode = 'brand' | 'branch' | 'item' | 'customer' | 'category';
export type TargetBreakdown = 'store' | 'region_l2' | 'war_zone' | 'category';

export interface Metric {
  metric_code: string;
  name: string;
  description: string | null;
  business_formula: string | null;
  measure_type: MeasureType;
  fact_table: string | null;
  value_column: string | null;
  agg: Agg;
  formula_ast: Ast | null;       // 结构化口径（生成器读此列用 astToSql 翻译）
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
  target_breakdown: TargetBreakdown; // target_metric_values 的 breakdown_level，如 'store' | 'region_l2' | 'war_zone' | 'category'
  rollup_from?: string;         // 父级 actual 从哪级 rollup（叶级无；父级如 'store'）
  is_leaf: boolean;
  columns: { out: string; expr: string }[]; // 输出维度列映射（如 {out:'war_zone', expr:'first_level_region'}）
  // T6: 该级 parent_code 列的取值表达式。省略/null → NULL::text AS parent_code。
  //   - 叶级：expr 应为 leaf_rows 已暴露的列名（如 'region_l2'）→ a.region_l2 AS parent_code
  //   - 父级：expr 应为该级 act CTE 的列名（即 grain 元素，如 'war_zone'）→ a.war_zone AS parent_code
  //   照 120：store 级 = second_level_region；sub_region 级 = war_zone；region 级 = NULL
  parent_expr?: string | null;
}

// 视图配置：生成器按配置产出 report_*_gen.sql。P0 无配置（空跑），P1 起填充。
export interface ViewScope {
  target_window: boolean;       // true: base 数据按 active total target 的日期窗口过滤
  assessed_war_zone?: boolean;   // true: base 数据按 is_assessed_war_zone 过滤（dim_branch join）
  target_level?: string;        // tgt CTE 取 targets.target_level（默认 'total'）
  target_status?: string | string[]; // tgt CTE 取 targets.status（默认 'active'；数组如 ['active','closed'] → IN 列表，用于定格后历史目标仍可见）
}

export interface ViewConfig {
  view_name: string;            // report_brand_metric_gen
  metrics: string[];            // metric_code 列表
  dim_code: DimCode | null;     // 维度（brand/branch/item/customer/category），null=无下钻
  levels: string[];             // 维度层级 level_code 列表
  target_metric_codes: string[];// 哪些 metric_code 需 join target_metric_values（取目标值）
  scope?: ViewScope;            // 数据范围约束（日期窗口 + 考核战区）
  total_row?: boolean;          // true: 末尾 UNION ALL 合计行（SUM rollup）
  dim_table?: string | null;    // 维度维表（如 dim_brand）cross-join 保证空品牌也出现
  aliases?: Record<string, string>; // metric_code → 输出列名（如 distribution_amount→delivery_amount）
  hierarchy?: HierarchyLevel[]; // 维度层级（存在时走 generateHierarchyView，产多级 UNION ALL 视图）
  target_breakdown?: TargetBreakdown; // target CTE 的 breakdown_level（默认 'store'；hierarchy 用 leaf.target_breakdown）
  categories?: string[];        // 类别值列表（category 维度专用），如 ['水果', '标品', '耗材']
  dim_grain?: {
    table: string;       // 'dim_item di'（含别名）
    on: string;          // 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num'
    key: string;         // 'item_code'（actual CTE 聚合到这一列）
    extra?: string[];    // ['item_name','category_name',...]（非分组 dim 列，从 dim 表带出）
  };
  carry_cols?: string[];  // 源表列，actual CTE 里 MAX(s.${col}) AS ${col} 带出（client_name/system_book_code）
  extra_join?: {
    table: string;  // 'dim_branch db'（表名+别名）
    on: { left: string; right: string };  // left=外层 CTE 列, right=join 表列：{left:'client_name', right:'branch_name'}
    cols: { out: string; expr: string }[];  // [{out:'client_brand_code', expr:'db.system_book_code'}]
  };
  source_override?: Record<string, { table: string; column?: string }>;
  // e.g. { sale_amount: { table: 'report_daily_item_sales', column: 'sale_amount' } }
  // per-view per-metric 源表/列重定向：把 base 指标从 registry canonical 源（门店粒度）
  // 切到本视图粒度匹配的聚合表（item/customer 粒度）。override 时丢弃原 source_filter（聚合表自洽）。
}
