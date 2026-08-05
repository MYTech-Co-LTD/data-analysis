// web/lib/qa/c1.ts
// C1 明细↔聚合对账核心：duck parquet 明细 SUM vs pg 聚合表 SUM，按 sbc|bizday，amt+profit 双指标。
// 抓 /compute 聚合漏算/翻倍--明细 duck 端用 brand_expr（regexp_extract filename）+ detail_date_expr
// 提取 sbc 与 bizday，pg 端用 system_book_code + biz_date；不 dim_branch JOIN（wholesale 64188 由 filename）。
// |diff|>tolerance -> mismatch；任一 mismatch -> fail。
import type { DetailSource, CheckResult } from './types';

export interface C1Opts {
  duck: { query: (sql: string) => Promise<any[]> };
  pg: { query: (sql: string, params?: any[]) => Promise<any[]> };
}

export interface C1Mismatch {
  sbc: string;
  bizday: string;
  metric: string;
  detail_sum: number;
  agg_sum: number;
  diff: number;
}

export async function runC1(
  src: DetailSource,
  fromIso: string,
  toIso: string,
  opts: C1Opts,
): Promise<CheckResult> {
  const fromCompact = fromIso.replace(/-/g, '');
  const toCompact = toIso.replace(/-/g, '');
  const customSql = src.custom_duck_sql;
  const mismatches: C1Mismatch[] = [];
  for (const m of src.agg_metric) {
    // custom_duck_sql：多源合并明细 SQL（transfer ∪ wholesale，已按 sbc|bizday 聚合），
    // 只替换日期占位（split/join 全量替换——双 CTE 各出现一次），读 m.detail 列
    // （如 delivery_amount/wholesale_amount）；否则默认单 glob SQL 读 detail_sum 列。
    const duckSql = customSql
      ? customSql.split('{{fromCompact}}').join(fromCompact).split('{{toCompact}}').join(toCompact)
      : `SELECT ${src.brand_expr} AS sbc, ${src.detail_date_expr} AS bizday, SUM(CAST(${m.detail} AS DECIMAL(18,2))) AS detail_sum FROM read_parquet('${src.glob}', filename=true, union_by_name=true) WHERE ${src.detail_date_expr} BETWEEN '${fromCompact}' AND '${toCompact}' GROUP BY sbc, bizday`;
    const pgSql = `SELECT system_book_code AS sbc, to_char(biz_date,'YYYYMMDD') AS bizday, SUM(${m.agg}) AS agg_sum FROM ${src.agg_table} WHERE biz_date BETWEEN '${fromIso}' AND '${toIso}' GROUP BY sbc, bizday`;
    const [duckRows, pgRows] = await Promise.all([opts.duck.query(duckSql), opts.pg.query(pgSql)]);
    const detailVal = (d: any): number => customSql ? Number(d?.[m.detail] ?? 0) : Number(d?.detail_sum ?? 0);
    const pgMap = new Map(pgRows.map((r: any) => [`${r.sbc}|${r.bizday}`, Number(r.agg_sum)]));
    for (const d of duckRows) {
      const agg = pgMap.get(`${d.sbc}|${d.bizday}`) ?? 0;
      const dv = detailVal(d);
      const diff = Math.round((dv - agg) * 100) / 100;
      if (Math.abs(diff) > src.tolerance) {
        mismatches.push({ sbc: d.sbc, bizday: d.bizday, metric: m.agg, detail_sum: dv, agg_sum: agg, diff });
      }
    }
    // M20: 反向对账--pg 有 duck 无的 key（聚合多算/明细漏算），双向覆盖
    const duckMap = new Map(duckRows.map((d: any) => [`${d.sbc}|${d.bizday}`, detailVal(d)]));
    for (const p of pgRows) {
      const key = `${p.sbc}|${p.bizday}`;
      if (!duckMap.has(key)) {
        const agg = Number(p.agg_sum);
        const diff = Math.round((0 - agg) * 100) / 100;
        if (Math.abs(diff) > src.tolerance) {
          mismatches.push({ sbc: p.sbc, bizday: p.bizday, metric: m.agg, detail_sum: 0, agg_sum: agg, diff });
        }
      }
    }
  }
  return {
    run_id: '',
    trigger: 'manual',
    check_type: 'C1',
    check_name: src.name,
    status: mismatches.length ? 'fail' : 'pass',
    diff: mismatches.length ? mismatches[0].diff : 0,
    detail: mismatches.length ? mismatches : null,
  };
}
