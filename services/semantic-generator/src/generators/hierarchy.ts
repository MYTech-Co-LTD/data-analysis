import { Metric, MetricSource, ViewConfig } from '../types';

/**
 * 层级视图生成器（T4：叶级基础）
 *
 * 能力：按 hierarchy 配置找到 is_leaf level，产出叶级 grain 上的
 *      actual + target + daily 聚合，汇总为 leaf_rows CTE
 *      （叶级粒度上挂 actual/target/窗口列，COALESCE 补 0）。
 *
 * 结构（照手写视图 120 的 store_tgt / sale_act / store_rows 部分）：
 *   WITH tgt AS (active total target 日期窗口 + 窗口列),
 *        leaf_act_N AS (base 表按叶级 grain + tgt 窗口 + assessed 聚合，含 daily FILTER),
 *        leaf_tgt AS (target_metric_values 按 leaf.target_breakdown + 叶级 grain 聚合),
 *        leaf_rows AS (tgt ⊥ dim_branch LEFT JOIN 各 actual/target + COALESCE + 窗口列)
 *   SELECT * FROM leaf_rows
 *
 * 衔接：
 *   T5 在 leaf_rows 上做父级（sub_region/region）rollup；
 *   T6 做 SELECT 列加工（rate/remaining/cost 脱敏）+ 各级 UNION ALL。
 *
 * 门店键铁律：store 级 grain 必含 (system_book_code, branch_num) 复合键，
 *            禁 branch_num 单独 join。
 */

/** 收集所选指标涉及的全部 base 叶子指标（含 derived 递归依赖） */
function collectLeaves(metricCodes: string[], metrics: Metric[]): Metric[] {
  const visited = new Set<string>();
  const leaves: Metric[] = [];
  function collect(m: Metric) {
    if (visited.has(m.metric_code)) return;
    visited.add(m.metric_code);
    if (m.measure_type === 'base') {
      leaves.push(m);
    } else {
      for (const dep of m.depends_on) {
        const d = metrics.find(x => x.metric_code === dep);
        if (d) collect(d);
      }
    }
  }
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (m) collect(m);
  }
  return leaves;
}

export function generateHierarchyView(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const { view_name, metrics: metricCodes, scope, hierarchy } = config;
  const useAssessed = scope?.assessed_war_zone ?? false;

  const leaf = hierarchy?.find(h => h.is_leaf);
  if (!leaf) {
    throw new Error('generateHierarchyView: hierarchy 配置缺 is_leaf level');
  }
  const grain = leaf.grain;                        // ['system_book_code','branch_num']
  const grainS = grain.map(g => `s.${g}`).join(', '); // source 表别名前缀
  const grainT = grain.map(g => `t.${g}`).join(', '); // targets 表别名前缀

  const leaves = collectLeaves(metricCodes, metrics);

  // daily 指标识别：derived + formula 含 FILTER(biz_date=latest_day)
  // → 在其 depends_on[0] 所属 base 的 actual CTE 里额外产 FILTER(latest_day) 聚合列
  const dailyMap = new Map<string, string>();      // baseMetricCode → dailyMetricCode
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m || m.measure_type !== 'derived') continue;
    const formula = m.formula ?? '';
    if (!/FILTER\s*\(\s*biz_date\s*=\s*latest_day\s*\)/i.test(formula)) continue;
    const baseCode = m.depends_on[0];
    if (baseCode) dailyMap.set(baseCode, code);
  }

  // base 叶子按 (source_table, source_filter) 分组；target_metric_values 单独走 target CTE
  const actualGroups = new Map<string, { table: string; filter: string | null; metrics: Metric[] }>();
  const targetLeaves: Metric[] = [];
  for (const lf of leaves) {
    const src = sources.find(s => s.metric_code === lf.metric_code);
    if (!src) continue;
    if (src.source_table === 'target_metric_values') {
      targetLeaves.push(lf);
      continue;
    }
    const key = `${src.source_table}|${src.source_filter ?? ''}`;
    if (!actualGroups.has(key)) actualGroups.set(key, { table: src.source_table, filter: src.source_filter, metrics: [] });
    actualGroups.get(key)!.metrics.push(lf);
  }

  const cteList: string[] = [];
  const cteOf = new Map<string, string>();          // metricCode(base+daily+target) → cteName

  // 1. tgt CTE —— hierarchy 视图依赖 target_id 关联 + 窗口列，始终构建
  //    （照 120：active total target 的日期窗口 + total_days/days_elapsed/latest_day）
  cteList.push(`tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
)`);

  // 2. 叶级 actual CTE：按 grain 聚合 base + daily FILTER，scope 日期窗口 + assessed
  let actIdx = 0;
  for (const g of actualGroups.values()) {
    const cteName = `leaf_act_${actIdx++}`;
    const cols = g.metrics.map(m => {
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      return `SUM(s.${src.source_column}) AS ${m.metric_code}`;
    });
    // daily FILTER 列：依附于 base metric 的 actual CTE
    for (const m of g.metrics) {
      const dailyCode = dailyMap.get(m.metric_code);
      if (!dailyCode) continue;
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      cols.push(`SUM(s.${src.source_column}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
    }
    const colsStr = cols.join(',\n    ');

    const joins: string[] = [`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date`];
    const where: string[] = [];
    if (g.filter) where.push(g.filter);
    if (useAssessed) {
      // 复合门店键 join dim_branch（禁 branch_num 单独 join）
      joins.push(`JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num`);
      where.push(`is_assessed_war_zone(db.first_level_region)`);
    }
    const whereClause = where.length ? `\n  WHERE ${where.join(' AND ')}` : '';

    cteList.push(`${cteName} AS (
  SELECT tgt.target_id, ${grainS},
    ${colsStr}
  FROM ${g.table} s
  ${joins.join('\n  ')}${whereClause}
  GROUP BY tgt.target_id, ${grainS}
)`);
    for (const m of g.metrics) {
      cteOf.set(m.metric_code, cteName);
      const dc = dailyMap.get(m.metric_code);
      if (dc) cteOf.set(dc, cteName);
    }
  }

  // 3. 叶级 target CTE：target_metric_values 按 leaf.target_breakdown + 叶级 grain 聚合
  //    照 120 store_tgt：MAX(target_value) FILTER (WHERE metric_code=...)，多 target 指标合一 CTE
  if (targetLeaves.length > 0) {
    const tgtCols = targetLeaves.map(tl => {
      const src = sources.find(s => s.metric_code === tl.metric_code)!;
      const f = src.source_filter ?? 'true';
      return `MAX(tmv.target_value) FILTER (WHERE ${f}) AS ${tl.metric_code}`;
    });
    // JOIN 条件：OR 合并各 target 指标的 source_filter
    const metricFilters = targetLeaves.map(tl => {
      const src = sources.find(s => s.metric_code === tl.metric_code)!;
      return src.source_filter ?? 'true';
    }).join(' OR ');

    const joins: string[] = [];
    const whereExtra: string[] = [`t.branch_num <> 'ALL'`];
    if (useAssessed) {
      joins.push(`JOIN dim_branch db ON db.system_book_code = t.system_book_code AND db.branch_num = t.branch_num`);
      whereExtra.push(`is_assessed_war_zone(db.first_level_region)`);
    }

    cteList.push(`leaf_tgt AS (
  SELECT t.parent_target_id AS target_id, ${grainT},
    ${tgtCols.join(',\n    ')}
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (${metricFilters})${joins.length ? '\n  ' + joins.join('\n  ') : ''}
  WHERE t.breakdown_level = '${leaf.target_breakdown}' AND ${whereExtra.join(' AND ')}
  GROUP BY t.parent_target_id, ${grainT}
)`);
    for (const tl of targetLeaves) cteOf.set(tl.metric_code, 'leaf_tgt');
  }

  // 4. leaf_rows CTE：tgt ⊥ dim_branch + LEFT JOIN 各 actual/target + COALESCE + 窗口列
  //    照 120 store_rows；门店键复合 (system_book_code, branch_num)
  const usedCtes = [...new Set(cteOf.values())];
  const cteAlias = new Map<string, string>();
  const leftJoins: string[] = [];
  usedCtes.forEach((cn, i) => {
    const al = `a${i}`;
    cteAlias.set(cn, al);
    const onParts = [`${al}.target_id = tgt.target_id`, ...grain.map(g => `${al}.${g} = db.${g}`)];
    leftJoins.push(`LEFT JOIN ${cn} ${al} ON ${onParts.join(' AND ')}`);
  });

  // 收集所有需 COALESCE 的指标列（actual base + daily + target），保留 metrics 配置顺序
  const metricCols: { code: string; cte: string }[] = [];
  const seen = new Set<string>();
  for (const g of actualGroups.values()) {
    for (const m of g.metrics) {
      if (!seen.has(m.metric_code)) { metricCols.push({ code: m.metric_code, cte: cteOf.get(m.metric_code)! }); seen.add(m.metric_code); }
      const dc = dailyMap.get(m.metric_code);
      if (dc && !seen.has(dc)) { metricCols.push({ code: dc, cte: cteOf.get(dc)! }); seen.add(dc); }
    }
  }
  for (const tl of targetLeaves) {
    if (!seen.has(tl.metric_code)) { metricCols.push({ code: tl.metric_code, cte: 'leaf_tgt' }); seen.add(tl.metric_code); }
  }

  const sel: string[] = [];
  sel.push(`tgt.target_id`);
  sel.push(`'${leaf.level}' AS level`);
  for (const g of grain) sel.push(`db.${g} AS ${g}`);
  // leaf.columns 输出维度列（来自 dim_branch，expr 无前缀时补 db.）
  for (const col of leaf.columns) {
    const expr = col.expr.includes('.') ? col.expr : `db.${col.expr}`;
    sel.push(`${expr} AS ${col.out}`);
  }
  for (const mc of metricCols) {
    const al = cteAlias.get(mc.cte)!;
    sel.push(`COALESCE(${al}.${mc.code}, 0) AS ${mc.code}`);
  }
  sel.push(`tgt.total_days`);
  sel.push(`tgt.days_elapsed`);

  const whereParts = [`db.is_active`, `db.branch_num <> '99'`];
  if (useAssessed) whereParts.push(`is_assessed_war_zone(db.first_level_region)`);

  cteList.push(`leaf_rows AS (
  SELECT ${sel.join(',\n  ')}
  FROM tgt CROSS JOIN dim_branch db
  ${leftJoins.join('\n  ')}
  WHERE ${whereParts.join(' AND ')}
)`);

  // T4 final SELECT：先返回叶级行；T5/T6 改为父级 rollup + UNION ALL + 列加工
  const sql = `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
WITH ${cteList.join(',\n')}
SELECT * FROM leaf_rows;`;

  return sql;
}
